using System.Windows.Automation;

namespace PrimeNexExportAgent.WindowsNative;

/// <summary>Implementacao real (F6.14A) de INexUiAutomationReader via
/// System.Windows.Automation (mesma API ja comprovada em F6.5-F6.9).
/// Estritamente somente leitura: nenhum Invoke/Select/SetFocus/SetValue -
/// somente AutomationElement.FromHandle + FindFirst + leitura de
/// propriedades (Name, IsOffscreenProperty).</summary>
public sealed class UiAutomationNexReader : INexUiAutomationReader
{
    public bool HasElementNamed(nint hWnd, string name) => FindByName(hWnd, name) is not null;

    public bool HasVisibleElementNamed(nint hWnd, string name)
    {
        var element = FindByName(hWnd, name);
        if (element is null) return false;

        try
        {
            var isOffscreen = (bool)element.GetCurrentPropertyValue(AutomationElement.IsOffscreenProperty);
            return !isOffscreen;
        }
        catch (ElementNotAvailableException)
        {
            // Elemento desapareceu entre o FindFirst e a leitura da
            // propriedade (janela mudou de estado) - tratar como ausente,
            // nunca como visivel (fail-closed).
            return false;
        }
    }

    public string? GetOwnName(nint hWnd)
    {
        AutomationElement root;
        try
        {
            root = AutomationElement.FromHandle(hWnd);
        }
        catch (ElementNotAvailableException)
        {
            return null;
        }

        if (root is null) return null;

        try
        {
            return (string)root.GetCurrentPropertyValue(AutomationElement.NameProperty);
        }
        catch (ElementNotAvailableException)
        {
            return null;
        }
    }

    private static AutomationElement? FindByName(nint hWnd, string name)
    {
        AutomationElement root;
        try
        {
            root = AutomationElement.FromHandle(hWnd);
        }
        catch (ElementNotAvailableException)
        {
            // HWND ja nao corresponde a um elemento de UI Automation valido
            // (janela fechada/mudou entre a validacao do HWND e esta
            // consulta) - fail-closed, tratado como "elemento nao encontrado".
            return null;
        }

        if (root is null) return null;

        var condition = new PropertyCondition(AutomationElement.NameProperty, name);
        try
        {
            return root.FindFirst(TreeScope.Descendants, condition);
        }
        catch (ElementNotAvailableException)
        {
            return null;
        }
    }
}
