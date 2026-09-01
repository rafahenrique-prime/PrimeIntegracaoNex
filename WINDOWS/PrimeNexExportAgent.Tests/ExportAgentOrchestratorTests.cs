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
        Assert.Equal(1, fx.SaveDialogController.ClickSaveCalls);
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
        Assert.Equal(0, fx.SaveDialogController.ClickSaveCalls);
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
        Assert.Equal(0, fx.SaveDialogController.ClickSaveCalls);
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
        Assert.Equal(0, fx.SaveDialogController.ClickSaveCalls);
    }

    // ---------- J/K/L. G10/G11/G12 falham individualmente ----------
    [Fact]
    public void J_ReadbackDestinoDivergente_ZeroClickSave()
    {
        var fx = new OrchestratorFixture();
        fx.SaveDialogInspector.ReadbackResult = SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "destino != EXPORT_STAGE");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(0, fx.SaveDialogController.ClickSaveCalls);
        Assert.Equal(1, fx.SaveDialogController.ConfigureCalls); // configurar aconteceu, mas nunca confiado
    }

    [Fact]
    public void K_ReadbackNomeDivergente_ZeroClickSave()
    {
        var fx = new OrchestratorFixture();
        fx.SaveDialogInspector.ReadbackResult = SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "nome != esperado");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(0, fx.SaveDialogController.ClickSaveCalls);
    }

    [Fact]
    public void L_ReadbackTipoDivergente_ZeroClickSave()
    {
        var fx = new OrchestratorFixture();
        fx.SaveDialogInspector.ReadbackResult = SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "tipo != Excel");

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(0, fx.SaveDialogController.ClickSaveCalls);
    }

    // ---------- M. G10-G12 PASS -> 1 ClickSave ----------
    [Fact]
    public void M_ReadbackTotalmentePositivo_ExatamenteUmClickSave()
    {
        var fx = new OrchestratorFixture();

        fx.BuildOrchestrator().Run();

        Assert.Equal(1, fx.SaveDialogController.ClickSaveCalls);
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
        Assert.Equal(0, fx.SaveDialogController.ClickSaveCalls);
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
        Assert.Equal(0, fx.SaveDialogController.ClickSaveCalls);
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
        Assert.Equal(0, fx.SaveDialogController.ClickSaveCalls);
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
            "Failed", "SkippedBusy", "SkippedSessionUnavailable", "NexNotFound", "UnsafeState",
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
        Assert.True(fx.Spy.Before("ReadBack", 1, "ClickSave", 1));
        Assert.True(fx.Spy.Before("SendExportShortcut", 1, "IdentifySaveDialog", 1));
        Assert.True(fx.Spy.Before("IdentifySaveDialog", 1, "Configure", 1));
    }
}
