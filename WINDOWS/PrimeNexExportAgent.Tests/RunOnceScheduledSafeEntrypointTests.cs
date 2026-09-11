using System.IO;
using PrimeNexExportAgent.Diagnostics;
using PrimeNexExportAgent.Domain;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline do arming/composicao/mapeamento de exit code do
/// entrypoint scheduled-safe (--run-once-scheduled-safe). Mesmo padrao de
/// RunOnceOperationalEntrypointTests. Run() (que efetivamente chamaria
/// .Run() do Orchestrator contra o NEX real) NUNCA e' chamado por nenhum
/// teste desta suite.
/// </summary>
public sealed class RunOnceScheduledSafeEntrypointTests
{
    // ---------- A. Sem args ----------
    [Fact]
    public void A_SemArgs_False()
    {
        Assert.False(RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag(Array.Empty<string>()));
    }

    // ---------- B. Arg desconhecido ----------
    [Fact]
    public void B_ArgDesconhecido_False()
    {
        Assert.False(RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag(new[] { "--qualquer-coisa" }));
    }

    // ---------- C. Prefixo parcial ----------
    [Fact]
    public void C_PrefixoParcial_False()
    {
        Assert.False(RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag(new[] { "--run-once-scheduled-saf" }));
    }

    // ---------- D. Sufixo extra ----------
    [Fact]
    public void D_SufixoExtra_False()
    {
        Assert.False(RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag(new[] { "--run-once-scheduled-safe-extra" }));
    }

    // ---------- E. Case diferente ----------
    [Fact]
    public void E_CaseDiferente_False()
    {
        Assert.False(RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag(new[] { "--RUN-ONCE-SCHEDULED-SAFE" }));
    }

    // ---------- F. Dois argumentos ----------
    [Fact]
    public void F_DoisArgumentos_False()
    {
        Assert.False(RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag(new[] { "--run-once-scheduled-safe", "extra" }));
        Assert.False(RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag(new[] { "extra", "--run-once-scheduled-safe" }));
    }

    // ---------- G. Nunca casa com --run-once-operational nem outras flags existentes ----------
    [Theory]
    [InlineData("--run-once-operational")]
    [InlineData("--inspect-readonly")]
    [InlineData("--diagnostic-send-export-shortcut-once")]
    public void G_FlagsExistentesNuncaCasamComScheduledSafe(string flag)
    {
        Assert.False(RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag(new[] { flag }));
    }

    // ---------- H. Somente a flag exata seleciona o branch scheduled-safe ----------
    [Fact]
    public void H_FlagExata_True()
    {
        Assert.True(RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag(new[] { "--run-once-scheduled-safe" }));
    }

    // ==================================================================
    // Composicao real (nunca chama .Run() contra o NEX)
    // ==================================================================

    // ---------- I. BuildOrchestrator() compoe sem excecao ----------
    [Fact]
    public void I_BuildOrchestrator_NaoLancaExcecao_RetornaInstancia()
    {
        var orchestrator = RunOnceScheduledSafeEntrypoint.BuildOrchestrator();

        Assert.NotNull(orchestrator);
    }

    // ---------- J. Paths e mutex identicos aos do modo manual (mesma UI do NexAdmin) ----------
    [Fact]
    public void J_PathsEMutexIdenticosAoModoManual()
    {
        Assert.Equal(RunOnceOperationalEntrypoint.ExportStagePath, RunOnceScheduledSafeEntrypoint.ExportStagePath);
        Assert.Equal(RunOnceOperationalEntrypoint.ExportadosPath, RunOnceScheduledSafeEntrypoint.ExportadosPath);
        Assert.Equal(RunOnceOperationalEntrypoint.ProductionMutexName, RunOnceScheduledSafeEntrypoint.ProductionMutexName);
    }

    // ---------- K. Source guard: composicao usa o sender scheduled-safe, nunca o manual ----------
    [Fact]
    public void K_ComposicaoUsaWindowsScheduledSafeInputSender_NuncaWindowsInputSender()
    {
        var path = FindSourceFile("RunOnceScheduledSafeEntrypoint.cs");
        var source = File.ReadAllText(path);

        Assert.Contains("new WindowsScheduledSafeInputSender(", source);
        Assert.DoesNotContain("new WindowsInputSender(", source);
        Assert.DoesNotContain("new PollingForegroundWaiter(", source); // T4a/T4b nao existem neste modo
        Assert.DoesNotContain("new Fake", source);
    }

    // ---------- L. Source guard: nenhuma automacao recorrente criada aqui tambem ----------
    [Fact]
    public void L_NenhumaAutomacaoRecorrenteCriadaNoEntrypoint()
    {
        var path = FindSourceFile("RunOnceScheduledSafeEntrypoint.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain("ScheduledTask", source);
        Assert.DoesNotContain("Timer", source);
        Assert.DoesNotContain("while (true)", source);
        Assert.DoesNotContain("for (;;)", source);
    }

    // ---------- M. Program.cs so alcanca o branch scheduled-safe via IsScheduledSafeFlag ----------
    [Fact]
    public void M_ProgramSoAlcancaScheduledSafeViaIsScheduledSafeFlag()
    {
        var programPath = FindSourceFile("Program.cs");
        var source = File.ReadAllText(programPath);

        Assert.Contains("RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag(args)", source);
        Assert.DoesNotContain("StartsWith(\"--run-once-scheduled-safe\"", source);
        Assert.DoesNotContain(".Contains(\"--run-once-scheduled-safe\"", source);
    }

    // ==================================================================
    // G (do plano): mapeamento explicito de exit code
    // ==================================================================

    [Theory]
    [InlineData(AgentStage.SkippedNotForeground, AgentErrorCode.NotForeground, 0)]
    [InlineData(AgentStage.SkippedBusy, AgentErrorCode.LockBusy, 0)]
    [InlineData(AgentStage.SkippedSessionUnavailable, AgentErrorCode.SessionUnavailable, 0)]
    [InlineData(AgentStage.NexNotFound, AgentErrorCode.NexNotFound, 0)]
    [InlineData(AgentStage.UnsafeState, AgentErrorCode.UnsafeState, 0)]
    [InlineData(AgentStage.Failed, AgentErrorCode.UnexpectedException, 1)]
    [InlineData(AgentStage.Failed, AgentErrorCode.FileUnstable, 1)]
    [InlineData(AgentStage.Failed, AgentErrorCode.ReaderRejected, 1)]
    [InlineData(AgentStage.Failed, AgentErrorCode.PublishFailed, 1)]
    public void MapExitCode_TerminaisEsperadosMapeiamCorretamente(AgentStage stage, AgentErrorCode errorCode, int expectedExitCode)
    {
        var result = AgentRunResult.Stop(Guid.NewGuid(), stage, errorCode);

        Assert.Equal(expectedExitCode, RunOnceScheduledSafeEntrypoint.MapExitCode(result));
    }

    [Fact]
    public void MapExitCode_Success_MapeiaParaZero()
    {
        var result = AgentRunResult.Ok(Guid.NewGuid(), @"C:\Nex\PrimeIntegracaoNex\EXPORTADOS\vendas-auto-teste.xls");

        Assert.Equal(0, RunOnceScheduledSafeEntrypoint.MapExitCode(result));
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
