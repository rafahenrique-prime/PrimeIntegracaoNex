using PrimeNexExportAgent.Real;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// F6.14B2.12B - testes offline (in-process) do Win32ExecutionLock real.
/// Cada teste usa um nome de Mutex UNICO (Guid) para nunca colidir entre
/// execucoes paralelas de teste nem com o nome real de producao
/// (Global\PrimeNexExportAgent.Lock, nunca usado aqui).
/// </summary>
public sealed class Win32ExecutionLockTests
{
    private static string UniqueName() => "PrimeNexExportAgentTests_" + Guid.NewGuid();

    /// <summary>
    /// Named Mutex do Windows tem posse por THREAD, nao por handle/objeto -
    /// dois objetos Mutex diferentes apontando para o MESMO nome, quando
    /// WaitOne() e' chamado pela MESMA thread, sao tratados como uma
    /// aquisicao recursiva pelo dono ja existente (a propria thread) e
    /// portanto succeed - isso NAO representa duas instancias concorrentes
    /// reais. Para provar bloqueio real entre "instancias" dentro de um
    /// unico processo de teste, a segunda tentativa precisa rodar numa
    /// THREAD DIFERENTE (o teste de concorrencia entre PROCESSOS reais,
    /// que nao tem esse artefato de reentrancia por thread, esta em
    /// Win32ExecutionLockProcessIntegrationTests).
    /// </summary>
    private static bool TryAcquireOnOtherThread(Win32ExecutionLock lockInstance)
    {
        bool result = false;
        var t = new System.Threading.Thread(() => result = lockInstance.TryAcquire());
        t.Start();
        t.Join();
        return result;
    }

    private static void ReleaseOnOtherThread(Win32ExecutionLock lockInstance)
    {
        var t = new System.Threading.Thread(lockInstance.Release);
        t.Start();
        t.Join();
    }

    [Fact]
    public void A_PrimeiraInstancia_TryAcquire_True()
    {
        var name = UniqueName();
        using var lockA = new Win32ExecutionLock(name);

        Assert.True(lockA.TryAcquire());
    }

    [Fact]
    public void B_SegundaInstanciaConcorrente_TryAcquire_FalseImediato()
    {
        var name = UniqueName();
        using var lockA = new Win32ExecutionLock(name);
        using var lockB = new Win32ExecutionLock(name);

        Assert.True(lockA.TryAcquire());
        Assert.False(TryAcquireOnOtherThread(lockB));
    }

    [Fact]
    public void C_PrimeiraLibera_SegundaConsegueAdquirirDepois()
    {
        var name = UniqueName();
        using var lockA = new Win32ExecutionLock(name);
        using var lockB = new Win32ExecutionLock(name);

        Assert.True(lockA.TryAcquire());
        Assert.False(TryAcquireOnOtherThread(lockB));

        lockA.Release();

        Assert.True(TryAcquireOnOtherThread(lockB));
    }

    [Fact]
    public void D_TimeoutEfetivoZero_SegundaTentativaNaoEspera()
    {
        var name = UniqueName();
        using var lockA = new Win32ExecutionLock(name);
        using var lockB = new Win32ExecutionLock(name);

        Assert.True(lockA.TryAcquire());

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var acquired = TryAcquireOnOtherThread(lockB);
        sw.Stop();

        Assert.False(acquired);
        // Nao exigimos milissegundos exatos (dependente do runner), so que
        // nao houve uma espera longa (WaitOne com timeout significativo) -
        // uma folga generosa de 2s ja distingue "imediato" de "esperou".
        Assert.True(sw.ElapsedMilliseconds < 2000, $"TryAcquire() demorou {sw.ElapsedMilliseconds}ms - esperado quase instantaneo (WaitOne(0)).");
    }

    [Fact]
    public void E_ReleaseSemAquisicao_NaoLancaENaoAfetaOutraInstancia()
    {
        var name = UniqueName();
        using var lockA = new Win32ExecutionLock(name);
        using var lockB = new Win32ExecutionLock(name);

        Assert.True(lockA.TryAcquire());

        // lockB nunca adquiriu - Release() deve ser um no-op seguro, nunca
        // lancar, e nunca liberar o lock que pertence a lockA.
        var exception = Record.Exception(() => lockB.Release());
        Assert.Null(exception);

        // lockA continua com o lock - uma terceira instancia ainda deve
        // falhar ao tentar adquirir.
        using var lockC = new Win32ExecutionLock(name);
        Assert.False(TryAcquireOnOtherThread(lockC));
    }

    [Fact]
    public void F_DoubleRelease_ComportamentoSeguro()
    {
        var name = UniqueName();
        using var lockA = new Win32ExecutionLock(name);

        Assert.True(lockA.TryAcquire());
        lockA.Release();

        var exception = Record.Exception(() => lockA.Release());
        Assert.Null(exception);
    }

    [Fact]
    public void G_DisposeAposAquisicao_LockELiberadoCorretamente()
    {
        var name = UniqueName();
        var lockA = new Win32ExecutionLock(name);
        Assert.True(lockA.TryAcquire());

        lockA.Dispose();

        using var lockB = new Win32ExecutionLock(name);
        Assert.True(lockB.TryAcquire());
    }

    [Fact]
    public void H_DisposeSemAquisicao_Seguro()
    {
        var name = UniqueName();
        var lockA = new Win32ExecutionLock(name);

        var exception = Record.Exception(() => lockA.Dispose());
        Assert.Null(exception);

        // Dispose duplo tambem deve ser seguro.
        var exception2 = Record.Exception(() => lockA.Dispose());
        Assert.Null(exception2);
    }

    [Fact]
    public void I_DuasThreadsReais_SomenteUmaPossuiLockSimultaneamente()
    {
        var name = UniqueName();
        var acquiredCount = 0;
        var barrier = new System.Threading.Barrier(2);

        void Attempt()
        {
            using var l = new Win32ExecutionLock(name);
            barrier.SignalAndWait();
            if (l.TryAcquire())
            {
                System.Threading.Interlocked.Increment(ref acquiredCount);
                System.Threading.Thread.Sleep(200);
                l.Release();
            }
        }

        var t1 = new System.Threading.Thread(Attempt);
        var t2 = new System.Threading.Thread(Attempt);
        t1.Start();
        t2.Start();
        t1.Join();
        t2.Join();

        Assert.Equal(1, acquiredCount);
    }

    [Fact]
    public void J_NomesDiferentes_NaoBloqueiamEntreSi()
    {
        using var lockA = new Win32ExecutionLock(UniqueName());
        using var lockB = new Win32ExecutionLock(UniqueName());

        Assert.True(lockA.TryAcquire());
        Assert.True(lockB.TryAcquire());
    }

    [Fact]
    public void K_TryAcquireRepetidoNaMesmaInstanciaJaDona_RetornaTrueSemRecursao()
    {
        var name = UniqueName();
        using var lockA = new Win32ExecutionLock(name);

        Assert.True(lockA.TryAcquire());
        Assert.True(lockA.TryAcquire());

        // Release unico ja deve bastar (sem exigir 2 Releases para
        // compensar 2 aquisicoes) - confirma que a segunda chamada nao
        // incrementou a contagem de recursao do Mutex.
        lockA.Release();

        using var lockB = new Win32ExecutionLock(name);
        Assert.True(lockB.TryAcquire());
    }

    [Fact]
    public void L_FonteNaoReferenciaApisDeMemoriaRemotaOuKillDeProcesso()
    {
        var path = System.IO.Path.Combine(FindSourceRoot(), "PrimeNexExportAgent", "Real", "Win32ExecutionLock.cs");
        var source = System.IO.File.ReadAllText(path);

        Assert.DoesNotContain("OpenProcess(", source);
        Assert.DoesNotContain("ReadProcessMemory(", source);
        Assert.DoesNotContain("WriteProcessMemory(", source);
        Assert.DoesNotContain("VirtualAllocEx(", source);
        Assert.DoesNotContain("VirtualFreeEx(", source);
        Assert.DoesNotContain("CreateRemoteThread(", source);
        Assert.DoesNotContain(".Kill(", source);
    }

    private static string FindSourceRoot()
    {
        var dir = new System.IO.DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && dir.Name != "WINDOWS")
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        return dir!.FullName;
    }
}
