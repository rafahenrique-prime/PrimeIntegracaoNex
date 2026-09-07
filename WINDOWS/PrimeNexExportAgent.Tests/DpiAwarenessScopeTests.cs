using PrimeNexExportAgent.WindowsNative;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>Testes offline (V1 - correcao pos-Probe 12A) de DpiAwarenessScope
/// - matriz A-D, I-K do plano aprovado. `setContext` e' injetado (spy
/// determinístico), entao toda a logica de entrar/restaurar/fail-closed e'
/// verificavel sem tocar user32.dll real.</summary>
public sealed class DpiAwarenessScopeTests
{
    private static readonly nint PerMonitorAwareV2 = new(-4);
    private static readonly nint SystemAware = new(-2);

    private sealed class SetContextSpy
    {
        public List<nint> Calls { get; } = new();
        private readonly Queue<nint> _returns;

        public SetContextSpy(params nint[] returns)
        {
            _returns = new Queue<nint>(returns);
        }

        public nint Invoke(nint requested)
        {
            Calls.Add(requested);
            return _returns.Count > 0 ? _returns.Dequeue() : 0;
        }
    }

    [Fact]
    public void A_SetContextUnawareChamadoAntesDaOperacao()
    {
        var spy = new SetContextSpy(PerMonitorAwareV2, PerMonitorAwareV2);
        var operationExecuted = false;

        Assert.True(DpiAwarenessScope.TryEnterUnaware(spy.Invoke, out var scope));
        using (scope)
        {
            operationExecuted = true;
        }

        Assert.Equal(DpiAwarenessScope.DpiAwarenessContextUnaware, spy.Calls[0]); // 1a chamada: entra em UNAWARE
        Assert.True(operationExecuted); // so' depois disso a operacao simulada roda
    }

    [Fact]
    public void B_OldContextRestauradoDepoisDoSucesso()
    {
        var spy = new SetContextSpy(PerMonitorAwareV2, PerMonitorAwareV2);

        Assert.True(DpiAwarenessScope.TryEnterUnaware(spy.Invoke, out var scope));
        using (scope)
        {
            // operacao Win32 simulada - sucesso normal
        }

        Assert.Equal(2, spy.Calls.Count);
        Assert.Equal(DpiAwarenessScope.DpiAwarenessContextUnaware, spy.Calls[0]);
        Assert.Equal(PerMonitorAwareV2, spy.Calls[1]); // restaurado ao valor original
    }

    [Fact]
    public void C_OldContextRestauradoAposExcecao()
    {
        var spy = new SetContextSpy(PerMonitorAwareV2, PerMonitorAwareV2);

        Assert.True(DpiAwarenessScope.TryEnterUnaware(spy.Invoke, out var scope));

        InvalidOperationException? thrown = null;
        try
        {
            using (scope)
            {
                throw new InvalidOperationException("falha simulada na operacao Win32");
            }
        }
        catch (InvalidOperationException ex)
        {
            thrown = ex;
        }

        Assert.NotNull(thrown);
        Assert.Equal("falha simulada na operacao Win32", thrown!.Message);
        Assert.Equal(2, spy.Calls.Count);
        Assert.Equal(PerMonitorAwareV2, spy.Calls[1]); // restaurado mesmo com excecao
    }

    [Fact]
    public void D_SetContextRetornaNull_FailClosedZeroOperacao()
    {
        var spy = new SetContextSpy(0); // primeira chamada ja retorna NULL/0
        var operationExecuted = false;

        var entered = DpiAwarenessScope.TryEnterUnaware(spy.Invoke, out var scope);

        Assert.False(entered);
        Assert.Null(scope);
        Assert.Single(spy.Calls); // so' a tentativa de entrar - nenhuma restauracao, pois nunca entrou
        Assert.False(operationExecuted); // chamador nunca deve executar a operacao Win32
    }

    [Fact]
    public void I_NenhumaOperacaoFicaComContextoAlteradoAposRetorno_DisposeIdempotente()
    {
        var spy = new SetContextSpy(PerMonitorAwareV2, PerMonitorAwareV2);

        Assert.True(DpiAwarenessScope.TryEnterUnaware(spy.Invoke, out var scope));
        scope!.Dispose();
        scope.Dispose(); // segunda chamada - nao deve restaurar de novo

        Assert.Equal(2, spy.Calls.Count); // 1 entrada + 1 restauracao, nunca mais
    }

    [Fact]
    public void J_ContextoOriginalPerMonitorV2_RestauradoParaPerMonitorV2()
    {
        var spy = new SetContextSpy(PerMonitorAwareV2, PerMonitorAwareV2);

        Assert.True(DpiAwarenessScope.TryEnterUnaware(spy.Invoke, out var scope));
        scope!.Dispose();

        Assert.Equal(PerMonitorAwareV2, spy.Calls[1]);
    }

    [Fact]
    public void K_ContextoOriginalSystemAware_RestauradoParaSystemAware()
    {
        var spy = new SetContextSpy(SystemAware, SystemAware);

        Assert.True(DpiAwarenessScope.TryEnterUnaware(spy.Invoke, out var scope));
        scope!.Dispose();

        Assert.Equal(SystemAware, spy.Calls[1]);
    }
}
