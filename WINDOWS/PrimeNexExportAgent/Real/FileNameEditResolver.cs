using PrimeNexExportAgent.WindowsNative;
using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Resolucao compartilhada (F6.14B2.2, corrigida em F6.14B2.3) do Edit real
/// dentro da subarvore do ComboBoxEx32 do CtrlId 1148 - evidencia real
/// (F6.14B2.1) provou que o nome do arquivo vive nesse Edit, nunca no HWND
/// do proprio ComboBoxEx32; evidencia adicional (probe real F6.14B2.2)
/// provou que esse Edit e NETO do ComboBoxEx32 (ComboBoxEx32 -> ComboBox ->
/// Edit), nao filho direto - por isso a busca usa GetDescendants (subarvore
/// inteira), nunca uma profundidade fixa. A seguranca vem de exigir
/// EXATAMENTE 1 ClassName=="Edit" em toda a subarvore, nunca de "o
/// primeiro"/"o mais profundo"/"o ultimo" encontrado. Usado tanto por
/// WindowsSaveDialogInspector (identificacao) quanto por
/// WindowsSaveDialogController (escrita) - nunca duplicado.
/// </summary>
internal static class FileNameEditResolver
{
    private const string EditClassName = "Edit";

    internal static bool TryResolve(
        nint comboBoxEx32Hwnd,
        INativeWindowApi nativeWindows,
        ISaveDialogControlApi controlApi,
        out nint editHwnd,
        out string? failureReason)
    {
        editHwnd = 0;

        IReadOnlyList<nint> descendants;
        try
        {
            descendants = controlApi.GetDescendants(comboBoxEx32Hwnd);
        }
        catch (Exception ex)
        {
            failureReason = $"erro ao enumerar descendentes do CtrlId 1148: {ex.Message}";
            return false;
        }

        var editCandidates = descendants
            .Where(h => nativeWindows.IsWindowValid(h) && string.Equals(nativeWindows.GetClassName(h), EditClassName, StringComparison.Ordinal))
            .ToList();

        if (editCandidates.Count != 1)
        {
            failureReason = $"esperado exatamente 1 Edit na subarvore do CtrlId 1148, encontrados {editCandidates.Count}";
            return false;
        }

        editHwnd = editCandidates[0];
        failureReason = null;
        return true;
    }
}
