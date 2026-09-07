using System.Text;

namespace PrimeNexExportAgent.WindowsSaveDialog;

/// <summary>Implementacao real (F6.14B2, ampliada em F6.14B2.2, corrigida
/// em F6.14B2.8 - removido CDM_*, migrado para WM_SETTEXT/WM_GETTEXT) de
/// ISaveDialogControlApi.</summary>
public sealed class Win32SaveDialogControlApi : ISaveDialogControlApi
{
    private const int MaxTextLength = 512;

    public nint GetControl(nint dialogHwnd, int ctrlId) => Win32SaveDialogInterop.GetDlgItem(dialogHwnd, ctrlId);

    public IReadOnlyList<nint> GetDescendants(nint containerHwnd)
    {
        var result = new List<nint>();
        bool Callback(nint hWnd, nint lParam)
        {
            result.Add(hWnd);
            return true;
        }
        // F6.14B2.3: EnumChildWindows ja enumera recursivamente TODA a
        // subarvore do HWND informado (filhos, netos, etc.) - nunca
        // filtrar por GetParent(h)==containerHwnd aqui (esse filtro foi
        // exatamente o que causou a regressao de F6.14B2.2, descartando o
        // Edit real que e neto, nao filho direto, do ComboBoxEx32). A
        // seguranca da resolucao vem de filtrar por ClassName+cardinalidade
        // no chamador (FileNameEditResolver), nunca de limitar profundidade.
        Win32SaveDialogInterop.EnumChildWindows(containerHwnd, Callback, 0);
        return result;
    }

    public bool IsControlEnabled(nint controlHwnd) => Win32SaveDialogInterop.IsWindowEnabled(controlHwnd);

    /// <summary>F6.14B2.8: escreve via WM_SETTEXT (< WM_USER, marshalling
    /// automatico documentado pelo Windows) - substitui SetWindowText.
    /// SendMessageFindString ja tem a assinatura correta (string in via
    /// lParam).</summary>
    public bool SetEditText(nint editHwnd, string value)
    {
        var result = Win32SaveDialogInterop.SendMessageFindString(editHwnd, Win32SaveDialogInterop.WM_SETTEXT, 0, value);
        return result != 0;
    }

    /// <summary>F6.14B2.8: releitura via WM_GETTEXTLENGTH+WM_GETTEXT (<
    /// WM_USER, marshalling automatico documentado) - substitui
    /// GetWindowText/CDM_GETFILEPATH. Fail-closed: qualquer resultado
    /// negativo/inconsistente vira null, nunca "deve estar ok".</summary>
    public string? ReadEditText(nint editHwnd)
    {
        if (editHwnd == 0) return null;

        var length = Win32SaveDialogInterop.SendMessageInt(editHwnd, Win32SaveDialogInterop.WM_GETTEXTLENGTH, 0, 0);
        if (length < 0) return null;
        if (length == 0) return string.Empty;

        var sb = new StringBuilder(Math.Max((int)length + 1, MaxTextLength));
        var written = Win32SaveDialogInterop.SendMessageGetBuffer(editHwnd, Win32SaveDialogInterop.WM_GETTEXT, sb.Capacity, sb);
        return written > 0 ? sb.ToString(0, (int)written) : null;
    }

    public int GetComboItemCount(nint comboHwnd)
    {
        var count = Win32SaveDialogInterop.SendMessageInt(comboHwnd, Win32SaveDialogInterop.CB_GETCOUNT, 0, 0);
        return count == Win32SaveDialogInterop.CB_ERR ? 0 : (int)count;
    }

    public string? GetComboItemText(nint comboHwnd, int index)
    {
        if (index < 0) return null;

        var sb = new StringBuilder(MaxTextLength);
        var result = Win32SaveDialogInterop.SendMessageGetBuffer(comboHwnd, Win32SaveDialogInterop.CB_GETLBTEXT, index, sb);
        return result == Win32SaveDialogInterop.CB_ERR ? null : sb.ToString();
    }

    public string? GetSelectedComboItemText(nint comboHwnd)
    {
        var selectedIndex = Win32SaveDialogInterop.SendMessageInt(comboHwnd, Win32SaveDialogInterop.CB_GETCURSEL, 0, 0);
        if (selectedIndex == Win32SaveDialogInterop.CB_ERR) return null;
        return GetComboItemText(comboHwnd, (int)selectedIndex);
    }

    public bool TrySelectComboBoxItemExact(nint controlHwnd, string value)
    {
        var index = Win32SaveDialogInterop.SendMessageFindString(
            controlHwnd, Win32SaveDialogInterop.CB_FINDSTRINGEXACT, (nint)(-1), value);

        if (index == Win32SaveDialogInterop.CB_ERR) return false;

        var result = Win32SaveDialogInterop.SendMessageInt(controlHwnd, Win32SaveDialogInterop.CB_SETCURSEL, index, 0);
        return result != Win32SaveDialogInterop.CB_ERR;
    }

    /// <summary>F6.14B2.9A: dispara BM_CLICK - deliberadamente `void`. O
    /// valor retornado por SendMessageW aqui NUNCA deve ser interpretado
    /// como "salvou com sucesso" (essa prova vem exclusivamente do
    /// sistema de arquivos, via IExportStageWatcher) - por isso este
    /// metodo nem expoe esse retorno ao chamador.</summary>
    public void ClickButton(nint buttonHwnd)
    {
        Win32SaveDialogInterop.SendMessageInt(buttonHwnd, Win32SaveDialogInterop.BM_CLICK, 0, 0);
    }
}
