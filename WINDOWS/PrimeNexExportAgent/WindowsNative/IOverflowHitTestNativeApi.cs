namespace PrimeNexExportAgent.WindowsNative;

/// <summary>
/// Fronteira mockavel dedicada a INexOverflowMenuOpener - hit-test por
/// coordenada fisica de tela (WindowFromPhysicalPoint), conversao para
/// coordenadas de cliente (ScreenToClient) e o clique PostMessage
/// direcionado ao HWND resultante. Deliberadamente separada de
/// INexClientNavigationNativeApi (embora ambas despachem
/// WM_LBUTTONDOWN/UP) para manter cada adapter focado em um unico
/// componente real, evitando acoplamento acidental entre eles.
/// </summary>
public interface IOverflowHitTestNativeApi
{
    /// <summary>GetWindowRect fisico (nunca virtualizado por DPI) do HWND
    /// informado, ou null se a consulta falhar.</summary>
    (int left, int top, int right, int bottom)? GetWindowRectPhysical(nint hWnd);

    /// <summary>WindowFromPhysicalPoint(x,y) - retorna 0 se nenhuma
    /// janela for encontrada naquele ponto fisico.</summary>
    nint WindowFromPhysicalPoint(int screenX, int screenY);

    int GetOwningProcessId(nint hWnd);
    string? GetClassName(nint hWnd);

    /// <summary>IsWindow(hWnd) - usado pelo handle gate do geometry
    /// stability gate (correcao pos-Probe 11B): confirma que o HWND
    /// capturado em OpenedClientIdentity continua valido antes/durante
    /// cada leitura de geometria, sem jamais trocar silenciosamente para
    /// outro HWND.</summary>
    bool IsWindowValid(nint hWnd);

    /// <summary>ScreenToClient(hWnd, screenX, screenY) - null se a
    /// conversao falhar.</summary>
    (int clientX, int clientY)? ScreenToClient(nint hWnd, int screenX, int screenY);

    (bool posted, int lastError) PostMouseDown(nint hWnd, int clientX, int clientY);
    (bool posted, int lastError) PostMouseUp(nint hWnd, int clientX, int clientY);

    /// <summary>Todas as janelas TOP-LEVEL visiveis do PID informado com
    /// o ClassName exato requisitado - usado para localizar o popup
    /// TdxBarSubMenuControl apos o clique.</summary>
    IReadOnlyList<nint> FindVisibleTopLevelByClass(int processId, string className);

    nint GetParent(nint hWnd);
    string? GetWindowTitle(nint hWnd);
}
