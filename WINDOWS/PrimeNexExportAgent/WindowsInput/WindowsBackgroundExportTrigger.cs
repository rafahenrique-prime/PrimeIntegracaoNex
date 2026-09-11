using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// Implementacao REAL (Scheduler V2, --run-once-scheduled-background-safe)
/// de IInputSender. Ao contrario de WindowsInputSender/
/// WindowsScheduledSafeInputSender (Shift+F5, exigem ou tentam foreground),
/// este trigger opera INTEIRAMENTE com o NexAdmin em BACKGROUND - mecanismo
/// homologado em runtime real nas Fases B.1.3 (WM_COMMAND/BN_CLICKED abre
/// o popup), B.2 (accDoDefaultAction aciona "Exportar", Save Dialog
/// aparece) e B.3 (Save Dialog->commit->XLS real, validado pelo Reader de
/// producao em B.3.1).
///
/// Disciplina fail-closed em duas fases distintas (decisao de design
/// homologada):
///   1. ANTES de qualquer acao mutante (WM_COMMAND) - qualquer gate de
///      ESTADO OPERACIONAL SEGURO nao satisfeito (NEX em foreground,
///      abridor nao identificado, "Todas vendas" nao confirmado) lanca
///      BackgroundSafeSkipException - ExportAgentOrchestrator trata como
///      skip (AgentStage.UnsafeState, exit 0), NUNCA como falha.
///   2. DEPOIS que o WM_COMMAND foi enviado - qualquer divergencia (popup
///      nao abriu, popup errado, "Exportar" nao localizado de forma
///      inequivoca, accDoDefaultAction falhou) lanca
///      InvalidOperationException - tratada como AgentStage.Failed
///      (exit 1), nunca mascarada como skip.
///
/// Localizacao de "Todas vendas" (barra da aba Historico) e "Exportar"
/// (popup TdxBarSubMenuControl) usa EXCLUSIVAMENTE
/// IMsaaAccessibilityApi.HitTestWithinWindow (AccessibleObjectFromWindow +
/// accHitTest ancorado ao HWND especifico) - NUNCA
/// AccessibleObjectFromPoint/HitTest global (hit-test de desktop), que
/// seria vulneravel a oclusao pela janela em primeiro plano (Chrome/
/// Claude). Decisao de design homologada, evidenciada em runtime real nas
/// Fases A.5/A.10.
///
/// Cada acao mutante (WM_COMMAND, accDoDefaultAction) e enviada NO MAXIMO
/// 1 vez por execucao - nenhum caminho de codigo abaixo re-tenta.
/// </summary>
public sealed class WindowsBackgroundExportTrigger : IInputSender
{
    /// <summary>OrdinalIgnoreCase - evidencia real (GetClassNameW ao vivo)
    /// mostrou a janela registrada como "TFrmPri", nao "TfrmPri"; Ordinal
    /// causava BackgroundSafeSkipException mesmo com o target correto.</summary>
    private const string ExpectedMainWindowClassName = "TfrmPri";

    /// <summary>Identidade do abridor e' SEMPRE estrutural, NUNCA por
    /// ControlId - achado real (investigacao pos-fix de casing): o
    /// ControlId homologado em B.1.3 (133354) nao existia mais no runtime
    /// posterior (o TcxButton no mesmo indice/parent tinha ControlId=132948)
    /// e nao ha nenhuma prova registrada de que esse valor seja fixo entre
    /// execucoes do Delphi/VCL. ControlId continua sendo lido dinamicamente
    /// (ver LocateOpenerOrSkip/FindStructuralOpenerOrDefault) apenas para
    /// compor o WM_COMMAND - nunca para decidir identidade.</summary>
    private const string OpenerClassName = "TcxButton";
    private const string OpenerParentClassName = "TPanel";
    private const int RequiredSiblingIndexZeroBased = 5;

    private const string BarControlClassName = "TdxBarControl";
    private const string AllSalesItemName = "Todas vendas";

    private const string PopupClassName = "TdxBarSubMenuControl";
    private const string ExportItemName = "Exportar";
    private const int MsaaRolePushButton = 43;
    private const int MsaaStateUnavailable = 0x1;

    private const uint WmCommandTimeoutMs = 1000;
    private const int ScanStepY = 15;
    private const int ScanStepX = 15;

    /// <summary>Direcao de varredura MSAA dentro do rect de um HWND
    /// (nunca hit-test de desktop - sempre HitTestWithinWindow). Vertical
    /// (X fixo, Y variando) e' correta para o popup TdxBarSubMenuControl
    /// (menu empilhado verticalmente). Horizontal (Y fixo, X variando) e'
    /// correta para a barra TdxBarControl da aba Historico (~22px de
    /// altura, itens dispostos lado a lado) - confirmado em runtime real
    /// (recheck pos-B.3: "Todas vendas" so foi encontrado varrendo X,
    /// nunca varrendo Y, na mesma barra onde a varredura vertical dava
    /// RAW_HIT_COUNT=0).</summary>
    private enum ScanDirection { Vertical, Horizontal }

    private static readonly TimeSpan PopupWaitTimeout = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan PopupWaitPollInterval = TimeSpan.FromMilliseconds(100);

    private readonly INativeWindowApi _nativeWindows;
    private readonly IOverflowHitTestNativeApi _hitTest;
    private readonly IMsaaAccessibilityApi _msaa;
    private readonly IBackgroundClickNativeApi _backgroundClick;
    private readonly IForegroundReader _foregroundReader;
    private readonly IDelay _delay;
    private readonly IClock _clock;

    public WindowsBackgroundExportTrigger(
        INativeWindowApi nativeWindows,
        IOverflowHitTestNativeApi hitTest,
        IMsaaAccessibilityApi msaa,
        IBackgroundClickNativeApi backgroundClick,
        IForegroundReader foregroundReader,
        IDelay delay,
        IClock clock)
    {
        _nativeWindows = nativeWindows;
        _hitTest = hitTest;
        _msaa = msaa;
        _backgroundClick = backgroundClick;
        _foregroundReader = foregroundReader;
        _delay = delay;
        _clock = clock;
    }

    public void SendExportShortcut(NexAdminWindowIdentity target)
    {
        // ==================================================================
        // FASE 1: gates de ESTADO OPERACIONAL SEGURO - qualquer divergencia
        // aqui e SKIP (BackgroundSafeSkipException), nunca falha. Nenhuma
        // acao mutante foi enviada ainda neste ponto.
        // ==================================================================

        if (!_nativeWindows.IsWindowValid(target.MainWindowHandle))
        {
            throw new BackgroundSafeSkipException("HWND do target nao existe mais.");
        }
        if (_nativeWindows.GetOwningProcessId(target.MainWindowHandle) != target.ProcessId)
        {
            throw new BackgroundSafeSkipException("HWND ja nao pertence ao PID esperado.");
        }
        if (!string.Equals(_nativeWindows.GetClassName(target.MainWindowHandle), ExpectedMainWindowClassName, StringComparison.OrdinalIgnoreCase))
        {
            throw new BackgroundSafeSkipException("ClassName do target mudou.");
        }
        if (!_nativeWindows.IsWindowCurrentlyVisible(target.MainWindowHandle))
        {
            throw new BackgroundSafeSkipException("target nao esta mais visivel.");
        }

        // Intencao do modo background-safe e' precisamente NAO agir
        // enquanto o usuario esta com o NEX em primeiro plano - QUALQUER
        // janela do NexAdmin, nao so o HWND exato de TfrmPri (achado
        // runtime real: com o widget TfrmIntercom/"Atendimento" em
        // foreground - HWND distinto de TfrmPri mas OWNER=TfrmPri, mesmo
        // PID - uma comparacao de HWND exato deixaria passar um caso onde
        // o usuario claramente esta usando o NEX). Ver IsNexForeground.
        if (IsNexForeground(target))
        {
            throw new BackgroundSafeSkipException("NEX (ou janela pertencente ao mesmo processo) esta em foreground - nao seguro agir em background.");
        }

        var openerHwnd = LocateOpenerOrSkip(target.MainWindowHandle, out var parentHwnd, out var controlId);

        ConfirmAllSalesOrSkip(target.MainWindowHandle);

        // Nenhum popup/dialogo de exportacao pode ja estar aberto antes de
        // iniciar - reaproveita FindVisibleTopLevelByClass, ja homologado.
        var popupsBefore = _hitTest.FindVisibleTopLevelByClass(target.ProcessId, PopupClassName);
        if (popupsBefore.Count != 0)
        {
            throw new BackgroundSafeSkipException($"popup '{PopupClassName}' ja aberto antes de iniciar (count={popupsBefore.Count}).");
        }

        // Revalidacao de foreground IMEDIATAMENTE antes da unica acao
        // mutante - o foco pode ter mudado entre as checagens acima e agora.
        // Mesmo criterio por PID de IsNexForeground - nunca so HWND exato.
        if (IsNexForeground(target))
        {
            throw new BackgroundSafeSkipException("NEX (ou janela pertencente ao mesmo processo) assumiu foreground imediatamente antes do WM_COMMAND.");
        }

        // ==================================================================
        // FASE 2: a partir daqui, exatamente 1 WM_COMMAND sera enviado.
        // Qualquer divergencia DAQUI EM DIANTE e FALHA TECNICA
        // (InvalidOperationException), nunca skip - nenhum caminho de
        // volta, nenhum retry.
        // ==================================================================

        var send = _backgroundClick.SendBnClickedViaWmCommand(parentHwnd, openerHwnd, controlId, WmCommandTimeoutMs);
        if (!send.completed)
        {
            throw new InvalidOperationException($"WM_COMMAND/BN_CLICKED falhou (LastError={send.lastError}) - nenhuma segunda tentativa.");
        }

        var popupHwnd = WaitForSinglePopup(target.ProcessId);
        if (popupHwnd == 0)
        {
            throw new InvalidOperationException($"popup '{PopupClassName}' nao apareceu (ou apareceu ambiguo) apos o WM_COMMAND.");
        }

        var exportElement = FindUniqueElementByName(popupHwnd, ExportItemName, ScanDirection.Vertical)
            ?? throw new InvalidOperationException($"item '{ExportItemName}' nao localizado de forma inequivoca no popup.");

        var role = _msaa.GetRole(exportElement);
        var state = _msaa.GetState(exportElement);
        var isDisabled = (state & MsaaStateUnavailable) != 0;
        if (role != MsaaRolePushButton || isDisabled)
        {
            throw new InvalidOperationException($"item '{ExportItemName}' encontrado mas role={role} (esperado {MsaaRolePushButton}) ou disabled={isDisabled}.");
        }

        // ---- Acao unica final: accDoDefaultAction exatamente 1 vez. ----
        var dispatched = _msaa.DoDefaultAction(exportElement);
        if (!dispatched)
        {
            throw new InvalidOperationException("accDoDefaultAction falhou/lancou excecao.");
        }

        // A partir daqui, o ExportAgentOrchestrator assume EXPORT_TRIGGERED
        // e prossegue para ISaveDialogWaiter/Inspector/Controller/Committer
        // - identico ao fluxo V1, nenhuma diferenca de codigo downstream.
    }

    /// <summary>Scheduler V2 - "NEX em foreground" NUNCA e' decidido por
    /// igualdade de HWND exato sozinha (isso deixaria passar qualquer
    /// janela legitima do NexAdmin que nao seja o HWND literal de
    /// TfrmPri - achado runtime real: TfrmIntercom/"Atendimento", HWND
    /// distinto mas OWNER=TfrmPri, mesmo PID, com o usuario claramente
    /// usando o NEX). Criterio: HWND exato OU MESMO PID do foreground
    /// atual - cobre qualquer janela legitima pertencente ao processo
    /// NexAdmin, nunca dependendo de resolver a cadeia de owner inteira
    /// (GetOwningProcessId ja e' suficiente e mais simples). Puramente
    /// leitura - nunca chama SetForegroundWindow/SendInput/qualquer acao.</summary>
    private bool IsNexForeground(NexAdminWindowIdentity target)
    {
        var foregroundHwnd = _foregroundReader.GetForegroundWindow();
        if (foregroundHwnd == target.MainWindowHandle)
        {
            return true;
        }

        var foregroundPid = _nativeWindows.GetOwningProcessId(foregroundHwnd);
        return foregroundPid == target.ProcessId;
    }

    private nint LocateOpenerOrSkip(nint mainWindowHandle, out nint parentHwnd, out int controlId)
    {
        var opener = FindStructuralOpenerOrDefault(mainWindowHandle, out var matchCount);
        if (matchCount != 1)
        {
            throw new BackgroundSafeSkipException($"abridor: MATCH_COUNT esperado=1, encontrado={matchCount}.");
        }

        parentHwnd = _nativeWindows.GetParentWindow(opener);
        controlId = _nativeWindows.GetControlId(opener);
        if (controlId <= 0)
        {
            throw new BackgroundSafeSkipException($"abridor: CONTROL_ID invalido na descoberta (atual={controlId}).");
        }

        // ---- Revalidacao TOCTOU (decisao de design homologada): repete o
        // MESMO matcher estrutural inteiro imediatamente antes do
        // WM_COMMAND - nunca confia apenas no HWND salvo. Qualquer mudanca
        // de identidade/topologia entre a descoberta e este ponto e' SKIP,
        // nunca falha tecnica (nenhum WM_COMMAND foi enviado ainda). ----
        var revalidatedOpener = FindStructuralOpenerOrDefault(mainWindowHandle, out var revalidatedMatchCount);
        if (revalidatedMatchCount != 1 || revalidatedOpener != opener)
        {
            throw new BackgroundSafeSkipException(
                $"abridor: revalidacao TOCTOU falhou (MATCH_COUNT={revalidatedMatchCount}, mesmoHwnd={revalidatedOpener == opener}).");
        }

        var revalidatedParent = _nativeWindows.GetParentWindow(revalidatedOpener);
        if (revalidatedParent != parentHwnd)
        {
            throw new BackgroundSafeSkipException("abridor: parent mudou na revalidacao TOCTOU.");
        }

        // ControlId e' relido no final (nunca reaproveita o valor da
        // descoberta) - se ele mudou entre a descoberta e agora mas a
        // identidade ESTRUTURAL continua a mesma, usa-se o valor NOVO
        // (prova de que ControlId nunca decide identidade).
        var revalidatedControlId = _nativeWindows.GetControlId(revalidatedOpener);
        if (revalidatedControlId <= 0)
        {
            throw new BackgroundSafeSkipException($"abridor: CONTROL_ID invalido na revalidacao (atual={revalidatedControlId}).");
        }

        controlId = revalidatedControlId;
        return revalidatedOpener;
    }

    /// <summary>Fingerprint estrutural do abridor - ClassName+Visible+
    /// Enabled+Parent(TPanel)+SiblingIndex==5, NUNCA ControlId (ver
    /// comentario da constante OpenerClassName acima). Retorna o HWND
    /// unico se matchCount==1, ou 0 caso contrario - o chamador (descoberta
    /// ou revalidacao TOCTOU, ambas usam esta MESMA funcao) decide o que
    /// fazer com matchCount!=1.</summary>
    private nint FindStructuralOpenerOrDefault(nint mainWindowHandle, out int matchCount)
    {
        var matches = new List<nint>();
        foreach (var h in _nativeWindows.GetAllDescendants(mainWindowHandle))
        {
            if (!_nativeWindows.IsWindowValid(h)) continue;
            if (!string.Equals(_nativeWindows.GetClassName(h), OpenerClassName, StringComparison.Ordinal)) continue;
            if (!_nativeWindows.IsWindowCurrentlyVisible(h)) continue;
            if (!_nativeWindows.IsWindowCurrentlyEnabled(h)) continue;

            var parent = _nativeWindows.GetParentWindow(h);
            if (parent == 0) continue;
            if (!string.Equals(_nativeWindows.GetClassName(parent), OpenerParentClassName, StringComparison.Ordinal)) continue;

            var siblings = _nativeWindows.GetImmediateChildrenInZOrder(parent);
            var siblingIndex = -1;
            for (var i = 0; i < siblings.Count; i++)
            {
                if (siblings[i] == h) { siblingIndex = i; break; }
            }
            if (siblingIndex != RequiredSiblingIndexZeroBased) continue;

            matches.Add(h);
        }

        matchCount = matches.Count;
        return matchCount == 1 ? matches[0] : 0;
    }

    /// <summary>ClassName=="TdxBarControl"+Visible sozinho NAO e' unico -
    /// runtime real confirmou ate 3 barras simultaneas visiveis (Historico
    /// tem sua propria barra de filtro, mas outras abas/paineis tambem
    /// expoem TdxBarControl proprios). Por isso a selecao NUNCA e'
    /// estrutural (nunca "exatamente 1 TdxBarControl visivel") - e'
    /// SEMPRE pelo CONTEUDO: enumera TODAS as barras candidatas e exige
    /// que EXATAMENTE UMA delas contenha, de forma inequivoca (varredura
    /// horizontal, dedup por fingerprint), o item "Todas vendas".</summary>
    private void ConfirmAllSalesOrSkip(nint mainWindowHandle)
    {
        var barCandidates = new List<nint>();
        foreach (var h in _nativeWindows.GetAllDescendants(mainWindowHandle))
        {
            if (string.Equals(_nativeWindows.GetClassName(h), BarControlClassName, StringComparison.Ordinal) &&
                _nativeWindows.IsWindowCurrentlyVisible(h))
            {
                barCandidates.Add(h);
            }
        }

        if (barCandidates.Count == 0)
        {
            throw new BackgroundSafeSkipException($"nenhuma barra candidata ('{BarControlClassName}' visivel) encontrada.");
        }

        var barsContainingAllSales = 0;
        foreach (var barHwnd in barCandidates)
        {
            if (FindUniqueElementByName(barHwnd, AllSalesItemName, ScanDirection.Horizontal) is not null)
            {
                barsContainingAllSales++;
            }
        }

        if (barsContainingAllSales != 1)
        {
            throw new BackgroundSafeSkipException(
                $"'{AllSalesItemName}': esperado exatamente 1 barra candidata contendo o item, encontrado {barsContainingAllSales} (de {barCandidates.Count} barra(s) candidata(s)) - nao seguro prosseguir.");
        }
    }

    private nint WaitForSinglePopup(int processId)
    {
        var deadline = _clock.Now + PopupWaitTimeout;
        while (true)
        {
            var popups = _hitTest.FindVisibleTopLevelByClass(processId, PopupClassName);
            if (popups.Count == 1) return popups[0];
            if (popups.Count > 1) return 0; // ambiguo - nunca escolher o primeiro

            if (_clock.Now >= deadline) return 0;
            _delay.Wait(PopupWaitPollInterval);
        }
    }

    /// <summary>Varre `hwnd` via HitTestWithinWindow (nunca hit-test
    /// global), na direcao pedida por `direction` (Vertical: X fixo, Y
    /// variando - popup empilhado verticalmente; Horizontal: Y fixo, X
    /// variando - barra de toolbar, itens lado a lado), deduplica
    /// candidatos por fingerprint semantico (Name+Role+ChildId+Location -
    /// mesmo padrao ja homologado em WindowsNexExportTrigger, correcao
    /// pos-Probe 13A), e exige EXATAMENTE 1 elemento unico com
    /// Name==`targetName`. Retorna um elemento FRESCO (reobtido no ponto
    /// do candidato unico, nunca reaproveita o handle do scan) ou null se
    /// RAW=0 ou UNIQUE!=1.</summary>
    private MsaaElementHandle? FindUniqueElementByName(nint hwnd, string targetName, ScanDirection direction)
    {
        var rect = _hitTest.GetWindowRectPhysical(hwnd);
        if (rect is null) return null;

        var rawHitCount = 0;
        var candidatesByFingerprint = new Dictionary<string, (int scanX, int scanY)>(StringComparer.Ordinal);

        foreach (var (x, y) in BuildScanPoints(rect.Value, direction))
        {
            var element = _msaa.HitTestWithinWindow(hwnd, x, y);
            if (element is null) continue;

            var name = _msaa.GetName(element);
            if (!string.Equals(name, targetName, StringComparison.Ordinal)) continue;

            rawHitCount++;
            var fingerprint = $"{name}|{_msaa.GetRole(element)}|{_msaa.DescribeChildId(element)}|{_msaa.GetLocation(element)}";
            candidatesByFingerprint.TryAdd(fingerprint, (x, y));
        }

        if (rawHitCount == 0 || candidatesByFingerprint.Count != 1)
        {
            return null;
        }

        var (repX, repY) = candidatesByFingerprint.Values.Single();
        var fresh = _msaa.HitTestWithinWindow(hwnd, repX, repY);
        if (fresh is null || !string.Equals(_msaa.GetName(fresh), targetName, StringComparison.Ordinal))
        {
            return null; // desapareceu entre o scan e a releitura fresca
        }

        return fresh;
    }

    private static IEnumerable<(int x, int y)> BuildScanPoints((int left, int top, int right, int bottom) rect, ScanDirection direction)
    {
        if (direction == ScanDirection.Vertical)
        {
            var scanX = rect.left + 10;
            for (var y = rect.top + 5; y < rect.bottom; y += ScanStepY)
            {
                yield return (scanX, y);
            }
        }
        else
        {
            var scanY = rect.top + 5;
            for (var x = rect.left; x < rect.right; x += ScanStepX)
            {
                yield return (x, scanY);
            }
        }
    }
}
