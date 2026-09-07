using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;
using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (F6.14B2, corrigida em F6.14B2.2) de
/// ISaveDialogInspector - identificacao fail-closed do dialogo "Salvar
/// como" (G8+G9) e releitura pos-configuracao (G10-G12). Nunca clica em
/// nada - so consulta.
///
/// F6.14B2.2 - CORRECAO POR EVIDENCIA REAL: o CtrlId 1148 e um
/// ComboBoxEx32 (container) cujo valor real vive num Edit FILHO - a
/// identificacao agora exige exatamente 1 child Edit valido, alem do
/// container em si. GetWindowText nos ComboBox simples (1137/1136) provou
/// (F6.14B2.1) retornar sempre vazio, entao NUNCA e usado para decisao.
///
/// F6.14B2.7/F6.14B2.8 - CORRECAO DE SEGURANCA: CDM_GETFILEPATH/
/// CDM_GETFOLDERPATH foram REMOVIDAS PERMANENTEMENTE do ReadBack -
/// auditoria F6.14B2.7 confirmou que sao mensagens >= WM_USER, sem
/// marshalling automatico do Windows, enviadas cross-process (Agent ->
/// janela do NexAdmin) com um ponteiro de buffer valido somente no
/// espaco de enderecamento do Agent - mecanismo classico de Access
/// Violation no processo receptor, correlacionado no tempo com o
/// desaparecimento do NexAdmin observado no probe real de F6.14B2.6. O
/// ReadBack agora releva o Edit filho do 1148 diretamente via
/// ReadEditText (WM_GETTEXTLENGTH+WM_GETTEXT, < WM_USER, marshalling
/// automatico documentado) e exige igualdade ESTRITA com o caminho
/// completo esperado (Path.Combine(destino, nome)) - o MESMO texto que
/// Configure() escreveu no MESMO controle. Isto prova o CONTEUDO
/// configurado no dialogo, mas NAO ainda o destino EFETIVO que o Common
/// Dialog usaria ao salvar - essa prova fica deferida para uma fase
/// futura supervisionada (clique unico em Salvar + verificacao via
/// sistema de arquivos, nunca via mensagem Win32 insegura).
/// </summary>
public sealed class WindowsSaveDialogInspector : ISaveDialogInspector
{
    private const string DialogClassName = "#32770";
    private const string ExpectedTitle = "Salvar como";

    internal const int CtrlIdFileName = 1148;
    internal const int CtrlIdDestination = 1137;
    internal const int CtrlIdFileType = 1136;
    internal const int CtrlIdSave = 1;
    internal const int CtrlIdCancel = 2;

    private static readonly int[] RequiredControlIds = { CtrlIdFileName, CtrlIdDestination, CtrlIdFileType, CtrlIdSave, CtrlIdCancel };

    private readonly INativeWindowApi _nativeWindows;
    private readonly ISaveDialogControlApi _controlApi;

    public WindowsSaveDialogInspector(INativeWindowApi nativeWindows, ISaveDialogControlApi controlApi)
    {
        _nativeWindows = nativeWindows;
        _controlApi = controlApi;
    }

    public SaveDialogIdentityResult IdentifySaveDialog(NexAdminWindowIdentity target)
    {
        IReadOnlyList<nint> visibleTopLevelWindows;
        try
        {
            visibleTopLevelWindows = _nativeWindows.GetVisibleTopLevelWindowsForProcess(target.ProcessId);
        }
        catch (Exception ex)
        {
            return SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, $"erro ao enumerar janelas: {ex.Message}");
        }

        var candidates = new List<nint>();
        foreach (var hwnd in visibleTopLevelWindows)
        {
            var className = _nativeWindows.GetClassName(hwnd);
            if (!string.Equals(className, DialogClassName, StringComparison.Ordinal)) continue;

            var title = _nativeWindows.GetWindowTitle(hwnd);
            if (!string.Equals(title, ExpectedTitle, StringComparison.Ordinal)) continue;

            candidates.Add(hwnd);
        }

        if (candidates.Count == 0)
        {
            return SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, $"nenhum dialogo '{DialogClassName}'/'{ExpectedTitle}' encontrado para o PID esperado");
        }

        if (candidates.Count > 1)
        {
            // Ambiguidade: nunca escolher o primeiro/foreground.
            return SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, $"mais de 1 dialogo '{ExpectedTitle}' encontrado ({candidates.Count}) - ambiguidade, abortando");
        }

        var dialogHwnd = candidates[0];

        // Coerencia owner/processo: o dialogo deve pertencer ao MESMO PID
        // do NexAdmin ja validado - nunca aceito por coincidencia de
        // classe/titulo.
        var owningPid = _nativeWindows.GetOwningProcessId(dialogHwnd);
        if (owningPid != target.ProcessId)
        {
            return SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, "dialogo encontrado nao pertence ao PID esperado do NexAdmin");
        }

        // ---- G9: os 5 controles esperados, todos presentes e Enabled=True ----
        foreach (var ctrlId in RequiredControlIds)
        {
            nint controlHwnd;
            try
            {
                controlHwnd = _controlApi.GetControl(dialogHwnd, ctrlId);
            }
            catch (Exception ex)
            {
                return SaveDialogIdentityResult.Fail(AgentErrorCode.ControlMissing, $"erro ao localizar CtrlId {ctrlId}: {ex.Message}");
            }

            if (controlHwnd == 0 || !_nativeWindows.IsWindowValid(controlHwnd))
            {
                return SaveDialogIdentityResult.Fail(AgentErrorCode.ControlMissing, $"CtrlId {ctrlId} ausente/invalido");
            }

            if (!_controlApi.IsControlEnabled(controlHwnd))
            {
                return SaveDialogIdentityResult.Fail(AgentErrorCode.ControlMissing, $"CtrlId {ctrlId} presente mas Disabled");
            }

            // F6.14B2.2: 1148 e um ComboBoxEx32 - exigir tambem exatamente
            // 1 child Edit valido, sem o qual nao ha onde escrever/ler o
            // nome do arquivo de verdade.
            if (ctrlId == CtrlIdFileName)
            {
                if (!FileNameEditResolver.TryResolve(controlHwnd, _nativeWindows, _controlApi, out _, out var reason))
                {
                    return SaveDialogIdentityResult.Fail(AgentErrorCode.ControlMissing, $"CtrlId {ctrlId}: {reason}");
                }
            }
        }

        return SaveDialogIdentityResult.Pass(new SaveDialogIdentity(dialogHwnd));
    }

    public SaveDialogReadbackResult ReadBack(SaveDialogIdentity dialog, string expectedDestination, string expectedFileName, string expectedFileType)
    {
        // ---- G10/G11 (F6.14B2.8): releitura direta do Edit filho do 1148
        // via WM_GETTEXT (< WM_USER, marshalling automatico documentado) -
        // CDM_GETFILEPATH REMOVIDA PERMANENTEMENTE (auditoria F6.14B2.7:
        // mensagem >= WM_USER, sem marshalling, cross-process inseguro).
        // Isto prova o CONTEUDO configurado no dialogo - a prova do destino
        // EFETIVO do Common Dialog fica deferida para uma fase futura
        // supervisionada (clique unico + verificacao via sistema de
        // arquivos). ----
        var fileNameContainer = _controlApi.GetControl(dialog.DialogHandle, CtrlIdFileName);
        if (fileNameContainer == 0 || !_nativeWindows.IsWindowValid(fileNameContainer))
        {
            return SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "CtrlId 1148 (container) desapareceu antes da releitura");
        }

        if (!FileNameEditResolver.TryResolve(fileNameContainer, _nativeWindows, _controlApi, out var editHwnd, out var editReason))
        {
            return SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, $"CtrlId 1148: {editReason}");
        }

        var expectedFullPath = Path.Combine(expectedDestination, expectedFileName);
        var actualEditText = _controlApi.ReadEditText(editHwnd);
        if (string.IsNullOrEmpty(actualEditText))
        {
            return SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "WM_GETTEXT falhou/retornou vazio no Edit filho do CtrlId 1148");
        }

        // Igualdade ESTRITA - nenhuma normalizacao ampla (F6.14B2.8 secao
        // 5). O texto escrito por Configure() e Path.Combine(destino,nome)
        // exatamente, entao a releitura deve bater caractere a caractere.
        if (!string.Equals(actualEditText, expectedFullPath, StringComparison.Ordinal))
        {
            return SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, $"Edit 1148 diverge: esperado '{expectedFullPath}', lido '{actualEditText}'");
        }

        // ---- G12: tipo via CB_GETCURSEL+CB_GETLBTEXT (F6.14B2.1/B2.2 -
        // ja seguros, ambos < WM_USER, nenhuma mudanca em F6.14B2.8) ----
        var fileTypeCtrl = _controlApi.GetControl(dialog.DialogHandle, CtrlIdFileType);
        if (fileTypeCtrl == 0 || !_nativeWindows.IsWindowValid(fileTypeCtrl))
        {
            return SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, "CtrlId 1136 desapareceu antes da releitura");
        }

        var actualFileType = _controlApi.GetSelectedComboItemText(fileTypeCtrl);
        if (!string.Equals(actualFileType, expectedFileType, StringComparison.Ordinal))
        {
            return SaveDialogReadbackResult.Fail(AgentErrorCode.ReadbackMismatch, $"tipo divergente: esperado '{expectedFileType}', lido '{actualFileType}'");
        }

        return SaveDialogReadbackResult.Pass();
    }
}
