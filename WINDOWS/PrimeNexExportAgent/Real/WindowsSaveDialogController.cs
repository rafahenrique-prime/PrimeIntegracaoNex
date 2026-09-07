using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;
using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (F6.14B2, corrigida em F6.14B2.2) de
/// ISaveDialogController - SOMENTE Configure() e real e utilizavel nesta
/// fase. ClickSave()/CancelSaveDialog() lancam NotSupportedException
/// sempre - nao foram homologados ainda (isso e F6.14B3+, mediante nova
/// ordem explicita).
///
/// F6.14B2.2 - CORRECAO POR EVIDENCIA REAL:
/// - O 1137 (destino) NUNCA mais recebe escrita - nao ha prova de que
///   escrever/selecionar um item nele mude o diretorio EFETIVO do
///   Common Dialog. Em vez disso, o caminho completo
///   (Path.Combine(destino, nome)) e escrito no Edit FILHO real do
///   CtrlId 1148 (resolvido por FileNameEditResolver) - o proprio Windows
///   Explorer aceita um caminho absoluto no campo de nome do arquivo.
/// - O fallback "ComboBox sem item exato -> escrever texto direto"
///   continua REMOVIDO (F6.14B2.1) - nunca reintroduzido.
///
/// F6.14B2.8 - a escrita no Edit do 1148 usa SetEditText (WM_SETTEXT via
/// SendMessageW, < WM_USER, marshalling automatico documentado) - nunca
/// mais SetWindowText direto (ver Win32SaveDialogInterop.cs).
/// </summary>
public sealed class WindowsSaveDialogController : ISaveDialogController
{
    private readonly INativeWindowApi _nativeWindows;
    private readonly ISaveDialogControlApi _controlApi;

    public WindowsSaveDialogController(INativeWindowApi nativeWindows, ISaveDialogControlApi controlApi)
    {
        _nativeWindows = nativeWindows;
        _controlApi = controlApi;
    }

    public void Configure(SaveDialogIdentity dialog, string destination, string fileName, string fileType)
    {
        // ---- Nome/destino: escritos JUNTOS como caminho absoluto, no
        // Edit filho do 1148 - NUNCA no 1137 (F6.14B2.2). Exatamente 1
        // escrita. ----
        var fileNameContainer = _controlApi.GetControl(dialog.DialogHandle, WindowsSaveDialogInspector.CtrlIdFileName);
        if (fileNameContainer == 0 || !_nativeWindows.IsWindowValid(fileNameContainer))
        {
            throw new InvalidOperationException("Configure abortado: CtrlId 1148 (container) nao encontrado/invalido.");
        }

        if (!FileNameEditResolver.TryResolve(fileNameContainer, _nativeWindows, _controlApi, out var editHwnd, out var reason))
        {
            throw new InvalidOperationException($"Configure abortado: {reason}");
        }

        var fullTargetPath = Path.Combine(destination, fileName);
        if (!_controlApi.SetEditText(editHwnd, fullTargetPath))
        {
            throw new InvalidOperationException("Configure abortado: falha ao escrever (WM_SETTEXT) o caminho completo no Edit filho do CtrlId 1148.");
        }

        // ---- Tipo: EXCLUSIVAMENTE via CB_FINDSTRINGEXACT+CB_SETCURSEL no
        // 1136 - zero fallback, zero retry (F6.14B2.1). ----
        var fileTypeCtrl = _controlApi.GetControl(dialog.DialogHandle, WindowsSaveDialogInspector.CtrlIdFileType);
        if (fileTypeCtrl == 0 || !_nativeWindows.IsWindowValid(fileTypeCtrl))
        {
            throw new InvalidOperationException("Configure abortado: CtrlId 1136 (tipo) nao encontrado/invalido.");
        }

        var className = _nativeWindows.GetClassName(fileTypeCtrl) ?? string.Empty;
        if (!className.Contains("ComboBox", StringComparison.OrdinalIgnoreCase))
        {
            throw new NotSupportedException($"Configure abortado: CtrlId 1136 (tipo) tem ClassName '{className}' nao suportada (esperado ComboBox) - fail-closed, sem improviso.");
        }

        if (!_controlApi.TrySelectComboBoxItemExact(fileTypeCtrl, fileType))
        {
            throw new InvalidOperationException($"Configure abortado: falha ao selecionar '{fileType}' no CtrlId 1136 (item ausente ou CB_SETCURSEL falhou) - zero retry.");
        }

        // ---- 1137 (destino visual) NUNCA e tocado (F6.14B2.2 secao 9) ----
    }

    public void ClickSave(SaveDialogIdentity dialog) =>
        throw new NotSupportedException("ClickSave real ainda NAO homologado (F6.14B2/B2.2) - somente Identify/Configure/ReadBack foram implementados/homologados nesta fase. Requer nova ordem explicita (F6.14B3+).");

    public void CancelSaveDialog(SaveDialogIdentity dialog) =>
        throw new NotSupportedException("CancelSaveDialog real ainda NAO homologado (F6.14B2/B2.2) - cleanup continua manual (Rafael clica Cancelar). Requer nova ordem explicita (F6.14B3+).");
}
