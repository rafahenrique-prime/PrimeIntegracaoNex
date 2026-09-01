using System.Runtime.InteropServices;

namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// UNICO ponto do projeto com DllImport de ACAO (F6.14B1). Deliberadamente
/// separado de WindowsNative/Win32Interop.cs (que permanece 100%
/// read-only, homologado em F6.14A/F6.14A.1/F6.14A.2) - nunca misturar as
/// duas camadas no mesmo arquivo.
///
/// Superficie MINIMA e final para esta fase: SetForegroundWindow,
/// GetForegroundWindow, SendInput. Nenhuma outra API de acao (nada de
/// AttachThreadInput, BringWindowToTop, SwitchToThisWindow, PostMessage,
/// SendMessage, WM_COMMAND/BM_CLICK/WM_SETTEXT, SetWindowText,
/// InvokePattern, SetValue, SendKeys) - essas continuam fora de escopo
/// desta fase (F6.14B2+, se algum dia necessario e explicitamente
/// autorizado).
///
/// O layout de INPUT/union abaixo e o padrao documentado da Win32 API
/// (winuser.h) - a uniao explicita (InputUnion) e o unico jeito correto de
/// fazer o CLR calcular o tamanho/alinhamento real de `INPUT` (40 bytes em
/// x64) sem hardcode manual de padding, que seria fragil e arriscado de
/// corromper a struct enviada ao driver de entrada do Windows.
/// </summary>
internal static class Win32InputInterop
{
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetForegroundWindow(nint hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern nint GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    internal const uint INPUT_KEYBOARD = 1;
    internal const uint KEYEVENTF_KEYUP = 0x0002;
    internal const ushort VK_SHIFT = 0x10;
    internal const ushort VK_F5 = 0x74;

    [StructLayout(LayoutKind.Sequential)]
    internal struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    internal struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public nint dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public nint dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }
}
