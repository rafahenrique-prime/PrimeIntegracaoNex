using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (V1) de INexOverflowMenuOpener. Usa o ponto de tela
/// final homologado (NexOverflowButtonProfile) SOMENTE se a geometria
/// atual da TFrmCadCli bater exatamente com a calibracao - fail-closed
/// (OverflowGeometryMismatch) caso contrario, nunca escala/recalcula.
/// Reacquire o TPanel do botao via hit-test em runtime a cada chamada
/// (nunca cacheia HWND entre execucoes).
/// </summary>
public sealed class WindowsNexOverflowMenuOpener : INexOverflowMenuOpener
{
    private const string PopupClassName = "TdxBarSubMenuControl";
    private const string PopupOwnerClassName = "TfbTranCli";
    private const string PopupOwnerTitle = "Transações";

    private static readonly string[] ExpectedItemNames =
    {
        "Agrupar por colunas", "Imprimir lista de transações", "Exportar lista de transações",
    };

    private static readonly TimeSpan PressDuration = TimeSpan.FromMilliseconds(80);
    private static readonly TimeSpan PostClickSettleDelay = TimeSpan.FromMilliseconds(500);

    private readonly IOverflowHitTestNativeApi _hitTest;
    private readonly IMsaaAccessibilityApi _msaa;
    private readonly IDelay _delay;

    public WindowsNexOverflowMenuOpener(IOverflowHitTestNativeApi hitTest, IMsaaAccessibilityApi msaa, IDelay delay)
    {
        _hitTest = hitTest;
        _msaa = msaa;
        _delay = delay;
    }

    public OverflowMenuResult OpenOverflowMenu(NexAdminWindowIdentity target, OpenedClientIdentity client)
    {
        // ---- Estado limpo: nenhum popup ja aberto ----
        var existingPopups = _hitTest.FindVisibleTopLevelByClass(target.ProcessId, PopupClassName);
        if (existingPopups.Count != 0)
        {
            return OverflowMenuResult.Fail(AgentErrorCode.OverflowPopupNotFound, $"ja existe(m) {existingPopups.Count} popup(s) de overflow aberto(s) antes de iniciar");
        }

        // ---- Geometry stability gate (correcao pos-4o OnceProbe/Probe 11B) ----
        // Uma unica leitura imediatamente apos TransactionsTabActive nao
        // basta (a falha real teve so ~6.8ms de folga, sem tempo de
        // repaint/resize residual). Exige N leituras CONSECUTIVAS
        // corretas, com handle gate (IsWindow+PID) a cada amostra, antes
        // de prosseguir para qualquer hit-test/PostMessage. ZERO clique,
        // ZERO PostMessage de mouse, ZERO acao mutante durante este gate -
        // isto NAO e' retry de acao, e' apenas leitura bounded.
        var maxSamples = Math.Max(1, NexOverflowButtonProfile.MaxGeometryWaitMs / NexOverflowButtonProfile.GeometryPollIntervalMs);
        var pollInterval = TimeSpan.FromMilliseconds(NexOverflowButtonProfile.GeometryPollIntervalMs);

        var sampleCount = 0;
        var consecutiveMatches = 0;
        (int left, int top, int right, int bottom)? lastActualRect = null;

        while (true)
        {
            if (sampleCount > 0)
            {
                _delay.Wait(pollInterval);
            }

            if (!_hitTest.IsWindowValid(client.ClientWindowHandle))
            {
                return OverflowMenuResult.Fail(AgentErrorCode.OverflowHandleInvalidated,
                    BuildGeometryDiagnostic("TFrmCadCli HWND ficou invalido durante o geometry stability gate - fail closed, HWND nunca trocado silenciosamente", client, target, lastActualRect, sampleCount, consecutiveMatches));
            }

            var currentPid = _hitTest.GetOwningProcessId(client.ClientWindowHandle);
            if (currentPid != target.ProcessId)
            {
                return OverflowMenuResult.Fail(AgentErrorCode.OverflowHandleInvalidated,
                    BuildGeometryDiagnostic($"PID do TFrmCadCli divergiu durante o geometry stability gate (atual={currentPid}, esperado={target.ProcessId}) - fail closed", client, target, lastActualRect, sampleCount, consecutiveMatches));
            }

            var rect = _hitTest.GetWindowRectPhysical(client.ClientWindowHandle);
            sampleCount++;

            if (rect is null)
            {
                consecutiveMatches = 0;
            }
            else
            {
                lastActualRect = rect;
                var sampledRect = new Win32Interop.RECT { Left = rect.Value.left, Top = rect.Value.top, Right = rect.Value.right, Bottom = rect.Value.bottom };
                consecutiveMatches = NexOverflowButtonProfile.MatchesExpectedGeometry(sampledRect) ? consecutiveMatches + 1 : 0;
            }

            if (consecutiveMatches >= NexOverflowButtonProfile.RequiredConsecutiveGeometryMatches)
            {
                break; // geometria estavel confirmada - PODE prosseguir
            }

            if (sampleCount >= maxSamples)
            {
                return OverflowMenuResult.Fail(AgentErrorCode.OverflowGeometryMismatch,
                    BuildGeometryDiagnostic("geometria nao estabilizou dentro do tempo maximo - fail-closed, sem recalculo/escala", client, target, lastActualRect, sampleCount, consecutiveMatches));
            }
        }

        var screenX = NexOverflowButtonProfile.ValidatedOverflowScreenX;
        var screenY = NexOverflowButtonProfile.ValidatedOverflowScreenY;

        // ---- Reacquire fresco do HWND sob o ponto calibrado ----
        var targetHwnd = _hitTest.WindowFromPhysicalPoint(screenX, screenY);
        if (targetHwnd == 0)
        {
            return OverflowMenuResult.Fail(AgentErrorCode.OverflowTargetNotMapped, "WindowFromPhysicalPoint nao encontrou nenhuma janela no ponto calibrado");
        }
        if (_hitTest.GetOwningProcessId(targetHwnd) != target.ProcessId)
        {
            return OverflowMenuResult.Fail(AgentErrorCode.OverflowTargetOccluded, "ponto calibrado esta ocluido por janela de outro processo");
        }

        var clientPoint = _hitTest.ScreenToClient(targetHwnd, screenX, screenY);
        if (clientPoint is null)
        {
            return OverflowMenuResult.Fail(AgentErrorCode.OverflowTargetNotMapped, "ScreenToClient falhou no HWND alvo");
        }

        var down = _hitTest.PostMouseDown(targetHwnd, clientPoint.Value.clientX, clientPoint.Value.clientY);
        if (!down.posted)
        {
            return OverflowMenuResult.Fail(AgentErrorCode.OverflowPostFailed, $"PostMessage WM_LBUTTONDOWN falhou (GetLastError={down.lastError})");
        }

        _delay.Wait(PressDuration);

        var up = _hitTest.PostMouseUp(targetHwnd, clientPoint.Value.clientX, clientPoint.Value.clientY);
        if (!up.posted)
        {
            return OverflowMenuResult.Fail(AgentErrorCode.OverflowPostFailed, $"PostMessage WM_LBUTTONUP falhou (GetLastError={up.lastError})");
        }

        _delay.Wait(PostClickSettleDelay);

        // ---- Validar popup: PostMessage=True nao e' interpretado sozinho como sucesso ----
        var popups = _hitTest.FindVisibleTopLevelByClass(target.ProcessId, PopupClassName);
        if (popups.Count == 0)
        {
            return OverflowMenuResult.Fail(AgentErrorCode.OverflowPopupNotFound, "nenhum popup apareceu apos o clique - sem retry");
        }
        if (popups.Count > 1)
        {
            return OverflowMenuResult.Fail(AgentErrorCode.OverflowWrongPopup, $"mais de 1 popup apareceu ({popups.Count}) - ambiguidade");
        }

        var popupHwnd = popups[0];
        var ownerHwnd = _hitTest.GetParent(popupHwnd);
        var ownerClass = _hitTest.GetClassName(ownerHwnd);
        var ownerTitle = _hitTest.GetWindowTitle(ownerHwnd);

        if (!string.Equals(ownerClass, PopupOwnerClassName, StringComparison.Ordinal) ||
            !string.Equals(ownerTitle, PopupOwnerTitle, StringComparison.Ordinal))
        {
            return OverflowMenuResult.Fail(AgentErrorCode.OverflowWrongPopup, $"popup encontrado mas owner incorreto (class='{ownerClass}', title='{ownerTitle}')");
        }

        var popupRect = _hitTest.GetWindowRectPhysical(popupHwnd);
        if (popupRect is null)
        {
            return OverflowMenuResult.Fail(AgentErrorCode.OverflowWrongPopup, "GetWindowRect do popup falhou");
        }

        var foundNames = ScanPopupItemNames(popupRect.Value);
        var allExpectedFound = ExpectedItemNames.All(expected => foundNames.Contains(expected));
        if (!allExpectedFound)
        {
            return OverflowMenuResult.Fail(AgentErrorCode.OverflowWrongPopup, $"itens MSAA esperados nao confirmados - encontrados: [{string.Join(", ", foundNames)}]");
        }

        return OverflowMenuResult.Pass(ownerClass!, ownerTitle!);
    }

    /// <summary>Monta o diagnostico textual persistido em OverflowMenuResult.Reason
    /// (e, por extensao, no log do orquestrador) quando o geometry
    /// stability gate falha - correcao pos-Probe 11B: antes dessa
    /// correcao o ACTUAL_RECT/HWND/PID/contagem de amostras eram sempre
    /// descartados, impedindo provar a causa exata de uma falha real.</summary>
    private static string BuildGeometryDiagnostic(
        string summary,
        OpenedClientIdentity client,
        NexAdminWindowIdentity target,
        (int left, int top, int right, int bottom)? actualRect,
        int sampleCount,
        int consecutiveMatches)
    {
        var expected = NexOverflowButtonProfile.ExpectedCadCliWindowRect;
        var actualText = actualRect is null
            ? "null"
            : $"({actualRect.Value.left},{actualRect.Value.top},{actualRect.Value.right},{actualRect.Value.bottom})";
        var elapsedMs = Math.Max(0, sampleCount - 1) * NexOverflowButtonProfile.GeometryPollIntervalMs;

        return $"{summary} | " +
               $"CADCLI_HWND={client.ClientWindowHandle} | " +
               $"EXPECTED_CADCLI_RECT=({expected.Left},{expected.Top},{expected.Right},{expected.Bottom}) | " +
               $"ACTUAL_CADCLI_RECT={actualText} | " +
               $"GEOMETRY_SAMPLE_COUNT={sampleCount} | " +
               $"GEOMETRY_STABLE_MATCH_COUNT={consecutiveMatches} | " +
               $"GEOMETRY_WAIT_ELAPSED_MS={elapsedMs} | " +
               $"TARGET_NEX_PID={target.ProcessId} | " +
               "OVERFLOW_DPI_CONTEXT=DPI_AWARENESS_CONTEXT_UNAWARE";
    }

    private HashSet<string> ScanPopupItemNames((int left, int top, int right, int bottom) rect)
    {
        var found = new HashSet<string>(StringComparer.Ordinal);
        const int stepY = 15;
        for (var y = rect.top + 5; y < rect.bottom; y += stepY)
        {
            var element = _msaa.HitTest(rect.left + 10, y);
            if (element is null) continue;
            var name = _msaa.GetName(element);
            if (!string.IsNullOrEmpty(name)) found.Add(name);
        }
        return found;
    }
}
