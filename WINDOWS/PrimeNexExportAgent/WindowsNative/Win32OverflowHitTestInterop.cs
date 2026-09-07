using System.Runtime.InteropServices;
using System.Text;

namespace PrimeNexExportAgent.WindowsNative;

/// <summary>UNICO ponto do projeto com DllImport para IOverflowHitTestNativeApi.
/// Separado dos demais arquivos de Interop pelo mesmo motivo de sempre -
/// cada fronteira de acao/leitura especializada tem seu proprio arquivo
/// minimo de P/Invoke.</summary>
internal static class Win32OverflowHitTestInterop
{
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(nint hwnd, int dwAttribute, out Win32Interop.RECT pvAttribute, int cbAttribute);

    // NOTA IMPORTANTE (achado real desta investigacao): DWMWA_EXTENDED_FRAME_BOUNDS
    // NAO foi usado para o profile final por ter divergido do espaco de
    // coordenadas fisico real nesta maquina - GetWindowRect comum, no
    // mesmo contexto de chamador usado durante toda a calibracao real, e'
    // a fonte usada para validar NexOverflowButtonProfile.ExpectedCadCliWindowRect.
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetWindowRect(nint hWnd, out Win32Interop.RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    internal struct POINT { public int X; public int Y; }

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern nint WindowFromPhysicalPoint(POINT point);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern uint GetWindowThreadProcessId(nint hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern int GetClassName(nint hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern int GetWindowText(nint hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ScreenToClient(nint hWnd, ref POINT lpPoint);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool PostMessage(nint hWnd, uint msg, nint wParam, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern nint GetParent(nint hWnd);

    internal delegate bool EnumWindowsProc(nint hWnd, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindowVisible(nint hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindow(nint hWnd);

    // ---- DPI awareness (correcao pos-Probe 12A - ver DpiAwarenessScope) ----
    [DllImport("user32.dll")]
    internal static extern nint SetThreadDpiAwarenessContext(nint dpiContext);

    internal const uint WM_LBUTTONDOWN = 0x0201;
    internal const uint WM_LBUTTONUP = 0x0202;
    internal const nint MK_LBUTTON = 0x0001;
}
