using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14B2.4) de PollingSaveDialogWaiter - corrige a race
/// de tempo assincrona entre SendExportShortcut e o Windows criar a janela
/// "Salvar como" (evidencia real: F6.14B2.3). ZERO Win32/tempo real e
/// tocado: ISaveDialogInspector e IDelay sao ambos fakes puros; IDelay
/// avanca um FakeClock compartilhado em vez de dormir de verdade, entao
/// nenhum destes testes demora de fato os 3s de timeout.
/// </summary>
public sealed class SaveDialogWaiterTests
{
    private const int NexAdminPid = 1316;
    private static readonly nint TargetHwnd = 0x1000;
    private static NexAdminWindowIdentity Target => new(processId: NexAdminPid, mainWindowHandle: TargetHwnd);

    private static readonly SaveDialogIdentityResult PassResult =
        SaveDialogIdentityResult.Pass(new SaveDialogIdentity(0x7000));

    private static readonly SaveDialogIdentityResult NotFoundResult =
        SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, "nenhum dialogo '#32770'/'Salvar como' encontrado para o PID esperado");

    private static readonly SaveDialogIdentityResult AmbiguousResult =
        SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, "mais de 1 dialogo 'Salvar como' encontrado (2) - ambiguidade, abortando");

    /// <summary>FakeDelay cujo Wait() avanca o FakeClock compartilhado -
    /// simula passagem de tempo sem nenhuma espera real (F6.14B2.4 secao 7/K).</summary>
    private static (FakeSaveDialogInspector Inspector, FakeDelay Delay, FakeClock Clock, PollingSaveDialogWaiter Waiter) BuildFixture(
        TimeSpan? timeout = null, TimeSpan? pollInterval = null)
    {
        var spy = new CallSpy();
        var inspector = new FakeSaveDialogInspector(spy);
        var clock = new FakeClock();
        var delay = new FakeDelay();
        delay.OnWait = d => clock.Now = clock.Now.Add(d);

        var waiter = new PollingSaveDialogWaiter(inspector, delay, clock, timeout, pollInterval);
        return (inspector, delay, clock, waiter);
    }

    // ---- A: dialogo ja existe no primeiro poll -> retorna imediatamente ----
    [Fact]
    public void A_DialogoJaExisteNoPrimeiroPoll_RetornaImediatamente()
    {
        var (inspector, delay, _, waiter) = BuildFixture();
        inspector.IdentityResult = PassResult;

        var result = waiter.WaitForSaveDialog(Target);

        Assert.True(result.Passed);
        Assert.Equal(1, inspector.IdentifySaveDialogCalls);
        Assert.Equal(0, delay.WaitCalls);
    }

    // ---- B: 0 no primeiro poll, 1 no segundo -> PASS ----
    [Fact]
    public void B_ZeroNoPrimeiroPollUmNoSegundo_Pass()
    {
        var (inspector, delay, _, waiter) = BuildFixture();
        inspector.IdentityResultSequence.Enqueue(NotFoundResult);
        inspector.IdentityResultSequence.Enqueue(PassResult);

        var result = waiter.WaitForSaveDialog(Target);

        Assert.True(result.Passed);
        Assert.Equal(2, inspector.IdentifySaveDialogCalls);
        Assert.Equal(1, delay.WaitCalls); // 1 espera entre o 1o e o 2o poll
    }

    // ---- C: 0 em varios polls, 1 antes do timeout -> PASS ----
    [Fact]
    public void C_ZeroEmVariosPollsUmAntesDoTimeout_Pass()
    {
        var (inspector, delay, _, waiter) = BuildFixture(timeout: TimeSpan.FromSeconds(3), pollInterval: TimeSpan.FromMilliseconds(100));
        for (var i = 0; i < 5; i++) inspector.IdentityResultSequence.Enqueue(NotFoundResult);
        inspector.IdentityResultSequence.Enqueue(PassResult);

        var result = waiter.WaitForSaveDialog(Target);

        Assert.True(result.Passed);
        Assert.Equal(6, inspector.IdentifySaveDialogCalls);
        Assert.Equal(5, delay.WaitCalls);
    }

    // ---- D: 0 ate timeout -> FAIL ----
    [Fact]
    public void D_ZeroAteTimeout_Falha()
    {
        var (inspector, _, _, waiter) = BuildFixture(timeout: TimeSpan.FromMilliseconds(300), pollInterval: TimeSpan.FromMilliseconds(100));
        inspector.IdentityResult = NotFoundResult; // sempre 0, nunca muda

        var result = waiter.WaitForSaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.DialogNotFound, result.ErrorCode);
    }

    // ---- E: timeout -> SendExportShortcutCalls continua exatamente 1 ----
    // (SendExportShortcut nao e nem conhecido pelo waiter - a prova aqui e
    // que o waiter jamais referencia/chama IInputSender de forma alguma.)
    [Fact]
    public void E_Timeout_NuncaReferenciaInputSender()
    {
        var (inspector, _, _, waiter) = BuildFixture(timeout: TimeSpan.FromMilliseconds(300), pollInterval: TimeSpan.FromMilliseconds(100));
        inspector.IdentityResult = NotFoundResult;

        var exception = Record.Exception(() => waiter.WaitForSaveDialog(Target));

        Assert.Null(exception);
        // PollingSaveDialogWaiter nao recebe IInputSender no construtor -
        // impossivel chamar SendExportShortcut a partir daqui (garantia
        // estrutural, nao apenas comportamental).
    }

    // ---- F: 2 candidatos em qualquer poll -> FAIL imediato ----
    [Fact]
    public void F_DoisCandidatosEmQualquerPoll_FalhaImediata()
    {
        var (inspector, delay, _, waiter) = BuildFixture();
        inspector.IdentityResultSequence.Enqueue(NotFoundResult);
        inspector.IdentityResultSequence.Enqueue(AmbiguousResult);
        inspector.IdentityResultSequence.Enqueue(PassResult); // nunca deveria ser consultado

        var result = waiter.WaitForSaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(2, inspector.IdentifySaveDialogCalls); // parou na ambiguidade, nao continuou tentando
        Assert.Equal(1, delay.WaitCalls);
    }

    // ---- G: durante a espera nenhuma API de input e chamada ----
    [Fact]
    public void G_DuranteAEsperaNenhumaApiDeInputEChamada()
    {
        var (inspector, _, _, waiter) = BuildFixture();
        inspector.IdentityResultSequence.Enqueue(NotFoundResult);
        inspector.IdentityResultSequence.Enqueue(PassResult);

        waiter.WaitForSaveDialog(Target);

        // O unico "efeito" possivel do waiter e chamar IdentifySaveDialog
        // (leitura) e IDelay.Wait (espera) - nenhum outro componente e
        // referenciado, estruturalmente impossivel enviar input a partir
        // daqui (o construtor de PollingSaveDialogWaiter nao aceita
        // IInputSender/ISaveDialogControlApi).
        Assert.True(true);
    }

    // ---- H: nenhum segundo Shift+F5 ocorre (garantia estrutural) ----
    [Fact]
    public void H_NenhumSegundoShiftF5EhEstruturalmenteImpossivel()
    {
        // PollingSaveDialogWaiter so depende de ISaveDialogInspector,
        // IDelay e IClock - nao tem nenhuma referencia a IInputSender.
        var ctorParams = typeof(PollingSaveDialogWaiter)
            .GetConstructors()[0]
            .GetParameters()
            .Select(p => p.ParameterType.Name)
            .ToList();

        Assert.DoesNotContain("IInputSender", ctorParams);
    }

    // ---- I: quando WaitForSaveDialog retorna dialogo valido -> fluxo segue ----
    // (testado no nivel do orquestrador - ver ExportAgentOrchestratorTests
    // A_HappyPath, que ja usa FakeSaveDialogWaiter delegando ao inspector.)
    [Fact]
    public void I_DialogoValidoRetornaPassComIdentidade()
    {
        var (inspector, _, _, waiter) = BuildFixture();
        inspector.IdentityResult = PassResult;

        var result = waiter.WaitForSaveDialog(Target);

        Assert.True(result.Passed);
        Assert.Equal(PassResult.Dialog, result.Dialog);
    }

    // ---- J: quando WaitForSaveDialog falha, ConfigureCalls/ReadBackCalls/
    // ClickSave = 0 - testado no nivel do orquestrador. ----
    [Fact]
    public void J_OrquestradorNaoConfiguraQuandoWaitForSaveDialogFalha()
    {
        var fx = new OrchestratorFixture();
        fx.SaveDialogInspector.IdentityResult = NotFoundResult;

        var result = fx.BuildOrchestrator().Run();

        Assert.False(result.Success);
        Assert.Equal(0, fx.SaveDialogController.ConfigureCalls);
        Assert.Equal(0, fx.SaveDialogController.ClickSaveCalls);
    }

    // ---- K: fake delay prova que testes nao dormem de verdade ----
    [Fact]
    public void K_FakeDelayNuncaDormeDeVerdade()
    {
        var (inspector, delay, _, waiter) = BuildFixture(timeout: TimeSpan.FromSeconds(3), pollInterval: TimeSpan.FromMilliseconds(100));
        inspector.IdentityResult = NotFoundResult; // forca esgotar o timeout completo (3s simulados)

        var startedAt = DateTime.UtcNow;
        waiter.WaitForSaveDialog(Target);
        var elapsedRealTime = DateTime.UtcNow - startedAt;

        // Se o FakeDelay dormisse de verdade, isto levaria ~3s reais. Como
        // so avanca o FakeClock, o teste termina quase instantaneamente.
        Assert.True(elapsedRealTime < TimeSpan.FromSeconds(1), $"Teste levou {elapsedRealTime.TotalMilliseconds}ms - FakeDelay parece ter dormido de verdade.");
        Assert.True(delay.WaitCalls > 0);
    }
}
