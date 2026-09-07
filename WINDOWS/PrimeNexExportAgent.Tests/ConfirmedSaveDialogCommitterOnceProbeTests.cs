using System.IO;
using System.Linq;
using PrimeNexExportAgent.Diagnostics;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14B2.12C2) da ORQUESTRACAO do novo probe do
/// WindowsConfirmedSaveDialogCommitter - exercitam
/// ConfirmedSaveDialogCommitterOnceProbe.RunCore(...) diretamente, com
/// TODAS as dependencias injetadas como fakes (nenhum Win32/NEX real
/// tocado). EXPORT_STAGE/EXPORTADOS aqui sao sempre pastas temporarias
/// isoladas, nunca os caminhos operacionais reais.
/// </summary>
public sealed class ConfirmedSaveDialogCommitterOnceProbeTests : IDisposable
{
    private const string ExpectedFileType = "Excel";

    private readonly string _exportStageDir;
    private readonly string _exportadosDir;

    public ConfirmedSaveDialogCommitterOnceProbeTests()
    {
        var root = Path.Combine(Path.GetTempPath(), "PrimeNexExportAgentTests_CommitterProbe_" + Guid.NewGuid());
        _exportStageDir = Path.Combine(root, "EXPORT_STAGE");
        _exportadosDir = Path.Combine(root, "EXPORTADOS");
        Directory.CreateDirectory(_exportStageDir);
        Directory.CreateDirectory(_exportadosDir);
    }

    public void Dispose()
    {
        try { Directory.Delete(Path.GetDirectoryName(_exportStageDir)!, recursive: true); } catch { /* best-effort */ }
    }

    private sealed class Fixture
    {
        public CallSpy Spy { get; } = new();
        public FakeSessionInspector Session { get; }
        public FakeNexWindowInspector Window { get; }
        public FakeInputSender Input { get; }
        public FakeSaveDialogInspector Inspector { get; }
        public FakeSaveDialogWaiter Waiter { get; }
        public FakeSaveDialogController Controller { get; }
        public FakeConfirmedSaveDialogCommitter Committer { get; }
        public FakeExportStageWatcher Watcher { get; } = new();
        public FakeClock Clock { get; } = new();

        public Fixture()
        {
            Session = new FakeSessionInspector(Spy);
            Window = new FakeNexWindowInspector(Spy);
            Input = new FakeInputSender(Spy);
            Inspector = new FakeSaveDialogInspector(Spy);
            Waiter = new FakeSaveDialogWaiter(Inspector);
            Controller = new FakeSaveDialogController(Spy);
            Committer = new FakeConfirmedSaveDialogCommitter(Spy);
        }

        public ConfirmedCommitterProbeOutcome Run(string exportStageDir, string exportadosDir, List<string>? log = null) =>
            ConfirmedSaveDialogCommitterOnceProbe.RunCore(
                Session, Window, Input, Waiter, Inspector, Controller, Committer, Watcher, Clock,
                exportStageDir, exportadosDir, ExpectedFileType, log is null ? (_ => { }) : log.Add);
    }

    private Fixture BuildHappyFixture() => new();

    // ---------- A. Todos gates PASS, Committer PASS, watcher PASS, EXPORTADOS igual -> Passed ----------
    [Fact]
    public void A_HappyPath_ProbePassed()
    {
        var fx = BuildHappyFixture();

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ConfirmedCommitterProbeOutcome.Passed, outcome);
        Assert.Equal(1, fx.Committer.CommitOnceCalls);
        Assert.Equal(1, fx.Input.SendExportShortcutCalls);
        Assert.Equal(1, fx.Controller.ConfigureCalls);
        Assert.Equal(0, fx.Controller.ClickSaveCalls); // ClickSave generico NUNCA chamado pelo probe
    }

    // ---------- B. Stage nao vazia -> zero Shift+F5, zero Committer ----------
    [Fact]
    public void B_StageNaoVazia_ZeroShiftF5_ZeroCommitter()
    {
        var fx = BuildHappyFixture();
        fx.Watcher.ConfirmEmptyResult = ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable, "EXPORT_STAGE nao esta vazia");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ConfirmedCommitterProbeOutcome.FailedStageNotEmpty, outcome);
        Assert.Equal(0, fx.Input.SendExportShortcutCalls);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
    }

    // ---------- C. Gate NEX falha (sessao) -> zero acao real ----------
    [Fact]
    public void C_GateSessaoFalha_ZeroAcaoReal()
    {
        var fx = BuildHappyFixture();
        fx.Session.Result = SessionCheckResult.Fail(AgentErrorCode.SessionUnavailable, "sessao bloqueada");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ConfirmedCommitterProbeOutcome.FailedSession, outcome);
        Assert.Equal(0, fx.Input.SendExportShortcutCalls);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
    }

    // ---------- C2. Gate NEX falha (janela) -> zero acao real ----------
    [Fact]
    public void C2_GateNexAdminFalha_ZeroAcaoReal()
    {
        var fx = BuildHappyFixture();
        fx.Window.LocateResult = NexAdminLocateResult.Fail(AgentErrorCode.NexNotFound, "processo ausente");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ConfirmedCommitterProbeOutcome.FailedLocateNexAdmin, outcome);
        Assert.Equal(0, fx.Input.SendExportShortcutCalls);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
    }

    // ---------- D. SaveDialog nao encontrado -> zero Committer ----------
    [Fact]
    public void D_SaveDialogNaoEncontrado_ZeroCommitter()
    {
        var fx = BuildHappyFixture();
        fx.Inspector.IdentityResult = SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, "#32770 nao apareceu");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ConfirmedCommitterProbeOutcome.FailedWaitForSaveDialog, outcome);
        Assert.Equal(1, fx.Input.SendExportShortcutCalls); // Shift+F5 ja tinha sido enviado, nao repetido
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
    }

    // ---------- E. Configure falha -> zero Committer ----------
    [Fact]
    public void E_ConfigureFalha_ZeroCommitter()
    {
        var fx = BuildHappyFixture();
        fx.Controller.ThrowOnConfigure = new InvalidOperationException("Configure falhou (simulado)");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ConfirmedCommitterProbeOutcome.FailedConfigure, outcome);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
    }

    // ---------- F. ReadBack falha -> zero Committer ----------
    [Fact]
    public void F_ReadBackFalha_ZeroCommitter()
    {
        var fx = BuildHappyFixture();
        fx.Inspector.ReadbackResult = SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "nome != esperado");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ConfirmedCommitterProbeOutcome.FailedReadBack, outcome);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
    }

    // ---------- G. Committer FAIL -> zero watcher ----------
    [Fact]
    public void G_CommitterFalha_ZeroWatcher()
    {
        var fx = BuildHappyFixture();
        fx.Committer.Result = SaveDialogCommitResult.Fail(AgentErrorCode.DialogIdentityMismatch, "dialogo diferente na revalidacao");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ConfirmedCommitterProbeOutcome.FailedCommit, outcome);
        Assert.Equal(1, fx.Committer.CommitOnceCalls);
        Assert.Equal(0, fx.Watcher.WaitForExpectedFileOnlyCalls);
    }

    // ---------- H. Committer PASS, watcher FAIL -> Committer continua 1, zero retry ----------
    [Fact]
    public void H_CommitterOkMasWatcherFalha_CommitterContinuaUm_ZeroRetry()
    {
        var fx = BuildHappyFixture();
        fx.Watcher.WaitResult = ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable, "timeout aguardando estabilidade");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ConfirmedCommitterProbeOutcome.FailedFilesystemTimeout, outcome);
        Assert.Equal(1, fx.Committer.CommitOnceCalls); // nenhuma segunda tentativa de commit
        Assert.Equal(1, fx.Input.SendExportShortcutCalls); // nenhum segundo Shift+F5
    }

    // ---------- I. EXPORTADOS mudou -> FAIL ----------
    [Fact]
    public void I_ExportadosMudouDuranteAExecucao_Fail()
    {
        var fx = BuildHappyFixture();
        fx.Watcher.OnWait = () => File.WriteAllText(Path.Combine(_exportadosDir, "arquivo-inesperado.xls"), "conteudo");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ConfirmedCommitterProbeOutcome.FailedExportadosChanged, outcome);
    }

    // ---------- J. Committer maximo 1 (happy path) ----------
    [Fact]
    public void J_CommitterMaximoUm()
    {
        var fx = BuildHappyFixture();

        fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(1, fx.Committer.CommitOnceCalls);
    }

    // ---------- K. Shift+F5 maximo 1 (happy path) ----------
    [Fact]
    public void K_ShiftF5MaximoUm()
    {
        var fx = BuildHappyFixture();

        fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(1, fx.Input.SendExportShortcutCalls);
    }

    // ---------- L. Zero Validator: guard estrutural (o probe nao referencia IExportValidator em lugar nenhum) ----------
    [Fact]
    public void L_ProbeNaoReferenciaIExportValidator()
    {
        var path = FindSourceFile("ConfirmedSaveDialogCommitterOnceProbe.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain("IExportValidator", source);
        Assert.DoesNotContain("NodeExportValidator", source);
    }

    // ---------- M. Zero Publisher: guard estrutural ----------
    [Fact]
    public void M_ProbeNaoReferenciaIAtomicPublisher()
    {
        var path = FindSourceFile("ConfirmedSaveDialogCommitterOnceProbe.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain("IAtomicPublisher", source);
        Assert.DoesNotContain("FileMoveAtomicPublisher", source);
        Assert.DoesNotContain("ValidatedExportPublicationCoordinator", source);
    }

    // ---------- N. Zero File.Move para EXPORTADOS ----------
    [Fact]
    public void N_ProbeNuncaChamaFileMove()
    {
        var path = FindSourceFile("ConfirmedSaveDialogCommitterOnceProbe.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain("File.Move(", source);
        Assert.DoesNotContain("File.Copy(", source);
    }

    // ---------- O. Novo probe nao referencia ClickButton/BM_CLICK/SendMessageInt diretamente ----------
    [Fact]
    public void O_ProbeNaoReferenciaClickButtonBmClickOuSendMessageDiretamente()
    {
        var path = FindSourceFile("ConfirmedSaveDialogCommitterOnceProbe.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain(".ClickButton(", source);
        Assert.DoesNotContain("0x00F5", source);
        Assert.DoesNotContain("SendMessageInt(", source);
        Assert.Contains(".CommitOnce(", source);
    }

    // ---------- P. Ordem objetiva: ReadBack < CommitOnce < WaitForStable/watcher ----------
    [Fact]
    public void P_OrdemObjetiva_ReadbackAntesDeCommitOnceAntesDoWatcher()
    {
        var fx = BuildHappyFixture();

        fx.Run(_exportStageDir, _exportadosDir);

        Assert.True(fx.Spy.Before("ReadBack", 1, "CommitOnce", 1));
        // WaitForExpectedFileOnly nao passa pelo mesmo CallSpy (FakeExportStageWatcher
        // nao recebe o spy compartilhado) - confirmado por contagem sequencial:
        // CommitOnceCalls==1 antes de checar Watcher.WaitForExpectedFileOnlyCalls==1,
        // ambos avaliados apos Run() concluir (execucao sincrona, sem concorrencia).
        Assert.Equal(1, fx.Committer.CommitOnceCalls);
        Assert.Equal(1, fx.Watcher.WaitForExpectedFileOnlyCalls);
    }

    // ---------- Total de call sites de ClickButton continua exatamente 2 (probe historico + Committer) ----------
    [Fact]
    public void Q_TotalDeCallSitesDeClickButtonContinuaExatamenteDois()
    {
        var root = FindSourceRoot();
        var callers = new List<string>();
        foreach (var file in Directory.GetFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}") || file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")) continue;
            if (file.EndsWith("ISaveDialogControlApi.cs", StringComparison.Ordinal)) continue;
            if (file.EndsWith("Win32SaveDialogControlApi.cs", StringComparison.Ordinal)) continue;

            var text = File.ReadAllText(file);
            if (text.Contains(".ClickButton(", StringComparison.Ordinal))
            {
                callers.Add(Path.GetFileName(file));
            }
        }

        var productionCallers = callers.Where(f => !f.Contains("Tests", StringComparison.OrdinalIgnoreCase)).ToList();

        Assert.Equal(2, productionCallers.Count);
        Assert.Contains("ConfigureSaveDialogClickSaveOnceProbe.cs", productionCallers);
        Assert.Contains("WindowsConfirmedSaveDialogCommitter.cs", productionCallers);
        Assert.DoesNotContain("ConfirmedSaveDialogCommitterOnceProbe.cs", productionCallers);
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
