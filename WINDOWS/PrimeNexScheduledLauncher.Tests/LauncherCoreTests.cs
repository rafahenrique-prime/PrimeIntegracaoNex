using PrimeNexScheduledLauncher;
using PrimeNexScheduledLauncher.Tests.Fakes;
using Xunit;

namespace PrimeNexScheduledLauncher.Tests;

/// <summary>
/// Testes offline de LauncherCore - IChildProcessRunner e' sempre um FAKE
/// (nunca inicia PrimeNexExportAgent.exe/NEX/Task Scheduler real). Log dir
/// e' sempre um diretorio TEMPORARIO descartavel criado por teste, nunca
/// C:\Nex\PrimeIntegracaoNex\LOGS real.
/// </summary>
public sealed class LauncherCoreTests : IDisposable
{
    private const string ExpectedArgument = "--run-once-scheduled-safe";
    private readonly string _tempRoot;
    private readonly string _fakeAgentExe;
    private readonly string _fakeAgentWorkDir;
    private readonly string _logDir;

    public LauncherCoreTests()
    {
        _tempRoot = Path.Combine(Path.GetTempPath(), "PrimeNexScheduledLauncherTests_" + Guid.NewGuid().ToString("N"));
        _fakeAgentWorkDir = Path.Combine(_tempRoot, "agent");
        _logDir = Path.Combine(_tempRoot, "logs");
        Directory.CreateDirectory(_fakeAgentWorkDir);
        Directory.CreateDirectory(_logDir);

        // Um arquivo qualquer, so para File.Exists(agentExe) passar - NUNCA
        // executado de fato (o fake runner intercepta antes).
        _fakeAgentExe = Path.Combine(_fakeAgentWorkDir, "PrimeNexExportAgent.exe");
        File.WriteAllText(_fakeAgentExe, "nao e um executavel real - so precisa existir como arquivo");
    }

    public void Dispose()
    {
        try { Directory.Delete(_tempRoot, recursive: true); } catch { /* melhor esforco, nunca falha o teste */ }
    }

    private static DateTime FixedNow() => new(2026, 9, 7, 12, 0, 0);

    // ---- D: argumento exato passado ao runner ----
    [Fact]
    public void D_ArgumentoExatoPassadoAoRunner()
    {
        var runner = new FakeChildProcessRunner();

        LauncherCore.Run(runner, _fakeAgentExe, _fakeAgentWorkDir, _logDir, ExpectedArgument, FixedNow);

        Assert.Equal(ExpectedArgument, runner.LastArgument);
        Assert.Equal(_fakeAgentExe, runner.LastFileName);
        Assert.Equal(_fakeAgentWorkDir, runner.LastWorkingDirectory);
    }

    // ---- E/F: exatamente 1 chamada ao runner, zero retry mesmo em falha ----
    [Fact]
    public void EF_ExatamenteUmaChamadaAoRunner_MesmoComFalha()
    {
        var runner = new FakeChildProcessRunner { ResultToReturn = new ChildProcessResult(1, "erro simulado", string.Empty) };

        LauncherCore.Run(runner, _fakeAgentExe, _fakeAgentWorkDir, _logDir, ExpectedArgument, FixedNow);

        Assert.Equal(1, runner.RunCalls);
    }

    // ---- G: fake child exit 0 -> LauncherCore retorna 0 ----
    [Fact]
    public void G_ChildExit0_LauncherCoreRetorna0()
    {
        var runner = new FakeChildProcessRunner { ResultToReturn = new ChildProcessResult(0, "{}", string.Empty) };

        var exitCode = LauncherCore.Run(runner, _fakeAgentExe, _fakeAgentWorkDir, _logDir, ExpectedArgument, FixedNow);

        Assert.Equal(0, exitCode);
    }

    // ---- H: fake child exit 1 -> LauncherCore retorna 1 ----
    [Fact]
    public void H_ChildExit1_LauncherCoreRetorna1()
    {
        var runner = new FakeChildProcessRunner { ResultToReturn = new ChildProcessResult(1, string.Empty, "falhou") };

        var exitCode = LauncherCore.Run(runner, _fakeAgentExe, _fakeAgentWorkDir, _logDir, ExpectedArgument, FixedNow);

        Assert.Equal(1, exitCode);
    }

    // ---- I: stdout preservado no log ----
    [Fact]
    public void I_StdoutPreservadoNoLog()
    {
        var runner = new FakeChildProcessRunner
        {
            ResultToReturn = new ChildProcessResult(0, "{\"stage\":\"Start\"}\n{\"stage\":\"Success\"}\n", string.Empty)
        };

        LauncherCore.Run(runner, _fakeAgentExe, _fakeAgentWorkDir, _logDir, ExpectedArgument, FixedNow);

        var logFile = Path.Combine(_logDir, "prime-nex-export-agent-scheduled-2026-09-07.jsonl");
        var content = File.ReadAllText(logFile);
        Assert.Contains("\"stage\":\"Start\"", content);
        Assert.Contains("\"stage\":\"Success\"", content);
    }

    // ---- J: stderr preservado no log, nunca escondido ----
    [Fact]
    public void J_StderrPreservadoNoLog()
    {
        var runner = new FakeChildProcessRunner
        {
            ResultToReturn = new ChildProcessResult(1, string.Empty, "Unhandled exception: algo quebrou\n")
        };

        LauncherCore.Run(runner, _fakeAgentExe, _fakeAgentWorkDir, _logDir, ExpectedArgument, FixedNow);

        var logFile = Path.Combine(_logDir, "prime-nex-export-agent-scheduled-2026-09-07.jsonl");
        var content = File.ReadAllText(logFile);
        Assert.Contains("Unhandled exception: algo quebrou", content);
    }

    // ---- K: append - duas execucoes nao sobrescrevem a anterior ----
    [Fact]
    public void K_DuasExecucoesFake_AppendNaoSobrescreve()
    {
        var runner1 = new FakeChildProcessRunner { ResultToReturn = new ChildProcessResult(0, "PRIMEIRA_EXECUCAO\n", string.Empty) };
        LauncherCore.Run(runner1, _fakeAgentExe, _fakeAgentWorkDir, _logDir, ExpectedArgument, FixedNow);

        var runner2 = new FakeChildProcessRunner { ResultToReturn = new ChildProcessResult(0, "SEGUNDA_EXECUCAO\n", string.Empty) };
        LauncherCore.Run(runner2, _fakeAgentExe, _fakeAgentWorkDir, _logDir, ExpectedArgument, FixedNow);

        var logFile = Path.Combine(_logDir, "prime-nex-export-agent-scheduled-2026-09-07.jsonl");
        var content = File.ReadAllText(logFile);
        Assert.Contains("PRIMEIRA_EXECUCAO", content);
        Assert.Contains("SEGUNDA_EXECUCAO", content);
    }

    // ---- L: nome diario do log correto ----
    [Fact]
    public void L_NomeDiarioDoLogCorreto()
    {
        var runner = new FakeChildProcessRunner { ResultToReturn = new ChildProcessResult(0, "x\n", string.Empty) };
        DateTime Now() => new(2026, 12, 25, 8, 30, 0);

        LauncherCore.Run(runner, _fakeAgentExe, _fakeAgentWorkDir, _logDir, ExpectedArgument, Now);

        Assert.True(File.Exists(Path.Combine(_logDir, "prime-nex-export-agent-scheduled-2026-12-25.jsonl")));
    }

    // ---- Falha do launcher (Agent EXE ausente) - zero chamada ao runner ----
    [Fact]
    public void AgentExeAusente_ZeroChamadaAoRunner_Retorna1()
    {
        var runner = new FakeChildProcessRunner();
        var caminhoInexistente = Path.Combine(_fakeAgentWorkDir, "NaoExiste.exe");

        var exitCode = LauncherCore.Run(runner, caminhoInexistente, _fakeAgentWorkDir, _logDir, ExpectedArgument, FixedNow);

        Assert.Equal(1, exitCode);
        Assert.Equal(0, runner.RunCalls);
    }
}
