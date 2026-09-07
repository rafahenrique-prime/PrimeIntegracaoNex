using System.IO;
using PrimeNexExportAgent.Diagnostics;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// F6.14B2.12E - testes offline do arming/composicao do entrypoint
/// operacional real. IsOperationalFlag() e' testado exaustivamente contra
/// falsos-positivos (nenhum StartsWith/Contains/case-insensitive). O
/// teste de composicao (BuildOrchestrator) constroi TODAS as
/// implementacoes reais - a UNICA acao de sistema que ocorre e' a criacao
/// de um Mutex nomeado pelo Win32ExecutionLock (ja homologado
/// isoladamente em F6.14B2.12B/12D) - nenhum NEX/EXPORT_STAGE/EXPORTADOS/
/// rede e' tocado pela mera construcao dos objetos. Run() (que
/// efetivamente chamaria .Run() do Orchestrator contra o NEX real) NUNCA
/// e' chamado por nenhum teste desta suite.
/// </summary>
public sealed class RunOnceOperationalEntrypointTests
{
    // ---------- A. Sem args ----------
    [Fact]
    public void A_SemArgs_False()
    {
        Assert.False(RunOnceOperationalEntrypoint.IsOperationalFlag(Array.Empty<string>()));
    }

    // ---------- B. Arg desconhecido ----------
    [Fact]
    public void B_ArgDesconhecido_False()
    {
        Assert.False(RunOnceOperationalEntrypoint.IsOperationalFlag(new[] { "--qualquer-coisa" }));
    }

    // ---------- C. Prefixo parcial ----------
    [Fact]
    public void C_PrefixoParcial_False()
    {
        Assert.False(RunOnceOperationalEntrypoint.IsOperationalFlag(new[] { "--run-once-operation" }));
    }

    // ---------- D. Sufixo extra ----------
    [Fact]
    public void D_SufixoExtra_False()
    {
        Assert.False(RunOnceOperationalEntrypoint.IsOperationalFlag(new[] { "--run-once-operational-extra" }));
    }

    // ---------- E. Case diferente ----------
    [Fact]
    public void E_CaseDiferente_False()
    {
        Assert.False(RunOnceOperationalEntrypoint.IsOperationalFlag(new[] { "--RUN-ONCE-OPERATIONAL" }));
    }

    // ---------- F. Dois argumentos, incluindo o correto ----------
    [Fact]
    public void F_DoisArgumentos_False()
    {
        Assert.False(RunOnceOperationalEntrypoint.IsOperationalFlag(new[] { "--run-once-operational", "extra" }));
        Assert.False(RunOnceOperationalEntrypoint.IsOperationalFlag(new[] { "extra", "--run-once-operational" }));
    }

    // ---------- G. Flags diagnosticas existentes nunca casam com o operacional ----------
    [Theory]
    [InlineData("--inspect-readonly")]
    [InlineData("--diagnostic-send-export-shortcut-once")]
    [InlineData("--diagnostic-configure-save-dialog-readback-once")]
    [InlineData("--diagnostic-configure-save-dialog-click-save-once")]
    [InlineData("--diagnostic-confirmed-save-committer-once")]
    public void G_FlagsDiagnosticasExistentes_NuncaCasamComOperacional(string flag)
    {
        Assert.False(RunOnceOperationalEntrypoint.IsOperationalFlag(new[] { flag }));
    }

    // ---------- H. Somente a flag exata seleciona o branch operacional ----------
    [Fact]
    public void H_FlagExata_True()
    {
        Assert.True(RunOnceOperationalEntrypoint.IsOperationalFlag(new[] { "--run-once-operational" }));
    }

    // ==================================================================
    // Composicao real (nunca chama .Run() contra o NEX)
    // ==================================================================

    // ---------- I. BuildOrchestrator() compoe sem excecao ----------
    [Fact]
    public void I_BuildOrchestrator_NaoLancaExcecao_RetornaInstancia()
    {
        var orchestrator = RunOnceOperationalEntrypoint.BuildOrchestrator();

        Assert.NotNull(orchestrator);
    }

    // ---------- J. Paths operacionais literais ----------
    [Fact]
    public void J_PathsOperacionaisSaoOsCanonicosDeProducao()
    {
        Assert.Equal(@"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE", RunOnceOperationalEntrypoint.ExportStagePath);
        Assert.Equal(@"C:\Nex\PrimeIntegracaoNex\EXPORTADOS", RunOnceOperationalEntrypoint.ExportadosPath);
        Assert.DoesNotContain("OUTPUT", RunOnceOperationalEntrypoint.ExportStagePath);
        Assert.DoesNotContain("OUTPUT", RunOnceOperationalEntrypoint.ExportadosPath);
        Assert.DoesNotContain("HOMOLOGACAO", RunOnceOperationalEntrypoint.ExportStagePath);
        Assert.DoesNotContain("HOMOLOGACAO", RunOnceOperationalEntrypoint.ExportadosPath);
        Assert.DoesNotContain("TEMP", RunOnceOperationalEntrypoint.ExportStagePath, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Fixtures", RunOnceOperationalEntrypoint.ExportStagePath);
    }

    // ---------- K. Nome do Mutex de producao literal ----------
    [Fact]
    public void K_ProductionMutexName_EExatamenteOEscolhidoEmF6_14B2_12D()
    {
        Assert.Equal(@"Local\PrimeNexExportAgent.Lock", RunOnceOperationalEntrypoint.ProductionMutexName);
        Assert.DoesNotContain(@"Global\", RunOnceOperationalEntrypoint.ProductionMutexName);
    }

    // ---------- L. Source guard: composicao usa somente implementacoes reais ----------
    [Fact]
    public void L_ComposicaoUsaSomenteImplementacoesReais_NenhumFake()
    {
        var path = FindSourceFile("RunOnceOperationalEntrypoint.cs");
        var source = File.ReadAllText(path);

        Assert.Contains("new Win32ExecutionLock(", source);
        Assert.Contains("new WindowsSessionInspector(", source);
        Assert.Contains("new WindowsNexWindowInspector(", source);
        Assert.Contains("new WindowsInputSender(", source);
        Assert.Contains("new WindowsSaveDialogInspector(", source);
        Assert.Contains("new WindowsSaveDialogController(", source);
        Assert.Contains("new PollingSaveDialogWaiter(", source);
        Assert.Contains("new WindowsConfirmedSaveDialogCommitter(", source);
        Assert.Contains("new PollingExportStageWatcher(", source);
        Assert.Contains("new NodeExportValidator(", source);
        Assert.Contains("new Win32ProcessRunner(", source);
        Assert.Contains("new FileMoveAtomicPublisher(", source);
        Assert.Contains("new Win32FileMover(", source);
        Assert.Contains("new ConsoleAgentLogger(", source);
        Assert.DoesNotContain("new Fake", source);
    }

    // ---------- M. Source guard: generic ClickSave nunca usado pelo operacional ----------
    [Fact]
    public void M_EntrypointNuncaChamaClickSaveGenerico()
    {
        var path = FindSourceFile("RunOnceOperationalEntrypoint.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain(".ClickSave(", source);
        Assert.DoesNotContain(".CancelSaveDialog(", source);
        Assert.DoesNotContain(".ClickButton(", source);
    }

    // ---------- N. Source guard: zero downstream ----------
    [Fact]
    public void N_EntrypointNuncaReferenciaDownstreamOperacional()
    {
        var path = FindSourceFile("RunOnceOperationalEntrypoint.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain("new DetectorExportsNex", source);
        Assert.DoesNotContain("new BootstrapIntegracaoNex", source);
        Assert.DoesNotContain("Environment.GetEnvironmentVariable(\"NEX_PRIME_ENDPOINT\"", source);
        Assert.DoesNotContain("Environment.GetEnvironmentVariable(\"NEX_PRIME_INTEGRATION_SECRET\"", source);
        Assert.DoesNotContain("new HttpClient(", source);
        Assert.DoesNotContain("fetch(", source);
    }

    // ---------- O. Source guard: nenhuma automacao recorrente criada ----------
    [Fact]
    public void O_NenhumaAutomacaoRecorrenteCriadaNoEntrypoint()
    {
        var path = FindSourceFile("RunOnceOperationalEntrypoint.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain("ScheduledTask", source);
        Assert.DoesNotContain("Timer", source);
        Assert.DoesNotContain("while (true)", source);
        Assert.DoesNotContain("for (;;)", source);
    }

    // ---------- P. Program.cs so alcanca o branch operacional via IsOperationalFlag ----------
    [Fact]
    public void P_ProgramSoAlcancaOperacionalViaIsOperationalFlag()
    {
        var programPath = FindSourceFile("Program.cs");
        var source = File.ReadAllText(programPath);

        Assert.Contains("RunOnceOperationalEntrypoint.IsOperationalFlag(args)", source);
        Assert.DoesNotContain("StartsWith(\"--run-once-operational\"", source);
        Assert.DoesNotContain(".Contains(\"--run-once-operational\"", source);
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
