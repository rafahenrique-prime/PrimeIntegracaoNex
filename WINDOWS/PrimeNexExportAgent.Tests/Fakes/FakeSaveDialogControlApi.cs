using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Tests.Fakes;

/// <summary>Fake de ISaveDialogControlApi (F6.14B2, ampliado em F6.14B2.2,
/// corrigido em F6.14B2.8) - simula controles de dialogo por
/// (DialogHwnd, CtrlId), filhos por parent, itens de ComboBox e o texto
/// do Edit (WM_SETTEXT/WM_GETTEXT), sem tocar nenhuma API Win32 real.
/// F6.14B2.8: FilePathByDialog/FolderPathByDialog (CDM_*) foram
/// REMOVIDOS - nunca reintroduzir.</summary>
public sealed class FakeSaveDialogControlApi : ISaveDialogControlApi
{
    public Dictionary<(nint Dialog, int CtrlId), nint> ControlsByDialogAndId { get; } = new();
    public HashSet<nint> EnabledControls { get; } = new();
    public Dictionary<nint, string> TextByControl { get; } = new();
    /// <summary>Simula EnumChildWindows(container) - a lista registrada
    /// para um HWND representa TODOS os descendentes da subarvore (nao so
    /// filhos imediatos), permitindo testar netos/bisnetos sem modelar uma
    /// hierarquia real (F6.14B2.3).</summary>
    public Dictionary<nint, IReadOnlyList<nint>> DescendantsByContainer { get; } = new();

    /// <summary>Itens validos (comparacao exata, nao-sensivel a caixa) por
    /// ComboBox - usado por TrySelectComboBoxItemExact/CB_GETLBTEXT/etc.
    /// A ordem da lista determina o indice (CB_GETLBTEXT).</summary>
    public Dictionary<nint, List<string>> ComboBoxItemsByControl { get; } = new();

    /// <summary>Indice atualmente selecionado por ComboBox (CB_GETCURSEL) -
    /// atualizado automaticamente por TrySelectComboBoxItemExact.</summary>
    public Dictionary<nint, int> ComboBoxSelectedIndexByControl { get; } = new();

    /// <summary>Simula CB_SETCURSEL falhando mesmo com o item exato
    /// encontrado (F6.14B2.1) - distingue "item nao existe" de "existe mas
    /// a selecao falhou".</summary>
    public HashSet<nint> ForceComboBoxSetCurSelFailure { get; } = new();

    /// <summary>F6.14B2.8: override explicito do que ReadEditText retorna
    /// para um dado Edit hwnd - usado para simular divergencia/falha de
    /// WM_GETTEXT sem depender do que SetEditText escreveu (ex.: simular o
    /// dialogo mostrando um valor diferente do que foi configurado, ou
    /// simular a mensagem falhando via null). Se ausente, ReadEditText usa
    /// o valor mais recente escrito por SetEditText (TextByControl),
    /// espelhando o comportamento real (mesmo controle, mesma leitura).</summary>
    public Dictionary<nint, string?> ReadEditTextOverride { get; } = new();

    public int SetEditTextCalls { get; private set; }
    public int TrySelectComboBoxItemExactCalls { get; private set; }
    public bool SetEditTextResult { get; set; } = true;
    public Exception? ThrowOnGetControl { get; set; }

    /// <summary>F6.14B2.9A: contador de chamadas a ClickButton - usado
    /// pelos testes para provar "zero" em todo caminho de falha e
    /// "exatamente 1" no fluxo feliz. Nunca simula "sucesso do save" -
    /// so registra que o dispatch ocorreu.</summary>
    public int ClickButtonCalls { get; private set; }
    public nint LastClickButtonHwnd { get; private set; }

    public nint GetControl(nint dialogHwnd, int ctrlId)
    {
        if (ThrowOnGetControl is not null) throw ThrowOnGetControl;
        return ControlsByDialogAndId.TryGetValue((dialogHwnd, ctrlId), out var hwnd) ? hwnd : 0;
    }

    public IReadOnlyList<nint> GetDescendants(nint containerHwnd) =>
        DescendantsByContainer.TryGetValue(containerHwnd, out var descendants) ? descendants : Array.Empty<nint>();

    public bool IsControlEnabled(nint controlHwnd) => EnabledControls.Contains(controlHwnd);

    public bool SetEditText(nint editHwnd, string value)
    {
        SetEditTextCalls++;
        if (SetEditTextResult)
        {
            TextByControl[editHwnd] = value;
        }
        return SetEditTextResult;
    }

    public string? ReadEditText(nint editHwnd)
    {
        if (ReadEditTextOverride.TryGetValue(editHwnd, out var overridden)) return overridden;
        return TextByControl.TryGetValue(editHwnd, out var text) ? text : null;
    }

    public int GetComboItemCount(nint comboHwnd) =>
        ComboBoxItemsByControl.TryGetValue(comboHwnd, out var items) ? items.Count : 0;

    public string? GetComboItemText(nint comboHwnd, int index)
    {
        if (!ComboBoxItemsByControl.TryGetValue(comboHwnd, out var items)) return null;
        return index >= 0 && index < items.Count ? items[index] : null;
    }

    public string? GetSelectedComboItemText(nint comboHwnd)
    {
        if (!ComboBoxSelectedIndexByControl.TryGetValue(comboHwnd, out var index)) return null;
        return GetComboItemText(comboHwnd, index);
    }

    public bool TrySelectComboBoxItemExact(nint controlHwnd, string value)
    {
        TrySelectComboBoxItemExactCalls++;
        if (ComboBoxItemsByControl.TryGetValue(controlHwnd, out var items))
        {
            var index = items.FindIndex(i => string.Equals(i, value, StringComparison.OrdinalIgnoreCase));
            if (index >= 0)
            {
                if (ForceComboBoxSetCurSelFailure.Contains(controlHwnd)) return false; // simula CB_SETCURSEL falhando
                ComboBoxSelectedIndexByControl[controlHwnd] = index;
                return true;
            }
        }
        return false;
    }

    public void ClickButton(nint buttonHwnd)
    {
        ClickButtonCalls++;
        LastClickButtonHwnd = buttonHwnd;
    }
}
