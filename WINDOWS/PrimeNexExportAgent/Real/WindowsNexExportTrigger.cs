using System.Linq;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (V1) de INexExportTrigger. SEMPRE reencontra o
/// popup e o item MSAA do zero (nunca reaproveita nenhum objeto de uma
/// chamada anterior - OverflowMenuResult nao carrega nada disso) antes de
/// chamar accDoDefaultAction exatamente uma vez.
///
/// CORRECAO POS-PROBE 13A (deduplicacao MSAA): a varredura vertical (passo
/// de 15px) pode atingir o MESMO botao real mais de uma vez quando sua
/// altura excede o passo (comprovado em runtime: botao de 36px de altura
/// gerou 2 hits brutos identicos em Y=242 e Y=257). Contar hits BRUTOS
/// como candidatos distintos e' incorreto - a identidade de um elemento
/// MSAA nunca deve ser julgada por ponteiro COM (AccessibleObjectFromPoint
/// pode legitimamente devolver interfaces diferentes para o mesmo
/// elemento logico, conforme documentacao oficial), mas SIM por um
/// fingerprint semantico (Name+Role+ChildId+accLocation). Cada hit bruto
/// e' deduplicado por esse fingerprint antes do gate de cardinalidade
/// (0/1/&gt;1).
/// </summary>
public sealed class WindowsNexExportTrigger : INexExportTrigger
{
    private const string PopupClassName = "TdxBarSubMenuControl";
    private const string ExportItemName = "Exportar lista de transações";
    private const int MsaaRolePushButton = 43;
    private const int MsaaStateUnavailable = 0x1;

    private readonly IOverflowHitTestNativeApi _hitTest;
    private readonly IMsaaAccessibilityApi _msaa;

    public WindowsNexExportTrigger(IOverflowHitTestNativeApi hitTest, IMsaaAccessibilityApi msaa)
    {
        _hitTest = hitTest;
        _msaa = msaa;
    }

    public ExportTriggerResult TriggerExport(NexAdminWindowIdentity target, OverflowMenuResult overflow)
    {
        if (!overflow.Passed)
        {
            return ExportTriggerResult.Fail(AgentErrorCode.OverflowPopupNotFound, "OverflowMenuResult recebido nao esta em Passed=true");
        }

        // ---- Reencontra o popup do zero, confere owner contra o que veio validado ----
        var popups = _hitTest.FindVisibleTopLevelByClass(target.ProcessId, PopupClassName);
        if (popups.Count != 1)
        {
            return ExportTriggerResult.Fail(AgentErrorCode.OverflowPopupNotFound, $"esperado exatamente 1 popup no momento do trigger, encontrado {popups.Count}");
        }

        var popupHwnd = popups[0];
        var ownerHwnd = _hitTest.GetParent(popupHwnd);
        var ownerClass = _hitTest.GetClassName(ownerHwnd);
        var ownerTitle = _hitTest.GetWindowTitle(ownerHwnd);

        if (!string.Equals(ownerClass, overflow.PopupOwnerClass, StringComparison.Ordinal) ||
            !string.Equals(ownerTitle, overflow.PopupOwnerTitle, StringComparison.Ordinal))
        {
            return ExportTriggerResult.Fail(AgentErrorCode.OverflowWrongPopup, "popup no momento do trigger nao bate com o validado em OpenOverflowMenu (owner/title divergente) - fechado/reaberto?");
        }

        var popupRect = _hitTest.GetWindowRectPhysical(popupHwnd);
        if (popupRect is null)
        {
            return ExportTriggerResult.Fail(AgentErrorCode.OverflowWrongPopup, "GetWindowRect do popup falhou no momento do trigger");
        }

        // ---- Hit-test MSAA FRESCO - nunca reaproveita objeto de chamada anterior ----
        // Deduplica por fingerprint semantico (Name+Role+ChildId+Location)
        // - RAW_EXPORT_HIT_COUNT conta toda leitura de scan que bateu o
        // nome; UNIQUE_EXPORT_ELEMENT_COUNT conta fingerprints distintos
        // (o gate de cardinalidade usa SOMENTE o segundo).
        var rawHitCount = 0;
        var candidatesByFingerprint = new Dictionary<string, (int scanX, int scanY)>(StringComparer.Ordinal);
        const int stepY = 15;
        var scanX = popupRect.Value.left + 10;
        for (var y = popupRect.Value.top + 5; y < popupRect.Value.bottom; y += stepY)
        {
            var element = _msaa.HitTest(scanX, y);
            if (element is null) continue;
            var name = _msaa.GetName(element);
            if (!string.Equals(name, ExportItemName, StringComparison.Ordinal)) continue;

            rawHitCount++;
            var fingerprint = BuildFingerprint(name, _msaa.GetRole(element), _msaa.DescribeChildId(element), _msaa.GetLocation(element));
            candidatesByFingerprint.TryAdd(fingerprint, (scanX, y));
        }

        if (rawHitCount == 0)
        {
            return ExportTriggerResult.Fail(AgentErrorCode.ExportItemNotFound, $"item MSAA '{ExportItemName}' nao encontrado no popup atual (RAW_EXPORT_HIT_COUNT=0)");
        }
        if (candidatesByFingerprint.Count > 1)
        {
            return ExportTriggerResult.Fail(AgentErrorCode.ExportItemAmbiguous,
                $"mais de 1 elemento UNICO para '{ExportItemName}' apos deduplicacao - RAW_EXPORT_HIT_COUNT={rawHitCount} UNIQUE_EXPORT_ELEMENT_COUNT={candidatesByFingerprint.Count} fingerprints=[{string.Join(" | ", candidatesByFingerprint.Keys)}] - nunca escolher o primeiro");
        }

        // ---- Reencontra um representante FRESCO do unico fingerprint - nunca reaproveita o handle do scan acima ----
        var (repScanX, repScanY) = candidatesByFingerprint.Values.Single();
        var exportElement = _msaa.HitTest(repScanX, repScanY);
        if (exportElement is null || !string.Equals(_msaa.GetName(exportElement), ExportItemName, StringComparison.Ordinal))
        {
            return ExportTriggerResult.Fail(AgentErrorCode.ExportItemNotFound, "elemento unico desapareceu ao reobter referencia MSAA fresca antes da acao");
        }

        var role = _msaa.GetRole(exportElement);
        var state = _msaa.GetState(exportElement);
        var isDisabled = (state & MsaaStateUnavailable) != 0;

        if (role != MsaaRolePushButton || isDisabled)
        {
            return ExportTriggerResult.Fail(AgentErrorCode.ExportItemNotActionable, $"item '{ExportItemName}' encontrado mas role={role} (esperado {MsaaRolePushButton}) ou disabled={isDisabled}");
        }

        // ---- Acao unica: accDoDefaultAction exatamente 1 vez ----
        var dispatched = _msaa.DoDefaultAction(exportElement);
        if (!dispatched)
        {
            return ExportTriggerResult.Fail(AgentErrorCode.UnexpectedException, "accDoDefaultAction lancou excecao/falhou");
        }

        return ExportTriggerResult.Pass();
    }

    private static string BuildFingerprint(string? name, int role, string childId, (int left, int top, int width, int height)? location)
    {
        var loc = location is null ? "null" : $"{location.Value.left},{location.Value.top},{location.Value.width},{location.Value.height}";
        return $"{name}|{role}|{childId}|{loc}";
    }
}
