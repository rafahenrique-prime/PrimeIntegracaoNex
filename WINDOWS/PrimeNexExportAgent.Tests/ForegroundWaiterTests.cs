using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14B2.5) de PollingForegroundWaiter - corrige a race
/// de tempo entre SetForegroundWindow retornar sucesso e o Windows
/// efetivamente refletir essa troca de foreground (evidencia real: probe
/// B2.4 mostrou SetForegroundWindow=true seguido imediatamente de
/// GetForegroundWindow() != target). ZERO Win32/tempo real e tocado:
/// IForegroundReader e IDelay sao fakes puros; IDelay avanca um FakeClock
/// compartilhado em vez de dormir de verdade.
/// </summary>
public sealed class ForegroundWaiterTests
{
    private static readonly nint TargetHwnd = 0x1000;
    private static readonly nint OtherHwnd = 0x9999;

    private static (FakeForegroundReader Reader, FakeDelay Delay, FakeClock Clock, PollingForegroundWaiter Waiter) BuildFixture(
        TimeSpan? timeout = null, TimeSpan? pollInterval = null)
    {
        var reader = new FakeForegroundReader();
        var clock = new FakeClock();
        var delay = new FakeDelay();
        delay.OnWait = d => clock.Now = clock.Now.Add(d);

        var waiter = new PollingForegroundWaiter(reader, delay, clock, timeout, pollInterval);
        return (reader, delay, clock, waiter);
    }

    // ---- B: foreground ja e target no primeiro poll -> PASS ----
    [Fact]
    public void B_ForegroundJaETargetNoPrimeiroPoll_Pass()
    {
        var (reader, delay, _, waiter) = BuildFixture();
        reader.ForegroundSequence.Enqueue(TargetHwnd);

        var result = waiter.WaitForForeground(TargetHwnd);

        Assert.True(result);
        Assert.Equal(1, reader.GetForegroundWindowCalls);
        Assert.Equal(0, delay.WaitCalls);
    }

    // ---- C: primeiro poll != target, segundo poll == target -> PASS ----
    [Fact]
    public void C_PrimeiroPollDivergeSegundoPollIgual_Pass()
    {
        var (reader, delay, _, waiter) = BuildFixture();
        reader.ForegroundSequence.Enqueue(OtherHwnd);
        reader.ForegroundSequence.Enqueue(TargetHwnd);

        var result = waiter.WaitForForeground(TargetHwnd);

        Assert.True(result);
        Assert.Equal(2, reader.GetForegroundWindowCalls);
        Assert.Equal(1, delay.WaitCalls);
    }

    // ---- D: varios polls != target, target aparece antes do timeout -> PASS ----
    [Fact]
    public void D_VariosPollsDivergemTargetApareceAntesDoTimeout_Pass()
    {
        var (reader, delay, _, waiter) = BuildFixture(timeout: TimeSpan.FromSeconds(1), pollInterval: TimeSpan.FromMilliseconds(50));
        for (var i = 0; i < 5; i++) reader.ForegroundSequence.Enqueue(OtherHwnd);
        reader.ForegroundSequence.Enqueue(TargetHwnd);

        var result = waiter.WaitForForeground(TargetHwnd);

        Assert.True(result);
        Assert.Equal(6, reader.GetForegroundWindowCalls);
        Assert.Equal(5, delay.WaitCalls);
    }

    // ---- E: target nunca vira foreground ate timeout -> FAIL ----
    [Fact]
    public void E_TargetNuncaVemAoForegroundAteTimeout_Falha()
    {
        var (reader, _, _, waiter) = BuildFixture(timeout: TimeSpan.FromMilliseconds(200), pollInterval: TimeSpan.FromMilliseconds(50));
        reader.ForegroundSequence.Enqueue(OtherHwnd); // sempre a mesma janela errada (fica sendo repetida)

        var result = waiter.WaitForForeground(TargetHwnd);

        Assert.False(result);
    }

    // ---- H: waiter nunca chama SetForegroundWindow (garantia estrutural) ----
    [Fact]
    public void H_WaiterNuncaChamaSetForegroundWindow()
    {
        // PollingForegroundWaiter so depende de IForegroundReader, IDelay
        // e IClock - IForegroundReader nem expoe SetForegroundWindow.
        var ctorParams = typeof(PollingForegroundWaiter)
            .GetConstructors()[0]
            .GetParameters()
            .Select(p => p.ParameterType.Name)
            .ToList();

        Assert.DoesNotContain("IInputNativeApi", ctorParams);
        Assert.Contains("IForegroundReader", ctorParams);

        var readerMethods = typeof(PrimeNexExportAgent.Contracts.IForegroundReader).GetMethods().Select(m => m.Name);
        Assert.DoesNotContain(readerMethods, n => n.Contains("SetForeground", StringComparison.OrdinalIgnoreCase));
    }

    // ---- I: waiter nunca chama SendInput (garantia estrutural) ----
    [Fact]
    public void I_WaiterNuncaChamaSendInput()
    {
        var ctorParams = typeof(PollingForegroundWaiter)
            .GetConstructors()[0]
            .GetParameters()
            .Select(p => p.ParameterType.Name)
            .ToList();

        // Nao ha nenhum parametro capaz de enviar input - so leitura
        // (IForegroundReader) e infraestrutura de espera (IDelay/IClock).
        Assert.DoesNotContain("IInputNativeApi", ctorParams);
        Assert.DoesNotContain("IInputSender", ctorParams);
    }

    // ---- L: nenhuma espera real ocorre nos testes (fake delay) ----
    [Fact]
    public void L_FakeDelayNuncaDormeDeVerdade()
    {
        var (reader, delay, _, waiter) = BuildFixture(timeout: TimeSpan.FromSeconds(1), pollInterval: TimeSpan.FromMilliseconds(50));
        reader.ForegroundSequence.Enqueue(OtherHwnd); // forca esgotar o timeout completo (1s simulado)

        var startedAt = DateTime.UtcNow;
        waiter.WaitForForeground(TargetHwnd);
        var elapsedRealTime = DateTime.UtcNow - startedAt;

        Assert.True(elapsedRealTime < TimeSpan.FromSeconds(1), $"Teste levou {elapsedRealTime.TotalMilliseconds}ms - FakeDelay parece ter dormido de verdade.");
        Assert.True(delay.WaitCalls > 0);
    }
}
