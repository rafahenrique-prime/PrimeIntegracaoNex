using System.IO;
using PrimeNexExportAgent.Diagnostics;
using PrimeNexExportAgent.Domain;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline do arming/composicao/mapeamento de exit code do
/// entrypoint Scheduler V2 (--run-once-scheduled-background-safe). Mesmo
/// padrao de RunOnceScheduledSafeEntrypointTests (V1). Run() (que
/// efetivamente chamaria .Run() do Orchestrator contra o NEX real) NUNCA
/// e' chamado por nenhum teste desta suite.
/// </summary>
public sealed class RunOnceScheduledBackgroundSafeEntrypointTests
{
    // ---------- A. Sem args ----------
    [Fact]
    public void A_SemArgs_False()
    {
        Assert.False(RunOnceScheduledBackgroundSafeEntrypoint.IsScheduledBackgroundSafeFlag(Array.Empty<string>()));
    }

    // ---------- B. Arg desconhecido ----------
    [Fact]
    public void B_ArgDesconhecido_False()
    {
        Assert.False(RunOnceScheduledBackgroundSafeEntrypoint.IsScheduledBackgroundSafeFlag(new[] { "--qualquer-coisa" }));
    }

    // ---------- C. Prefixo parcial ----------
    [Fact]
    public void C_PrefixoParcial_False()
    {
        Assert.False(RunOnceScheduledBackgroundSafeEntrypoint.IsScheduledBackgroundSafeFlag(new[] { "--run-once-scheduled-background-saf" }));
    }

    // ---------- D. Sufixo extra ----------
    [Fact]
    public void D_SufixoExtra_False()
    {
        Assert.False(RunOnceScheduledBackgroundSafeEntrypoint.IsScheduledBackgroundSafeFlag(new[] { "--run-once-scheduled-background-safe-extra" }));
    }

    // ---------- E. Case diferente ----------
    [Fact]
    public void E_CaseDiferente_False()
    {
        Assert.False(RunOnceScheduledBackgroundSafeEntrypoint.IsScheduledBackgroundSafeFlag(new[] { "--RUN-ONCE-SCHEDULED-BACKGROUND-SAFE" }));
    }

    // ---------- F. Dois argumentos ----------
    [Fact]
    public void F_DoisArgumentos_False()
    {
        Assert.False(RunOnceScheduledBackgroundSafeEntrypoint.IsScheduledBackgroundSafeFlag(new[] { "--run-once-scheduled-background-safe", "extra" }));
        Assert.False(RunOnceScheduledBackgroundSafeEntrypoint.IsScheduledBackgroundSafeFlag(new[] { "extra", "--run-once-scheduled-background-safe" }));
    }

    // ---------- G. Nunca casa com V1 nem outras flags existentes ----------
    [Theory]
    [InlineData("--run-once-operational")]
    [InlineData("--run-once-scheduled-safe")]
    [InlineData("--inspect-readonly")]
    [InlineData("--diagnostic-send-export-shortcut-once")]
    public void G_FlagsExistentesNuncaCasamComScheduledBackgroundSafe(string flag)
    {
        Assert.False(RunOnceScheduledBackgroundSafeEntrypoint.IsScheduledBackgroundSafeFlag(new[] { flag }));
    }

    // ---------- H. Somente a flag exata seleciona o branch background-safe ----------
    [Fact]
    public void H_FlagExata_True()
    {
        Assert.True(RunOnceScheduledBackgroundSafeEntrypoint.IsScheduledBackgroundSafeFlag(new[] { "--run-once-scheduled-background-safe" }));
    }

    // ---------- H2. V1 nunca reconhece a flag de V2, e vice-versa ----------
    [Fact]
    public void H2_V1NuncaReconheceFlagDeV2_EViceVersa()
    {
        Assert.False(RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag(new[] { "--run-once-scheduled-background-safe" }));
        Assert.False(RunOnceScheduledBackgroundSafeEntrypoint.IsScheduledBackgroundSafeFlag(new[] { "--run-once-scheduled-safe" }));
    }

    // ==================================================================
    // Composicao real (nunca chama .Run() contra o NEX)
    // ==================================================================

    // ---------- I. BuildOrchestrator() compoe sem excecao ----------
    [Fact]
    public void I_BuildOrchestrator_NaoLancaExcecao_RetornaInstancia()
    {
        var orchestrator = RunOnceScheduledBackgroundSafeEntrypoint.BuildOrchestrator();

        Assert.NotNull(orchestrator);
    }

    // ---------- J. Paths e mutex identicos aos do modo manual E do V1 scheduled-safe ----------
    [Fact]
    public void J_PathsEMutexIdenticosAoModoManualEAoV1()
    {
        Assert.Equal(RunOnceOperationalEntrypoint.ExportStagePath, RunOnceScheduledBackgroundSafeEntrypoint.ExportStagePath);
        Assert.Equal(RunOnceOperationalEntrypoint.ExportadosPath, RunOnceScheduledBackgroundSafeEntrypoint.ExportadosPath);
        // Decisao de design homologada: MESMO mutex do V1 - V1 e V2 nunca
        // podem exportar simultaneamente.
        Assert.Equal(RunOnceOperationalEntrypoint.ProductionMutexName, RunOnceScheduledBackgroundSafeEntrypoint.ProductionMutexName);
        Assert.Equal(RunOnceScheduledSafeEntrypoint.ProductionMutexName, RunOnceScheduledBackgroundSafeEntrypoint.ProductionMutexName);
    }

    // ---------- K. Source guard: composicao usa WindowsBackgroundExportTrigger, NUNCA os senders de Shift+F5 ----------
    [Fact]
    public void K_ComposicaoUsaWindowsBackgroundExportTrigger_NuncaSendersDeShiftF5()
    {
        var path = FindSourceFile("RunOnceScheduledBackgroundSafeEntrypoint.cs");
        var source = File.ReadAllText(path);

        Assert.Contains("new WindowsBackgroundExportTrigger(", source);
        Assert.DoesNotContain("new WindowsInputSender(", source);
        Assert.DoesNotContain("new WindowsScheduledSafeInputSender(", source);
        Assert.DoesNotContain("new PollingForegroundWaiter(", source); // T4a/T4b (SetForegroundWindow) nao existem neste modo
        Assert.DoesNotContain("new Fake", source);
    }

    // ---------- K2. Source guard: nunca SetForegroundWindow/SendInput em todo o arquivo ----------
    [Fact]
    public void K2_SourceGuard_NuncaForcaForegroundNemSendInput()
    {
        var path = FindSourceFile("RunOnceScheduledBackgroundSafeEntrypoint.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain("SetForegroundWindow", source);
        Assert.DoesNotContain("SendInput", source);
    }

    // ---------- L. Source guard: nenhuma automacao recorrente criada aqui tambem ----------
    [Fact]
    public void L_NenhumaAutomacaoRecorrenteCriadaNoEntrypoint()
    {
        var path = FindSourceFile("RunOnceScheduledBackgroundSafeEntrypoint.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain("ScheduledTask", source);
        Assert.DoesNotContain("Timer", source);
        Assert.DoesNotContain("while (true)", source);
        Assert.DoesNotContain("for (;;)", source);
    }

    // ---------- M. Program.cs so alcanca o branch background-safe via IsScheduledBackgroundSafeFlag ----------
    [Fact]
    public void M_ProgramSoAlcancaBackgroundSafeViaIsScheduledBackgroundSafeFlag()
    {
        var programPath = FindSourceFile("Program.cs");
        var source = File.ReadAllText(programPath);

        Assert.Contains("RunOnceScheduledBackgroundSafeEntrypoint.IsScheduledBackgroundSafeFlag(args)", source);
        // V1 continua presente e intocado no mesmo arquivo.
        Assert.Contains("RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag(args)", source);
        Assert.DoesNotContain("StartsWith(\"--run-once-scheduled-background-safe\"", source);
        Assert.DoesNotContain(".Contains(\"--run-once-scheduled-background-safe\"", source);
    }

    // ---------- N. Source guard: WindowsBackgroundExportTrigger nunca usa hit-test global ----------
    [Fact]
    public void N_TriggerSourceGuard_NuncaUsaHitTestGlobal()
    {
        var path = FindSourceFile("WindowsBackgroundExportTrigger.cs");
        var source = File.ReadAllText(path);

        // _msaa.HitTest(...) [global] nao pode aparecer; somente
        // _msaa.HitTestWithinWindow(...) - decisao de design homologada
        // (imunidade a oclusao por Chrome/Claude em primeiro plano).
        Assert.Contains("HitTestWithinWindow(", source);
        Assert.DoesNotContain("_msaa.HitTest(", source);
    }

    // ==================================================================
    // Mapeamento explicito de exit code (identico ao V1)
    // ==================================================================

    [Theory]
    [InlineData(AgentStage.SkippedNotForeground, AgentErrorCode.NotForeground, 0)]
    [InlineData(AgentStage.SkippedBusy, AgentErrorCode.LockBusy, 0)]
    [InlineData(AgentStage.SkippedSessionUnavailable, AgentErrorCode.SessionUnavailable, 0)]
    [InlineData(AgentStage.NexNotFound, AgentErrorCode.NexNotFound, 0)]
    [InlineData(AgentStage.UnsafeState, AgentErrorCode.UnsafeState, 0)] // inclui o skip novo de BackgroundSafeSkipException
    [InlineData(AgentStage.Failed, AgentErrorCode.UnexpectedException, 1)]
    [InlineData(AgentStage.Failed, AgentErrorCode.FileUnstable, 1)]
    [InlineData(AgentStage.Failed, AgentErrorCode.ReaderRejected, 1)]
    [InlineData(AgentStage.Failed, AgentErrorCode.PublishFailed, 1)]
    public void MapExitCode_TerminaisEsperadosMapeiamCorretamente(AgentStage stage, AgentErrorCode errorCode, int expectedExitCode)
    {
        var result = AgentRunResult.Stop(Guid.NewGuid(), stage, errorCode);

        Assert.Equal(expectedExitCode, RunOnceScheduledBackgroundSafeEntrypoint.MapExitCode(result));
    }

    [Fact]
    public void MapExitCode_Success_MapeiaParaZero()
    {
        var result = AgentRunResult.Ok(Guid.NewGuid(), @"C:\Nex\PrimeIntegracaoNex\EXPORTADOS\vendas-auto-teste.xls");

        Assert.Equal(0, RunOnceScheduledBackgroundSafeEntrypoint.MapExitCode(result));
    }

    private static string FindSourceFile(string fileName)
    {
        var root = FindSourceRoot();
        var matches = Directory.GetFiles(root, fileName, SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}") && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
            .ToList();
        Assert.Single(matches);
        return matches[0];
    }

    private static string FindSourceRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && dir.Name != "WINDOWS")
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        return dir!.FullName;
    }
}
