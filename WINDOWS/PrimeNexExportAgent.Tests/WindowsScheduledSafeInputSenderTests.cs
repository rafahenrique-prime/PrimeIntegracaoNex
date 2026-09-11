using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Tests.Fakes;
using PrimeNexExportAgent.WindowsInput;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline de WindowsScheduledSafeInputSender - a implementacao REAL
/// de IInputSender do modo --run-once-scheduled-safe. ZERO Win32 real e
/// tocado aqui: INativeWindowApi (T1/T2) e IInputNativeApi (usado somente
/// como IForegroundReader para T3/T4 + SendShiftF5) sao fakes puros.
///
/// Diferenca central em relacao a WindowsInputSenderTests: este sender
/// NUNCA chama SetForegroundWindow - todos os testes abaixo confirmam
/// SetForegroundWindowCalls=0 em TODO caminho, inclusive no happy path.
/// </summary>
public sealed class WindowsScheduledSafeInputSenderTests
{
    private const string ExpectedClassName = "TfrmPri";
    private const int TargetPid = 1316;
    private static readonly nint TargetHwnd = 0x1000;
    private static readonly nint OtherHwnd = 0x8888;

    private static NexAdminWindowIdentity ValidTarget => new(processId: TargetPid, mainWindowHandle: TargetHwnd);

    private static (WindowsScheduledSafeInputSender Sender, FakeNativeWindowApi Native, FakeInputNativeApi Input) BuildValidFixture()
    {
        var native = new FakeNativeWindowApi();
        native.ValidWindows.Add(TargetHwnd);
        native.VisibleWindows.Add(TargetHwnd);
        native.OwningProcessByWindow[TargetHwnd] = TargetPid;
        native.ClassNameByWindow[TargetHwnd] = ExpectedClassName;

        var input = new FakeInputNativeApi();
        // Happy path por padrao: as DUAS leituras (T3 + T4) retornam o
        // proprio target. Testes especificos sobrescrevem a fila.
        input.GetForegroundWindowSequence.Enqueue(TargetHwnd);
        input.GetForegroundWindowSequence.Enqueue(TargetHwnd);

        return (new WindowsScheduledSafeInputSender(native, input, input), native, input);
    }

    // ---- T1/T2: mesmos gates de validacao do target do sender manual ----
    [Fact]
    public void HwndInexistente_ZeroForegroundZeroInput()
    {
        var (sender, native, input) = BuildValidFixture();
        native.ValidWindows.Remove(TargetHwnd);

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(0, input.GetForegroundWindowCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    [Fact]
    public void PidDiferente_ZeroForegroundZeroInput()
    {
        var (sender, native, input) = BuildValidFixture();
        native.OwningProcessByWindow[TargetHwnd] = 9999;

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(0, input.GetForegroundWindowCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- A: foreground != target na PRIMEIRA leitura (T3) ----
    [Fact]
    public void A_ForegroundDiferenteNaPrimeiraLeitura_NotForegroundZeroSendInput()
    {
        var (sender, _, input) = BuildValidFixture();
        input.GetForegroundWindowSequence.Clear();
        input.GetForegroundWindowSequence.Enqueue(OtherHwnd);

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        var notForeground = Assert.IsType<NotForegroundException>(exception);
        Assert.False(string.IsNullOrEmpty(notForeground.Message));
        Assert.Equal(0, input.SetForegroundWindowCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
    }

    // ---- B: foreground == target nas DUAS leituras -> SendShiftF5 1x, zero SetForegroundWindow ----
    [Fact]
    public void B_ForegroundCorretoNasDuasLeituras_SendShiftF5UmaVezZeroSetForeground()
    {
        var (sender, _, input) = BuildValidFixture();

        sender.SendExportShortcut(ValidTarget);

        Assert.Equal(1, input.SendShiftF5Calls);
        Assert.Equal(0, input.SetForegroundWindowCalls);
        Assert.Equal(2, input.GetForegroundWindowCalls); // T3 + T4, nunca mais que isso
    }

    // ---- C: primeira leitura == target, segunda leitura (T4) diverge ----
    [Fact]
    public void C_ForegroundMudaEntreT3ET4_NotForegroundZeroSendInput()
    {
        var (sender, _, input) = BuildValidFixture();
        input.GetForegroundWindowSequence.Clear();
        input.GetForegroundWindowSequence.Enqueue(TargetHwnd); // T3: correto
        input.GetForegroundWindowSequence.Enqueue(OtherHwnd);  // T4: mudou

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.IsType<NotForegroundException>(exception);
        Assert.Equal(0, input.SetForegroundWindowCalls);
        Assert.Equal(0, input.SendShiftF5Calls);
        Assert.Equal(2, input.GetForegroundWindowCalls);
    }

    // ---- D: SendShiftF5 retorna != 4 -> falha real (nao NotForegroundException), zero retry ----
    [Fact]
    public void D_SendInputRetornaQuantidadeDiferenteDeQuatro_FalhaRealSemRetry()
    {
        var (sender, _, input) = BuildValidFixture();
        input.SendShiftF5Result = 2;

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.IsNotType<NotForegroundException>(exception);
        Assert.Equal(1, input.SendShiftF5Calls); // nunca uma segunda tentativa
        Assert.Equal(0, input.SetForegroundWindowCalls);
    }

    // ---- SendShiftF5 lanca -> propaga, zero segunda chamada, zero SetForegroundWindow ----
    [Fact]
    public void SendShiftF5Lanca_PropagaExcecaoSemSegundaChamada()
    {
        var (sender, _, input) = BuildValidFixture();
        input.ThrowOnSendShiftF5 = new InvalidOperationException("SendInput falhou (simulado)");

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.IsNotType<NotForegroundException>(exception);
        Assert.Equal(1, input.SendShiftF5Calls);
        Assert.Equal(0, input.SetForegroundWindowCalls);
    }

    // ---- Happy path: nunca chama SetForegroundWindow em nenhum ponto ----
    [Fact]
    public void HappyPath_NuncaChamaSetForegroundWindow()
    {
        var (sender, _, input) = BuildValidFixture();

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.Null(exception);
        Assert.Equal(0, input.SetForegroundWindowCalls);
    }

    // ---- T2 ClassName: OrdinalIgnoreCase (bug real corrigido - GetClassNameW
    // ao vivo retornou "TFrmPri", nao "TfrmPri"; Ordinal causava NotForeground/
    // falha mesmo com o target correto) ----
    [Theory]
    [InlineData("TfrmPri")]
    [InlineData("TFrmPri")]
    [InlineData("tfrmpri")]
    public void ClassNameVariacaoDeCasing_Aceita(string className)
    {
        var (sender, native, input) = BuildValidFixture();
        native.ClassNameByWindow[TargetHwnd] = className;

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.Null(exception);
        Assert.Equal(1, input.SendShiftF5Calls);
    }

    [Theory]
    [InlineData("TfrmPriXYZ")]
    [InlineData("TFrmPr")]
    [InlineData("QualquerOutraClasse")]
    public void ClassNameDiferente_RejeitaZeroSendInput(string className)
    {
        var (sender, native, input) = BuildValidFixture();
        native.ClassNameByWindow[TargetHwnd] = className;

        var exception = Record.Exception(() => sender.SendExportShortcut(ValidTarget));

        Assert.NotNull(exception);
        Assert.Equal(0, input.SendShiftF5Calls);
    }
}
