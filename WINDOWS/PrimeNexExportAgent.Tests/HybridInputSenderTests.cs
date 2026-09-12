using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Tests.Fakes;
using PrimeNexExportAgent.WindowsInput;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (Hybrid V3) de HybridInputSender. ZERO logica de V1/V2
/// real aqui - os dois "mecanismos homologados" sao FakeInputSender
/// (contam chamadas, nunca tocam Win32). Prova: rota decidida por
/// foreground (HWND exato OU MESMO PID, mesmo criterio ja homologado em
/// WindowsBackgroundExportTrigger.IsNexForeground), exatamente 1 chamada
/// ao sender escolhido, ZERO chamadas ao outro, e que uma mudanca de
/// foreground so' e' lida UMA VEZ (nao ha segunda consulta que pudesse
/// trocar de rota no meio da execucao).
/// </summary>
public sealed class HybridInputSenderTests
{
    private const int NexPid = 1000;
    private static readonly nint FrmPri = 0x1000;
    private static readonly nint TfrmIntercomLike = 0x1500; // outra janela do MESMO PID (ex.: "Atendimento")
    private static readonly nint ExternalForegroundHwnd = 0x9000;
    private const int ExternalPid = 2000;

    private static NexAdminWindowIdentity Target => new(NexPid, FrmPri);

    private static (HybridInputSender Sender, FakeNativeWindowApi Native, FakeForegroundReader ForegroundReader, FakeInputSender ForegroundSender, FakeInputSender BackgroundSender) BuildFixture()
    {
        var native = new FakeNativeWindowApi();
        native.OwningProcessByWindow[FrmPri] = NexPid;

        var foregroundReader = new FakeForegroundReader();
        var foregroundSender = new FakeInputSender(new CallSpy());
        var backgroundSender = new FakeInputSender(new CallSpy());

        var sender = new HybridInputSender(native, foregroundReader, foregroundSender, backgroundSender);
        return (sender, native, foregroundReader, foregroundSender, backgroundSender);
    }

    // ---- A: foreground == HWND exato do target -> V1 (foreground), zero V2 ----
    [Fact]
    public void A_ForegroundHwndExato_UsaForegroundSender_ZeroBackgroundSender()
    {
        var (sender, _, foregroundReader, foregroundSender, backgroundSender) = BuildFixture();
        foregroundReader.ForegroundSequence.Enqueue(FrmPri);

        sender.SendExportShortcut(Target);

        Assert.Equal(1, foregroundSender.SendExportShortcutCalls);
        Assert.Equal(0, backgroundSender.SendExportShortcutCalls);
        Assert.Equal(Target, foregroundSender.LastTargetReceived);
        Assert.Equal(HybridRouteDecision.V1Foreground, sender.CurrentDecision);
    }

    // ---- B: foreground e' outra janela do MESMO PID (ex.: TfrmIntercom/"Atendimento") -> ainda V1, zero V2 ----
    [Fact]
    public void B_ForegroundOutraJanelaDoMesmoPid_UsaForegroundSender_ZeroBackgroundSender()
    {
        var (sender, native, foregroundReader, foregroundSender, backgroundSender) = BuildFixture();
        foregroundReader.ForegroundSequence.Enqueue(TfrmIntercomLike);
        native.OwningProcessByWindow[TfrmIntercomLike] = NexPid; // mesmo PID, HWND diferente

        sender.SendExportShortcut(Target);

        Assert.Equal(1, foregroundSender.SendExportShortcutCalls);
        Assert.Equal(0, backgroundSender.SendExportShortcutCalls);
    }

    // ---- C: foreground pertence a PID externo -> V2 (background), zero V1 ----
    [Fact]
    public void C_ForegroundPidExterno_UsaBackgroundSender_ZeroForegroundSender()
    {
        var (sender, native, foregroundReader, foregroundSender, backgroundSender) = BuildFixture();
        foregroundReader.ForegroundSequence.Enqueue(ExternalForegroundHwnd);
        native.OwningProcessByWindow[ExternalForegroundHwnd] = ExternalPid;

        sender.SendExportShortcut(Target);

        Assert.Equal(0, foregroundSender.SendExportShortcutCalls);
        Assert.Equal(1, backgroundSender.SendExportShortcutCalls);
        Assert.Equal(Target, backgroundSender.LastTargetReceived);
        Assert.Equal(HybridRouteDecision.V2Background, sender.CurrentDecision);
    }

    // ---- D: GetForegroundWindow() e' consultado exatamente 1 vez - a rota nunca e' reconsultada dentro desta execucao ----
    [Fact]
    public void D_ForegroundConsultadoExatamenteUmaVez_RotaNuncaReconsultada()
    {
        var (sender, native, foregroundReader, _, _) = BuildFixture();
        foregroundReader.ForegroundSequence.Enqueue(FrmPri);

        sender.SendExportShortcut(Target);

        Assert.Equal(1, foregroundReader.GetForegroundWindowCalls);
    }

    // ---- E: sender escolhido lanca excecao -> HybridInputSender propaga, nunca tenta o outro sender (nunca um "fallback" de rota) ----
    [Fact]
    public void E_ForegroundSenderLanca_PropagaSemTentarBackgroundSender()
    {
        var (sender, _, foregroundReader, foregroundSender, backgroundSender) = BuildFixture();
        foregroundReader.ForegroundSequence.Enqueue(FrmPri);
        foregroundSender.ThrowOnSend = new InvalidOperationException("falha simulada no sender V1");

        var ex = Record.Exception(() => sender.SendExportShortcut(Target));

        Assert.NotNull(ex);
        Assert.Equal(1, foregroundSender.SendExportShortcutCalls);
        Assert.Equal(0, backgroundSender.SendExportShortcutCalls); // nunca um fallback para V2
        Assert.Equal(HybridRouteDecision.V1Foreground, sender.CurrentDecision);
    }

    [Fact]
    public void F_BackgroundSenderLanca_PropagaSemTentarForegroundSender()
    {
        var (sender, native, foregroundReader, foregroundSender, backgroundSender) = BuildFixture();
        foregroundReader.ForegroundSequence.Enqueue(ExternalForegroundHwnd);
        native.OwningProcessByWindow[ExternalForegroundHwnd] = ExternalPid;
        backgroundSender.ThrowOnSend = new InvalidOperationException("falha simulada no sender V2");

        var ex = Record.Exception(() => sender.SendExportShortcut(Target));

        Assert.NotNull(ex);
        Assert.Equal(0, foregroundSender.SendExportShortcutCalls); // nunca um fallback para V1
        Assert.Equal(1, backgroundSender.SendExportShortcutCalls);
        Assert.Equal(HybridRouteDecision.V2Background, sender.CurrentDecision);
    }
}
