namespace PrimeNexExportAgent.WindowsNative;

/// <summary>
/// Fronteira mockavel para leitura (SOMENTE LEITURA) da arvore de
/// Microsoft UI Automation do NexAdmin (F6.14A, tecnica ja comprovada em
/// F6.5-F6.9). Nunca chama InvokePattern, SelectionItemPattern.Select,
/// SetFocus, ValuePattern.SetValue ou qualquer outro Pattern de acao -
/// somente propriedades (Name/IsOffscreen) e FindFirst/FindAll.
/// </summary>
public interface INexUiAutomationReader
{
    /// <summary>True se existir, na arvore descendente do HWND informado,
    /// um elemento cujo Name seja exatamente `name` (comparacao exata,
    /// sem normalizacao) - independente de estar ou nao na tela.</summary>
    bool HasElementNamed(nint hWnd, string name);

    /// <summary>True se existir um elemento com esse Name E
    /// IsOffscreenProperty == false (efetivamente visivel na tela).</summary>
    bool HasVisibleElementNamed(nint hWnd, string name);

    /// <summary>Le o Name PROPRIO do elemento raiz correspondente a este
    /// HWND (nunca busca em descendentes) - usado para confirmar a
    /// identidade do widget "Atendimento" (F6.14A.2). Retorna null se o
    /// elemento nao puder ser resolvido/a propriedade nao puder ser lida -
    /// o chamador DEVE tratar null como "nao confirmado" (fail-closed),
    /// nunca como "deve ser o esperado".</summary>
    string? GetOwnName(nint hWnd);
}
