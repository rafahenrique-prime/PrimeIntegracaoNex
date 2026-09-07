using System.IO;
using System.Linq;
using PrimeNexExportAgent.Diagnostics;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using PrimeNexExportAgent.WindowsSaveDialog;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14B2.9C) da ORQUESTRACAO do probe de ClickSave real -
/// exercitam ConfigureSaveDialogClickSaveOnceProbe.RunCore(...) diretamente,
/// com TODAS as dependencias injetadas como fakes (nenhum Win32/NEX real
/// tocado). Fecha a lacuna identificada no BEFORE F6.14B2.9B: ate aqui, só
/// os COMPONENTES reaproveitados (inspetores/waiters/watcher/ClickButton)
/// tinham cobertura direta - a sequencia de decisao ESPECIFICA deste probe
/// (gate EXPORT_STAGE antes do Shift+F5, validacao de path-escape,
/// comparacao de HWND na revalidacao, comparacao de snapshot de
/// EXPORTADOS) nao tinha nenhum teste de orquestracao fim-a-fim.
///
/// EXPORTADOS/EXPORT_STAGE nunca sao os caminhos operacionais reais aqui -
/// sempre pastas temporarias isoladas (Path.GetTempPath()), nunca
/// C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE\EXPORTADOS.
/// </summary>
public sealed class ConfigureSaveDialogClickSaveOnceProbeTests : IDisposable
{
    private const int NexAdminPid = 1316;
    private static readonly nint DialogHwnd = FakeSaveDialogInspector.DefaultDialog.DialogHandle; // 0x7000
    private static readonly nint SaveButtonHwnd = 0x9001;
    private const string ExpectedFileType = "Excel";

    private readonly string _exportStageDir;
    private readonly string _exportadosDir;

    public ConfigureSaveDialogClickSaveOnceProbeTests()
    {
        var root = Path.Combine(Path.GetTempPath(), "PrimeNexExportAgentTests_ClickSaveProbe_" + Guid.NewGuid());
        _exportStageDir = Path.Combine(root, "EXPORT_STAGE");
        _exportadosDir = Path.Combine(root, "EXPORTADOS");
        Directory.CreateDirectory(_exportStageDir);
        Directory.CreateDirectory(_exportadosDir);
    }

    public void Dispose()
    {
        try { Directory.Delete(Path.GetDirectoryName(_exportStageDir)!, recursive: true); } catch { /* best-effort cleanup de teste */ }
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
        public FakeSaveDialogControlApi ControlApi { get; } = new();
        public FakeNativeWindowApi Native { get; } = new();
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

            // CtrlId 1 (Salvar) do dialogo padrao (DialogHwnd) - presente,
            // valido e Enabled por padrao (happy path). Testes de N/O
            // removem/desabilitam isso especificamente.
            ControlApi.ControlsByDialogAndId[(DialogHwnd, WindowsSaveDialogInspector.CtrlIdSave)] = SaveButtonHwnd;
            ControlApi.EnabledControls.Add(SaveButtonHwnd);
            Native.ValidWindows.Add(SaveButtonHwnd);
        }

        public ClickSaveProbeOutcome Run(string exportStageDir, string exportadosDir, List<string>? log = null) =>
            ConfigureSaveDialogClickSaveOnceProbe.RunCore(
                Session, Window, Input, Waiter, Inspector, Controller, ControlApi, Native, Watcher, Clock,
                exportStageDir, exportadosDir, ExpectedFileType, log is null ? (_ => { }) : log.Add);
    }

    private Fixture BuildHappyFixture()
    {
        var fx = new Fixture();
        // Todos os gates default (Session/Window/Waiter/Inspector/Controller)
        // ja vem "Pass" por padrao nos fakes reutilizados do restante da
        // suite (F6.13+).
        return fx;
    }

    // ==================================================================
    // D. Happy path
    // ==================================================================

    [Fact]
    public void D_HappyPath_ClickButtonExatamenteUmaVez()
    {
        var fx = BuildHappyFixture();

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.Passed, outcome);
        Assert.Equal(1, fx.ControlApi.ClickButtonCalls);
        Assert.Equal(1, fx.Input.SendExportShortcutCalls);
        Assert.Equal(1, fx.Controller.ConfigureCalls);
        Assert.Equal(0, fx.Controller.ClickSaveCalls); // ClickSave generico NUNCA chamado pelo probe
    }

    // ==================================================================
    // A/E-H: cada gate anterior falhando -> ClickButton = 0
    // ==================================================================

    [Fact]
    public void A_ClickSaveGenerico_NuncaChamadoPeloProbe_MesmoNoHappyPath()
    {
        var fx = BuildHappyFixture();

        fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(0, fx.Controller.ClickSaveCalls);
    }

    [Fact]
    public void E_GateAnteriorFalha_SessaoIndisponivel_ClickButtonZero()
    {
        var fx = new Fixture();
        fx.Session.Result = SessionCheckResult.Fail(AgentErrorCode.SessionUnavailable, "sessao bloqueada (teste)");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedSession, outcome);
        Assert.Equal(0, fx.ControlApi.ClickButtonCalls);
        Assert.Equal(0, fx.Input.SendExportShortcutCalls);
    }

    [Fact]
    public void F_ReadBackFalha_ClickButtonZero()
    {
        var fx = new Fixture();
        fx.Inspector.ReadbackResult = SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "simulado (teste)");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedReadBack, outcome);
        Assert.Equal(0, fx.ControlApi.ClickButtonCalls);
    }

    [Fact]
    public void G_FilenameDivergenteNoReadBack_ClickButtonZero()
    {
        // No nivel da orquestracao, "filename divergente" e reportado pelo
        // ReadBack (ja exaustivamente testado em WindowsSaveDialogTests.cs) -
        // aqui provamos que o PROBE respeita esse resultado negativo.
        var fx = new Fixture();
        fx.Inspector.ReadbackResult = SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "Edit 1148 diverge (teste)");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedReadBack, outcome);
        Assert.Equal(0, fx.ControlApi.ClickButtonCalls);
    }

    [Fact]
    public void H_TipoDiferenteDeExcelNoReadBack_ClickButtonZero()
    {
        var fx = new Fixture();
        fx.Inspector.ReadbackResult = SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "tipo divergente (teste)");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedReadBack, outcome);
        Assert.Equal(0, fx.ControlApi.ClickButtonCalls);
    }

    // ==================================================================
    // I: EXPORT_STAGE nao vazia - gate ANTES ate do Shift+F5
    // ==================================================================

    [Fact]
    public void I_ExportStageNaoVazia_ShiftF5EClickButtonZero()
    {
        var fx = new Fixture();
        fx.Watcher.ConfirmEmptyResult = ExportStageWatchResult.Fail(AgentErrorCode.UnsafeState, "EXPORT_STAGE nao vazia (teste)");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedStageNotEmpty, outcome);
        Assert.Equal(0, fx.Input.SendExportShortcutCalls); // preserva: gate ocorre ANTES do Shift+F5
        Assert.Equal(0, fx.ControlApi.ClickButtonCalls);
    }

    // ==================================================================
    // J/K/M: revalidacao final falha (dialogo sumiu / PID divergiu /
    // segundo dialogo surgiu) - todos convergem para o mesmo branch em
    // RunCore (IdentifySaveDialog reexecutado retorna Fail), ja que RunCore
    // so consulta Passed - a CAUSA de cada cenario real (PID/ambiguidade/
    // ausencia) ja e' coberta exaustivamente em WindowsSaveDialogTests.cs
    // no nivel do Inspector real. Aqui provamos que o PROBE respeita esse
    // resultado negativo em qualquer um dos 3 casos.
    // ==================================================================

    [Fact]
    public void J_DialogoSumiuNaRevalidacaoFinal_ClickButtonZero()
    {
        var fx = new Fixture();
        fx.Inspector.IdentityResultSequence.Enqueue(SaveDialogIdentityResult.Pass(FakeSaveDialogInspector.DefaultDialog)); // 1a chamada (WaitForSaveDialog)
        fx.Inspector.IdentityResultSequence.Enqueue(SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, "dialogo sumiu (teste)")); // revalidacao

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedDialogRevalidation, outcome);
        Assert.Equal(0, fx.ControlApi.ClickButtonCalls);
    }

    [Fact]
    public void K_PidDivergiuNaRevalidacaoFinal_ClickButtonZero()
    {
        var fx = new Fixture();
        fx.Inspector.IdentityResultSequence.Enqueue(SaveDialogIdentityResult.Pass(FakeSaveDialogInspector.DefaultDialog));
        fx.Inspector.IdentityResultSequence.Enqueue(SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, "dialogo encontrado nao pertence ao PID esperado (teste)"));

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedDialogRevalidation, outcome);
        Assert.Equal(0, fx.ControlApi.ClickButtonCalls);
    }

    [Fact]
    public void M_SegundoDialogoValidoSurgiuNaRevalidacaoFinal_ClickButtonZero()
    {
        var fx = new Fixture();
        fx.Inspector.IdentityResultSequence.Enqueue(SaveDialogIdentityResult.Pass(FakeSaveDialogInspector.DefaultDialog));
        fx.Inspector.IdentityResultSequence.Enqueue(SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, "mais de 1 dialogo (teste)"));

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedDialogRevalidation, outcome);
        Assert.Equal(0, fx.ControlApi.ClickButtonCalls);
    }

    // ==================================================================
    // L: HWND divergiu - UNICA checagem nova, exclusiva deste probe (nao
    // coberta em nenhum outro lugar) - revalidacao retorna Passed=true mas
    // com um dialogo DIFERENTE do originalmente identificado.
    // ==================================================================

    [Fact]
    public void L_HwndDoDialogoDivergiuNaRevalidacaoFinal_ClickButtonZero()
    {
        var fx = new Fixture();
        var outroDialogo = new SaveDialogIdentity(0x8000);
        fx.Inspector.IdentityResultSequence.Enqueue(SaveDialogIdentityResult.Pass(FakeSaveDialogInspector.DefaultDialog)); // original
        fx.Inspector.IdentityResultSequence.Enqueue(SaveDialogIdentityResult.Pass(outroDialogo)); // revalidacao: PASS, mas HWND diferente

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedDialogHandleMismatch, outcome);
        Assert.Equal(0, fx.ControlApi.ClickButtonCalls);
    }

    // ==================================================================
    // N/O: CtrlId 1 ausente/disabled na checagem FINAL explicita (camada
    // extra de defesa alem do que IdentifySaveDialog ja verifica em G9) -
    // simulado configurando o fake da inspecao para dizer "esta tudo bem"
    // (Passed=true) enquanto o controlApi/native fake nao tem o botao
    // registrado/habilitado - exercita exatamente a checagem redundante
    // adicionada em RunCore, independente do que o inspector "diz".
    // ==================================================================

    [Fact]
    public void N_CtrlId1AusenteNaChecagemFinal_ClickButtonZero()
    {
        var fx = new Fixture();
        fx.ControlApi.ControlsByDialogAndId.Remove((DialogHwnd, WindowsSaveDialogInspector.CtrlIdSave));

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedSaveButtonMissing, outcome);
        Assert.Equal(0, fx.ControlApi.ClickButtonCalls);
    }

    [Fact]
    public void O_CtrlId1DisabledNaChecagemFinal_ClickButtonZero()
    {
        var fx = new Fixture();
        fx.ControlApi.EnabledControls.Remove(SaveButtonHwnd);

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedSaveButtonMissing, outcome);
        Assert.Equal(0, fx.ControlApi.ClickButtonCalls);
    }

    // ==================================================================
    // V: EXPECTED_FULL_PATH fora de EXPORT_STAGE - validacao canonical.
    // IsExpectedPathWithinStage foi extraida (F6.14B2.9C) exatamente para
    // permitir testa-la com entradas adversariais isoladamente, mesmo que
    // FileNaming hoje nunca produza um nome capaz de escapar.
    // ==================================================================

    [Fact]
    public void V_ValidacaoCanonical_DetectaTentativaDeEscapeViaTraversal()
    {
        var isWithin = InvokeIsExpectedPathWithinStage(
            @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE\..\EXPORTADOS\malicioso.xls",
            @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE");

        Assert.False(isWithin);
    }

    [Fact]
    public void V_ValidacaoCanonical_DetectaCaminhoAbsolutoAlheio()
    {
        var isWithin = InvokeIsExpectedPathWithinStage(
            @"C:\Windows\System32\arquivo.xls",
            @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE");

        Assert.False(isWithin);
    }

    [Fact]
    public void V_ValidacaoCanonical_AceitaCaminhoLegitimoDentroDoStage()
    {
        var isWithin = InvokeIsExpectedPathWithinStage(
            @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE\vendas-auto-clicksave-test-20260902-010203.xls",
            @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE");

        Assert.True(isWithin);
    }

    [Fact]
    public void V_NomeGeradoPorFileNamingNuncaContemSeparadorOuTraversal()
    {
        // Evidencia estrutural complementar: o unico gerador de nome usado
        // pelo probe (FileNaming.GerarNomeArquivoVendas) produz apenas
        // digitos/hifen/prefixo fixo - nunca pode conter ".." nem
        // separador de caminho, tornando o path-escape estruturalmente
        // impossivel a partir do nome do arquivo em si (defesa em
        // profundidade complementar a IsExpectedPathWithinStage).
        var clock = new FakeClock();
        var nome = PrimeNexExportAgent.Domain.FileNaming.GerarNomeArquivoVendas(clock);

        Assert.DoesNotContain("..", nome);
        Assert.DoesNotContain(Path.DirectorySeparatorChar.ToString(), nome);
        Assert.DoesNotContain(Path.AltDirectorySeparatorChar.ToString(), nome);
    }

    private static bool InvokeIsExpectedPathWithinStage(string expectedFullPath, string exportStagePath) =>
        ConfigureSaveDialogClickSaveOnceProbe.IsExpectedPathWithinStage(expectedFullPath, exportStagePath);

    // ==================================================================
    // W: EXPORTADOS snapshot alterado durante a execucao -> FAIL, mas
    // ClickButton continua exatamente 1 (o clique ja tinha acontecido
    // antes da divergencia ser detectada - nenhuma segunda acao ocorre).
    // ==================================================================

    [Fact]
    public void W_ExportadosSnapshotAlterado_ResultadoFinalFalha_ClickButtonContinuaUm()
    {
        var fx = new Fixture();
        File.WriteAllBytes(Path.Combine(_exportadosDir, "arquivo-original.xls"), new byte[10]);
        fx.Watcher.OnWait = () =>
        {
            // Simula um agente EXTERNO alterando EXPORTADOS exatamente
            // durante a janela de espera do watcher (nunca o proprio
            // codigo do probe, que nunca escreve la).
            File.WriteAllBytes(Path.Combine(_exportadosDir, "arquivo-novo-inesperado.xls"), new byte[5]);
        };

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedExportadosChanged, outcome);
        Assert.Equal(1, fx.ControlApi.ClickButtonCalls); // ja tinha ocorrido - nunca uma segunda tentativa
    }

    // ==================================================================
    // AG: ClickButton nunca > 1, em nenhum cenario de falha pos-clique
    // ==================================================================

    [Fact]
    public void AG_WatcherTimeout_ClickButtonContinuaUm_NuncaDois()
    {
        var fx = new Fixture();
        fx.Watcher.WaitResult = ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable, "timeout (teste)");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedFilesystemTimeout, outcome);
        Assert.Equal(1, fx.ControlApi.ClickButtonCalls);
    }

    [Fact]
    public void AG_WatcherNomeInesperado_ClickButtonContinuaUm_NuncaDois()
    {
        var fx = new Fixture();
        fx.Watcher.WaitResult = ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable, "arquivo inesperado (teste)");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedFilesystemTimeout, outcome);
        Assert.Equal(1, fx.ControlApi.ClickButtonCalls);
    }

    [Fact]
    public void AG_WatcherMultiplosArquivos_ClickButtonContinuaUm_NuncaDois()
    {
        var fx = new Fixture();
        fx.Watcher.WaitResult = ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable, "mais de 1 arquivo (teste)");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedFilesystemTimeout, outcome);
        Assert.Equal(1, fx.ControlApi.ClickButtonCalls);
    }

    [Fact]
    public void AG_ExportadosMudou_ClickButtonContinuaUm_NuncaDois()
    {
        var fx = new Fixture();
        fx.Watcher.OnWait = () => File.WriteAllBytes(Path.Combine(_exportadosDir, "surpresa.xls"), new byte[1]);

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedExportadosChanged, outcome);
        Assert.Equal(1, fx.ControlApi.ClickButtonCalls);
    }

    // ==================================================================
    // F6.14B2.9F secao 8 - orquestracao com watcher tolerando o transitorio
    // "<basename>.csv" (a logica real de tolerancia ja e' exaustivamente
    // testada em PollingExportStageWatcher/ExportStageWatcherTests.cs; aqui
    // provamos apenas que RunCore reage corretamente ao resultado agregado
    // do watcher, seja Pass (transitorio resolvido) ou Fail).
    // ==================================================================

    [Fact]
    public void CsvTransitorioResolvidoParaXlsEstavel_PassComShiftF5EClickButtonExatamenteUm()
    {
        var fx = new Fixture();
        // Simula o watcher real ja ter observado csv->xls e concluido PASS
        // (comportamento agora tolerado por PollingExportStageWatcher).
        fx.Watcher.WaitResult = ExportStageWatchResult.Pass();

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.Passed, outcome);
        Assert.Equal(1, fx.Input.SendExportShortcutCalls);
        Assert.Equal(1, fx.ControlApi.ClickButtonCalls);
    }

    [Fact]
    public void CsvTransitorioNuncaResolvido_WatcherFail_ClickButtonContinuaUm_SemNovaAcao()
    {
        var fx = new Fixture();
        fx.Watcher.WaitResult = ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable, "apenas o transitorio persistiu ate o timeout (teste)");

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedFilesystemTimeout, outcome);
        Assert.Equal(1, fx.ControlApi.ClickButtonCalls); // ja tinha ocorrido - nunca uma segunda tentativa
        Assert.Equal(1, fx.Input.SendExportShortcutCalls);
    }

    [Fact]
    public void SnapshotExportadosMudaAposWatcherResolverTransitorio_ResultadoFinalFalha_ClickButtonContinuaUm()
    {
        var fx = new Fixture();
        fx.Watcher.WaitResult = ExportStageWatchResult.Pass(); // watcher resolveu o transitorio e considerou o XLS estavel
        File.WriteAllBytes(Path.Combine(_exportadosDir, "original.xls"), new byte[10]);
        fx.Watcher.OnWait = () => File.WriteAllBytes(Path.Combine(_exportadosDir, "surpresa-durante-transitorio.xls"), new byte[1]);

        var outcome = fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(ClickSaveProbeOutcome.FailedExportadosChanged, outcome);
        Assert.Equal(1, fx.ControlApi.ClickButtonCalls);
    }

    // ==================================================================
    // Zero retry no core (secao 7 da ordem)
    // ==================================================================

    [Fact]
    public void ZeroRetry_FalhaAposShiftF5_NuncaEnviaSegundoShiftF5()
    {
        var fx = new Fixture();
        fx.Inspector.IdentityResult = SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, "timeout (teste)");

        fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(1, fx.Input.SendExportShortcutCalls);
    }

    [Fact]
    public void ZeroRetry_FalhaAposClickButton_NuncaEnviaSegundoClickButton()
    {
        var fx = new Fixture();
        fx.Watcher.WaitResult = ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable, "timeout (teste)");

        fx.Run(_exportStageDir, _exportadosDir);

        Assert.Equal(1, fx.ControlApi.ClickButtonCalls);
    }

    // ==================================================================
    // B: B2.8 (readback probe) nunca referencia ClickButton/ClickSave -
    // guard estrutural por fonte (mesmo espirito de outras auditorias
    // estruturais do projeto).
    // ==================================================================

    [Fact]
    public void B_ReadbackProbeFonte_NuncaReferenciaClickButtonOuClickSave()
    {
        // Verifica CALL SITES reais (".ClickButton("/".ClickSave("), nunca
        // a palavra solta - o cabecalho deste arquivo legitimamente
        // MENCIONA "ClickSave"/"CancelSaveDialog" em prosa, explicando que
        // NUNCA os chama.
        var path = FindSourceFile("ConfigureSaveDialogReadbackOnceProbe.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain(".ClickButton(", source);
        Assert.DoesNotContain(".ClickSave(", source);
    }

    // ==================================================================
    // C: unico call site RUNTIME de ClickButton e' o novo probe (exclui
    // declaracao de interface, implementacao do wrapper, e fakes de
    // teste).
    // ==================================================================

    [Fact]
    public void C_UnicoCallSiteRuntimeDeClickButton_EhONovoProbe()
    {
        var srcRoot = FindSourceRoot();
        var callers = new List<string>();
        foreach (var file in Directory.GetFiles(srcRoot, "*.cs", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}") ||
                file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
            {
                continue;
            }
            // Exclui a propria declaracao de interface e a implementacao
            // do wrapper (nao sao "call sites", sao a definicao do
            // primitivo em si).
            if (file.EndsWith("ISaveDialogControlApi.cs", StringComparison.Ordinal)) continue;
            if (file.EndsWith("Win32SaveDialogControlApi.cs", StringComparison.Ordinal)) continue;

            var text = File.ReadAllText(file);
            if (text.Contains(".ClickButton(", StringComparison.Ordinal))
            {
                callers.Add(Path.GetFileName(file));
            }
        }

        // Excluir arquivos de teste do proprio projeto de testes (fakes e
        // os testes desta suite chamam controls.ClickButton(...) tambem,
        // legitimamente, para testar o fake em isolamento) - o requisito e'
        // sobre o codigo de PRODUCAO (WINDOWS/PrimeNexExportAgent, nao
        // WINDOWS/PrimeNexExportAgent.Tests).
        //
        // F6.14B2.12C1: um SEGUNDO call site de producao foi introduzido
        // deliberadamente - WindowsConfirmedSaveDialogCommitter.cs, o
        // Committer operacional estreito que reidentifica o dialogo e
        // exige o mesmo HWND antes de despachar BM_CLICK (nunca desbloqueia
        // ISaveDialogController.ClickSave() generico). Isso e' uma mudanca
        // arquitetural intencional e explicitamente autorizada, nao uma
        // regressao - por isso o teste agora afirma exatamente os DOIS
        // call sites conhecidos e legitimos, nunca um terceiro nao previsto.
        var productionCallers = callers.Where(f => !f.Contains("Tests", StringComparison.OrdinalIgnoreCase)).ToList();

        Assert.Equal(2, productionCallers.Count);
        Assert.Contains("ConfigureSaveDialogClickSaveOnceProbe.cs", productionCallers);
        Assert.Contains("WindowsConfirmedSaveDialogCommitter.cs", productionCallers);
    }

    // ==================================================================
    // X: zero escrita em EXPORTADOS pelo codigo novo (guard por fonte)
    // ==================================================================

    [Fact]
    public void X_CodigoNovoNuncaEscreveEmExportados_GuardPorFonte()
    {
        var probeSource = File.ReadAllText(FindSourceFile("ConfigureSaveDialogClickSaveOnceProbe.cs"));
        var watcherSource = File.ReadAllText(FindSourceFile("PollingExportStageWatcher.cs"));

        foreach (var source in new[] { probeSource, watcherSource })
        {
            Assert.DoesNotContain("File.Move", source);
            Assert.DoesNotContain("File.Copy", source);
            Assert.DoesNotContain("IAtomicPublisher", source);
        }
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

    /// <summary>Sobe a partir do diretorio de execucao dos testes ate achar
    /// a pasta WINDOWS (raiz das duas solucoes .csproj) - evita caminho
    /// absoluto hardcoded fora do repositorio.</summary>
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
