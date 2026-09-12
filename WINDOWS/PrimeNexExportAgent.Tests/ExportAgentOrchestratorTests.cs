using PrimeNexExportAgent.Domain;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Matriz de testes offline do PRIME NEX EXPORT AGENT (F6.13 secao 13-14).
/// ZERO Win32 real, ZERO UI Automation real, ZERO SendInput real - tudo
/// via fakes/spies definidos em Fakes/. Cada teste prova, no minimo,
/// contagem exata de chamadas as duas unicas interfaces de ACAO
/// (IInputSender/ISaveDialogController), nunca so o valor de retorno.
/// </summary>
public sealed class ExportAgentOrchestratorTests
{
    // ---------- A. Happy path completo mockado ----------
    [Fact]
    public void A_HappyPath_AtingeSuccessComExatamenteUmaChamadaDeCadaAcao()
    {
        var fx = new OrchestratorFixture();
        var result = fx.BuildOrchestrator().Run();

        Assert.True(result.Success);
        Assert.Equal(AgentStage.Success, result.FinalStage);
        Assert.Equal(AgentErrorCode.None, result.ErrorCode);
        Assert.Equal(1, fx.InputSender.SendExportShortcutCalls);
        Assert.Equal(1, fx.Committer.CommitOnceCalls);
        Assert.Equal(1, fx.SaveDialogController.ConfigureCalls);
        Assert.Equal(1, fx.Lock.TryAcquireCalls);
        Assert.Equal(1, fx.Lock.ReleaseCalls);
        Assert.NotNull(result.PublishedFilePath);
    }

    // ---------- B. Lock ocupado ----------
    [Fact]
    public void B_LockOcupado_RetornaSkippedBusySemNenhumaAcaoDeUI()
    {
        var fx = new OrchestratorFixture();
        fx.Lock.AcquireSucceeds = false;

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(AgentStage.SkippedBusy, result.FinalStage);
        Assert.Equal(AgentErrorCode.LockBusy, result.ErrorCode);
        Assert.Equal(0, fx.InputSender.SendExportShortcutCalls);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
        // Lock nao foi de fato adquirido - Release() nao deveria ser chamado
        // (nada a liberar).
        Assert.Equal(0, fx.Lock.ReleaseCalls);
    }

    // ---------- C. Sessao indisponivel ----------
    [Fact]
    public void C_SessaoIndisponivel_ZeroShiftF5()
    {
        var fx = new OrchestratorFixture();
        fx.SessionInspector.Result = SessionCheckResult.Fail(AgentErrorCode.SessionUnavailable, "sessao bloqueada");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(AgentStage.SkippedSessionUnavailable, result.FinalStage);
        Assert.Equal(0, fx.InputSender.SendExportShortcutCalls);
        Assert.Equal(1, fx.Lock.ReleaseCalls); // lock foi adquirido, deve ser liberado mesmo em falha
    }

    // ---------- D. NexAdmin invalido ----------
    [Fact]
    public void D_NexAdminInvalido_ZeroShiftF5()
    {
        var fx = new OrchestratorFixture();
        // F6.13.2: identidade do NexAdmin agora e responsabilidade de
        // INexWindowInspector.LocateNexAdmin(), nao mais de ISessionInspector.
        fx.NexWindowInspector.LocateResult = NexAdminLocateResult.Fail(AgentErrorCode.NexNotFound, "processo nao encontrado");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(AgentStage.NexNotFound, result.FinalStage);
        Assert.Equal(0, fx.InputSender.SendExportShortcutCalls);
        // CheckSafeState nunca deveria ser chamado sem o NexAdmin localizado
        Assert.Null(fx.NexWindowInspector.LastTargetReceived);
        // LocateNexAdmin DEVE ter recebido o SessionId do proprio Agent
        Assert.NotNull(fx.NexWindowInspector.LastExpectedSessionIdReceived);
    }

    // ---------- D2. NexAdmin encontrado mas em sessao diferente ----------
    [Fact]
    public void D2_NexAdminEmSessaoDiferente_ZeroShiftF5()
    {
        var fx = new OrchestratorFixture();
        fx.NexWindowInspector.LocateResult = NexAdminLocateResult.Fail(AgentErrorCode.SessionUnavailable, "NexAdmin esta na Session 0, Agent esta na Session 1");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(AgentStage.SkippedSessionUnavailable, result.FinalStage);
        Assert.Equal(0, fx.InputSender.SendExportShortcutCalls);
    }

    // ---------- E. Multiplas janelas/modal ----------
    [Fact]
    public void E_ModalFinanceiroPresente_ZeroShiftF5()
    {
        var fx = new OrchestratorFixture();
        fx.NexWindowInspector.SafeStateResult = NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, "mais de 1 janela top-level");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(AgentStage.UnsafeState, result.FinalStage);
        Assert.Equal(0, fx.InputSender.SendExportShortcutCalls);
    }

    // ---------- F. Historico ausente/offscreen ----------
    [Fact]
    public void F_HistoricoAusenteOuOffscreen_ZeroShiftF5()
    {
        var fx = new OrchestratorFixture();
        fx.NexWindowInspector.SafeStateResult = NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, "Historico offscreen");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(0, fx.InputSender.SendExportShortcutCalls);
    }

    // ---------- G. Todos G1-G7 PASS -> 1 Shift+F5 ----------
    [Fact]
    public void G_TodosGatesPreTriggerPassam_ExatamenteUmShiftF5()
    {
        var fx = new OrchestratorFixture();

        fx.BuildOrchestrator().Run();

        Assert.Equal(1, fx.InputSender.SendExportShortcutCalls);
    }

    // ==================================================================
    // F6.13.4 - identidade explicita da janela flui Locate -> SafeState ->
    // InputSender, nunca recalculada no meio do caminho.
    // ==================================================================

    // ---------- G2. LocateNexAdmin -> CheckSafeState recebe o MESMO target ----------
    [Fact]
    public void G2_IdentidadeDeLocateNexAdmin_ChegaIntactaACheckSafeState()
    {
        var fx = new OrchestratorFixture();
        var identidadeEsperada = new NexAdminWindowIdentity(processId: 123, mainWindowHandle: 0xABC);
        fx.NexWindowInspector.LocateResult = NexAdminLocateResult.Pass(identidadeEsperada);

        fx.BuildOrchestrator().Run();

        Assert.Equal(identidadeEsperada, fx.NexWindowInspector.LastTargetReceived);
        Assert.Equal(123, fx.NexWindowInspector.LastTargetReceived!.ProcessId);
        Assert.Equal(0xABC, fx.NexWindowInspector.LastTargetReceived!.MainWindowHandle);
    }

    // ---------- G3. O MESMO identity chega a SendExportShortcut ----------
    [Fact]
    public void G3_MesmaIdentidadeValidada_ChegaASendExportShortcut()
    {
        var fx = new OrchestratorFixture();
        var identidadeEsperada = new NexAdminWindowIdentity(processId: 777, mainWindowHandle: 0xDEAD);
        fx.NexWindowInspector.LocateResult = NexAdminLocateResult.Pass(identidadeEsperada);

        fx.BuildOrchestrator().Run();

        Assert.Equal(identidadeEsperada, fx.InputSender.LastTargetReceived);
        // Prova que e a MESMA identidade que chegou a CheckSafeState, nunca
        // uma recalculada de forma independente no meio do fluxo.
        Assert.Equal(fx.NexWindowInspector.LastTargetReceived, fx.InputSender.LastTargetReceived);
    }

    // ---------- G4. CheckSafeState falha -> zero SendExportShortcut ----------
    [Fact]
    public void G4_CheckSafeStateFalha_ZeroSendExportShortcut()
    {
        var fx = new OrchestratorFixture();
        fx.NexWindowInspector.SafeStateResult = NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, "modal presente");

        fx.BuildOrchestrator().Run();

        Assert.Equal(0, fx.InputSender.SendExportShortcutCalls);
        Assert.Null(fx.InputSender.LastTargetReceived);
    }

    // ---------- G5. LocateNexAdmin falha (nenhum target valido) -> zero SendExportShortcut ----------
    [Fact]
    public void G5_LocateNexAdminFalha_NenhumTargetValido_ZeroSendExportShortcut()
    {
        var fx = new OrchestratorFixture();
        fx.NexWindowInspector.LocateResult = NexAdminLocateResult.Fail(AgentErrorCode.NexNotFound, "processo ausente");

        fx.BuildOrchestrator().Run();

        Assert.Equal(0, fx.InputSender.SendExportShortcutCalls);
        Assert.Null(fx.InputSender.LastTargetReceived);
        // CheckSafeState nem deveria ser chamado sem identidade valida.
        Assert.Null(fx.NexWindowInspector.LastTargetReceived);
    }

    // ---------- H. G8 falha (dialogo nao encontrado) ----------
    [Fact]
    public void H_DialogoNaoEncontrado_UmShiftF5TotalEZeroClickSave()
    {
        var fx = new OrchestratorFixture();
        fx.SaveDialogInspector.IdentityResult = SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, "#32770 nao apareceu");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(1, fx.InputSender.SendExportShortcutCalls);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
    }

    // ---------- I. G9 falha (controles ausentes/identidade errada) ----------
    [Fact]
    public void I_IdentidadeOuControlesInvalidos_UmShiftF5TotalEZeroClickSave()
    {
        var fx = new OrchestratorFixture();
        fx.SaveDialogInspector.IdentityResult = SaveDialogIdentityResult.Fail(AgentErrorCode.ControlMissing, "CtrlId 1148 ausente");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(1, fx.InputSender.SendExportShortcutCalls);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
    }

    // ---------- J/K/L. G10/G11/G12 falham individualmente ----------
    [Fact]
    public void J_ReadbackDestinoDivergente_ZeroClickSave()
    {
        var fx = new OrchestratorFixture();
        fx.SaveDialogInspector.ReadbackResult = SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "destino != EXPORT_STAGE");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
        Assert.Equal(1, fx.SaveDialogController.ConfigureCalls); // configurar aconteceu, mas nunca confiado
    }

    [Fact]
    public void K_ReadbackNomeDivergente_ZeroClickSave()
    {
        var fx = new OrchestratorFixture();
        fx.SaveDialogInspector.ReadbackResult = SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "nome != esperado");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
    }

    [Fact]
    public void L_ReadbackTipoDivergente_ZeroClickSave()
    {
        var fx = new OrchestratorFixture();
        fx.SaveDialogInspector.ReadbackResult = SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "tipo != Excel");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
    }

    // ---------- M. G10-G12 PASS -> 1 ClickSave ----------
    [Fact]
    public void M_ReadbackTotalmentePositivo_ExatamenteUmClickSave()
    {
        var fx = new OrchestratorFixture();

        fx.BuildOrchestrator().Run();

        Assert.Equal(1, fx.Committer.CommitOnceCalls);
    }

    // ---------- N. Excecao em SendExportShortcut ----------
    [Fact]
    public void N_ExcecaoAoEnviarAtalho_FailedComLockLiberado()
    {
        var fx = new OrchestratorFixture();
        fx.InputSender.ThrowOnSend = new InvalidOperationException("SendInput falhou (simulado)");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(AgentStage.Failed, result.FinalStage);
        Assert.Equal(AgentErrorCode.UnexpectedException, result.ErrorCode);
        Assert.Equal(1, fx.Lock.ReleaseCalls);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
    }

    // ---------- N1. Correcao de observabilidade: Log() nao descarta mais `reason` ----------
    // Antes da correcao, o metodo privado Log() recebia `reason` mas nunca o
    // repassava ao AgentLogEvent - qualquer TryLog(..., reason: ex.Message)
    // virava "reason": null no evento final. Achado real de um incidente
    // (UnexpectedException em SendExportShortcut cujo ex.Message nunca
    // apareceu no log).
    [Fact]
    public void N1_ExcecaoAoEnviarAtalho_ReasonComMensagemDaExcecaoPreservado()
    {
        var fx = new OrchestratorFixture();
        fx.InputSender.ThrowOnSend = new InvalidOperationException("SendInput falhou (simulado)");

        fx.BuildOrchestrator().Run();

        var failedEvent = fx.Logger.Events.Last();
        Assert.Equal(nameof(AgentStage.Failed), failedEvent.Stage);
        Assert.Equal(nameof(AgentErrorCode.UnexpectedException), failedEvent.ErrorCode);
        Assert.Equal("SendInput falhou (simulado)", failedEvent.Reason);
        // Zero segunda tentativa de SendExportShortcut - a excecao no catch
        // nunca reintroduz a acao, so afeta o que e' logado.
        Assert.Equal(1, fx.InputSender.SendExportShortcutCalls);
    }

    // ---------- N1b. Hybrid V3 (observabilidade minima) - o call-site de
    // CheckSafeState (UnsafeState) TAMBEM passa reason agora - fecha o gap
    // que este teste antes documentava como "fora do escopo" da correcao
    // N1 original. Achado real: incidente de 2026-09-11 onde 2 execucoes
    // UnsafeState consecutivas (17:55 e 18:25) ficaram com reason=null no
    // log de producao, exigindo investigacao manual passo a passo para
    // sequer confirmar QUAL gate G3-G6 tinha bloqueado. Nenhuma mudanca de
    // decisao/gate - safeState.Reason ja existia, so nao era repassado. ----
    [Fact]
    public void N1b_CheckSafeStateFalha_ReasonEspecificoDoGatePreservadoNoLog()
    {
        var fx = new OrchestratorFixture();
        fx.NexWindowInspector.SafeStateResult = NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, "mais de 1 janela top-level");

        fx.BuildOrchestrator().Run();

        var failedEvent = fx.Logger.Events.Last();
        Assert.Equal(nameof(AgentStage.UnsafeState), failedEvent.Stage);
        Assert.Equal(nameof(AgentErrorCode.UnsafeState), failedEvent.ErrorCode);
        Assert.Equal("mais de 1 janela top-level", failedEvent.Reason);
    }

    // ---------- N1c. Ausencia de reason em outros call-sites que legitimamente
    // nunca passam reason continua null (nenhuma regressao de schema -
    // AgentLogEvent.Reason e opcional desde sua criacao). ----
    [Fact]
    public void N1c_LogSemReasonExplicito_EventoContinuaComReasonNulo()
    {
        var fx = new OrchestratorFixture();
        fx.Lock.AcquireSucceeds = false;

        fx.BuildOrchestrator().Run();

        var loggedEvent = fx.Logger.Events.Last();
        Assert.Equal(nameof(AgentStage.SkippedBusy), loggedEvent.Stage);
        Assert.Null(loggedEvent.Reason);
    }

    // ---------- N0. NotForegroundException -> SkippedNotForeground (modo scheduled-safe) ----------
    // Simula, via FakeInputSender.ThrowOnSend, o que
    // WindowsScheduledSafeInputSender lanca quando o NexAdmin nao esta em
    // primeiro plano. O sender manual (WindowsInputSender/FakeInputSender
    // no caminho normal) nunca lanca este tipo - este catch especifico
    // nunca dispara para nenhum outro cenario ja testado.
    [Fact]
    public void N0_NotForegroundException_SkippedNotForegroundComReasonELockLiberado()
    {
        var fx = new OrchestratorFixture();
        fx.InputSender.ThrowOnSend = new NotForegroundException("SCHEDULED-SAFE GATE T3 falhou: NexAdmin nao esta em primeiro plano - nenhuma tentativa de forcar foco.");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(AgentStage.SkippedNotForeground, result.FinalStage);
        Assert.Equal(AgentErrorCode.NotForeground, result.ErrorCode);
        Assert.Equal(1, fx.Lock.ReleaseCalls);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);

        var loggedEvent = fx.Logger.Events.Last();
        Assert.Equal(nameof(AgentStage.SkippedNotForeground), loggedEvent.Stage);
        Assert.Equal(nameof(AgentErrorCode.NotForeground), loggedEvent.ErrorCode);
        Assert.Contains("NexAdmin nao esta em primeiro plano", loggedEvent.Reason);
    }

    // ---------- N1. BackgroundSafeSkipException -> UnsafeState (Scheduler V2) ----------
    // Simula, via FakeInputSender.ThrowOnSend, o que
    // WindowsBackgroundExportTrigger lanca quando um gate de estado
    // operacional seguro (NEX foreground/abridor/"Todas vendas") nao foi
    // satisfeito ANTES do WM_COMMAND. Reaproveita AgentStage.UnsafeState
    // (decisao de design homologada) - nunca um novo valor de enum.
    [Fact]
    public void N1_BackgroundSafeSkipException_UnsafeStateComReasonELockLiberado()
    {
        var fx = new OrchestratorFixture();
        fx.InputSender.ThrowOnSend = new BackgroundSafeSkipException("'Todas vendas' nao confirmado na barra - nao seguro prosseguir.");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(AgentStage.UnsafeState, result.FinalStage);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
        Assert.Equal(1, fx.Lock.ReleaseCalls);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);

        var loggedEvent = fx.Logger.Events.Last();
        Assert.Equal(nameof(AgentStage.UnsafeState), loggedEvent.Stage);
        Assert.Equal(nameof(AgentErrorCode.UnsafeState), loggedEvent.ErrorCode);
        Assert.Contains("Todas vendas", loggedEvent.Reason);
    }

    // ---------- N2. Excecao na PRIMEIRA chamada de log (F6.13.2 correcao) ----------
    // Antes da correcao, Log(Start) acontecia FORA do try e essa excecao
    // escaparia de Run() sem tratamento nenhum. Depois da correcao, deve
    // ser capturada como qualquer outra excecao inesperada.
    [Fact]
    public void N2_ExcecaoNoPrimeiroLog_RetornaFailedComZeroAcoesDeUI()
    {
        var fx = new OrchestratorFixture();
        fx.Logger.ThrowOnFirstLog = new IOException("disco cheio (simulado)");

        AgentRunResult? result = null;
        var exception = Record.Exception(() => result = fx.BuildOrchestrator().Run());

        Assert.Null(exception); // nunca escapa de Run()
        Assert.NotNull(result);
        Assert.False(result!.Success);
        Assert.Equal(AgentStage.Failed, result.FinalStage);
        Assert.Equal(AgentErrorCode.UnexpectedException, result.ErrorCode);
        Assert.Equal(0, fx.InputSender.SendExportShortcutCalls);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
        // Falhou antes mesmo de tentar o lock - Release() nao deve ter sido chamado.
        Assert.Equal(0, fx.Lock.ReleaseCalls);
    }

    // ---------- N3. Logger SEMPRE quebrado (F6.13.3) ----------
    [Fact]
    public void N3_LoggerSempreQuebrado_RetornaFailedSemEscaparESemAcoesDeUI()
    {
        var fx = new OrchestratorFixture();
        fx.Logger.ThrowOnEveryLog = new IOException("disco cheio (simulado, permanente)");

        AgentRunResult? result = null;
        var exception = Record.Exception(() => result = fx.BuildOrchestrator().Run());

        // O ponto central deste teste: mesmo com o Log(Start) E o
        // Log(Failed,...) do catch mais externo falhando, nada escapa.
        Assert.Null(exception);
        Assert.NotNull(result);
        Assert.False(result!.Success);
        Assert.Equal(AgentStage.Failed, result.FinalStage);
        Assert.Equal(AgentErrorCode.UnexpectedException, result.ErrorCode);
        Assert.Equal(0, fx.InputSender.SendExportShortcutCalls);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
        Assert.Equal(0, fx.Lock.ReleaseCalls);
        // Logger sempre lanca - nenhum evento chega a ser de fato registrado.
        Assert.Empty(fx.Logger.Events);
    }

    // ---------- O. State machine sem transicao de retry ----------
    [Fact]
    public void O_AgentStageNaoPossuiEstagioDeRetryOuRepeticao()
    {
        var nomesEsperados = new[]
        {
            "Start", "LockAcquired", "SessionValidated", "NexValidated", "SafeStateValidated",
            "ExportTriggered", "SaveDialogIdentified", "SaveControlsValidated", "SaveDialogConfigured",
            "SaveDialogReadbackValidated", "FileSaveTriggered", "FileStable", "ReaderValidated",
            "Published", "Success",
            // V1 (extrato individual por cliente) - estagios NOVOS do fluxo
            // de IndividualStatementExportOrchestrator, inseridos no MESMO
            // enum compartilhado (AgentStage) por decisao de design (ver
            // plano aprovado). Nao alteram nenhum comportamento do
            // pipeline de Vendas - ExportAgentOrchestrator nunca emite
            // nenhum destes 3 estagios.
            "ClientOpened", "TransactionsTabActive", "OverflowMenuOpened",
            "Failed", "SkippedBusy", "SkippedSessionUnavailable", "NexNotFound", "UnsafeState",
            // Modo scheduled-safe (--run-once-scheduled-safe) - ver plano
            // aprovado. ExportAgentOrchestrator so emite este estagio
            // quando o IInputSender injetado lanca NotForegroundException
            // (nunca o sender manual homologado).
            "SkippedNotForeground",
        };

        var nomesReais = Enum.GetNames(typeof(AgentStage));

        Assert.Equal(nomesEsperados.OrderBy(n => n), nomesReais.OrderBy(n => n));
        Assert.DoesNotContain(nomesReais, n => n.Contains("Retry", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(nomesReais, n => n.Contains("Repeat", StringComparison.OrdinalIgnoreCase));
    }

    // ---------- P. Nomenclatura deterministica ----------
    [Fact]
    public void P_NomeDeArquivo_EDeterministicoAPartirDoRelogio()
    {
        var clock = new Fakes.FakeClock { Now = new DateTime(2026, 9, 1, 14, 30, 5) };

        var nome = FileNaming.GerarNomeArquivoVendas(clock);

        Assert.Equal("vendas-auto-20260901-143005.xls", nome);
        Assert.DoesNotContain("Exportar-dia-31-08", nome);
        Assert.EndsWith(".xls", nome, StringComparison.Ordinal);
    }

    // ---------- Teste de ORDEM explicita (F6.13 secao 14) ----------
    [Fact]
    public void Ordem_ConfigureAntesDeReadback_ReadbackPositivoAntesDeClickSave()
    {
        var fx = new OrchestratorFixture();

        fx.BuildOrchestrator().Run();

        Assert.True(fx.Spy.Before("Configure", 1, "ReadBack", 1));
        Assert.True(fx.Spy.Before("ReadBack", 1, "CommitOnce", 1));
        Assert.True(fx.Spy.Before("SendExportShortcut", 1, "IdentifySaveDialog", 1));
        Assert.True(fx.Spy.Before("IdentifySaveDialog", 1, "Configure", 1));
    }

    // ==================================================================
    // F6.14B2.12C1 - Committer wired: prova a ordem final
    // ReadBack -> CommitOnce -> WaitForStable -> Validate -> Publish, e
    // que qualquer falha em qualquer estagio dessa cadeia nunca provoca
    // uma segunda chamada de nada (zero retry).
    // ==================================================================

    // ---------- Q. CommitOnce FAIL -> zero watcher/validator/publisher ----------
    [Fact]
    public void Q_CommitOnceFalha_ZeroWatcherZeroValidatorZeroPublisher()
    {
        var fx = new OrchestratorFixture();
        fx.Committer.Result = SaveDialogCommitResult.Fail(AgentErrorCode.DialogIdentityMismatch, "dialogo diferente na revalidacao final");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(AgentStage.Failed, result.FinalStage);
        Assert.Equal(AgentErrorCode.DialogIdentityMismatch, result.ErrorCode);
        Assert.Equal(1, fx.Committer.CommitOnceCalls);
        Assert.Equal(0, fx.Spy.CountOf("WaitForExpectedFileOnly"));
        Assert.Equal(0, fx.Spy.CountOf("Validate"));
        Assert.Equal(0, fx.Spy.CountOf("Publish"));
    }

    // ---------- R. CommitOnce PASS, watcher (IExportStageWatcher) FAIL -> CommitOnce continua 1, zero Validator/Publisher ----------
    [Fact]
    public void R_CommitOnceOkMasArquivoNuncaEstabiliza_CommitOnceContinuaUm_ZeroValidatorZeroPublisher()
    {
        var fx = new OrchestratorFixture();
        fx.Watcher.WaitResult = ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable, "timeout aguardando estabilidade");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(AgentStage.Failed, result.FinalStage);
        Assert.Equal(AgentErrorCode.FileUnstable, result.ErrorCode);
        Assert.Equal(1, fx.Committer.CommitOnceCalls); // nenhuma segunda tentativa de clique
        Assert.Equal(TimeSpan.FromSeconds(30), fx.Watcher.LastTimeoutReceived);
        Assert.Equal(0, fx.Spy.CountOf("Validate"));
        Assert.Equal(0, fx.Spy.CountOf("Publish"));

        var failedEvent = fx.Logger.Events.Last();
        Assert.Equal(nameof(AgentStage.Failed), failedEvent.Stage);
        Assert.Equal(nameof(AgentErrorCode.FileUnstable), failedEvent.ErrorCode);
        Assert.Equal("timeout aguardando estabilidade", failedEvent.Reason);
    }

    // ---------- S. Watcher PASS, Reader FAIL -> zero Publisher ----------
    [Fact]
    public void S_ReaderRejeita_ZeroPublisher()
    {
        var fx = new OrchestratorFixture();
        fx.ExportValidator.Result = ExportValidationResult.Fail(AgentErrorCode.ReaderRejected, "colunas_inesperadas");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(1, fx.Committer.CommitOnceCalls);
        Assert.Equal(1, fx.Spy.CountOf("Validate"));
        Assert.Equal(0, fx.Spy.CountOf("Publish"));
    }

    // ---------- T. Cadeia inteira PASS -> exatamente 1 de cada ----------
    [Fact]
    public void T_CadeiaCompletaOk_ExatamenteUmaChamadaDeCadaEstagio()
    {
        var fx = new OrchestratorFixture();

        var result = fx.BuildOrchestrator().Run();

        Assert.True(result.Success);
        Assert.Equal(1, fx.InputSender.SendExportShortcutCalls);
        Assert.Equal(1, fx.Committer.CommitOnceCalls);
        Assert.Equal(1, fx.Spy.CountOf("WaitForExpectedFileOnly"));
        Assert.Equal(1, fx.Spy.CountOf("Validate"));
        Assert.Equal(1, fx.Spy.CountOf("Publish"));
    }

    // ---------- U. Ordem objetiva completa ----------
    [Fact]
    public void U_OrdemObjetivaCompleta_ReadbackAntesDeCommitAntesDeWatcherAntesDeValidateAntesDePublish()
    {
        var fx = new OrchestratorFixture();

        fx.BuildOrchestrator().Run();

        Assert.True(fx.Spy.Before("ReadBack", 1, "CommitOnce", 1));
        Assert.True(fx.Spy.Before("CommitOnce", 1, "WaitForExpectedFileOnly", 1));
        Assert.True(fx.Spy.Before("WaitForExpectedFileOnly", 1, "Validate", 1));
        Assert.True(fx.Spy.Before("Validate", 1, "Publish", 1));
    }

    // ---------- W. G13: EXPORT_STAGE nao vazia -> zero Shift+F5 ----------
    [Fact]
    public void W_StageNaoVazia_ZeroShiftF5_ZeroCommitOnce()
    {
        var fx = new OrchestratorFixture();
        fx.Watcher.ConfirmEmptyResult = ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable, "EXPORT_STAGE nao esta vazia");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(AgentStage.Failed, result.FinalStage);
        Assert.Equal(0, fx.InputSender.SendExportShortcutCalls);
        Assert.Equal(0, fx.Committer.CommitOnceCalls);
        Assert.Equal(1, fx.Watcher.ConfirmEmptyBeforeActionCalls);
    }

    // ---------- X. G13 PASS -> ConfirmEmptyBeforeAction antes do Shift+F5 ----------
    [Fact]
    public void X_StageVazia_ConfirmEmptyBeforeActionAntesDoShiftF5()
    {
        var fx = new OrchestratorFixture();

        fx.BuildOrchestrator().Run();

        Assert.Equal(1, fx.Watcher.ConfirmEmptyBeforeActionCalls);
        Assert.True(fx.Spy.Before("ConfirmEmptyBeforeAction", 1, "SendExportShortcut", 1));
    }

    // ---------- V. CommitOnce recebe target e dialog corretos ----------
    [Fact]
    public void V_CommitOnceRecebeMesmoTargetEMesmoDialogJaValidados()
    {
        var fx = new OrchestratorFixture();
        var identidadeEsperada = new NexAdminWindowIdentity(processId: 555, mainWindowHandle: 0x9999);
        fx.NexWindowInspector.LocateResult = NexAdminLocateResult.Pass(identidadeEsperada);

        fx.BuildOrchestrator().Run();

        Assert.Equal(identidadeEsperada, fx.Committer.LastTargetReceived);
        Assert.Equal(fx.SaveDialogInspector.IdentityResult.Dialog, fx.Committer.LastExpectedDialogReceived);
    }
}
