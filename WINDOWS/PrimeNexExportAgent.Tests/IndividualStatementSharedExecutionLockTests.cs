using System.IO;
using PrimeNexExportAgent.Diagnostics;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// V1 (extrato individual por cliente) - CORRECAO ARQUITETURAL: prova que
/// Vendas (RunOnceOperationalEntrypoint) e Extrato Individual
/// (IndividualStatementOnceProbe) disputam o MESMO lock/mutex global de
/// automacao do NEX - nao dois locks distintos. O lock protege a
/// sessao/UI global do NexAdmin (um unico NexAdmin, uma unica UI), nunca
/// "o tipo de exportacao" - por isso NAO pode existir um segundo nome de
/// mutex so para este fluxo.
/// </summary>
public sealed class IndividualStatementSharedExecutionLockTests
{
    [Fact]
    public void SourceCode_IndividualStatementOnceProbe_NaoDeclaraNomeDeMutexProprio()
    {
        var sourcePath = FindSourceFile("IndividualStatementOnceProbe.cs");
        var source = File.ReadAllText(sourcePath);

        Assert.DoesNotContain("IndividualStatement.Lock", source);
        Assert.DoesNotContain("ProbeMutexName", source);
        Assert.Contains("RunOnceOperationalEntrypoint.ProductionMutexName", source);
    }

    [Fact]
    public void SharedLock_MesmoNomeDeMutex_ContendeEntreVendasEIndividualStatement()
    {
        // Mesma string literal usada por AMBOS RunOnceOperationalEntrypoint
        // (Vendas) e IndividualStatementOnceProbe.BuildOrchestrator() (V1) -
        // construir dois Win32ExecutionLock reais com este MESMO nome e'
        // exatamente o que aconteceria se as duas automacoes tentassem
        // rodar ao mesmo tempo.
        var sharedName = RunOnceOperationalEntrypoint.ProductionMutexName + ".TesteContencao." + Guid.NewGuid();
        // (sufixo unico so para isolar este teste de uma eventual instancia
        // real do Agent rodando na maquina do desenvolvedor - a IDENTIDADE
        // testada e' "mesma string para os dois lados", nao o nome exato de
        // producao, que ja e' verificado textualmente no teste acima.)

        using var vendasLock = new Win32ExecutionLock(sharedName);
        using var individualStatementLock = new Win32ExecutionLock(sharedName);

        bool vendasAcquired = false, individualAcquiredWhileVendasHolds = false, individualAcquiredAfterRelease = false;

        // IMPORTANTE: o Mutex do Windows abandona automaticamente a posse
        // quando a THREAD que a adquiriu termina - por isso a thread que
        // representa "Vendas rodando" precisa permanecer VIVA (bloqueada)
        // durante toda a checagem de contencao, nunca ser Join()ada antes.
        var vendasReadyToRelease = new ManualResetEventSlim(false);
        var vendasCanExit = new ManualResetEventSlim(false);

        var vendasThread = new Thread(() =>
        {
            vendasAcquired = vendasLock.TryAcquire();
            vendasReadyToRelease.Set();
            vendasCanExit.Wait();
            vendasLock.Release();
        });
        vendasThread.Start();
        vendasReadyToRelease.Wait();

        Assert.True(vendasAcquired, "Vendas deveria conseguir adquirir o lock livre.");

        var individualThread1 = new Thread(() =>
        {
            individualAcquiredWhileVendasHolds = individualStatementLock.TryAcquire();
        });
        individualThread1.Start();
        individualThread1.Join();

        // Enquanto Vendas segura o MESMO mutex (thread ainda viva, bloqueada
        // de proposito), Individual Statement NUNCA pode adquirir - prova
        // que os dois competem pelo mesmo lock.
        Assert.False(individualAcquiredWhileVendasHolds, "Individual Statement adquiriu o lock mesmo com Vendas ainda segurando - locks NAO estao compartilhados.");

        // Agora deixa a thread de Vendas liberar o mutex e terminar.
        vendasCanExit.Set();
        vendasThread.Join();

        var individualThread2 = new Thread(() =>
        {
            individualAcquiredAfterRelease = individualStatementLock.TryAcquire();
        });
        individualThread2.Start();
        individualThread2.Join();

        Assert.True(individualAcquiredAfterRelease, "Depois que Vendas liberou, Individual Statement deveria conseguir adquirir o MESMO mutex normalmente.");

        var finalRelease = new Thread(individualStatementLock.Release);
        finalRelease.Start();
        finalRelease.Join();
    }

    [Fact]
    public void ZeroActionWhenLockUnavailable_OrquestradorIndividualStatement_NaoChamaMaisNadaSeLockOcupado()
    {
        var fixture = new IndividualStatementOrchestratorFixture();
        fixture.Lock.AcquireSucceeds = false;
        var orchestrator = fixture.BuildOrchestrator();

        var result = orchestrator.Run(new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Success);
        Assert.Equal(AgentErrorCode.LockBusy, result.ErrorCode);

        // Fail-closed TOTAL: nenhum componente subsequente foi tocado -
        // nem sessao, nem navegacao de cliente, nem overflow, nem export,
        // nem Save Dialog.
        Assert.DoesNotContain("CheckSession", fixture.Spy.Calls);
        Assert.Equal(0, fixture.ClientNavigator.OpenClientByCodeCalls);
        Assert.Equal(0, fixture.ClientNavigator.OpenTransactionsTabCalls);
        Assert.Equal(0, fixture.OverflowMenuOpener.OpenOverflowMenuCalls);
        Assert.Equal(0, fixture.ExportTrigger.TriggerExportCalls);
        Assert.DoesNotContain("IdentifySaveDialog", fixture.Spy.Calls);
        Assert.DoesNotContain("Configure", fixture.Spy.Calls);
        Assert.DoesNotContain("CommitOnce", fixture.Spy.Calls);
        Assert.DoesNotContain("Publish", fixture.Spy.Calls);
    }

    [Fact]
    public void VendasOrchestrator_LockOcupado_TambemZeroAcao_SemRegressao()
    {
        var fixture = new OrchestratorFixture();
        fixture.Lock.AcquireSucceeds = false;
        var orchestrator = fixture.BuildOrchestrator();

        var result = orchestrator.Run();

        Assert.False(result.Success);
        Assert.Equal(AgentErrorCode.LockBusy, result.ErrorCode);
        Assert.Equal(0, fixture.InputSender.SendExportShortcutCalls);
        Assert.DoesNotContain("Configure", fixture.Spy.Calls);
    }

    private static string FindSourceFile(string fileName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && dir.Name != "WINDOWS")
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        var path = Path.Combine(dir!.FullName, "PrimeNexExportAgent", "Diagnostics", fileName);
        Assert.True(File.Exists(path), $"Arquivo fonte nao encontrado em '{path}'.");
        return path;
    }
}
