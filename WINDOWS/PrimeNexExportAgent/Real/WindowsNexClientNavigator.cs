using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (V1 - extrato individual por cliente) de
/// INexClientNavigator. Reaproveita INativeWindowApi (ja existente,
/// somente leitura) para enumerar janelas top-level por PID, e usa
/// INexClientNavigationNativeApi (novo, dedicado) para as poucas acoes
/// mutantes (WM_SETTEXT no campo de busca, WM_LBUTTONDOWN/UP no grid de
/// Clientes e na aba Transacoes) - cada uma reacquire fresca em toda
/// chamada, nunca HWND cacheado entre execucoes.
///
/// CORRECAO ARQUITETURAL (pos Probes 10A-10D): F2 foi REMOVIDO do
/// caminho de abertura de cliente. Dois OnceProbes reais provaram que F2
/// abre o registro que estava previamente selecionado internamente no
/// grid (observado: cliente 743), independente do campo de busca estar
/// corretamente filtrado para o codigo solicitado (confirmado
/// visualmente, Probe 10A) - o F2 nao re-seleciona a linha filtrada por
/// si so. A abertura agora e' feita por um clique tecnico direto
/// (PostMessage WM_LBUTTONDOWN/UP) no ponto calibrado do TcxGridSite
/// (NexClientsGridOpenProfile), que seleciona E ativa a linha filtrada
/// na mesma acao - comprovado real no Probe 10D (Codigo=292,
/// Nome=MATHEUS HENRIQUE DEPRE confirmados pos-abertura).
/// </summary>
public sealed class WindowsNexClientNavigator : INexClientNavigator
{
    private const string SearchFieldClassName = "TcxTextEdit";
    private const string ClientsGridClassName = "TcxGridSite";
    private const string ClientWindowClassName = "TFrmCadCli";
    private const string ClientCodeControlClassName = "TcxDBMaskEdit";
    private const string ClientNameControlClassName = "TcxDBTextEdit";
    private const string TransactionsTabClassName = "TdxFormattedLabel";
    private const string TransactionsTabText = "Transações";

    private static readonly string[] TransactionsPageIndicators =
    {
        "Pagamento", "Observações", "Filtrar", "Imprimir", "Cancelar Transação",
    };
    private const int MinimumIndicatorsForActiveTab = 3;

    private static readonly TimeSpan ClientWindowTimeout = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan PressDuration = TimeSpan.FromMilliseconds(80);
    private static readonly TimeSpan PostActionSettleDelay = TimeSpan.FromMilliseconds(800);
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(200);

    /// <summary>CALIBRACAO TEMPORAL V1 (nao e' prova estrutural do grid -
    /// o grid continua opaco, nao ha API para consultar quando o filtro
    /// termina de processar). Ajustada para 1000ms apos o Probe 10A ter
    /// comprovado VISUALMENTE (Rafael observando a tela) que o grid
    /// mostra corretamente "Clientes (1) / MATHEUS HENRIQUE DEPRE /
    /// Codigo 292" nesse instante - os 600ms usados anteriormente nunca
    /// tiveram essa confirmacao visual, apenas a suposicao de que
    /// bastariam. O gate definitivo que realmente prova qual cliente foi
    /// aberto continua sendo a verificacao de identidade POS-clique
    /// (Codigo + Nome exatos) - esta espera apenas reduz a chance de
    /// interagir com o grid antes do filtro estar visualmente completo,
    /// nunca substitui aquele gate.</summary>
    private static readonly TimeSpan SearchFilterSettleDelay = TimeSpan.FromMilliseconds(1000);

    private readonly INativeWindowApi _readOnlyWindows;
    private readonly INexClientNavigationNativeApi _nativeApi;
    private readonly IDelay _delay;

    public WindowsNexClientNavigator(INativeWindowApi readOnlyWindows, INexClientNavigationNativeApi nativeApi, IDelay delay)
    {
        _readOnlyWindows = readOnlyWindows;
        _nativeApi = nativeApi;
        _delay = delay;
    }

    public ClientOpenResult OpenClientByCode(NexAdminWindowIdentity target, ClientNavigationTarget navigationTarget)
    {
        // ---- Estado limpo: nenhuma TFrmCadCli ja aberta antes de comecar ----
        var beforeWindows = FindTopLevelByClass(target.ProcessId, ClientWindowClassName);
        if (beforeWindows.Count != 0)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientWindowAmbiguous, $"ja existe(m) {beforeWindows.Count} TFrmCadCli aberta(s) antes de iniciar a busca");
        }

        // ---- Campo de busca: reacquire fresco, nunca cacheado ----
        var searchCandidates = FindChildrenByClass(target.MainWindowHandle, SearchFieldClassName);
        if (searchCandidates.Count != 1)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientWindowNotFound, $"esperado exatamente 1 campo de busca ({SearchFieldClassName}), encontrado(s) {searchCandidates.Count}");
        }
        var searchHwnd = searchCandidates[0];

        if (!_nativeApi.WriteControlText(searchHwnd, navigationTarget.ClientCode))
        {
            return ClientOpenResult.Fail(AgentErrorCode.UnexpectedException, "WM_SETTEXT falhou no campo de busca");
        }

        var readback = _nativeApi.ReadControlText(searchHwnd);
        if (!string.Equals(readback, navigationTarget.ClientCode, StringComparison.Ordinal))
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientSearchReadbackMismatch, $"readback do campo de busca ('{readback}') diverge do codigo solicitado ('{navigationTarget.ClientCode}')");
        }

        // ---- Espera de estabilizacao do filtro incremental do grid
        // (calibracao V1, ver SearchFilterSettleDelay) - UMA unica vez,
        // antes de qualquer verificacao de contexto ou F2. ----
        _delay.Wait(SearchFilterSettleDelay);

        // ---- Revalidacao COMPLETA apos a espera - nada e' assumido do
        // estado lido antes do delay. Se qualquer coisa mudou durante a
        // espera (contexto, readback, janela inesperada), fail-closed sem
        // enviar F2. ----
        if (!_nativeApi.IsWindowValid(searchHwnd))
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientContextChangedDuringSettle, "campo de busca deixou de ser valido durante a espera de estabilizacao");
        }

        var readbackAfterSettle = _nativeApi.ReadControlText(searchHwnd);
        if (!string.Equals(readbackAfterSettle, navigationTarget.ClientCode, StringComparison.Ordinal))
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientContextChangedDuringSettle, $"readback do campo de busca mudou durante a espera ('{readbackAfterSettle}' != '{navigationTarget.ClientCode}')");
        }

        var windowsDuringSettle = FindTopLevelByClass(target.ProcessId, ClientWindowClassName);
        if (windowsDuringSettle.Count != 0)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientContextChangedDuringSettle, $"TFrmCadCli inesperada apareceu durante a espera de estabilizacao ({windowsDuringSettle.Count})");
        }

        // ---- Foreground, imediatamente antes do clique ----
        var foreground = _nativeApi.GetForegroundWindow();
        if (_nativeApi.GetOwningProcessId(foreground) != target.ProcessId)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientFocusUnresolved, "janela em foreground nao pertence ao TARGET_NEX_PID imediatamente antes do clique no grid");
        }

        // ---- Reacquire fresco do grid de Clientes (TcxGridSite) - NUNCA
        // cacheado entre chamadas.
        //
        // CORRECAO (pos-3o OnceProbe real): EnumChildWindows enumera TODA
        // a subarvore Win32 de TFrmPri, incluindo grids de OUTRAS abas
        // (Vendas, Produtos, etc.) que permanecem instanciados mesmo
        // quando nao visiveis - achado real: 4 TcxGridSite descendentes,
        // apenas 1 visivel. O filtro de visibilidade/validade/PID agora
        // e' aplicado ANTES de exigir cardinalidade 1 (nunca depois) -
        // "0 ou >1 candidatos VISIVEIS E VALIDOS" e' que determina
        // ClientGridNotFound/ClientGridAmbiguous, nunca a contagem bruta
        // de todos os descendentes daquela classe. ----
        var gridCandidates = FindChildrenByClass(target.MainWindowHandle, ClientsGridClassName)
            .Where(h => _nativeApi.IsWindowValid(h)
                        && _nativeApi.IsWindowCurrentlyVisible(h)
                        && _nativeApi.IsWindowCurrentlyEnabled(h)
                        && _nativeApi.GetOwningProcessId(h) == target.ProcessId)
            .ToList();

        if (gridCandidates.Count == 0)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientGridNotFound, $"nenhum {ClientsGridClassName} visivel/valido encontrado na tela de Clientes");
        }
        if (gridCandidates.Count > 1)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientGridAmbiguous, $"mais de 1 {ClientsGridClassName} visivel/valido encontrado ({gridCandidates.Count}) - ambiguidade");
        }
        var gridHwnd = gridCandidates[0];

        // ---- Gate de geometria (NexClientsGridOpenProfile) - o ponto de
        // clique calibrado SO e' valido nesta geometria exata. Qualquer
        // divergencia e' fail-closed, ZERO clique, nunca escala/recalcula. ----
        var tFrmPriRectRaw = _nativeApi.GetWindowRectangle(target.MainWindowHandle);
        var gridWindowRectRaw = _nativeApi.GetWindowRectangle(gridHwnd);
        var gridClientSize = _nativeApi.GetClientSize(gridHwnd);

        if (tFrmPriRectRaw is null || gridWindowRectRaw is null || gridClientSize is null)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientGridGeometryMismatch, "falha ao ler geometria (GetWindowRect/GetClientRect) do TFrmPri ou do grid");
        }

        var tFrmPriRect = ToRect(tFrmPriRectRaw.Value);
        var gridWindowRect = ToRect(gridWindowRectRaw.Value);

        if (!NexClientsGridOpenProfile.MatchesExpectedGeometry(tFrmPriRect, gridWindowRect, gridClientSize.Value.width, gridClientSize.Value.height))
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientGridGeometryMismatch,
                $"geometria atual (TFrmPri={FormatRect(tFrmPriRect)}, Grid={FormatRect(gridWindowRect)}, GridClient={gridClientSize.Value.width}x{gridClientSize.Value.height}) diverge da calibracao homologada - fail-closed, sem recalculo");
        }

        // ---- Clique tecnico direto no ponto calibrado do grid - substitui
        // F2 (ver correcao arquitetural no cabecalho da classe). UMA unica
        // sequencia DOWN+UP, sem mover o cursor fisico. ----
        var down = _nativeApi.PostMouseDown(gridHwnd, NexClientsGridOpenProfile.EditClientPointX, NexClientsGridOpenProfile.EditClientPointY);
        if (!down.posted)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientGridClickFailed, $"PostMessage WM_LBUTTONDOWN falhou no grid de Clientes (GetLastError={down.lastError})");
        }

        _delay.Wait(PressDuration);

        var up = _nativeApi.PostMouseUp(gridHwnd, NexClientsGridOpenProfile.EditClientPointX, NexClientsGridOpenProfile.EditClientPointY);
        if (!up.posted)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientGridClickFailed, $"PostMessage WM_LBUTTONUP falhou no grid de Clientes (GetLastError={up.lastError})");
        }

        // ---- Aguardar TFrmCadCli aparecer - polling bounded, NUNCA retry do clique ----
        var elapsed = TimeSpan.Zero;
        IReadOnlyList<nint> afterWindows = Array.Empty<nint>();
        while (elapsed < ClientWindowTimeout)
        {
            _delay.Wait(PollInterval);
            elapsed += PollInterval;
            afterWindows = FindTopLevelByClass(target.ProcessId, ClientWindowClassName);
            if (afterWindows.Count >= 1) break;
        }

        if (afterWindows.Count == 0)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientWindowNotFound, "TFrmCadCli nao apareceu dentro do timeout apos o clique no grid - sem retry");
        }
        if (afterWindows.Count > 1)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientWindowAmbiguous, $"mais de 1 TFrmCadCli apareceu apos o clique no grid ({afterWindows.Count})");
        }

        var clientHwnd = afterWindows[0];

        // ---- Gate fail-closed pos-abertura ----
        // Codigo: exigir exatamente 1 TcxDBMaskEdit cujo texto seja
        // EXATAMENTE o codigo solicitado (nunca "o unico nao-vazio" - o
        // primeiro OnceProbe real nao expos esse problema para Codigo,
        // mas a mesma disciplina de correspondencia exata e' aplicada por
        // consistencia e seguranca).
        var codeMatches = FindExactTextMatches(clientHwnd, ClientCodeControlClassName, navigationTarget.ClientCode);
        if (codeMatches.Count == 0)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientIdentityMismatch, $"nenhum {ClientCodeControlClassName} com texto exatamente '{navigationTarget.ClientCode}' encontrado - cliente aberto e' outro");
        }
        if (codeMatches.Count > 1)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientIdentityAmbiguous, $"{codeMatches.Count} controles {ClientCodeControlClassName} com texto '{navigationTarget.ClientCode}' - ambiguidade");
        }

        // Nome: CORRECAO pos-primeiro OnceProbe real - o cadastro pode ter
        // varios TcxDBTextEdit nao-vazios simultaneamente (telefone,
        // codigo de area, etc.). NUNCA exigir "exatamente 1 nao-vazio" -
        // em vez disso, localizar por CORRESPONDENCIA EXATA ao
        // ExpectedClientName (agora obrigatorio), ignorando qualquer outro
        // TcxDBTextEdit nao-vazio que nao bata.
        var nameMatches = FindExactTextMatches(clientHwnd, ClientNameControlClassName, navigationTarget.ExpectedClientName);
        if (nameMatches.Count == 0)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientIdentityMismatch, $"nenhum {ClientNameControlClassName} com texto exatamente '{navigationTarget.ExpectedClientName}' encontrado - cliente aberto e' outro");
        }
        if (nameMatches.Count > 1)
        {
            return ClientOpenResult.Fail(AgentErrorCode.ClientIdentityAmbiguous, $"{nameMatches.Count} controles {ClientNameControlClassName} com texto '{navigationTarget.ExpectedClientName}' - ambiguidade");
        }

        return ClientOpenResult.Pass(new OpenedClientIdentity(clientHwnd, navigationTarget.ClientCode, navigationTarget.ExpectedClientName));
    }

    public TransactionsTabResult OpenTransactionsTab(NexAdminWindowIdentity target, OpenedClientIdentity client)
    {
        // Reconfirma a mesma janela de cliente ainda existe/valida - nunca
        // confia que continua igual so porque foi retornada antes.
        if (!_nativeApi.IsWindowValid(client.ClientWindowHandle))
        {
            return TransactionsTabResult.Fail(AgentErrorCode.ClientWindowNotFound, "TFrmCadCli deixou de existir antes de abrir Transacoes");
        }

        var candidates = FindChildrenByClassAndText(client.ClientWindowHandle, TransactionsTabClassName, TransactionsTabText);
        if (candidates.Count != 1)
        {
            return TransactionsTabResult.Fail(AgentErrorCode.TransactionsTabAmbiguous, $"esperado exatamente 1 {TransactionsTabClassName} '{TransactionsTabText}', encontrado(s) {candidates.Count}");
        }
        var tabHwnd = candidates[0];

        if (!_nativeApi.IsWindowValid(tabHwnd) || !_nativeApi.IsWindowCurrentlyVisible(tabHwnd) || !_nativeApi.IsWindowCurrentlyEnabled(tabHwnd))
        {
            return TransactionsTabResult.Fail(AgentErrorCode.TransactionsTabNotFound, "HWND da aba Transacoes invalido/invisivel/desabilitado");
        }

        var clientSize = _nativeApi.GetClientSize(tabHwnd);
        if (clientSize is null || clientSize.Value.width <= 0 || clientSize.Value.height <= 0)
        {
            return TransactionsTabResult.Fail(AgentErrorCode.TransactionsTabNotFound, "GetClientRect da aba Transacoes falhou ou retornou area vazia");
        }

        var clickX = clientSize.Value.width / 2;
        var clickY = clientSize.Value.height / 2;

        var down = _nativeApi.PostMouseDown(tabHwnd, clickX, clickY);
        if (!down.posted)
        {
            return TransactionsTabResult.Fail(AgentErrorCode.OverflowPostFailed, $"PostMessage WM_LBUTTONDOWN falhou na aba Transacoes (GetLastError={down.lastError})");
        }

        _delay.Wait(PressDuration);

        var up = _nativeApi.PostMouseUp(tabHwnd, clickX, clickY);
        if (!up.posted)
        {
            return TransactionsTabResult.Fail(AgentErrorCode.OverflowPostFailed, $"PostMessage WM_LBUTTONUP falhou na aba Transacoes (GetLastError={up.lastError})");
        }

        _delay.Wait(PostActionSettleDelay);

        // PostMessage=True NUNCA e' interpretado sozinho como sucesso -
        // exige-se prova estrutural de que a pagina realmente ativou.
        var visibleTexts = ReadAllVisibleChildTexts(client.ClientWindowHandle);
        var indicatorsPresent = TransactionsPageIndicators.Count(indicator => visibleTexts.Any(t => t.Contains(indicator, StringComparison.Ordinal)));

        if (indicatorsPresent < MinimumIndicatorsForActiveTab)
        {
            return TransactionsTabResult.Fail(AgentErrorCode.TransactionsTabNoEffect, $"apenas {indicatorsPresent}/{TransactionsPageIndicators.Length} indicadores estruturais presentes apos o clique - sem retry");
        }

        var codeStillMatches = FindExactTextMatches(client.ClientWindowHandle, ClientCodeControlClassName, client.ClientCode);
        var nameStillMatches = FindExactTextMatches(client.ClientWindowHandle, ClientNameControlClassName, client.ClientName);
        if (codeStillMatches.Count != 1 || nameStillMatches.Count != 1)
        {
            return TransactionsTabResult.Fail(AgentErrorCode.AmbiguousIdentityAfterNavigation, "identidade do cliente (Codigo/Nome por correspondencia exata) divergiu apos abrir a aba Transacoes");
        }

        return TransactionsTabResult.Pass();
    }

    private static Win32Interop.RECT ToRect((int left, int top, int right, int bottom) r) =>
        new() { Left = r.left, Top = r.top, Right = r.right, Bottom = r.bottom };

    private static string FormatRect(Win32Interop.RECT r) => $"{r.Left},{r.Top},{r.Right},{r.Bottom}";

    /// <summary>Enumera os descendentes FRESCOS de `parentHwnd` e retorna
    /// os HWNDs cuja classe seja `className` E cujo texto (WM_GETTEXT)
    /// seja EXATAMENTE `expectedText` - nunca "o unico nao-vazio". Usado
    /// tanto para Codigo quanto para Nome, garantindo que outros
    /// controles da mesma classe com conteudo diferente (ex.: telefone,
    /// codigo de area em outros TcxDBTextEdit) sejam corretamente
    /// ignorados em vez de causar falso-positivo/falso-negativo por
    /// cardinalidade.</summary>
    private IReadOnlyList<nint> FindExactTextMatches(nint parentHwnd, string className, string expectedText) =>
        _nativeApi.EnumChildWindows(parentHwnd)
            .Where(h => string.Equals(_nativeApi.GetClassName(h), className, StringComparison.Ordinal)
                        && string.Equals(_nativeApi.ReadControlText(h), expectedText, StringComparison.Ordinal))
            .ToList();

    private IReadOnlyList<string> ReadAllVisibleChildTexts(nint parentHwnd) =>
        _nativeApi.EnumChildWindows(parentHwnd)
            .Where(h => _nativeApi.IsWindowCurrentlyVisible(h))
            .Select(h => _nativeApi.ReadControlText(h))
            .Where(t => !string.IsNullOrEmpty(t))
            .Select(t => t!)
            .ToList();

    private IReadOnlyList<nint> FindChildrenByClass(nint parentHwnd, string className) =>
        _nativeApi.EnumChildWindows(parentHwnd)
            .Where(h => string.Equals(_nativeApi.GetClassName(h), className, StringComparison.Ordinal))
            .ToList();

    private IReadOnlyList<nint> FindChildrenByClassAndText(nint parentHwnd, string className, string text) =>
        _nativeApi.EnumChildWindows(parentHwnd)
            .Where(h => string.Equals(_nativeApi.GetClassName(h), className, StringComparison.Ordinal)
                        && string.Equals(_nativeApi.ReadControlText(h), text, StringComparison.Ordinal))
            .ToList();

    private IReadOnlyList<nint> FindTopLevelByClass(int processId, string className) =>
        _readOnlyWindows.GetVisibleTopLevelWindowsForProcess(processId)
            .Where(h => string.Equals(_readOnlyWindows.GetClassName(h), className, StringComparison.Ordinal))
            .ToList();
}
