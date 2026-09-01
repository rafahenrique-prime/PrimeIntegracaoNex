namespace PrimeNexExportAgent.WindowsInput;

/// <summary>Implementacao REAL (F6.14B1) de IInputNativeApi - a UNICA
/// classe do projeto que efetivamente envia entrada de teclado/altera
/// foreground. Usada exclusivamente por WindowsInputSender, sempre depois
/// do PRE-INPUT TARGET GATE (T1-T4) ja ter passado.</summary>
public sealed class Win32InputNativeApi : IInputNativeApi
{
    public bool SetForegroundWindow(nint hWnd) => Win32InputInterop.SetForegroundWindow(hWnd);

    public nint GetForegroundWindow() => Win32InputInterop.GetForegroundWindow();

    public int SendShiftF5()
    {
        var inputs = new[]
        {
            KeyDown(Win32InputInterop.VK_SHIFT),
            KeyDown(Win32InputInterop.VK_F5),
            KeyUp(Win32InputInterop.VK_F5),
            KeyUp(Win32InputInterop.VK_SHIFT),
        };

        var inserted = Win32InputInterop.SendInput(
            (uint)inputs.Length,
            inputs,
            System.Runtime.InteropServices.Marshal.SizeOf<Win32InputInterop.INPUT>());

        return (int)inserted;
    }

    private static Win32InputInterop.INPUT KeyDown(ushort vk) => BuildKeyInput(vk, keyUp: false);

    private static Win32InputInterop.INPUT KeyUp(ushort vk) => BuildKeyInput(vk, keyUp: true);

    private static Win32InputInterop.INPUT BuildKeyInput(ushort vk, bool keyUp) => new()
    {
        type = Win32InputInterop.INPUT_KEYBOARD,
        U = new Win32InputInterop.InputUnion
        {
            ki = new Win32InputInterop.KEYBDINPUT
            {
                wVk = vk,
                wScan = 0,
                dwFlags = keyUp ? Win32InputInterop.KEYEVENTF_KEYUP : 0,
                time = 0,
                dwExtraInfo = 0,
            },
        },
    };
}
