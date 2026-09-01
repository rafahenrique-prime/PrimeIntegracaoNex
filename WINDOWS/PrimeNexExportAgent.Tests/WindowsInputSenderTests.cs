using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Tests.Fakes;
using PrimeNexExportAgent.WindowsInput;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14B1) de WindowsInputSender - a implementacao REAL
/// de IInputSender. ZERO Win32 real e tocado aqui: INativeWindowApi
/// (revalidacao T1/T2) e IInputNativeApi (foreground/SendInput, T3/T4 e o
/// input em si) sao ambos fakes puros. Cada cenario do PRE-INPUT TARGET
/// GATE tem teste proprio.
/// </summary>
public sealed class WindowsInputSenderTests
{
    private const string ExpectedClassName = "TfrmPri";
    private const int TargetPid = 1316;
    private static readonly nint TargetHwnd = 0x1000;

    private static NexAdminWindowIdentity ValidTarget => new(processId: TargetPid, mainWindowHandle: TargetHwnd);

    private static (WindowsInputSender Sender, FakeNativeWindowApi Native, FakeInputNativeApi Input) BuildValidFixture()
    {
        var native = new FakeNativeWindowApi();
        native.ValidWindows.Add(TargetHwnd);
        native.VisibleWindows.Add(TargetHwnd);
        native.OwningProcessByWindow[TargetHwnd] = TargetPid;
        native.ClassNameByWindow[TargetHwnd] = ExpectedClassName;

        var input = new FakeInputNativeApi();
        // Por padrao, ambas as confirmacoes de foreground retornam o
        // proprio target (happy path) - testes especificos sobrescrevem.
        input.GetForegroundWindowSequence.Enqueue(TargetHwnd);
        input.GetForegroundWindowSequence.Enqueue(TargetHwnd);

        return (new WindowsInputSender(native, input), native, input);
    }

    // ---- A: HWND inexistente -> 0 foreground, 0 input ----
    [Fact]
    public void A_HwndInexistente_ZeroForegroundZeroInput()
    {
        var (sender, native, input) = BuildValidFixture();
        native.ValidWindows.Remove(TargetHwnd);

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(0, input.SetForegroundWindowCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- B: PID diferente -> 0 foreground, 0 input ----
    [Fact]
    public void B_PidDiferente_ZeroForegroundZeroInput()
    {
        var (sender, native, input) = BuildValidFixture();
        native.OwningProcessByWindow[TargetHwnd] = 9999;

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(0, input.SetForegroundWindowCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- C: ClassName != TfrmPri -> 0 foreground, 0 input ----
    [Fact]
    public void C_ClassNameDiferente_ZeroForegroundZeroInput()
    {
        var (sender, native, input) = BuildValidFixture();
        native.ClassNameByWindow[TargetHwnd] = "OutraClasse";

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(0, input.SetForegroundWindowCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- D: target invisivel -> 0 foreground, 0 input ----
    [Fact]
    public void D_TargetInvisivel_ZeroForegroundZeroInput()
    {
        var (sender, native, input) = BuildValidFixture();
        native.VisibleWindows.Remove(TargetHwnd);

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(0, input.SetForegroundWindowCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- E: SetForegroundWindow retorna false -> 1 tentativa, 0 input ----
    [Fact]
    public void E_SetForegroundWindowFalha_ExatamenteUmaTentativaZeroInput()
    {
        var (sender, _, input) = BuildValidFixture();
        input.SetForegroundWindowResult = false;

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(1, input.SetForegroundWindowCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- F: SetForegroundWindow PASS mas GetForegroundWindow != target -> 0 input ----
    [Fact]
    public void F_ForegroundDivergenteNaPrimeiraConfirmacao_ZeroInput()
    {
        var (sender, _, input) = BuildValidFixture();
        input.GetForegroundWindowSequence.Clear();
        input.GetForegroundWindowSequence.Enqueue((nint)0x9999); // janela errada

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(1, input.SetForegroundWindowCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- G: 1a confirmacao PASS, 2a diverge -> 0 input ----
    [Fact]
    public void G_SegundaConfirmacaoForegroundDiverge_ZeroInput()
    {
        var (sender, _, input) = BuildValidFixture();
        input.GetForegroundWindowSequence.Clear();
        input.GetForegroundWindowSequence.Enqueue(TargetHwnd);       // 1a confirmacao: correta
        input.GetForegroundWindowSequence.Enqueue((nint)0x8888);     // 2a confirmacao: mudou

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(2, input.GetForegroundWindowCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- H: T1-T4 todos PASS -> SendShiftF5 exatamente 1 vez ----
    [Fact]
    public void H_TodosOsGatesPassam_SendShiftF5ExatamenteUmaVez()
    {
        var (sender, _, input) = BuildValidFixture();

        sender.SendExportShortcut(ValidTarget);

        Assert.Equal(1, input.SendShiftF5Calls);
        Assert.Equal(1, input.SetForegroundWindowCalls);
    }

    // ---- I: target recebido pelo input e exatamente o target validado ----
    [Fact]
    public void I_TargetRecebidoPeloForeground_EExatamenteOTargetPassado()
    {
        var (sender, _, input) = BuildValidFixture();

        sender.SendExportShortcut(ValidTarget);

        Assert.Equal(TargetHwnd, input.LastSetForegroundWindowTarget);
    }

    // ---- J: SendShiftF5 lanca -> FAILED, zero segunda chamada ----
    [Fact]
    public void J_SendShiftF5Lanca_PropagaExcecaoSemSegundaChamada()
    {
        var (sender, _, input) = BuildValidFixture();
        input.ThrowOnSendShiftF5 = new InvalidOperationException("SendInput falhou (simulado)");

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(1, input.SendShiftF5Calls);
    }

    // ---- K: SendInput reporta quantidade != 4 -> FAIL, zero retry ----
    [Fact]
    public void K_SendInputRetornaQuantidadeDiferenteDeQuatro_Falha()
    {
        var (sender, _, input) = BuildValidFixture();
        input.SendShiftF5Result = 2; // insercao parcial

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(1, input.SendShiftF5Calls); // nunca uma segunda tentativa
    }

    // ---- L: happy path continua com maximo SetForegroundWindow=1, SendShiftF5=1 ----
    [Fact]
    public void L_HappyPath_MaximoUmForegroundEUmInput()
    {
        var (sender, _, input) = BuildValidFixture();

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.Null(exception);
        Assert.Equal(1, input.SetForegroundWindowCalls);
        Assert.Equal(1, input.SendShiftF5Calls);
    }
}
