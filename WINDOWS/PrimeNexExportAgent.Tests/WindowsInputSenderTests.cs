using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Tests.Fakes;
using PrimeNexExportAgent.WindowsInput;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14B1, corrigidos em F6.14B2.5) de WindowsInputSender -
/// a implementacao REAL de IInputSender. ZERO Win32 real e tocado aqui:
/// INativeWindowApi (T1/T2), IInputNativeApi (T4a/confirmacao final/input)
/// e IForegroundWaiter (T4b) sao todos fakes puros.
///
/// F6.14B2.5 - T4 passou a ter duas partes: T4a (SetForegroundWindow,
/// unico) + T4b (IForegroundWaiter.WaitForForeground - aqui um
/// FakeForegroundWaiter simples, sem polling real - o polling de verdade e
/// testado em ForegroundWaiterTests contra PollingForegroundWaiter). Depois
/// do waiter, uma confirmacao FINAL direta via IInputNativeApi.
/// GetForegroundWindow() acontece imediatamente antes do SendInput.
/// </summary>
public sealed class WindowsInputSenderTests
{
    private const string ExpectedClassName = "TfrmPri";
    private const int TargetPid = 1316;
    private static readonly nint TargetHwnd = 0x1000;

    private static NexAdminWindowIdentity ValidTarget => new(processId: TargetPid, mainWindowHandle: TargetHwnd);

    private static (WindowsInputSender Sender, FakeNativeWindowApi Native, FakeInputNativeApi Input, FakeForegroundWaiter Waiter) BuildValidFixture()
    {
        var native = new FakeNativeWindowApi();
        native.ValidWindows.Add(TargetHwnd);
        native.VisibleWindows.Add(TargetHwnd);
        native.OwningProcessByWindow[TargetHwnd] = TargetPid;
        native.ClassNameByWindow[TargetHwnd] = ExpectedClassName;

        var input = new FakeInputNativeApi();
        // Confirmacao FINAL (unica leitura direta que resta em
        // IInputNativeApi apos F6.14B2.5) - por padrao retorna o proprio
        // target (happy path); testes especificos sobrescrevem.
        input.GetForegroundWindowSequence.Enqueue(TargetHwnd);

        var waiter = new FakeForegroundWaiter(); // Result=true por padrao (T4b passa)

        return (new WindowsInputSender(native, input, waiter), native, input, waiter);
    }

    // ---- A: HWND inexistente -> 0 foreground, 0 waiter, 0 input ----
    [Fact]
    public void A_HwndInexistente_ZeroForegroundZeroInput()
    {
        var (sender, native, input, waiter) = BuildValidFixture();
        native.ValidWindows.Remove(TargetHwnd);

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(0, input.SetForegroundWindowCalls);
        Assert.Equal(0, waiter.WaitForForegroundCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- B: PID diferente -> 0 foreground, 0 input ----
    [Fact]
    public void B_PidDiferente_ZeroForegroundZeroInput()
    {
        var (sender, native, input, waiter) = BuildValidFixture();
        native.OwningProcessByWindow[TargetHwnd] = 9999;

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(0, input.SetForegroundWindowCalls);
        Assert.Equal(0, waiter.WaitForForegroundCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- C: ClassName != TfrmPri -> 0 foreground, 0 input ----
    [Fact]
    public void C_ClassNameDiferente_ZeroForegroundZeroInput()
    {
        var (sender, native, input, waiter) = BuildValidFixture();
        native.ClassNameByWindow[TargetHwnd] = "OutraClasse";

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(0, input.SetForegroundWindowCalls);
        Assert.Equal(0, waiter.WaitForForegroundCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- D: target invisivel -> 0 foreground, 0 input ----
    [Fact]
    public void D_TargetInvisivel_ZeroForegroundZeroInput()
    {
        var (sender, native, input, waiter) = BuildValidFixture();
        native.VisibleWindows.Remove(TargetHwnd);

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(0, input.SetForegroundWindowCalls);
        Assert.Equal(0, waiter.WaitForForegroundCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- E (ordem A): SetForegroundWindow retorna false -> fail imediato,
    // waiter NUNCA chamado, 0 input ----
    [Fact]
    public void E_SetForegroundWindowFalha_WaiterNaoChamadoZeroInput()
    {
        var (sender, _, input, waiter) = BuildValidFixture();
        input.SetForegroundWindowResult = false;

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(1, input.SetForegroundWindowCalls);
        Assert.Equal(0, waiter.WaitForForegroundCalls); // T4b nao roda se T4a falhou
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- F (ordem F/G): waiter (T4b) retorna false (timeout) -> 0 input,
    // SetForegroundWindowCalls continua exatamente 1 (nunca uma 2a tentativa) ----
    [Fact]
    public void F_ForegroundWaiterRetornaFalse_SetForegroundWindowContinuaUm_ZeroInput()
    {
        var (sender, _, input, waiter) = BuildValidFixture();
        waiter.Result = false; // simula timeout do PollingForegroundWaiter

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(1, input.SetForegroundWindowCalls); // G/F da ordem: nunca 2a tentativa
        Assert.Equal(1, waiter.WaitForForegroundCalls);
        Assert.Equal(0, input.SendShiftF5Calls); // G da ordem: SendInputCalls == 0
    }

    // ---- G (ordem J): waiter PASS, mas confirmacao FINAL diverge -> FAIL, 0 input ----
    [Fact]
    public void G_WaiterPassMasConfirmacaoFinalDiverge_ZeroInput()
    {
        var (sender, _, input, waiter) = BuildValidFixture();
        waiter.Result = true;
        input.GetForegroundWindowSequence.Clear();
        input.GetForegroundWindowSequence.Enqueue((nint)0x8888); // confirmacao final: janela errada

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(1, waiter.WaitForForegroundCalls);
        Assert.Equal(1, input.GetForegroundWindowCalls); // 1 unica confirmacao final direta
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- H: T1-T4 todos PASS -> SendShiftF5 exatamente 1 vez (ordem K) ----
    [Fact]
    public void H_TodosOsGatesPassam_SendShiftF5ExatamenteUmaVez()
    {
        var (sender, _, input, waiter) = BuildValidFixture();

        sender.SendExportShortcut(ValidTarget);

        Assert.Equal(1, input.SendShiftF5Calls);
        Assert.Equal(1, input.SetForegroundWindowCalls);
        Assert.Equal(1, waiter.WaitForForegroundCalls);
    }

    // ---- I: target recebido pelo foreground/waiter e exatamente o target validado ----
    [Fact]
    public void I_TargetRecebidoPeloForegroundEWaiter_EExatamenteOTargetPassado()
    {
        var (sender, _, input, waiter) = BuildValidFixture();

        sender.SendExportShortcut(ValidTarget);

        Assert.Equal(TargetHwnd, input.LastSetForegroundWindowTarget);
        Assert.Equal(TargetHwnd, waiter.LastTargetReceived);
    }

    // ---- J: SendShiftF5 lanca -> FAILED, zero segunda chamada ----
    [Fact]
    public void J_SendShiftF5Lanca_PropagaExcecaoSemSegundaChamada()
    {
        var (sender, _, input, waiter) = BuildValidFixture();
        input.ThrowOnSendShiftF5 = new InvalidOperationException("SendInput falhou (simulado)");

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(1, input.SendShiftF5Calls);
    }

    // ---- K: SendInput reporta quantidade != 4 -> FAIL, zero retry ----
    [Fact]
    public void K_SendInputRetornaQuantidadeDiferenteDeQuatro_Falha()
    {
        var (sender, _, input, waiter) = BuildValidFixture();
        input.SendShiftF5Result = 2; // insercao parcial

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(1, input.SendShiftF5Calls); // nunca uma segunda tentativa
    }

    // ---- L: happy path continua com maximo SetForegroundWindow=1, SendShiftF5=1 ----
    [Fact]
    public void L_HappyPath_MaximoUmForegroundEUmInput()
    {
        var (sender, _, input, waiter) = BuildValidFixture();

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.Null(exception);
        Assert.Equal(1, input.SetForegroundWindowCalls);
        Assert.Equal(1, waiter.WaitForForegroundCalls);
        Assert.Equal(1, input.SendShiftF5Calls);
    }

    // ---- T2 ClassName: OrdinalIgnoreCase (bug real corrigido - GetClassNameW
    // ao vivo retornou "TFrmPri", nao "TfrmPri"; Ordinal causava falha mesmo
    // com o target correto) ----
    [Theory]
    [InlineData("TfrmPri")]
    [InlineData("TFrmPri")]
    [InlineData("tfrmpri")]
    public void ClassNameVariacaoDeCasing_Aceita(string className)
    {
        var (sender, native, input, _) = BuildValidFixture();
        native.ClassNameByWindow[TargetHwnd] = className;

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.Null(exception);
        Assert.Equal(1, input.SendShiftF5Calls);
    }

    [Theory]
    [InlineData("TfrmPriXYZ")]
    [InlineData("TFrmPr")]
    [InlineData("QualquerOutraClasse")]
    public void ClassNameDiferente_RejeitaZeroInput(string className)
    {
        var (sender, native, input, waiter) = BuildValidFixture();
        native.ClassNameByWindow[TargetHwnd] = className;

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(0, waiter.WaitForForegroundCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }
}
