namespace PrimeNexExportAgent.WindowsNative;

/// <summary>
/// Fronteira mockavel dedicada a INexClientNavigator (V1 - extrato
/// individual por cliente). Deliberadamente separada de INativeWindowApi
/// (que permanece 100% read-only e generico, usado por
/// INexWindowInspector) - esta interface expoe as poucas operacoes de
/// ACAO necessarias (WM_SETTEXT no campo de busca, WM_KEYDOWN/WM_KEYUP do
/// F2, WM_LBUTTONDOWN/WM_LBUTTONUP da aba Transacoes), sempre em
/// controles/HWNDs especificos passados pelo chamador - nunca decide
/// sozinha qual janela/controle tocar.
/// </summary>
public interface INexClientNavigationNativeApi
{
    nint GetForegroundWindow();
    int GetOwningProcessId(nint hWnd);
    string? GetClassName(nint hWnd);
    IReadOnlyList<nint> EnumChildWindows(nint parentHwnd);
    string? ReadControlText(nint hWnd);
    bool WriteControlText(nint hWnd, string value);
    bool IsWindowValid(nint hWnd);
    bool IsWindowCurrentlyVisible(nint hWnd);
    bool IsWindowCurrentlyEnabled(nint hWnd);

    /// <summary>HWND com foco de teclado dentro do thread da janela em
    /// foreground informada (GetGUIThreadInfo.hwndFocus), ou 0 se
    /// indeterminavel.</summary>
    nint GetFocusedWindow(nint foregroundHwnd);

    /// <summary>Scan code Win32 (MapVirtualKeyW) para a tecla virtual
    /// informada, ou 0 se indeterminavel.</summary>
    ushort GetKeyScanCode(ushort virtualKey);

    /// <summary>True se a tecla modificadora (SHIFT/CTRL/ALT) informada
    /// esta fisicamente pressionada agora (GetAsyncKeyState).</summary>
    bool IsModifierKeyDown(int virtualKey);

    /// <summary>PostMessage(WM_KEYDOWN/WM_KEYUP). `lastError` so e'
    /// significativo quando `posted=false` - nunca reportar um
    /// GetLastError residual de uma chamada anterior quando `posted=true`.</summary>
    (bool posted, int lastError) PostKeyDown(nint hWnd, ushort virtualKey, nint lParam);
    (bool posted, int lastError) PostKeyUp(nint hWnd, ushort virtualKey, nint lParam);

    /// <summary>PostMessage(WM_LBUTTONDOWN/WM_LBUTTONUP) em coordenadas
    /// de CLIENTE (ja relativas ao proprio hWnd) - usado pela ativacao da
    /// aba Transacoes (TdxFormattedLabel tem HWND proprio, dispensa
    /// ScreenToClient).</summary>
    (bool posted, int lastError) PostMouseDown(nint hWnd, int clientX, int clientY);
    (bool posted, int lastError) PostMouseUp(nint hWnd, int clientX, int clientY);

    /// <summary>Largura/altura da area cliente (GetClientRect), ou null
    /// se a consulta falhar.</summary>
    (int width, int height)? GetClientSize(nint hWnd);

    /// <summary>GetWindowRect (coordenadas de tela) - usado exclusivamente
    /// pelo gate de geometria de NexClientsGridOpenProfile, nunca como
    /// origem de calculo de clique (o ponto de clique e' sempre o valor ja
    /// calibrado do profile, em coordenadas de CLIENTE do proprio HWND
    /// alvo).</summary>
    (int left, int top, int right, int bottom)? GetWindowRectangle(nint hWnd);
}
