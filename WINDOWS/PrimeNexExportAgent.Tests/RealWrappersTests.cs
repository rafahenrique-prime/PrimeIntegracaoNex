using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using PrimeNexExportAgent.WindowsNative;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14A, corrigidos em F6.14A.1) das implementacoes REAIS
/// de ISessionInspector e INexWindowInspector, com as APIs nativas
/// (Win32/UI Automation) substituidas por fakes puros - ZERO processo/
/// janela/WTS real e tocado nestes testes. Cada subgate (G1-G6) tem teste
/// proprio, conforme exigido desde a auditoria F6.13.1.
///
/// F6.14A.1: a inspecao real (F6.14A) provou que Process.MainWindowHandle
/// do NexAdmin.exe aponta para a janela oculta "TApplication" (Delphi/VCL),
/// nao para a janela de negocio real "TfrmPri" (que tem Owner != 0). Os
/// testes de G1/G3 abaixo refletem a correcao: a janela alvo e sempre
/// resolvida por enumeracao (EnumWindows) + ClassName, nunca por
/// MainWindowHandle, e G3 nunca mais filtra por "Owner == 0".
/// </summary>
public sealed class RealWrappersTests
{
    // ==================================================================
    // ISessionInspector real (G2 - sessao do proprio Agent)
    // ==================================================================

    [Fact]
    public void Sessao_Active_RetornaPassComSessionId()
    {
        var native = new FakeSessionNativeApi { CurrentSessionId = 7, ConnectStateToReturn = WtsConnectState.Active };
        var inspector = new WindowsSessionInspector(native);

        var result = inspector.CheckSession();

        Assert.True(result.Passed);
        Assert.Equal(7, result.AgentSessionId);
        Assert.Equal(7, native.LastSessionIdQueried);
    }

    [Fact]
    public void Sessao_Disconnected_RetornaFailSessionUnavailable()
    {
        var native = new FakeSessionNativeApi { ConnectStateToReturn = WtsConnectState.Disconnected };
        var inspector = new WindowsSessionInspector(native);

        var result = inspector.CheckSession();

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.SessionUnavailable, result.ErrorCode);
    }

    [Fact]
    public void Sessao_EstadoDesconhecido_FailClosed()
    {
        var native = new FakeSessionNativeApi { ConnectStateToReturn = null };
        var inspector = new WindowsSessionInspector(native);

        var result = inspector.CheckSession();

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.SessionUnavailable, result.ErrorCode);
    }

    [Fact]
    public void Sessao_ConsultaWtsLancaExcecao_FailClosedSemEscapar()
    {
        var native = new FakeSessionNativeApi { ThrowOnQueryConnectState = new InvalidOperationException("WTS indisponivel (simulado)") };
        var inspector = new WindowsSessionInspector(native);

        var exception = Record.Exception(() => inspector.CheckSession());

        Assert.Null(exception);
    }

    [Fact]
    public void Sessao_ObterSessionIdDoProprioAgentLancaExcecao_FailClosedSemEscapar()
    {
        var native = new FakeSessionNativeApi { ThrowOnGetCurrentProcessSessionId = new InvalidOperationException("falha ao obter SessionId (simulado)") };
        var inspector = new WindowsSessionInspector(native);

        AgentErrorCode code = AgentErrorCode.None;
        var exception = Record.Exception(() =>
        {
            var result = inspector.CheckSession();
            code = result.ErrorCode;
        });

        Assert.Null(exception);
        Assert.Equal(AgentErrorCode.SessionUnavailable, code);
    }

    // ==================================================================
    // INexWindowInspector real - LocateNexAdmin (G1, corrigido F6.14A.1)
    // ==================================================================

    private const string ExpectedExecutablePath = @"C:\Nex\NexAdmin.exe";
    private const string ExpectedClassName = "TfrmPri";
    private const string TApplicationClassName = "TApplication";
    private const int ExpectedSessionId = 1;
    private const int NexAdminPid = 1316;
    private static readonly nint TfrmPriHwnd = 0x1000;
    private static readonly nint TApplicationHwnd = 0x0500;

    private static (WindowsNexWindowInspector Inspector, FakeNexProcessScanner Scanner, FakeNativeWindowApi Native, FakeNexUiAutomationReader Ui) BuildInspector()
    {
        var scanner = new FakeNexProcessScanner();
        var native = new FakeNativeWindowApi();
        var ui = new FakeNexUiAutomationReader();
        return (new WindowsNexWindowInspector(scanner, native, ui), scanner, native, ui);
    }

    /// <summary>Registra o cenario real observado ao vivo em F6.14A: a
    /// janela oculta TApplication (invisivel para o filtro de visibilidade
    /// - por isso nunca aparece em TopLevelWindowsByProcess) e a janela de
    /// negocio TfrmPri, visivel, com Owner = TApplication (Owner != 0).</summary>
    private static void RegisterRealisticNexAdminTopology(FakeNativeWindowApi native, nint tfrmPriHwnd, int pid, string tfrmPriClassName = ExpectedClassName)
    {
        // TApplication - evidencia real (F6.14A.1): IsWindowVisible == True
        // tecnicamente, mas com area 0x0 (assinatura estrita reconhecida
        // como infraestrutura em F6.14A.2) e Owner == 0.
        native.ValidWindows.Add(TApplicationHwnd);
        native.VisibleWindows.Add(TApplicationHwnd);
        native.OwningProcessByWindow[TApplicationHwnd] = pid;
        native.ClassNameByWindow[TApplicationHwnd] = TApplicationClassName;
        native.OwnerByWindow[TApplicationHwnd] = 0;
        native.RectByWindow[TApplicationHwnd] = (0, 0);

        // TfrmPri - a janela de negocio real: visivel, Owner != 0 (o
        // proprio TApplication), mas GetOwningProcessId (thread/processo
        // dono, NAO GW_OWNER) ainda e o mesmo PID.
        native.ValidWindows.Add(tfrmPriHwnd);
        native.VisibleWindows.Add(tfrmPriHwnd);
        native.OwningProcessByWindow[tfrmPriHwnd] = pid;
        native.ClassNameByWindow[tfrmPriHwnd] = tfrmPriClassName;
        native.OwnerByWindow[tfrmPriHwnd] = TApplicationHwnd;

        native.TopLevelWindowsByProcess[pid] = new[] { tfrmPriHwnd, TApplicationHwnd };
    }

    [Fact]
    public void G1_A_MainWindowHandleTApplication_TfrmPriEncontradoPorEnumeracao_LocatePassComHwndDoTfrmPri()
    {
        var (inspector, scanner, native, _) = BuildInspector();
        RegisterRealisticNexAdminTopology(native, TfrmPriHwnd, NexAdminPid);
        scanner.Candidates.Add(new NexProcessCandidate(NexAdminPid, ExpectedExecutablePath, ExpectedSessionId));

        var result = inspector.LocateNexAdmin(ExpectedSessionId);

        Assert.True(result.Passed);
        Assert.Equal(NexAdminPid, result.Identity!.ProcessId);
        // O ponto central da correcao: o HWND retornado e o da TfrmPri,
        // NUNCA o da TApplication (que nem aparece na enumeracao visivel).
        Assert.Equal(TfrmPriHwnd, result.Identity!.MainWindowHandle);
        Assert.NotEqual(TApplicationHwnd, result.Identity!.MainWindowHandle);
    }

    [Fact]
    public void G1_B_TfrmPriComOwnerDiferenteDeZero_ContinuaCandidatoValido()
    {
        // RegisterRealisticNexAdminTopology ja registra TfrmPri como tendo,
        // na pratica, Owner = TApplication (Owner != 0) - este teste
        // confirma explicitamente que isso NAO impede o match, ao contrario
        // do comportamento pre-F6.14A.1 (que exigia Owner == 0).
        var (inspector, scanner, native, _) = BuildInspector();
        RegisterRealisticNexAdminTopology(native, TfrmPriHwnd, NexAdminPid);
        scanner.Candidates.Add(new NexProcessCandidate(NexAdminPid, ExpectedExecutablePath, ExpectedSessionId));

        var result = inspector.LocateNexAdmin(ExpectedSessionId);

        Assert.True(result.Passed);
    }

    [Fact]
    public void G1_C_ZeroTfrmPriVisivel_NexNotFound()
    {
        var (inspector, scanner, native, _) = BuildInspector();
        // So a TApplication (oculta, fora da lista de visiveis) - nenhuma TfrmPri.
        native.TopLevelWindowsByProcess[NexAdminPid] = Array.Empty<nint>();
        scanner.Candidates.Add(new NexProcessCandidate(NexAdminPid, ExpectedExecutablePath, ExpectedSessionId));

        var result = inspector.LocateNexAdmin(ExpectedSessionId);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.NexNotFound, result.ErrorCode);
    }

    [Fact]
    public void G1_D_DuasTfrmPriVisiveis_NexNotFoundPorAmbiguidade()
    {
        var (inspector, scanner, native, _) = BuildInspector();
        var segundaTfrmPri = (nint)0x2000;
        native.ValidWindows.Add(segundaTfrmPri);
        native.VisibleWindows.Add(segundaTfrmPri);
        native.OwningProcessByWindow[segundaTfrmPri] = NexAdminPid;
        native.ClassNameByWindow[segundaTfrmPri] = ExpectedClassName;
        RegisterRealisticNexAdminTopology(native, TfrmPriHwnd, NexAdminPid);
        native.TopLevelWindowsByProcess[NexAdminPid] = new[] { TfrmPriHwnd, segundaTfrmPri };
        scanner.Candidates.Add(new NexProcessCandidate(NexAdminPid, ExpectedExecutablePath, ExpectedSessionId));

        var result = inspector.LocateNexAdmin(ExpectedSessionId);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.NexNotFound, result.ErrorCode);
    }

    [Fact]
    public void G1_E_TApplicationOcultoNaoAparecendoNaEnumeracaoVisivel_NaoInterfereNaLocalizacao()
    {
        // Cenario explicito: TApplication existe (registrado como janela
        // valida com ClassName TApplication) mas NAO esta na lista de
        // top-level visiveis (representando "oculto") - a presenca dela no
        // sistema nao deve, de forma alguma, impedir o match da TfrmPri.
        var (inspector, scanner, native, _) = BuildInspector();
        RegisterRealisticNexAdminTopology(native, TfrmPriHwnd, NexAdminPid);
        scanner.Candidates.Add(new NexProcessCandidate(NexAdminPid, ExpectedExecutablePath, ExpectedSessionId));

        var result = inspector.LocateNexAdmin(ExpectedSessionId);

        Assert.True(result.Passed);
        Assert.Equal(TfrmPriHwnd, result.Identity!.MainWindowHandle);
    }

    [Fact]
    public void G1_ExecutavelErrado_NexNotFound()
    {
        var (inspector, scanner, native, _) = BuildInspector();
        RegisterRealisticNexAdminTopology(native, TfrmPriHwnd, NexAdminPid);
        scanner.Candidates.Add(new NexProcessCandidate(NexAdminPid, @"C:\OutroPrograma\Fake.exe", ExpectedSessionId));

        var result = inspector.LocateNexAdmin(ExpectedSessionId);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.NexNotFound, result.ErrorCode);
    }

    [Fact]
    public void G1_ZeroCandidatos_NexNotFound()
    {
        var (inspector, _, _, _) = BuildInspector();

        var result = inspector.LocateNexAdmin(ExpectedSessionId);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.NexNotFound, result.ErrorCode);
    }

    [Fact]
    public void G1_SessaoDoNexAdminDiferenteDaEsperada_SessionUnavailable()
    {
        var (inspector, scanner, native, _) = BuildInspector();
        RegisterRealisticNexAdminTopology(native, TfrmPriHwnd, NexAdminPid);
        scanner.Candidates.Add(new NexProcessCandidate(NexAdminPid, ExpectedExecutablePath, SessionId: 0));

        var result = inspector.LocateNexAdmin(expectedSessionId: 1);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.SessionUnavailable, result.ErrorCode);
    }

    [Fact]
    public void G1_ScannerLancaExcecao_NexNotFoundSemEscapar()
    {
        var (inspector, scanner, _, _) = BuildInspector();
        scanner.ThrowOnScan = new InvalidOperationException("falha ao enumerar processos (simulado)");

        AgentErrorCode code = AgentErrorCode.None;
        var exception = Record.Exception(() => code = inspector.LocateNexAdmin(ExpectedSessionId).ErrorCode);

        Assert.Null(exception);
        Assert.Equal(AgentErrorCode.NexNotFound, code);
    }

    [Fact]
    public void G1_EnumeracaoDeJanelasLancaExcecao_NexNotFoundSemEscapar()
    {
        var (inspector, scanner, native, _) = BuildInspector();
        native.ThrowOnEnumerate = new InvalidOperationException("EnumWindows falhou (simulado)");
        scanner.Candidates.Add(new NexProcessCandidate(NexAdminPid, ExpectedExecutablePath, ExpectedSessionId));

        var exception = Record.Exception(() => inspector.LocateNexAdmin(ExpectedSessionId));

        Assert.Null(exception);
    }

    // ==================================================================
    // INexWindowInspector real - CheckSafeState (G3-G6, corrigido F6.14A.2)
    // ==================================================================
    //
    // F6.14A.2: G3 deixou de "contar janelas visiveis" e passou a
    // CLASSIFICAR cada uma contra 2 assinaturas estritas e fechadas
    // (TApplication oculta/area 0x0; TfrmIntercom "Atendimento" filho da
    // target) - qualquer coisa que nao bata exatamente cai em
    // BlockingUnknown e falha. Infraestrutura NAO precisa estar presente
    // (teste L) - so e validada estritamente QUANDO existir.

    private static NexAdminWindowIdentity ValidTarget => new(processId: NexAdminPid, mainWindowHandle: TfrmPriHwnd);
    private static readonly nint IntercomHwnd = 0x4000;

    /// <summary>Registra a target (TfrmPri) + TApplication com assinatura
    /// estrita valida (Owner=0, rect 0x0) - baseline minimo, SEM Intercom
    /// (o teste L exige que isso j\u00e1 baste para PASS).</summary>
    private static (WindowsNexWindowInspector Inspector, FakeNativeWindowApi Native, FakeNexUiAutomationReader Ui) BuildSafeStateFixture()
    {
        var (inspector, _, native, ui) = BuildInspector();
        RegisterRealisticNexAdminTopology(native, TfrmPriHwnd, NexAdminPid);
        ui.PresentElementNames.Add("Vendas");
        ui.PresentElementNames.Add("Hist\u00f3rico");
        ui.VisibleElementNames.Add("Hist\u00f3rico");
        return (inspector, native, ui);
    }

    private static void RegisterValidIntercom(FakeNativeWindowApi native, FakeNexUiAutomationReader ui, nint hwnd, nint owner, string name = "Atendimento")
    {
        native.ValidWindows.Add(hwnd);
        native.VisibleWindows.Add(hwnd);
        native.OwningProcessByWindow[hwnd] = NexAdminPid;
        native.ClassNameByWindow[hwnd] = "TfrmIntercom";
        native.OwnerByWindow[hwnd] = owner;
        ui.OwnNameByWindow[hwnd] = name;
    }

    private static void AddToVisibleTopLevelList(FakeNativeWindowApi native, params nint[] hwnds) =>
        native.TopLevelWindowsByProcess[NexAdminPid] = hwnds;

    // ---- A: target + TApplication (0x0) + Intercom valido -> PASS ----
    [Fact]
    public void G3_A_TargetMaisTApplicationZeroSizeMaisIntercomValido_Pass()
    {
        var (inspector, native, ui) = BuildSafeStateFixture();
        RegisterValidIntercom(native, ui, IntercomHwnd, owner: TfrmPriHwnd);
        AddToVisibleTopLevelList(native, TfrmPriHwnd, TApplicationHwnd, IntercomHwnd);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.True(result.Passed);
    }

    // ---- B: TApplication IsWindowVisible=True mas rect=0x0 -> infra ----
    [Fact]
    public void G3_B_TApplicationVisivelMasRectZero_ReconhecidaComoInfra()
    {
        var (inspector, _, _) = BuildSafeStateFixture(); // ja registra TApplication com rect 0x0 e Visible

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.True(result.Passed);
    }

    // ---- C: TApplication com rect > 0 -> FAIL ----
    [Fact]
    public void G3_C_TApplicationComAreaUtilizavel_Falha()
    {
        var (inspector, native, _) = BuildSafeStateFixture();
        native.RectByWindow[TApplicationHwnd] = (800, 600);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    // ---- D: GetWindowRect falha para a TApplication -> FAIL ----
    [Fact]
    public void G3_D_TApplicationGetWindowRectFalha_Falha()
    {
        var (inspector, native, _) = BuildSafeStateFixture();
        native.RectByWindow.Remove(TApplicationHwnd); // simula falha de GetWindowRect

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    // ---- E: 2 TApplication -> FAIL ----
    [Fact]
    public void G3_E_DuasTApplicationValidas_Falha()
    {
        var (inspector, native, _) = BuildSafeStateFixture();
        var segundaTApplication = (nint)0x0501;
        native.ValidWindows.Add(segundaTApplication);
        native.VisibleWindows.Add(segundaTApplication);
        native.OwningProcessByWindow[segundaTApplication] = NexAdminPid;
        native.ClassNameByWindow[segundaTApplication] = "TApplication";
        native.OwnerByWindow[segundaTApplication] = 0;
        native.RectByWindow[segundaTApplication] = (0, 0);
        AddToVisibleTopLevelList(native, TfrmPriHwnd, TApplicationHwnd, segundaTApplication);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    // ---- F: TfrmIntercom + Owner=target + Name=Atendimento -> infra ----
    [Fact]
    public void G3_F_IntercomComOwnerETargetComNomeAtendimento_ReconhecidoComoInfra()
    {
        var (inspector, native, ui) = BuildSafeStateFixture();
        RegisterValidIntercom(native, ui, IntercomHwnd, owner: TfrmPriHwnd);
        AddToVisibleTopLevelList(native, TfrmPriHwnd, TApplicationHwnd, IntercomHwnd);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.True(result.Passed);
    }

    // ---- G: TfrmIntercom com Owner diferente -> FAIL ----
    [Fact]
    public void G3_G_IntercomComOwnerDiferenteDaTarget_Falha()
    {
        var (inspector, native, ui) = BuildSafeStateFixture();
        RegisterValidIntercom(native, ui, IntercomHwnd, owner: 0); // owner != target
        AddToVisibleTopLevelList(native, TfrmPriHwnd, TApplicationHwnd, IntercomHwnd);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    // ---- H: TfrmIntercom com Name diferente -> FAIL ----
    [Fact]
    public void G3_H_IntercomComNomeDiferente_Falha()
    {
        var (inspector, native, ui) = BuildSafeStateFixture();
        RegisterValidIntercom(native, ui, IntercomHwnd, owner: TfrmPriHwnd, name: "Outro Widget");
        AddToVisibleTopLevelList(native, TfrmPriHwnd, TApplicationHwnd, IntercomHwnd);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    [Fact]
    public void G3_IntercomComNomeIlegivel_FailClosed()
    {
        var (inspector, native, ui) = BuildSafeStateFixture();
        // Registrado sem OwnNameByWindow -> GetOwnName retorna null (fail-closed).
        native.ValidWindows.Add(IntercomHwnd);
        native.VisibleWindows.Add(IntercomHwnd);
        native.OwningProcessByWindow[IntercomHwnd] = NexAdminPid;
        native.ClassNameByWindow[IntercomHwnd] = "TfrmIntercom";
        native.OwnerByWindow[IntercomHwnd] = TfrmPriHwnd;
        AddToVisibleTopLevelList(native, TfrmPriHwnd, TApplicationHwnd, IntercomHwnd);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    // ---- I: 2 TfrmIntercom validos -> FAIL ----
    [Fact]
    public void G3_I_DoisIntercomValidos_Falha()
    {
        var (inspector, native, ui) = BuildSafeStateFixture();
        var segundoIntercom = (nint)0x4001;
        RegisterValidIntercom(native, ui, IntercomHwnd, owner: TfrmPriHwnd);
        RegisterValidIntercom(native, ui, segundoIntercom, owner: TfrmPriHwnd);
        AddToVisibleTopLevelList(native, TfrmPriHwnd, TApplicationHwnd, IntercomHwnd, segundoIntercom);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    // ---- J: janela top-level visivel desconhecida -> FAIL ----
    [Fact]
    public void G3_J_JanelaTopLevelVisivelDesconhecida_Falha()
    {
        var (inspector, native, _) = BuildSafeStateFixture();
        var desconhecida = (nint)0x5000;
        native.ValidWindows.Add(desconhecida);
        native.VisibleWindows.Add(desconhecida);
        native.OwningProcessByWindow[desconhecida] = NexAdminPid;
        native.ClassNameByWindow[desconhecida] = "TAlgumaCoisaNuncaVista";
        AddToVisibleTopLevelList(native, TfrmPriHwnd, TApplicationHwnd, desconhecida);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    // ---- K: modal visivel pertencente ao target -> FAIL, independente do Owner ----
    [Fact]
    public void G3_K_ModalVisivelPertencenteAoTarget_FalhaIndependenteDoOwner()
    {
        var (inspector, native, _) = BuildSafeStateFixture();
        var modal = (nint)0x6000;
        native.ValidWindows.Add(modal);
        native.VisibleWindows.Add(modal);
        native.OwningProcessByWindow[modal] = NexAdminPid;
        native.ClassNameByWindow[modal] = "TfrmPagamento";
        native.OwnerByWindow[modal] = TfrmPriHwnd; // Owner == target, mesmo assim inseguro
        AddToVisibleTopLevelList(native, TfrmPriHwnd, TApplicationHwnd, modal);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    // ---- L: apenas target, sem Intercom/TApplication -> PASS ----
    [Fact]
    public void G3_L_ApenasTarget_SemInfraestruturaNenhuma_Pass()
    {
        var (inspector, native, _) = BuildSafeStateFixture();
        AddToVisibleTopLevelList(native, TfrmPriHwnd); // so a target, nada mais

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.True(result.Passed);
    }

    // ---- M: target invalido -> FAIL (ja coberto, mantido explicitamente) ----
    [Fact]
    public void G3_M_TargetInvalido_Falha()
    {
        var (inspector, native, _) = BuildSafeStateFixture();
        native.ValidWindows.Remove(TfrmPriHwnd);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.NexNotFound, result.ErrorCode);
    }

    [Fact]
    public void CheckSafeState_TudoValido_RetornaPass()
    {
        var (inspector, _, _) = BuildSafeStateFixture();

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.True(result.Passed);
    }

    [Fact]
    public void CheckSafeState_TargetHwndPertenceAOutroPid_Falha()
    {
        var (inspector, native, _) = BuildSafeStateFixture();
        native.OwningProcessByWindow[TfrmPriHwnd] = 9999;

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.NexNotFound, result.ErrorCode);
    }

    [Fact]
    public void CheckSafeState_TargetPerdeuClassNameTfrmPri_Falha()
    {
        var (inspector, native, _) = BuildSafeStateFixture();
        native.ClassNameByWindow[TfrmPriHwnd] = "OutraClasse";

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.NexNotFound, result.ErrorCode);
    }

    [Fact]
    public void CheckSafeState_TargetDeixouDeExistir_Falha()
    {
        var (inspector, native, _) = BuildSafeStateFixture();
        native.ValidWindows.Remove(TfrmPriHwnd);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.NexNotFound, result.ErrorCode);
    }

    [Fact]
    public void CheckSafeState_TargetFicouInvisivel_Falha()
    {
        var (inspector, native, _) = BuildSafeStateFixture();
        native.VisibleWindows.Remove(TfrmPriHwnd);

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    [Fact]
    public void CheckSafeState_EnumeracaoDeJanelasLancaExcecao_FalhaSemEscapar()
    {
        var (inspector, native, _) = BuildSafeStateFixture();
        native.ThrowOnEnumerate = new InvalidOperationException("EnumWindows falhou (simulado)");

        var exception = Record.Exception(() => inspector.CheckSafeState(ValidTarget));

        Assert.Null(exception);
    }

    [Fact]
    public void CheckSafeState_ClassificacaoLancaExcecaoViaUiAutomation_FalhaSemEscapar()
    {
        var (inspector, native, ui) = BuildSafeStateFixture();
        RegisterValidIntercom(native, ui, IntercomHwnd, owner: TfrmPriHwnd);
        AddToVisibleTopLevelList(native, TfrmPriHwnd, TApplicationHwnd, IntercomHwnd);
        ui.ThrowOnQuery = new InvalidOperationException("UI Automation falhou ao ler Name (simulado)");

        var exception = Record.Exception(() => inspector.CheckSafeState(ValidTarget));

        Assert.Null(exception);
    }

    // ---- G4: aba Vendas ----
    [Fact]
    public void G4_VendasPresente_ContinuaParaProximoGate()
    {
        var (inspector, _, _) = BuildSafeStateFixture();

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.True(result.Passed);
    }

    [Fact]
    public void G4_VendasAusente_Falha()
    {
        var (inspector, _, ui) = BuildSafeStateFixture();
        ui.PresentElementNames.Remove("Vendas");

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    // ---- G5: aba Historico presente + visivel ----
    [Fact]
    public void G5_HistoricoPresenteEVisivel_Pass()
    {
        var (inspector, _, _) = BuildSafeStateFixture();

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.True(result.Passed);
    }

    [Fact]
    public void G5_HistoricoAusente_Falha()
    {
        var (inspector, _, ui) = BuildSafeStateFixture();
        ui.PresentElementNames.Remove("Hist\u00f3rico");
        ui.VisibleElementNames.Remove("Hist\u00f3rico");

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    [Fact]
    public void G5_HistoricoPresenteMasOffscreen_Falha()
    {
        var (inspector, _, ui) = BuildSafeStateFixture();
        ui.VisibleElementNames.Remove("Hist\u00f3rico"); // presente mas nao visivel

        var result = inspector.CheckSafeState(ValidTarget);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
    }

    [Fact]
    public void CheckSafeState_UiAutomationLancaExcecao_FalhaSemEscapar()
    {
        var (inspector, _, ui) = BuildSafeStateFixture();
        ui.ThrowOnQuery = new InvalidOperationException("UI Automation falhou (simulado)");

        var exception = Record.Exception(() => inspector.CheckSafeState(ValidTarget));

        Assert.Null(exception);
    }
}
