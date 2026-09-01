using System.Runtime.InteropServices;
using System.Text;

namespace PrimeNexExportAgent.WindowsNative;

/// <summary>
/// UNICO ponto do projeto com DllImport (F6.14A secao 11 - "nao espalhar
/// P/Invoke pelo projeto"). Todas as funcoes aqui sao estritamente
/// SOMENTE LEITURA - nenhuma delas altera estado do Windows ou de
/// qualquer processo/janela. Nenhum codigo de dominio/orquestrador
/// referencia esta classe diretamente - sempre atraves de
/// Win32NativeWindowApi/Win32SessionNativeApi (interfaces mockaveis).
///
/// PROIBIDO acrescentar aqui (F6.14A): SendInput, keybd_event, mouse_event,
/// PostMessage, SendMessage de escrita, WM_COMMAND/BM_CLICK/WM_SETTEXT,
/// SetWindowText, SetForegroundWindow - essas pertencem exclusivamente a
/// F6.14B (IInputSender/ISaveDialogController reais), ainda nao implementada.
/// </summary>
internal static class Win32Interop
{
    // ---- user32.dll (somente leitura) ----

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool IsWindow(nint hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool IsWindowVisible(nint hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern uint GetWindowThreadProcessId(nint hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern int GetClassName(nint hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern nint GetWindow(nint hWnd, uint uCmd);

    /// <summary>F6.14A.2 - somente leitura, usada para classificar a
    /// janela oculta TApplication (area 0x0) sem depender de heuristica
    /// visual/coordenada.</summary>
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetWindowRect(nint hWnd, out RECT lpRect);

    internal delegate bool EnumWindowsProc(nint hWnd, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, nint lParam);

    internal const uint GW_OWNER = 4;

    // ---- wtsapi32.dll (somente leitura) ----

    [DllImport("wtsapi32.dll", SetLastError = true)]
    internal static extern bool WTSQuerySessionInformation(
        nint hServer, uint sessionId, WtsInfoClass wtsInfoClass, out nint ppBuffer, out uint pBytesReturned);

    [DllImport("wtsapi32.dll")]
    internal static extern void WTSFreeMemory(nint pMemory);

    internal const nint WTS_CURRENT_SERVER_HANDLE = 0;

    internal enum WtsInfoClass
    {
        WTSConnectState = 8,
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
