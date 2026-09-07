using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (V1 - extrato individual por cliente) de
/// WindowsNexClientNavigator. CORRECAO ARQUITETURAL (pos Probes 10A-10D):
/// F2 foi REMOVIDO do caminho de OpenClientByCode - a abertura agora e'
/// por clique direto (PostMessage WM_LBUTTONDOWN/UP) no ponto calibrado
/// do TcxGridSite (NexClientsGridOpenProfile). ZERO chamada Win32/NEX
/// real - toda interacao passa por FakeNativeWindowApi +
/// FakeNexClientNavigationNativeApi + FakeDelay.
/// </summary>
public sealed class WindowsNexClientNavigatorTests
{
    private const int Pid = 22240;
    private static readonly nint MainWindow = 0x1000;
    private static readonly nint SearchField = 0x2000;
    private static readonly nint GridHwnd = 0x2500;
    private static readonly nint ClientWindow = 0x3000;
    private static readonly nint CodeControl = 0x4000;
    private static readonly nint NameControl = 0x4001;
    private static readonly nint TransactionsTabHwnd = 0x5000;

    private static readonly Domain.NexAdminWindowIdentity Target = new(Pid, MainWindow);

    // Geometria homologada (NexClientsGridOpenProfile) - usada em todos os
    // testes do caminho feliz.
    private static readonly (int, int, int, int) ExpectedTFrmPriRect = (-10, -10, 1930, 1030);
    private static readonly (int, int, int, int) ExpectedGridWindowRect = (245, 204, 1920, 1020);
    private const int ExpectedGridClientWidth = 1675;
    private const int ExpectedGridClientHeight = 816;

    private sealed class Fixture
    {
        public FakeNativeWindowApi ReadOnly { get; } = new();
        public FakeNexClientNavigationNativeApi Native { get; } = new();
        public FakeDelay Delay { get; } = new();
        public WindowsNexClientNavigator Navigator { get; }

        public Fixture()
        {
            Navigator = new WindowsNexClientNavigator(ReadOnly, Native, Delay);

            // Estado base: TFrmPri em foreground, campo de busca presente,
            // grid presente com geometria homologada, sem TFrmCadCli aberta.
            Native.ForegroundWindow = MainWindow;
            Native.OwningProcessByHwnd[MainWindow] = Pid;
            Native.ChildrenByParent[MainWindow] = new List<nint> { SearchField, GridHwnd };
            Native.ClassNameByHwnd[SearchField] = "TcxTextEdit";
            Native.ValidWindows.Add(SearchField);

            Native.ClassNameByHwnd[GridHwnd] = "TcxGridSite";
            Native.OwningProcessByHwnd[GridHwnd] = Pid;
            Native.ValidWindows.Add(GridHwnd);
            Native.VisibleWindows.Add(GridHwnd);
            Native.EnabledWindows.Add(GridHwnd);
            Native.WindowRectByHwnd[MainWindow] = ExpectedTFrmPriRect;
            Native.WindowRectByHwnd[GridHwnd] = ExpectedGridWindowRect;
            Native.ClientSizeByHwnd[GridHwnd] = (ExpectedGridClientWidth, ExpectedGridClientHeight);

            ReadOnly.TopLevelWindowsByProcess[Pid] = new List<nint>(); // nenhuma TFrmCadCli ainda
        }

        private int _waitCount;

        /// <summary>Simula a janela do cliente aparecendo SOMENTE depois do
        /// clique no grid (nao antes) - a primeira chamada a Delay.Wait()
        /// e' o settle de 1000ms, a segunda e' o dwell do clique, as
        /// seguintes sao o polling; so populamos a janela a partir da 3a
        /// chamada em diante.</summary>
        public void SetClientWindowAppearsAfterClick(string code, string name)
        {
            ReadOnly.ClassNameByWindow[ClientWindow] = "TFrmCadCli";
            Native.ChildrenByParent[ClientWindow] = new List<nint> { CodeControl, NameControl };
            Native.ClassNameByHwnd[CodeControl] = "TcxDBMaskEdit";
            Native.ClassNameByHwnd[NameControl] = "TcxDBTextEdit";
            Native.TextByHwnd[CodeControl] = code;
            Native.TextByHwnd[NameControl] = name;

            Delay.OnWait = _ =>
            {
                _waitCount++;
                if (_waitCount >= 3)
                {
                    ReadOnly.TopLevelWindowsByProcess[Pid] = new List<nint> { ClientWindow };
                }
            };
        }
    }

    [Fact]
    public void A_SearchReadbackCorreto_Prossegue()
    {
        var f = new Fixture();
        f.SetClientWindowAppearsAfterClick("292", "MATHEUS HENRIQUE DEPRE");

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.True(result.Passed);
        Assert.Equal("292", result.Client!.ClientCode);
        Assert.Equal("MATHEUS HENRIQUE DEPRE", result.Client.ClientName);
    }

    [Fact]
    public void B_SearchReadbackDivergente_BlockedSemClique()
    {
        var f = new Fixture();
        f.Native.ForceReadbackValue = "999"; // diverge do "292" escrito

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientSearchReadbackMismatch, result.ErrorCode);
        Assert.Equal(0, f.Native.PostMouseDownCalls);
        Assert.Equal(0, f.Delay.WaitCalls); // nem o settle delay chegou a ser aguardado
    }

    [Fact]
    public void C_CliqueAbreTFrmCadCliCorreta_Pass()
    {
        var f = new Fixture();
        f.SetClientWindowAppearsAfterClick("292", "MATHEUS HENRIQUE DEPRE");

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.True(result.Passed);
    }

    [Fact]
    public void D_CliqueSemEfeito_TimeoutSemRetry()
    {
        var f = new Fixture();
        // TFrmCadCli nunca aparece

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientWindowNotFound, result.ErrorCode);
    }

    [Fact]
    public void E_ClienteErradoPosClique_FailClosed()
    {
        var f = new Fixture();
        f.SetClientWindowAppearsAfterClick("999", "OUTRO CLIENTE");

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientIdentityMismatch, result.ErrorCode);
    }

    [Fact]
    public void AA_ExpectedClientNameAusente_InputRejeitadoAntesDeTocarNoNex()
    {
        Assert.Throws<ArgumentException>(() => new ClientNavigationTarget("292", ""));
        Assert.Throws<ArgumentException>(() => new ClientNavigationTarget("292", "   "));
    }

    // ---------- F2 removido ----------

    [Fact]
    public void F2_NuncaUsadoPeloNavigator()
    {
        var f = new Fixture();
        f.SetClientWindowAppearsAfterClick("292", "MATHEUS HENRIQUE DEPRE");

        f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.Equal(0, f.Native.PostKeyDownCalls);
        Assert.Equal(0, f.Native.PostKeyUpCalls);
    }

    // ---------- Correcao: search filter settlement (agora 1000ms) ----------

    [Fact]
    public void SettleDelay_ChamadoExatamenteUmaVez_ComDuracao1000ms()
    {
        var f = new Fixture();
        f.SetClientWindowAppearsAfterClick("292", "MATHEUS HENRIQUE DEPRE");

        f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.Equal(1, f.Delay.Durations.Count(d => d == TimeSpan.FromMilliseconds(1000)));
    }

    [Fact]
    public void SettleDelay_GridReacquiredSomenteAposSettle()
    {
        var f = new Fixture();
        f.SetClientWindowAppearsAfterClick("292", "MATHEUS HENRIQUE DEPRE");

        // Remove o grid ANTES da espera de settle comecar - se o
        // navigator consultasse o grid antes do settle (ordem errada no
        // codigo-fonte), o teste falharia com ClientGridNotFound em vez
        // de PASS, pois o grid so e' reinserido dentro do OnWait (ou
        // seja, so existe a partir do momento em que o settle de fato
        // ocorreu).
        f.Native.ChildrenByParent[MainWindow] = new List<nint> { SearchField };
        var originalOnWait = f.Delay.OnWait;
        f.Delay.OnWait = duration =>
        {
            if (duration == TimeSpan.FromMilliseconds(1000))
            {
                f.Native.ChildrenByParent[MainWindow] = new List<nint> { SearchField, GridHwnd };
            }
            originalOnWait?.Invoke(duration);
        };

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.True(result.Passed);
    }

    [Fact]
    public void SettleDelay_SeReadbackMudaDuranteAEspera_ZeroClique()
    {
        var f = new Fixture();
        f.Delay.OnWait = duration =>
        {
            if (duration == TimeSpan.FromMilliseconds(1000))
            {
                f.Native.ForceReadbackValue = "999";
            }
        };

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientContextChangedDuringSettle, result.ErrorCode);
    }

    // ---------- Grid reacquire ----------

    [Fact]
    public void Grid_ZeroCandidatos_FailSemPostMessage()
    {
        var f = new Fixture();
        f.Native.ChildrenByParent[MainWindow] = new List<nint> { SearchField }; // grid removido

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientGridNotFound, result.ErrorCode);
    }

    [Fact]
    public void Grid_MultiploCandidatosVisiveis_FailSemPostMessage()
    {
        var f = new Fixture();
        var secondGrid = (nint)0x2600;
        f.Native.ClassNameByHwnd[secondGrid] = "TcxGridSite";
        f.Native.OwningProcessByHwnd[secondGrid] = Pid;
        // Segundo grid TAMBEM visivel/valido - ambiguidade real entre 2
        // candidatos que passariam no filtro de visibilidade.
        f.Native.ValidWindows.Add(secondGrid);
        f.Native.VisibleWindows.Add(secondGrid);
        f.Native.EnabledWindows.Add(secondGrid);
        f.Native.ChildrenByParent[MainWindow] = new List<nint> { SearchField, GridHwnd, secondGrid };

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientGridAmbiguous, result.ErrorCode);
        Assert.Equal(0, f.Native.PostMouseDownCalls);
    }

    // ---------- Correcao pos-3o OnceProbe: filtro de visibilidade do grid ----------

    [Fact]
    public void A_QuatroGridsUmVisivelTresInvisiveis_SelecionaExatamenteOVisivel()
    {
        var f = new Fixture();
        f.SetClientWindowAppearsAfterClick("292", "MATHEUS HENRIQUE DEPRE");

        // 3 grids adicionais de OUTRAS abas (Vendas, Produtos, etc.) -
        // mesma classe, mesmo PID, geometria ate poderia bater, mas
        // INVISIVEIS - nunca devem participar da selecao.
        var vendasGrid = (nint)0x2601;
        var produtosGrid = (nint)0x2602;
        var estoqueGrid = (nint)0x2603;
        foreach (var h in new[] { vendasGrid, produtosGrid, estoqueGrid })
        {
            f.Native.ClassNameByHwnd[h] = "TcxGridSite";
            f.Native.OwningProcessByHwnd[h] = Pid;
            f.Native.ValidWindows.Add(h); // valido mas NAO visivel
            f.Native.WindowRectByHwnd[h] = ExpectedGridWindowRect; // ate geometria bate
            f.Native.ClientSizeByHwnd[h] = (ExpectedGridClientWidth, ExpectedGridClientHeight);
        }
        f.Native.ChildrenByParent[MainWindow] = new List<nint> { SearchField, GridHwnd, vendasGrid, produtosGrid, estoqueGrid };

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.True(result.Passed);
        Assert.Equal(1, f.Native.PostMouseDownCalls);
        Assert.Equal(GridHwnd, f.Native.LastMouseDownArgs!.Value.hWnd); // clicou exatamente no grid visivel, nunca nos invisiveis
    }

    [Fact]
    public void B_QuatroGridsZeroVisiveis_ClientGridNotFound_ZeroPostMessage()
    {
        var f = new Fixture();
        f.Native.VisibleWindows.Remove(GridHwnd); // o grid "padrao" da fixture tambem fica invisivel
        var g2 = (nint)0x2601;
        var g3 = (nint)0x2602;
        var g4 = (nint)0x2603;
        foreach (var h in new[] { g2, g3, g4 })
        {
            f.Native.ClassNameByHwnd[h] = "TcxGridSite";
            f.Native.OwningProcessByHwnd[h] = Pid;
            f.Native.ValidWindows.Add(h);
        }
        f.Native.ChildrenByParent[MainWindow] = new List<nint> { SearchField, GridHwnd, g2, g3, g4 };

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientGridNotFound, result.ErrorCode);
        Assert.Equal(0, f.Native.PostMouseDownCalls);
    }

    [Fact]
    public void C_QuatroGridsDoisVisiveis_ClientGridAmbiguous_ZeroPostMessage()
    {
        var f = new Fixture();
        var outroVisivel = (nint)0x2601;
        var doisInvisiveis = new[] { (nint)0x2602, (nint)0x2603 };

        f.Native.ClassNameByHwnd[outroVisivel] = "TcxGridSite";
        f.Native.OwningProcessByHwnd[outroVisivel] = Pid;
        f.Native.ValidWindows.Add(outroVisivel);
        f.Native.VisibleWindows.Add(outroVisivel);
        f.Native.EnabledWindows.Add(outroVisivel);

        foreach (var h in doisInvisiveis)
        {
            f.Native.ClassNameByHwnd[h] = "TcxGridSite";
            f.Native.OwningProcessByHwnd[h] = Pid;
            f.Native.ValidWindows.Add(h); // invisivel de proposito
        }

        f.Native.ChildrenByParent[MainWindow] = new List<nint> { SearchField, GridHwnd, outroVisivel, doisInvisiveis[0], doisInvisiveis[1] };

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientGridAmbiguous, result.ErrorCode);
        Assert.Equal(0, f.Native.PostMouseDownCalls);
    }

    [Fact]
    public void D_GridInvisivelComGeometriaHomologada_SoOVisivelParticipa()
    {
        var f = new Fixture();
        f.SetClientWindowAppearsAfterClick("292", "MATHEUS HENRIQUE DEPRE");

        // Grid invisivel com a MESMA geometria homologada do grid visivel -
        // mesmo assim NUNCA deve ser escolhido nem causar ambiguidade,
        // porque e' filtrado por visibilidade antes da cardinalidade.
        var invisibleWithSameGeometry = (nint)0x2601;
        f.Native.ClassNameByHwnd[invisibleWithSameGeometry] = "TcxGridSite";
        f.Native.OwningProcessByHwnd[invisibleWithSameGeometry] = Pid;
        f.Native.ValidWindows.Add(invisibleWithSameGeometry);
        f.Native.WindowRectByHwnd[invisibleWithSameGeometry] = ExpectedGridWindowRect;
        f.Native.ClientSizeByHwnd[invisibleWithSameGeometry] = (ExpectedGridClientWidth, ExpectedGridClientHeight);
        f.Native.ChildrenByParent[MainWindow] = new List<nint> { SearchField, GridHwnd, invisibleWithSameGeometry };

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.True(result.Passed);
        Assert.Equal(GridHwnd, f.Native.LastMouseDownArgs!.Value.hWnd);
    }

    [Fact]
    public void E_UnicoGridVisivel_MasGeometryMismatch_ZeroPostMessage()
    {
        var f = new Fixture();
        f.Native.WindowRectByHwnd[GridHwnd] = (1, 1, 1, 1); // diverge

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientGridGeometryMismatch, result.ErrorCode);
        Assert.Equal(0, f.Native.PostMouseDownCalls);
    }

    [Fact]
    public void G_HwndAntigoNuncaReutilizado_CadaChamadaReacquireFresco()
    {
        var f = new Fixture();
        f.SetClientWindowAppearsAfterClick("292", "MATHEUS HENRIQUE DEPRE");

        f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));
        var firstClickHwnd = f.Native.LastMouseDownArgs!.Value.hWnd;

        Assert.Equal(GridHwnd, firstClickHwnd); // reacquire sempre aponta para o HWND fresco valido, nunca um cache antigo
    }

    [Fact]
    public void H_F2ContinuaZeroDownZeroUp_MesmoNoCaminhoFeliz()
    {
        var f = new Fixture();
        f.SetClientWindowAppearsAfterClick("292", "MATHEUS HENRIQUE DEPRE");

        f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.Equal(0, f.Native.PostKeyDownCalls);
        Assert.Equal(0, f.Native.PostKeyUpCalls);
    }

    // ---------- Geometry gate ----------

    [Fact]
    public void Geometry_TFrmPriMismatch_ZeroPostMessage()
    {
        var f = new Fixture();
        f.Native.WindowRectByHwnd[MainWindow] = (0, 0, 1920, 1080); // diverge

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientGridGeometryMismatch, result.ErrorCode);
    }

    [Fact]
    public void Geometry_GridWindowMismatch_ZeroPostMessage()
    {
        var f = new Fixture();
        f.Native.WindowRectByHwnd[GridHwnd] = (0, 0, 800, 600); // diverge

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientGridGeometryMismatch, result.ErrorCode);
    }

    [Fact]
    public void Geometry_GridClientMismatch_ZeroPostMessage()
    {
        var f = new Fixture();
        f.Native.ClientSizeByHwnd[GridHwnd] = (999, 999); // diverge

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientGridGeometryMismatch, result.ErrorCode);
    }

    // ---------- Ponto/lParam calibrados ----------

    [Fact]
    public void CalibratedPoint_Is83x88()
    {
        Assert.Equal(83, PrimeNexExportAgent.WindowsNative.NexClientsGridOpenProfile.EditClientPointX);
        Assert.Equal(88, PrimeNexExportAgent.WindowsNative.NexClientsGridOpenProfile.EditClientPointY);
    }

    [Fact]
    public void CalibratedLParam_Is0x00580053()
    {
        var lparam = (uint)((PrimeNexExportAgent.WindowsNative.NexClientsGridOpenProfile.EditClientPointY << 16)
                             | (PrimeNexExportAgent.WindowsNative.NexClientsGridOpenProfile.EditClientPointX & 0xFFFF));
        Assert.Equal(0x00580053u, lparam);
    }

    // ---------- DOWN/UP exatamente 1, sem retry ----------

    [Fact]
    public void Click_DownExatamenteUma_UpExatamenteUma()
    {
        var f = new Fixture();
        f.SetClientWindowAppearsAfterClick("292", "MATHEUS HENRIQUE DEPRE");

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.True(result.Passed);
        Assert.Equal(1, f.Native.PostMouseDownCalls);
        Assert.Equal(1, f.Native.PostMouseUpCalls);
    }

    [Fact]
    public void PostDownFalha_NenhumSegundoDown()
    {
        var f = new Fixture();
        f.Native.MouseDownResult = (false, 5);

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientGridClickFailed, result.ErrorCode);
        Assert.Equal(1, f.Native.PostMouseDownCalls); // exatamente 1 tentativa, nunca 2
    }

    [Fact]
    public void PostUpFalha_FailClosedSemRetry()
    {
        var f = new Fixture();
        f.Native.MouseUpResult = (false, 5);

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientGridClickFailed, result.ErrorCode);
        Assert.Equal(1, f.Native.PostMouseDownCalls);
        Assert.Equal(1, f.Native.PostMouseUpCalls); // exatamente 1 tentativa, nunca 2
    }

    [Fact]
    public void PostMessageTrueSemTFrmCadCli_NoEffectSemRetry()
    {
        var f = new Fixture();
        // MouseDownResult/MouseUpResult default = (true, 0), mas nenhuma
        // TFrmCadCli aparece.

        var result = f.Navigator.OpenClientByCode(Target, new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ClientWindowNotFound, result.ErrorCode);
    }

    // ---------- G - J: aba Transacoes (inalterado) ----------

    [Fact]
    public void G_TransacoesHwndUnico_Abre()
    {
        var f = new Fixture();
        var client = new OpenedClientIdentity(ClientWindow, "292", "MATHEUS HENRIQUE DEPRE");
        f.Native.ValidWindows.Add(ClientWindow);
        f.Native.ChildrenByParent[ClientWindow] = new List<nint> { TransactionsTabHwnd, CodeControl, NameControl };
        f.Native.ClassNameByHwnd[TransactionsTabHwnd] = "TdxFormattedLabel";
        f.Native.TextByHwnd[TransactionsTabHwnd] = "Transações";
        f.Native.ClassNameByHwnd[CodeControl] = "TcxDBMaskEdit";
        f.Native.TextByHwnd[CodeControl] = "292";
        f.Native.ClassNameByHwnd[NameControl] = "TcxDBTextEdit";
        f.Native.TextByHwnd[NameControl] = "MATHEUS HENRIQUE DEPRE";
        var indicatorHwnds = new List<nint> { 0x6001, 0x6002, 0x6003 };
        foreach (var h in indicatorHwnds) f.Native.VisibleWindows.Add(h);
        f.Native.TextByHwnd[0x6001] = "Pagamento";
        f.Native.TextByHwnd[0x6002] = "Observações";
        f.Native.TextByHwnd[0x6003] = "Filtrar";
        f.Native.ChildrenByParent[ClientWindow] = new List<nint> { TransactionsTabHwnd, CodeControl, NameControl, 0x6001, 0x6002, 0x6003 };
        f.Native.ValidWindows.Add(TransactionsTabHwnd);
        f.Native.VisibleWindows.Add(TransactionsTabHwnd);
        f.Native.EnabledWindows.Add(TransactionsTabHwnd);
        f.Native.ClientSizeByHwnd[TransactionsTabHwnd] = (88, 30);

        var result = f.Navigator.OpenTransactionsTab(Target, client);

        Assert.True(result.Passed);
    }

    [Fact]
    public void H_TransacoesAusente_Block()
    {
        var f = new Fixture();
        var client = new OpenedClientIdentity(ClientWindow, "292", "MATHEUS HENRIQUE DEPRE");
        f.Native.ValidWindows.Add(ClientWindow);
        f.Native.ChildrenByParent[ClientWindow] = new List<nint>();

        var result = f.Navigator.OpenTransactionsTab(Target, client);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.TransactionsTabAmbiguous, result.ErrorCode);
    }

    [Fact]
    public void H2_TransacoesDuplicada_Block()
    {
        var f = new Fixture();
        var client = new OpenedClientIdentity(ClientWindow, "292", "MATHEUS HENRIQUE DEPRE");
        f.Native.ValidWindows.Add(ClientWindow);
        var second = (nint)0x5001;
        f.Native.ChildrenByParent[ClientWindow] = new List<nint> { TransactionsTabHwnd, second };
        f.Native.ClassNameByHwnd[TransactionsTabHwnd] = "TdxFormattedLabel";
        f.Native.TextByHwnd[TransactionsTabHwnd] = "Transações";
        f.Native.ClassNameByHwnd[second] = "TdxFormattedLabel";
        f.Native.TextByHwnd[second] = "Transações";

        var result = f.Navigator.OpenTransactionsTab(Target, client);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.TransactionsTabAmbiguous, result.ErrorCode);
    }

    [Fact]
    public void I_AbaNaoMuda_NoEffectSemRetry()
    {
        var f = new Fixture();
        var client = new OpenedClientIdentity(ClientWindow, "292", "MATHEUS HENRIQUE DEPRE");
        f.Native.ValidWindows.Add(ClientWindow);
        f.Native.ChildrenByParent[ClientWindow] = new List<nint> { TransactionsTabHwnd, CodeControl, NameControl };
        f.Native.ClassNameByHwnd[TransactionsTabHwnd] = "TdxFormattedLabel";
        f.Native.TextByHwnd[TransactionsTabHwnd] = "Transações";
        f.Native.ValidWindows.Add(TransactionsTabHwnd);
        f.Native.VisibleWindows.Add(TransactionsTabHwnd);
        f.Native.EnabledWindows.Add(TransactionsTabHwnd);
        f.Native.ClientSizeByHwnd[TransactionsTabHwnd] = (88, 30);
        f.Native.ClassNameByHwnd[CodeControl] = "TcxDBMaskEdit";
        f.Native.TextByHwnd[CodeControl] = "292";
        f.Native.ClassNameByHwnd[NameControl] = "TcxDBTextEdit";
        f.Native.TextByHwnd[NameControl] = "MATHEUS HENRIQUE DEPRE";

        var result = f.Navigator.OpenTransactionsTab(Target, client);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.TransactionsTabNoEffect, result.ErrorCode);
    }

    [Fact]
    public void J_IdentidadeMudaAposTab_Block()
    {
        var f = new Fixture();
        var client = new OpenedClientIdentity(ClientWindow, "292", "MATHEUS HENRIQUE DEPRE");
        f.Native.ValidWindows.Add(ClientWindow);
        f.Native.ValidWindows.Add(TransactionsTabHwnd);
        f.Native.VisibleWindows.Add(TransactionsTabHwnd);
        f.Native.EnabledWindows.Add(TransactionsTabHwnd);
        f.Native.ClientSizeByHwnd[TransactionsTabHwnd] = (88, 30);

        var indicatorHwnds = new List<nint> { 0x6001, 0x6002, 0x6003 };
        foreach (var h in indicatorHwnds) f.Native.VisibleWindows.Add(h);
        f.Native.TextByHwnd[0x6001] = "Pagamento";
        f.Native.TextByHwnd[0x6002] = "Observações";
        f.Native.TextByHwnd[0x6003] = "Filtrar";

        f.Native.ClassNameByHwnd[TransactionsTabHwnd] = "TdxFormattedLabel";
        f.Native.TextByHwnd[TransactionsTabHwnd] = "Transações";
        f.Native.ClassNameByHwnd[CodeControl] = "TcxDBMaskEdit";
        f.Native.TextByHwnd[CodeControl] = "999";
        f.Native.ClassNameByHwnd[NameControl] = "TcxDBTextEdit";
        f.Native.TextByHwnd[NameControl] = "OUTRO";

        f.Native.ChildrenByParent[ClientWindow] = new List<nint> { TransactionsTabHwnd, CodeControl, NameControl, 0x6001, 0x6002, 0x6003 };

        var result = f.Navigator.OpenTransactionsTab(Target, client);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.AmbiguousIdentityAfterNavigation, result.ErrorCode);
    }
}
