using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using PrimeNexExportAgent.WindowsNative;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (Hybrid V3) de Win32NexRuntimeStateProbe. ZERO Win32
/// real - INexProcessScanner e INativeWindowApi sao fakes puros. Prova a
/// classificacao Open/Minimized/Closed/BlockingUnknown e, em especial, que
/// nenhum erro de observabilidade (excecao, ExecutablePath ilegivel) vira
/// Closed por engano (regra homologada explicitamente pos-correcao 2 do
/// Hybrid V3 amendment).
/// </summary>
public sealed class Win32NexRuntimeStateProbeTests
{
    private const string ExpectedExecutablePath = @"C:\Nex\NexAdmin.exe";
    private const int Pid = 100;
    private static readonly nint TAppHwnd = 0x1000;
    private static readonly nint TfrmPriHwnd = 0x2000;

    private static (Win32NexRuntimeStateProbe Probe, FakeNexProcessScanner Scanner, FakeNativeWindowApi NativeWindows) BuildFixture()
    {
        var scanner = new FakeNexProcessScanner();
        var nativeWindows = new FakeNativeWindowApi();
        return (new Win32NexRuntimeStateProbe(scanner, nativeWindows), scanner, nativeWindows);
    }

    private static void RegisterCoherentOpenInstance(FakeNativeWindowApi native, int pid, nint tAppHwnd, nint tfrmPriHwnd, bool minimized)
    {
        native.AllTopLevelWindowsByProcess[pid] = new List<nint> { tAppHwnd, tfrmPriHwnd };
        native.ClassNameByWindow[tAppHwnd] = "TApplication";
        // OwnerByWindow ausente = 0 (fake) - satisfaz Owner==0.
        if (minimized) native.MinimizedWindows.Add(tAppHwnd);

        native.ClassNameByWindow[tfrmPriHwnd] = "TfrmPri";
        native.VisibleWindows.Add(tfrmPriHwnd);
    }

    // ---- A: zero processos validos, leitura bem-sucedida -> Closed ----
    [Fact]
    public void A_ZeroProcessosValidos_LeituraBemSucedida_Closed()
    {
        var (probe, scanner, _) = BuildFixture();
        scanner.Candidates.Add(new NexProcessCandidate(999, @"C:\Outro\Programa.exe", 1)); // path lido com sucesso, nao bate

        var result = probe.Classify();

        Assert.Equal(NexRuntimeState.Closed, result.State);
    }

    [Fact]
    public void A2_NenhumProcessoComEsseNome_Closed()
    {
        var (probe, _, _) = BuildFixture();
        // scanner.Candidates vazio - nenhum processo "NexAdmin" existe.

        var result = probe.Classify();

        Assert.Equal(NexRuntimeState.Closed, result.State);
    }

    // ---- B: processo valido + TApplication IsIconic=true -> Minimized ----
    [Fact]
    public void B_ProcessoValido_TApplicationIconic_Minimized()
    {
        var (probe, scanner, native) = BuildFixture();
        scanner.Candidates.Add(new NexProcessCandidate(Pid, ExpectedExecutablePath, 1));
        RegisterCoherentOpenInstance(native, Pid, TAppHwnd, TfrmPriHwnd, minimized: true);
        // Minimized: TfrmPri fica Visible=False (evidencia real) - remove
        // do conjunto de visiveis para fidelidade ao runtime.
        native.VisibleWindows.Remove(TfrmPriHwnd);

        var result = probe.Classify();

        Assert.Equal(NexRuntimeState.Minimized, result.State);
    }

    // ---- C: processo valido + estrutura aberta coerente -> Open ----
    [Fact]
    public void C_ProcessoValido_EstruturaAbertaCoerente_Open()
    {
        var (probe, scanner, native) = BuildFixture();
        scanner.Candidates.Add(new NexProcessCandidate(Pid, ExpectedExecutablePath, 1));
        RegisterCoherentOpenInstance(native, Pid, TAppHwnd, TfrmPriHwnd, minimized: false);

        var result = probe.Classify();

        Assert.Equal(NexRuntimeState.Open, result.State);
    }

    // ---- D: processo valido mas sem TApplication -> BlockingUnknown ----
    [Fact]
    public void D_ProcessoValido_SemTApplication_BlockingUnknown()
    {
        var (probe, scanner, native) = BuildFixture();
        scanner.Candidates.Add(new NexProcessCandidate(Pid, ExpectedExecutablePath, 1));
        var utilHwnd = (nint)0x3000;
        native.AllTopLevelWindowsByProcess[Pid] = new List<nint> { utilHwnd };
        native.ClassNameByWindow[utilHwnd] = "TPUtilWindow";

        var result = probe.Classify();

        Assert.Equal(NexRuntimeState.BlockingUnknown, result.State);
    }

    // ---- E: TApplication ambigua (2 com Owner==0) -> BlockingUnknown ----
    [Fact]
    public void E_TApplicationAmbigua_BlockingUnknown()
    {
        var (probe, scanner, native) = BuildFixture();
        scanner.Candidates.Add(new NexProcessCandidate(Pid, ExpectedExecutablePath, 1));
        var tApp2 = (nint)0x1001;
        native.AllTopLevelWindowsByProcess[Pid] = new List<nint> { TAppHwnd, tApp2, TfrmPriHwnd };
        native.ClassNameByWindow[TAppHwnd] = "TApplication";
        native.ClassNameByWindow[tApp2] = "TApplication";
        native.ClassNameByWindow[TfrmPriHwnd] = "TfrmPri";
        native.VisibleWindows.Add(TfrmPriHwnd);

        var result = probe.Classify();

        Assert.Equal(NexRuntimeState.BlockingUnknown, result.State);
    }

    // ---- F: multiplas instancias principais validas -> BlockingUnknown ----
    [Fact]
    public void F_MultiplasInstanciasPrincipaisValidas_BlockingUnknown()
    {
        var (probe, scanner, native) = BuildFixture();
        const int pid2 = 200;
        var tApp2 = (nint)0x1001;
        var tfrmPri2 = (nint)0x2001;

        scanner.Candidates.Add(new NexProcessCandidate(Pid, ExpectedExecutablePath, 1));
        scanner.Candidates.Add(new NexProcessCandidate(pid2, ExpectedExecutablePath, 1));

        RegisterCoherentOpenInstance(native, Pid, TAppHwnd, TfrmPriHwnd, minimized: false);
        RegisterCoherentOpenInstance(native, pid2, tApp2, tfrmPri2, minimized: false);

        var result = probe.Classify();

        Assert.Equal(NexRuntimeState.BlockingUnknown, result.State);
    }

    // ---- G: erro ao consultar processo -> BlockingUnknown, NAO Closed ----
    [Fact]
    public void G_ErroAoConsultarProcesso_BlockingUnknown_NuncaClosed()
    {
        var (probe, scanner, _) = BuildFixture();
        scanner.ThrowOnScan = new InvalidOperationException("falha simulada ao enumerar processos");

        var result = probe.Classify();

        Assert.Equal(NexRuntimeState.BlockingUnknown, result.State);
        Assert.NotEqual(NexRuntimeState.Closed, result.State);
    }

    // ---- H: erro ao consultar ExecutablePath (path ilegivel) -> BlockingUnknown ----
    [Fact]
    public void H_ExecutablePathIlegivel_BlockingUnknown_NuncaClosed()
    {
        var (probe, scanner, _) = BuildFixture();
        scanner.Candidates.Add(new NexProcessCandidate(Pid, null, 1)); // AccessDenied simulado (Win32NexProcessScanner real registra null nesse caso)

        var result = probe.Classify();

        Assert.Equal(NexRuntimeState.BlockingUnknown, result.State);
        Assert.NotEqual(NexRuntimeState.Closed, result.State);
    }

    // ---- I: erro ao enumerar janelas -> BlockingUnknown ----
    [Fact]
    public void I_ErroAoEnumerarJanelas_BlockingUnknown()
    {
        var (probe, scanner, native) = BuildFixture();
        scanner.Candidates.Add(new NexProcessCandidate(Pid, ExpectedExecutablePath, 1));
        native.ThrowOnGetAllTopLevelWindowsForProcess = new InvalidOperationException("falha simulada ao enumerar janelas");

        var result = probe.Classify();

        Assert.Equal(NexRuntimeState.BlockingUnknown, result.State);
    }

    // ---- J: Reason sempre preenchido, mesmo em Open/Closed/Minimized (nao so' BlockingUnknown) ----
    [Fact]
    public void J_ReasonSempreNaoVazio_EmQualquerEstado()
    {
        var (probeOpen, scannerOpen, nativeOpen) = BuildFixture();
        scannerOpen.Candidates.Add(new NexProcessCandidate(Pid, ExpectedExecutablePath, 1));
        RegisterCoherentOpenInstance(nativeOpen, Pid, TAppHwnd, TfrmPriHwnd, minimized: false);
        Assert.False(string.IsNullOrWhiteSpace(probeOpen.Classify().Reason));

        var (probeClosed, _, _) = BuildFixture();
        Assert.False(string.IsNullOrWhiteSpace(probeClosed.Classify().Reason));
    }

    // ---- K: instancia sem TApplication (helper process) convivendo com a instancia coerente -> Open (nunca ambigua so' por causa de um processo residual) ----
    [Fact]
    public void K_ProcessoAuxiliarSemTApplication_ConviveComInstanciaCoerente_Open()
    {
        var (probe, scanner, native) = BuildFixture();
        const int helperPid = 300;
        scanner.Candidates.Add(new NexProcessCandidate(Pid, ExpectedExecutablePath, 1));
        scanner.Candidates.Add(new NexProcessCandidate(helperPid, ExpectedExecutablePath, 1));

        RegisterCoherentOpenInstance(native, Pid, TAppHwnd, TfrmPriHwnd, minimized: false);

        var helperUtilHwnd = (nint)0x4000;
        native.AllTopLevelWindowsByProcess[helperPid] = new List<nint> { helperUtilHwnd };
        native.ClassNameByWindow[helperUtilHwnd] = "TPUtilWindow";

        var result = probe.Classify();

        Assert.Equal(NexRuntimeState.Open, result.State);
    }
}
