using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;
using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// F6.14B2.12C1 - implementacao REAL de IConfirmedSaveDialogCommitter,
/// extraindo (sem alterar comportamento) exatamente a sequencia de
/// revalidacao final ja homologada 2x no NEX real dentro de
/// Diagnostics/ConfigureSaveDialogClickSaveOnceProbe.cs (linhas 209-240
/// daquele arquivo, nao alterado por esta classe). Nenhum P/Invoke novo,
/// nenhuma segunda implementacao de BM_CLICK - reutiliza
/// ISaveDialogControlApi.ClickButton, ja existente.
///
/// CommitOnce() NUNCA reaproveita a identificacao antiga do dialogo -
/// chama ISaveDialogInspector.IdentifySaveDialog(target) DE NOVO,
/// exige o MESMO DialogHandle que `expectedDialog`, resolve e revalida
/// CtrlId 1 (Salvar, WindowsSaveDialogInspector.CtrlIdSave) do zero, e so
/// entao despacha BM_CLICK exatamente 1 vez. CtrlId 1137 (destino) e 1148/
/// 1136 (nome/tipo) NUNCA sao tocados aqui - esta classe so resolve
/// CtrlId 1.
/// </summary>
public sealed class WindowsConfirmedSaveDialogCommitter : IConfirmedSaveDialogCommitter
{
    private readonly ISaveDialogInspector _saveDialogInspector;
    private readonly ISaveDialogControlApi _controlApi;
    private readonly INativeWindowApi _nativeWindows;

    public WindowsConfirmedSaveDialogCommitter(
        ISaveDialogInspector saveDialogInspector,
        ISaveDialogControlApi controlApi,
        INativeWindowApi nativeWindows)
    {
        _saveDialogInspector = saveDialogInspector;
        _controlApi = controlApi;
        _nativeWindows = nativeWindows;
    }

    public SaveDialogCommitResult CommitOnce(NexAdminWindowIdentity target, SaveDialogIdentity expectedDialog)
    {
        // ---- PASSO 1+2: reidentificar o dialogo do zero (nunca reaproveita
        // a identificacao anterior) e exigir EXATAMENTE o mesmo HWND ja
        // esperado - protege contra a race assincrona de outro #32770
        // aparecer entre ReadBack e o clique (F6.14B2.4/.7). ----
        var revalidation = _saveDialogInspector.IdentifySaveDialog(target);
        if (!revalidation.Passed)
        {
            return SaveDialogCommitResult.Fail(revalidation.ErrorCode, $"revalidacao final falhou: {revalidation.Reason}");
        }

        if (revalidation.Dialog!.DialogHandle != expectedDialog.DialogHandle)
        {
            return SaveDialogCommitResult.Fail(
                AgentErrorCode.DialogIdentityMismatch,
                $"revalidacao encontrou dialogo diferente (HWND=0x{revalidation.Dialog.DialogHandle:X} != esperado 0x{expectedDialog.DialogHandle:X})");
        }

        // ---- PASSO 3-5: resolver SOMENTE CtrlId 1 (Salvar) - nunca 1137/
        // 1148/1136, que ja foram tratados por Configure/ReadBack antes
        // deste ponto. ----
        var saveButtonHwnd = _controlApi.GetControl(expectedDialog.DialogHandle, WindowsSaveDialogInspector.CtrlIdSave);
        if (saveButtonHwnd == 0)
        {
            return SaveDialogCommitResult.Fail(AgentErrorCode.ControlMissing, "CtrlId 1 (Salvar) ausente na revalidacao final");
        }

        if (!_nativeWindows.IsWindowValid(saveButtonHwnd))
        {
            return SaveDialogCommitResult.Fail(AgentErrorCode.ControlMissing, "CtrlId 1 (Salvar) invalido na revalidacao final");
        }

        if (!_controlApi.IsControlEnabled(saveButtonHwnd))
        {
            return SaveDialogCommitResult.Fail(AgentErrorCode.ControlMissing, "CtrlId 1 (Salvar) desabilitado na revalidacao final");
        }

        // ---- PASSO 6: despachar BM_CLICK EXATAMENTE 1 vez. Zero retry,
        // zero fallback, zero segunda tecnica - o retorno (void) NUNCA e
        // consultado como prova de sucesso. ----
        try
        {
            _controlApi.ClickButton(saveButtonHwnd);
        }
        catch (Exception ex)
        {
            return SaveDialogCommitResult.Fail(AgentErrorCode.UnexpectedException, $"ClickButton lancou: {ex.Message}");
        }

        return SaveDialogCommitResult.Pass();
    }
}
