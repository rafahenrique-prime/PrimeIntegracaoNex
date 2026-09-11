using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Tests.Fakes;
using PrimeNexExportAgent.WindowsInput;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (Scheduler V2) de WindowsBackgroundExportTrigger. ZERO
/// Win32/MSAA real - tudo via fakes. Prova, no minimo: contagem exata de
/// WM_COMMAND (0 ou 1, nunca 2+), contagem exata de accDoDefaultAction (0
/// ou 1, nunca 2+), a separacao SKIP (BackgroundSafeSkipException, ANTES
/// do WM_COMMAND) vs FALHA TECNICA (InvalidOperationException, DEPOIS do
/// WM_COMMAND), que HitTestWithinWindow (nunca HitTest global) e o UNICO
/// metodo de hit-test usado tanto para "Todas vendas" quanto para
/// "Exportar", e a selecao de barra por CONTEUDO (nunca por contagem
/// estrutural de TdxBarControl visiveis - runtime real confirmou ate 3
/// candidatas simultaneas).
/// </summary>
public sealed class WindowsBackgroundExportTriggerTests
{
    private const int Pid = 100;
    private static readonly nint FrmPri = 0x1000;
    private static readonly nint Opener = 0x2000;
    private static readonly nint OpenerParent = 0x3000;
    private static readonly nint Bar = 0x5000;
    private static readonly nint Bar2 = 0x5001;
    private static readonly nint Bar3 = 0x5002;
    private static readonly nint Popup = 0x4000;
    private static readonly nint ForegroundOther = 0x9999;
    private static readonly nint TfrmIntercomLike = 0x6000; // janela distinta de TfrmPri, mesmo PID (ex.: "Atendimento")
    private const int ExternalProcessPid = 200; // Chrome/PowerShell/etc - nunca o NexAdmin

    // Rect compartilhado (0,0,50,50) por todas as barras/popup:
    //   scan VERTICAL (Exportar/popup):   x=10 fixo,  y em {5,20,35}
    //   scan HORIZONTAL (Todas vendas):   y=5 fixo,   x em {0,15,30,45}
    // (10,5) e' o UNICO ponto compartilhado pelas duas grades - os demais
    // pontos usados nos testes abaixo sao deliberadamente exclusivos de
    // uma das duas direcoes, para que cada teste prove a direcao certa.

    private sealed class Fixture
    {
        public FakeNativeWindowApi NativeWindows { get; } = new();
        public FakeOverflowHitTestNativeApi HitTest { get; } = new();
        public FakeMsaaAccessibilityApi Msaa { get; } = new();
        public FakeBackgroundClickNativeApi BackgroundClick { get; } = new();
        public FakeForegroundReader ForegroundReader { get; } = new();
        public FakeDelay Delay { get; } = new();
        public FakeClock Clock { get; } = new();

        public NexAdminWindowIdentity Target { get; } = new(Pid, FrmPri);

        public Fixture()
        {
            Delay.OnWait = d => Clock.Now = Clock.Now.Add(d);

            // ---- target (TfrmPri) valido/visivel/mesmo PID ----
            NativeWindows.ValidWindows.Add(FrmPri);
            NativeWindows.VisibleWindows.Add(FrmPri);
            NativeWindows.OwningProcessByWindow[FrmPri] = Pid;
            NativeWindows.ClassNameByWindow[FrmPri] = "TfrmPri";

            // ---- foreground = outra coisa, nunca o NEX ----
            ForegroundReader.ForegroundSequence.Enqueue(ForegroundOther); // antes do abridor
            ForegroundReader.ForegroundSequence.Enqueue(ForegroundOther); // imediatamente antes do WM_COMMAND

            // ---- abridor: identidade SEMPRE estrutural (ClassName=TcxButton +
            // Visible + Enabled + Valid + Parent ClassName=TPanel + SiblingIndex
            // 0-based=5), NUNCA por ControlId - ControlId (133354 aqui) e' so um
            // valor dinamico qualquer, lido em runtime, nunca comparado. ----
            NativeWindows.AllDescendantsByWindow[FrmPri] = new List<nint> { Opener, Bar, Bar2, Bar3 };
            NativeWindows.ClassNameByWindow[Opener] = "TcxButton";
            NativeWindows.ControlIdByWindow[Opener] = 133354;
            NativeWindows.ValidWindows.Add(Opener);
            NativeWindows.VisibleWindows.Add(Opener);
            NativeWindows.EnabledWindows.Add(Opener);
            NativeWindows.ParentByWindow[Opener] = OpenerParent;
            NativeWindows.ClassNameByWindow[OpenerParent] = "TPanel";
            NativeWindows.ImmediateChildrenInZOrderByWindow[OpenerParent] =
                new List<nint> { 0x10, 0x11, 0x12, 0x13, 0x14, Opener }; // Opener no indice 5 (0-based)

            // ---- 3 barras candidatas simultaneas (fidelidade ao runtime real:
            // recheck pos-B.3 confirmou 3 TdxBarControl visiveis ao mesmo tempo) ----
            NativeWindows.ClassNameByWindow[Bar] = "TdxBarControl";
            NativeWindows.VisibleWindows.Add(Bar);
            NativeWindows.ClassNameByWindow[Bar2] = "TdxBarControl";
            NativeWindows.VisibleWindows.Add(Bar2);
            NativeWindows.ClassNameByWindow[Bar3] = "TdxBarControl";
            NativeWindows.VisibleWindows.Add(Bar3);

            HitTest.WindowRect = (0, 0, 50, 50);

            // ---- "Todas vendas" SOMENTE na barra 1, em ponto EXCLUSIVAMENTE
            // horizontal (x=15, fora da coluna vertical fixa x=10) - Bar2/Bar3
            // nao contem o item. ----
            Msaa.NamesByWindowPoint[(Bar, 15, 5)] = "Todas vendas";
            Msaa.RoleByPoint[(15, 5)] = 12;
            Msaa.LocationByPoint[(15, 5)] = (15, 5, 20, 10);

            // ---- nenhum popup antes; exatamente 1 popup apos o WM_COMMAND ----
            HitTest.TopLevelByClassResultsSequence.Enqueue(new List<nint>()); // popupsBefore
            HitTest.TopLevelByClassResultsSequence.Enqueue(new List<nint> { Popup }); // WaitForSinglePopup

            // ---- WM_COMMAND completa com sucesso ----
            BackgroundClick.CompletedResult = true;

            // ---- "Exportar" no popup, ponto EXCLUSIVAMENTE vertical (x=10
            // fixo, y=20) - Role=PUSHBUTTON(43), habilitado ----
            Msaa.NamesByWindowPoint[(Popup, 10, 20)] = "Exportar";
            Msaa.RoleByPoint[(10, 20)] = 43;
            Msaa.StateByPoint[(10, 20)] = 0;
            Msaa.LocationByPoint[(10, 20)] = (10, 20, 30, 15);
        }

        public WindowsBackgroundExportTrigger BuildTrigger() => new(
            NativeWindows, HitTest, Msaa, BackgroundClick, ForegroundReader, Delay, Clock);
    }

    // ---------- A. Happy path: 3 barras candidatas, so 1 contem "Todas vendas" -> PASS ----------
    [Fact]
    public void A_TresBarrasCandidatas_ApenasUmaContemTodasVendas_EnviaExatamenteUmWmCommandEUmAccDoDefaultAction()
    {
        var fx = new Fixture();

        fx.BuildTrigger().SendExportShortcut(fx.Target);

        Assert.Equal(1, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
        Assert.Equal(OpenerParent, fx.BackgroundClick.LastParentHwndReceived);
        Assert.Equal(Opener, fx.BackgroundClick.LastControlHwndReceived);
        Assert.Equal(133354, fx.BackgroundClick.LastControlIdReceived);
        Assert.Equal(1, fx.Msaa.DoDefaultActionCalls);
        Assert.Equal(new[] { "Exportar" }, fx.Msaa.DoDefaultActionCalledOnNames);
    }

    // ---------- A2. ClassName do target: OrdinalIgnoreCase (bug real
    // corrigido - GetClassNameW ao vivo retornou "TFrmPri", nao "TfrmPri";
    // Ordinal causava BackgroundSafeSkipException mesmo com o target
    // correto) ----------
    [Theory]
    [InlineData("TfrmPri")]
    [InlineData("TFrmPri")]
    [InlineData("tfrmpri")]
    public void A2_ClassNameVariacaoDeCasing_Aceita(string className)
    {
        var fx = new Fixture();
        fx.NativeWindows.ClassNameByWindow[FrmPri] = className;

        fx.BuildTrigger().SendExportShortcut(fx.Target);

        Assert.Equal(1, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
        Assert.Equal(1, fx.Msaa.DoDefaultActionCalls);
    }

    [Theory]
    [InlineData("TfrmPriXYZ")]
    [InlineData("TFrmPr")]
    [InlineData("QualquerOutraClasse")]
    public void A2_ClassNameDiferente_LancaSkipZeroWmCommand(string className)
    {
        var fx = new Fixture();
        fx.NativeWindows.ClassNameByWindow[FrmPri] = className;

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("ClassName", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
        Assert.Equal(0, fx.Msaa.DoDefaultActionCalls);
    }

    // ---------- B. NEX em foreground -> SKIP, zero WM_COMMAND ----------
    [Fact]
    public void B_NexEmForeground_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.ForegroundReader.ForegroundSequence.Clear();
        fx.ForegroundReader.ForegroundSequence.Enqueue(FrmPri); // primeira leitura ja e o proprio NEX

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("foreground", ex.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
        Assert.Equal(0, fx.Msaa.DoDefaultActionCalls);
    }

    // ---------- B2. Foreground e' OUTRA janela do MESMO PID do NexAdmin (ex.: TfrmIntercom/"Atendimento") -> SKIP, zero WM_COMMAND ----------
    // Achado runtime real (BEFORE do Estado B): HWND de foreground era
    // 0x208BC (TfrmIntercom, "Atendimento"), OWNER=TfrmPri, MESMO PID -
    // uma comparacao de HWND exato deixaria isso passar incorretamente.
    [Fact]
    public void B2_ForegroundEhOutraJanelaDoMesmoPidNexAdmin_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.ForegroundReader.ForegroundSequence.Clear();
        fx.ForegroundReader.ForegroundSequence.Enqueue(TfrmIntercomLike); // HWND != FrmPri
        fx.NativeWindows.OwningProcessByWindow[TfrmIntercomLike] = Pid; // mas MESMO PID do NexAdmin

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("foreground", ex.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
        Assert.Equal(0, fx.Msaa.DoDefaultActionCalls);
    }

    // ---------- B3. Foreground pertence a um PID EXTERNO (Chrome/PowerShell) -> NAO bloqueia, segue para os demais gates ----------
    [Fact]
    public void B3_ForegroundPertenceAPidExterno_NaoBloqueiaSeguePraOsDemaisGates()
    {
        var fx = new Fixture();
        fx.ForegroundReader.ForegroundSequence.Clear();
        fx.ForegroundReader.ForegroundSequence.Enqueue(ForegroundOther);
        fx.ForegroundReader.ForegroundSequence.Enqueue(ForegroundOther);
        fx.NativeWindows.OwningProcessByWindow[ForegroundOther] = ExternalProcessPid; // explicitamente um PID diferente, nunca o NexAdmin

        fx.BuildTrigger().SendExportShortcut(fx.Target);

        Assert.Equal(1, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
        Assert.Equal(1, fx.Msaa.DoDefaultActionCalls);
    }

    // ---------- C. Abridor ausente/ambiguo -> SKIP, zero WM_COMMAND ----------
    [Fact]
    public void C_AbridorNaoEncontrado_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.NativeWindows.AllDescendantsByWindow[FrmPri] = new List<nint> { Bar, Bar2, Bar3 }; // sem o Opener

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("MATCH_COUNT", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- C2. Abridor com sibling index divergente -> SKIP fail-closed ----------
    // Pos-matcher-estrutural (correcao do ControlId nao-estavel): indice
    // divergente agora e' so' mais um criterio dentro do MESMO filtro
    // estrutural (FindStructuralOpenerOrDefault) - o candidato simplesmente
    // nao entra na lista de matches, resultando na MESMA mensagem
    // MATCH_COUNT=0 de qualquer outro criterio estrutural nao satisfeito
    // (nunca mais uma mensagem "indice 0-based divergiu" separada, que so'
    // fazia sentido quando o indice era revalidado POS-selecao por ControlId).
    [Fact]
    public void C2_AbridorComSiblingIndexDivergente_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.NativeWindows.ImmediateChildrenInZOrderByWindow[OpenerParent] =
            new List<nint> { 0x10, 0x11, Opener, 0x13, 0x14, 0x15 };

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("MATCH_COUNT", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- A3. ControlId NAO decide identidade - qualquer valor
    // positivo (incluindo > 65535, como o historico 133354) e' aceito
    // desde que a estrutura (classe+parent+indice) esteja correta ----------
    [Theory]
    [InlineData(132948)] // valor observado apos a investigacao do bug de casing
    [InlineData(999999)] // valor arbitrario qualquer, sem nenhum significado historico
    public void A3_ControlIdVariacao_EstruturaCorreta_AceitaEUsaOValorLido(int controlId)
    {
        var fx = new Fixture();
        fx.NativeWindows.ControlIdByWindow[Opener] = controlId;

        fx.BuildTrigger().SendExportShortcut(fx.Target);

        Assert.Equal(1, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
        Assert.Equal(controlId, fx.BackgroundClick.LastControlIdReceived);
    }

    // ---------- A4. ControlId==0 (sem ID atribuido) -> SKIP, zero WM_COMMAND ----------
    [Fact]
    public void A4_ControlIdZero_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.NativeWindows.ControlIdByWindow[Opener] = 0;

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("CONTROL_ID", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- A5. ControlId negativo -> SKIP, zero WM_COMMAND ----------
    [Fact]
    public void A5_ControlIdNegativo_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.NativeWindows.ControlIdByWindow[Opener] = -7;

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("CONTROL_ID", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- C3. Parent do abridor com ClassName != TPanel -> SKIP (candidato excluido do fingerprint estrutural) ----------
    [Fact]
    public void C3_ParentClassDiferenteDeTPanel_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.NativeWindows.ClassNameByWindow[OpenerParent] = "TPageControl";

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("MATCH_COUNT", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- C4. ClassName do abridor divergente (nao e' TcxButton) -> SKIP ----------
    [Fact]
    public void C4_AbridorComClassNameDiferente_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.NativeWindows.ClassNameByWindow[Opener] = "TcxLabel";

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("MATCH_COUNT", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- C5. Abridor invisivel -> SKIP ----------
    [Fact]
    public void C5_AbridorInvisivel_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.NativeWindows.VisibleWindows.Remove(Opener);

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("MATCH_COUNT", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- C6. Abridor desabilitado -> SKIP ----------
    [Fact]
    public void C6_AbridorDesabilitado_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.NativeWindows.EnabledWindows.Remove(Opener);

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("MATCH_COUNT", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- C7. 2 candidatos ESTRUTURALMENTE validos (parents distintos, cada um no proprio indice 5) -> MATCH_COUNT=2 -> SKIP ----------
    [Fact]
    public void C7_DoisCandidatosEstruturalmenteValidos_MatchCountDois_LancaSkip()
    {
        var fx = new Fixture();
        var opener2 = (nint)0x2001;
        var opener2Parent = (nint)0x3001;
        fx.NativeWindows.ClassNameByWindow[opener2] = "TcxButton";
        fx.NativeWindows.ControlIdByWindow[opener2] = 555555;
        fx.NativeWindows.ValidWindows.Add(opener2);
        fx.NativeWindows.VisibleWindows.Add(opener2);
        fx.NativeWindows.EnabledWindows.Add(opener2);
        fx.NativeWindows.ParentByWindow[opener2] = opener2Parent;
        fx.NativeWindows.ClassNameByWindow[opener2Parent] = "TPanel";
        fx.NativeWindows.ImmediateChildrenInZOrderByWindow[opener2Parent] =
            new List<nint> { 0x20, 0x21, 0x22, 0x23, 0x24, opener2 }; // tambem no indice 5
        fx.NativeWindows.AllDescendantsByWindow[FrmPri] = new List<nint> { Opener, opener2, Bar, Bar2, Bar3 };

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("encontrado=2", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    /// <summary>Decorador local (somente destes testes TOCTOU) que permite
    /// simular o estado do abridor MUDANDO entre a descoberta e a
    /// revalidacao dentro da MESMA chamada a SendExportShortcut - algo que
    /// FakeNativeWindowApi (dicionarios estaticos) nao expressa sozinho.
    /// Delega tudo ao FakeNativeWindowApi injetado, exceto os metodos com
    /// uma fila explicita registrada (o 1o valor enfileirado responde a
    /// 1a chamada, o 2o a 2a chamada, etc.) - fora de escopo deste patch
    /// alterar Fakes/FakeNativeApis.cs, entao a simulacao fica isolada
    /// aqui, so para estes testes.</summary>
    private sealed class ToctouNativeWindowApi : PrimeNexExportAgent.WindowsNative.INativeWindowApi
    {
        private readonly FakeNativeWindowApi _inner;
        private readonly Dictionary<nint, Queue<IReadOnlyList<nint>>> _allDescendantsSequence = new();
        private readonly Dictionary<nint, Queue<IReadOnlyList<nint>>> _immediateChildrenSequence = new();
        private readonly Dictionary<nint, Queue<int>> _controlIdSequence = new();

        public ToctouNativeWindowApi(FakeNativeWindowApi inner) => _inner = inner;

        public void EnqueueAllDescendants(nint parent, IReadOnlyList<nint> result)
        {
            if (!_allDescendantsSequence.TryGetValue(parent, out var q)) { q = new(); _allDescendantsSequence[parent] = q; }
            q.Enqueue(result);
        }

        public void EnqueueImmediateChildren(nint parent, IReadOnlyList<nint> result)
        {
            if (!_immediateChildrenSequence.TryGetValue(parent, out var q)) { q = new(); _immediateChildrenSequence[parent] = q; }
            q.Enqueue(result);
        }

        public void EnqueueControlId(nint hwnd, int value)
        {
            if (!_controlIdSequence.TryGetValue(hwnd, out var q)) { q = new(); _controlIdSequence[hwnd] = q; }
            q.Enqueue(value);
        }

        public bool IsWindowValid(nint hWnd) => _inner.IsWindowValid(hWnd);
        public bool IsWindowCurrentlyVisible(nint hWnd) => _inner.IsWindowCurrentlyVisible(hWnd);
        public int? GetOwningProcessId(nint hWnd) => _inner.GetOwningProcessId(hWnd);
        public string? GetClassName(nint hWnd) => _inner.GetClassName(hWnd);
        public string? GetWindowTitle(nint hWnd) => _inner.GetWindowTitle(hWnd);
        public nint GetOwner(nint hWnd) => _inner.GetOwner(hWnd);
        public bool TryGetWindowRect(nint hWnd, out int width, out int height) => _inner.TryGetWindowRect(hWnd, out width, out height);
        public IReadOnlyList<nint> GetVisibleTopLevelWindowsForProcess(int processId) => _inner.GetVisibleTopLevelWindowsForProcess(processId);
        public bool IsWindowCurrentlyEnabled(nint hWnd) => _inner.IsWindowCurrentlyEnabled(hWnd);
        public nint GetParentWindow(nint hWnd) => _inner.GetParentWindow(hWnd);
        public bool IsWindowMinimized(nint hWnd) => _inner.IsWindowMinimized(hWnd);
        public IReadOnlyList<nint> GetAllTopLevelWindowsForProcess(int processId) => _inner.GetAllTopLevelWindowsForProcess(processId);

        public IReadOnlyList<nint> GetAllDescendants(nint hWndParent)
        {
            if (_allDescendantsSequence.TryGetValue(hWndParent, out var q) && q.Count > 0) return q.Dequeue();
            return _inner.GetAllDescendants(hWndParent);
        }

        public IReadOnlyList<nint> GetImmediateChildrenInZOrder(nint hWndParent)
        {
            if (_immediateChildrenSequence.TryGetValue(hWndParent, out var q) && q.Count > 0) return q.Dequeue();
            return _inner.GetImmediateChildrenInZOrder(hWndParent);
        }

        public int GetControlId(nint hWnd)
        {
            if (_controlIdSequence.TryGetValue(hWnd, out var q) && q.Count > 0) return q.Dequeue();
            return _inner.GetControlId(hWnd);
        }
    }

    // ---------- N1 (TOCTOU). Descoberta encontra 1; revalidacao encontra 2 -> SKIP, zero WM_COMMAND ----------
    [Fact]
    public void N1_ToctouRevalidacaoEncontraDoisCandidatos_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        var opener2 = (nint)0x2002;
        var opener2Parent = (nint)0x3002;
        fx.NativeWindows.ClassNameByWindow[opener2] = "TcxButton";
        fx.NativeWindows.ControlIdByWindow[opener2] = 555555;
        fx.NativeWindows.ValidWindows.Add(opener2);
        fx.NativeWindows.VisibleWindows.Add(opener2);
        fx.NativeWindows.EnabledWindows.Add(opener2);
        fx.NativeWindows.ParentByWindow[opener2] = opener2Parent;
        fx.NativeWindows.ClassNameByWindow[opener2Parent] = "TPanel";
        fx.NativeWindows.ImmediateChildrenInZOrderByWindow[opener2Parent] =
            new List<nint> { 0x30, 0x31, 0x32, 0x33, 0x34, opener2 };

        var toctou = new ToctouNativeWindowApi(fx.NativeWindows);
        var baseline = fx.NativeWindows.AllDescendantsByWindow[FrmPri]; // Opener, Bar, Bar2, Bar3 (SEM opener2)
        toctou.EnqueueAllDescendants(FrmPri, baseline); // 1a chamada (descoberta): so' Opener
        toctou.EnqueueAllDescendants(FrmPri, new List<nint> { Opener, opener2, Bar, Bar2, Bar3 }); // 2a (revalidacao): opener2 "apareceu"

        var trigger = new WindowsBackgroundExportTrigger(toctou, fx.HitTest, fx.Msaa, fx.BackgroundClick, fx.ForegroundReader, fx.Delay, fx.Clock);

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => trigger.SendExportShortcut(fx.Target));

        Assert.Contains("revalidacao TOCTOU", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- N2 (TOCTOU). Descoberta encontra Opener; revalidacao encontra um opener DIFERENTE (mesmo HWND nao confirmado) -> SKIP ----------
    [Fact]
    public void N2_ToctouRevalidacaoEncontraOpenerDiferente_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        var opener2 = (nint)0x2003;
        var opener2Parent = (nint)0x3003;
        fx.NativeWindows.ClassNameByWindow[opener2] = "TcxButton";
        fx.NativeWindows.ControlIdByWindow[opener2] = 555555;
        fx.NativeWindows.ValidWindows.Add(opener2);
        fx.NativeWindows.VisibleWindows.Add(opener2);
        fx.NativeWindows.EnabledWindows.Add(opener2);
        fx.NativeWindows.ParentByWindow[opener2] = opener2Parent;
        fx.NativeWindows.ClassNameByWindow[opener2Parent] = "TPanel";
        fx.NativeWindows.ImmediateChildrenInZOrderByWindow[opener2Parent] =
            new List<nint> { 0x40, 0x41, 0x42, 0x43, 0x44, opener2 };

        var toctou = new ToctouNativeWindowApi(fx.NativeWindows);
        toctou.EnqueueAllDescendants(FrmPri, new List<nint> { Opener, Bar, Bar2, Bar3 }); // descoberta: Opener
        toctou.EnqueueAllDescendants(FrmPri, new List<nint> { opener2, Bar, Bar2, Bar3 }); // revalidacao: so' opener2 (Opener sumiu)

        var trigger = new WindowsBackgroundExportTrigger(toctou, fx.HitTest, fx.Msaa, fx.BackgroundClick, fx.ForegroundReader, fx.Delay, fx.Clock);

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => trigger.SendExportShortcut(fx.Target));

        Assert.Contains("mesmoHwnd=False", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- N3 (TOCTOU). Topologia (sibling index) muda entre descoberta e revalidacao -> SKIP ----------
    [Fact]
    public void N3_ToctouTopologiaMudaEntreDescobertaERevalidacao_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        var toctou = new ToctouNativeWindowApi(fx.NativeWindows);
        toctou.EnqueueImmediateChildren(OpenerParent, new List<nint> { 0x10, 0x11, 0x12, 0x13, 0x14, Opener }); // descoberta: indice 5 (OK)
        toctou.EnqueueImmediateChildren(OpenerParent, new List<nint> { Opener, 0x11, 0x12, 0x13, 0x14, 0x15 }); // revalidacao: Opener foi para o indice 0

        var trigger = new WindowsBackgroundExportTrigger(toctou, fx.HitTest, fx.Msaa, fx.BackgroundClick, fx.ForegroundReader, fx.Delay, fx.Clock);

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => trigger.SendExportShortcut(fx.Target));

        Assert.Contains("revalidacao TOCTOU", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- N4 (TOCTOU). ControlId muda entre descoberta e revalidacao, identidade ESTRUTURAL continua igual -> usa o valor da REVALIDACAO ----------
    [Fact]
    public void N4_ToctouControlIdMudaEntreDescobertaERevalidacao_UsaValorDaRevalidacao()
    {
        var fx = new Fixture();
        var toctou = new ToctouNativeWindowApi(fx.NativeWindows);
        toctou.EnqueueControlId(Opener, 133354); // descoberta
        toctou.EnqueueControlId(Opener, 132948); // revalidacao - ID mudou, estrutura nao

        var trigger = new WindowsBackgroundExportTrigger(toctou, fx.HitTest, fx.Msaa, fx.BackgroundClick, fx.ForegroundReader, fx.Delay, fx.Clock);

        trigger.SendExportShortcut(fx.Target);

        Assert.Equal(1, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
        Assert.Equal(132948, fx.BackgroundClick.LastControlIdReceived); // valor NOVO (revalidacao), nunca o da descoberta
    }

    // ---------- D. Nenhuma das 3 barras contem "Todas vendas" -> SKIP, zero WM_COMMAND ----------
    [Fact]
    public void D_NenhumaBarraContemTodasVendas_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.Msaa.NamesByWindowPoint.Remove((Bar, 15, 5)); // zero barras contem o item agora

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("Todas vendas", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- D2. 2 das 3 barras contem "Todas vendas" (ambiguo) -> SKIP, zero WM_COMMAND ----------
    [Fact]
    public void D2_DuasBarrasContemTodasVendas_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        // Bar2 TAMBEM contem o item, de forma inequivoca nela mesma (cada
        // barra e' escaneada isoladamente) - agora 2 das 3 barras
        // qualificam, o que e' ambiguidade real, nunca resolvida
        // escolhendo "a primeira".
        fx.Msaa.NamesByWindowPoint[(Bar2, 15, 5)] = "Todas vendas";
        fx.Msaa.RoleByPoint[(15, 5)] = 12;
        fx.Msaa.LocationByPoint[(15, 5)] = (15, 5, 20, 10);

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("Todas vendas", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- D3. "Todas vendas" existe SOMENTE num ponto vertical (x=10,y=20) -> scan horizontal nao encontra -> SKIP ----------
    // Prova negativa direta: o gate de "Todas vendas" NAO cai de volta para
    // varredura vertical-only. Se caisse, este teste falharia (encontraria
    // e mandaria WM_COMMAND).
    [Fact]
    public void D3_TodasVendasSoExisteEmPontoVertical_GateHorizontalNaoEncontra_LancaSkip()
    {
        var fx = new Fixture();
        fx.Msaa.NamesByWindowPoint.Remove((Bar, 15, 5)); // remove o unico ponto horizontal valido
        fx.Msaa.NamesByWindowPoint[(Bar, 10, 20)] = "Todas vendas"; // so alcancavel por scan VERTICAL
        fx.Msaa.RoleByPoint[(10, 20)] = 12;
        fx.Msaa.LocationByPoint[(10, 20)] = (10, 20, 20, 10);

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("Todas vendas", ex.Message);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- D4. "Exportar" existe SOMENTE num ponto horizontal -> scan vertical (usado para Exportar) nao encontra -> FALHA TECNICA ----------
    // Prova negativa direta de que a busca de Exportar CONTINUA vertical -
    // nunca foi trocada para horizontal junto com a de "Todas vendas".
    [Fact]
    public void D4_ExportarSoExisteEmPontoHorizontal_BuscaVerticalDoPopupNaoEncontra_LancaFalhaTecnica()
    {
        var fx = new Fixture();
        fx.Msaa.NamesByWindowPoint.Remove((Popup, 10, 20)); // remove o unico ponto vertical valido
        fx.Msaa.NamesByWindowPoint[(Popup, 0, 5)] = "Exportar"; // so alcancavel por scan HORIZONTAL
        fx.Msaa.RoleByPoint[(0, 5)] = 43;
        fx.Msaa.StateByPoint[(0, 5)] = 0;
        fx.Msaa.LocationByPoint[(0, 5)] = (0, 5, 20, 10);

        var ex = Record.Exception(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.IsType<InvalidOperationException>(ex);
        Assert.Contains("Exportar", ex!.Message);
        Assert.Equal(1, fx.BackgroundClick.SendBnClickedViaWmCommandCalls); // WM_COMMAND ja tinha sido enviado
        Assert.Equal(0, fx.Msaa.DoDefaultActionCalls);
    }

    // ---------- E. Popup nao aparece apos WM_COMMAND -> FALHA TECNICA, nunca skip ----------
    [Fact]
    public void E_PopupNaoAparece_LancaFalhaTecnicaNuncaSkip()
    {
        var fx = new Fixture();
        fx.HitTest.TopLevelByClassResultsSequence.Clear();
        fx.HitTest.TopLevelByClassResultsSequence.Enqueue(new List<nint>()); // popupsBefore
        fx.HitTest.TopLevelByClassResultsSequence.Enqueue(new List<nint>()); // WaitForSinglePopup - nunca aparece

        var ex = Record.Exception(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.IsType<InvalidOperationException>(ex);
        Assert.Equal(1, fx.BackgroundClick.SendBnClickedViaWmCommandCalls); // WM_COMMAND FOI enviado
        Assert.Equal(0, fx.Msaa.DoDefaultActionCalls);
    }

    // ---------- F. Exportar 0 matches no popup -> FALHA TECNICA ----------
    // Hybrid V3 (observabilidade minima): a mensagem agora carrega
    // popupFound/popupHandle/popupClass/exportarMatchCount/elapsedMs -
    // achado real de incidente onde essa mesma falha (0 matches, ver F)
    // era indistinguivel de F2 (ambiguo, >1 matches) so' pelo texto antigo
    // ("nao localizado de forma inequivoca"). Zero mudanca de decisao -
    // ainda InvalidOperationException, ainda 1 WM_COMMAND, ainda 0
    // accDoDefaultAction.
    [Fact]
    public void F_ExportarZeroMatches_LancaFalhaTecnicaComDiagnosticoMatchCountZero()
    {
        var fx = new Fixture();
        fx.Msaa.NamesByWindowPoint.Remove((Popup, 10, 20));

        var ex = Record.Exception(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.IsType<InvalidOperationException>(ex);
        Assert.Contains("Exportar", ex!.Message);
        Assert.Equal(1, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
        Assert.Equal(0, fx.Msaa.DoDefaultActionCalls);

        // Novos campos de diagnostico (telemetria pura, nunca influenciam a decisao acima).
        Assert.Contains("popupFound=true", ex.Message);
        Assert.Contains($"popupHandle=0x{Popup:X}", ex.Message);
        Assert.Contains("popupClass='TdxBarSubMenuControl'", ex.Message);
        Assert.Contains("exportarMatchCount=0", ex.Message);
        Assert.Contains("elapsedMsDesdeWmCommand=", ex.Message);
    }

    // ---------- F2. Exportar >1 matches (ambiguo) no popup -> FALHA TECNICA ----------
    [Fact]
    public void F2_ExportarAmbiguo_LancaFalhaTecnicaComDiagnosticoMatchCountDois()
    {
        var fx = new Fixture();
        fx.Msaa.NamesByWindowPoint[(Popup, 10, 35)] = "Exportar";
        fx.Msaa.LocationByPoint[(10, 35)] = (777, 777, 1, 1); // fingerprint distinto

        var ex = Record.Exception(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.IsType<InvalidOperationException>(ex);
        Assert.Equal(1, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
        Assert.Equal(0, fx.Msaa.DoDefaultActionCalls);

        // exportarMatchCount=2 e' precisamente o que distingue esta falha
        // (D - MULTIPLE_EXPORTAR_MATCHES) da falha F (zero matches) - antes
        // dessa mudanca, os dois cenarios produziam o MESMO texto de erro.
        Assert.Contains("popupFound=true", ex.Message);
        Assert.Contains($"popupHandle=0x{Popup:X}", ex.Message);
        Assert.Contains("popupClass='TdxBarSubMenuControl'", ex.Message);
        Assert.Contains("exportarMatchCount=2", ex.Message);
        Assert.Contains("elapsedMsDesdeWmCommand=", ex.Message);
    }

    // ---------- G. WM_COMMAND falha (SendMessageTimeout nao completou) -> FALHA TECNICA ----------
    [Fact]
    public void G_WmCommandNaoCompleta_LancaFalhaTecnicaZeroAccDoDefaultAction()
    {
        var fx = new Fixture();
        fx.BackgroundClick.CompletedResult = false;

        var ex = Record.Exception(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.IsType<InvalidOperationException>(ex);
        Assert.Equal(1, fx.BackgroundClick.SendBnClickedViaWmCommandCalls); // 1 tentativa, nunca 0 nem 2+
        Assert.Equal(0, fx.Msaa.DoDefaultActionCalls);
    }

    // ---------- H. accDoDefaultAction falha -> FALHA TECNICA ----------
    [Fact]
    public void H_AccDoDefaultActionFalha_LancaFalhaTecnica()
    {
        var fx = new Fixture();
        fx.Msaa.DoDefaultActionShouldFailFor.Add("Exportar");

        var ex = Record.Exception(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.IsType<InvalidOperationException>(ex);
        Assert.Equal(1, fx.Msaa.DoDefaultActionCalls); // 1 tentativa, nunca retry
    }

    // ---------- I. Item de role errado -> FALHA TECNICA, zero accDoDefaultAction ----------
    [Fact]
    public void I_ExportarComRoleErrada_LancaFalhaTecnicaZeroAccDoDefaultAction()
    {
        var fx = new Fixture();
        fx.Msaa.RoleByPoint[(10, 20)] = 12; // nao-PUSHBUTTON

        var ex = Record.Exception(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.IsType<InvalidOperationException>(ex);
        Assert.Equal(0, fx.Msaa.DoDefaultActionCalls);
    }

    // ---------- J. Item desabilitado -> FALHA TECNICA, zero accDoDefaultAction ----------
    [Fact]
    public void J_ExportarDesabilitado_LancaFalhaTecnicaZeroAccDoDefaultAction()
    {
        var fx = new Fixture();
        fx.Msaa.StateByPoint[(10, 20)] = 0x1; // STATE_SYSTEM_UNAVAILABLE

        var ex = Record.Exception(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.IsType<InvalidOperationException>(ex);
        Assert.Equal(0, fx.Msaa.DoDefaultActionCalls);
    }

    // ---------- K. Nenhuma chamada usa HitTest global (nunca AccessibleObjectFromPoint) ----------
    [Fact]
    public void K_HappyPath_NuncaChamaHitTestGlobal_SoHitTestWithinWindow()
    {
        var fx = new Fixture();
        // NamesByPoint (global) permanece vazio o teste inteiro - se o
        // trigger chamasse HitTest(x,y) global em vez de
        // HitTestWithinWindow(hwnd,x,y), todo hit-test retornaria null e
        // o teste A (happy path) falharia. Este teste torna essa garantia
        // EXPLICITA e nomeada, nao apenas incidental.
        Assert.Empty(fx.Msaa.NamesByPoint);

        fx.BuildTrigger().SendExportShortcut(fx.Target);

        Assert.Equal(1, fx.Msaa.DoDefaultActionCalls);
        Assert.Empty(fx.Msaa.NamesByPoint); // continua vazio - nunca populado/consultado por este trigger
    }

    // ---------- L. Popup ja aberto antes de iniciar -> SKIP, zero WM_COMMAND ----------
    [Fact]
    public void L_PopupJaAbertoAntes_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.HitTest.TopLevelByClassResultsSequence.Clear();
        fx.HitTest.TopLevelByClassResultsSequence.Enqueue(new List<nint> { Popup }); // ja existe um popup

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("popup", ex.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }

    // ---------- M. Nenhuma barra candidata (TdxBarControl visivel) sequer existe -> SKIP ----------
    [Fact]
    public void M_NenhumaBarraCandidataExiste_LancaSkipZeroWmCommand()
    {
        var fx = new Fixture();
        fx.NativeWindows.AllDescendantsByWindow[FrmPri] = new List<nint> { Opener }; // sem nenhuma barra

        var ex = Assert.Throws<BackgroundSafeSkipException>(() => fx.BuildTrigger().SendExportShortcut(fx.Target));

        Assert.Contains("barra candidata", ex.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, fx.BackgroundClick.SendBnClickedViaWmCommandCalls);
    }
}
