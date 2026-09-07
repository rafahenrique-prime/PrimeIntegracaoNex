using System.Text;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Real;

/// <summary>Implementacao REAL de INexClientNavigationNativeApi - fina
/// camada sobre Win32NexClientNavigationInterop, sem nenhuma decisao de
/// negocio (isso pertence a WindowsNexClientNavigator).</summary>
public sealed class Win32NexClientNavigationNativeApi : INexClientNavigationNativeApi
{
    private const int MaxTextLength = 512;

    public nint GetForegroundWindow() => Win32NexClientNavigationInterop.GetForegroundWindow();

    public int GetOwningProcessId(nint hWnd)
    {
        Win32NexClientNavigationInterop.GetWindowThreadProcessId(hWnd, out var pid);
        return (int)pid;
    }

    public string? GetClassName(nint hWnd)
    {
        var sb = new StringBuilder(256);
        var len = Win32NexClientNavigationInterop.GetClassName(hWnd, sb, sb.Capacity);
        return len > 0 ? sb.ToString(0, len) : null;
    }

    public IReadOnlyList<nint> EnumChildWindows(nint parentHwnd)
    {
        var result = new List<nint>();
        bool Callback(nint hWnd, nint lParam)
        {
            result.Add(hWnd);
            return true;
        }
        Win32NexClientNavigationInterop.EnumChildWindows(parentHwnd, Callback, 0);
        return result;
    }

    public string? ReadControlText(nint hWnd)
    {
        if (hWnd == 0) return null;
        var length = (int)Win32NexClientNavigationInterop.SendMessageGetTextLength(hWnd, Win32NexClientNavigationInterop.WM_GETTEXTLENGTH, 0, 0);
        if (length < 0) return null;
        if (length == 0) return string.Empty;

        var sb = new StringBuilder(Math.Max(length + 1, MaxTextLength));
        var written = Win32NexClientNavigationInterop.SendMessageGetText(hWnd, Win32NexClientNavigationInterop.WM_GETTEXT, (nint)sb.Capacity, sb);
        return written > 0 ? sb.ToString(0, (int)written) : null;
    }

    public bool WriteControlText(nint hWnd, string value) =>
        Win32NexClientNavigationInterop.SendMessageSetText(hWnd, Win32NexClientNavigationInterop.WM_SETTEXT, 0, value) != 0;

    public bool IsWindowValid(nint hWnd) => Win32NexClientNavigationInterop.IsWindow(hWnd);

    public bool IsWindowCurrentlyVisible(nint hWnd) => Win32NexClientNavigationInterop.IsWindowVisible(hWnd);

    public bool IsWindowCurrentlyEnabled(nint hWnd) => Win32NexClientNavigationInterop.IsWindowEnabled(hWnd);

    public nint GetFocusedWindow(nint foregroundHwnd)
    {
        Win32NexClientNavigationInterop.GetWindowThreadProcessId(foregroundHwnd, out _);
        var threadId = GetWindowThread(foregroundHwnd);
        var gti = new Win32NexClientNavigationInterop.GUITHREADINFO
        {
            cbSize = System.Runtime.InteropServices.Marshal.SizeOf<Win32NexClientNavigationInterop.GUITHREADINFO>(),
        };
        return Win32NexClientNavigationInterop.GetGUIThreadInfo(threadId, ref gti) ? gti.hwndFocus : 0;
    }

    private static uint GetWindowThread(nint hWnd)
    {
        Win32NexClientNavigationInterop.GetWindowThreadProcessId(hWnd, out _);
        // GetWindowThreadProcessId retorna o thread id como valor de
        // retorno da funcao nativa - reimplementado aqui via P/Invoke
        // direto porque o wrapper acima descarta esse retorno.
        return Win32NativeThreadIdReader.GetThreadId(hWnd);
    }

    public ushort GetKeyScanCode(ushort virtualKey) =>
        (ushort)Win32NexClientNavigationInterop.MapVirtualKeyW(virtualKey, Win32NexClientNavigationInterop.MAPVK_VK_TO_VSC);

    public bool IsModifierKeyDown(int virtualKey) =>
        (Win32NexClientNavigationInterop.GetAsyncKeyState(virtualKey) & 0x8000) != 0;

    public (bool posted, int lastError) PostKeyDown(nint hWnd, ushort virtualKey, nint lParam) =>
        Post(hWnd, Win32NexClientNavigationInterop.WM_KEYDOWN, (nint)virtualKey, lParam);

    public (bool posted, int lastError) PostKeyUp(nint hWnd, ushort virtualKey, nint lParam) =>
        Post(hWnd, Win32NexClientNavigationInterop.WM_KEYUP, (nint)virtualKey, lParam);

    public (bool posted, int lastError) PostMouseDown(nint hWnd, int clientX, int clientY) =>
        Post(hWnd, Win32NexClientNavigationInterop.WM_LBUTTONDOWN, Win32NexClientNavigationInterop.MK_LBUTTON, MakeLParam(clientX, clientY));

    public (bool posted, int lastError) PostMouseUp(nint hWnd, int clientX, int clientY) =>
        Post(hWnd, Win32NexClientNavigationInterop.WM_LBUTTONUP, 0, MakeLParam(clientX, clientY));

    public (int width, int height)? GetClientSize(nint hWnd)
    {
        if (!Win32NexClientNavigationInterop.GetClientRect(hWnd, out var rect)) return null;
        return (rect.Right - rect.Left, rect.Bottom - rect.Top);
    }

    public (int left, int top, int right, int bottom)? GetWindowRectangle(nint hWnd)
    {
        if (!Win32NexClientNavigationInterop.GetWindowRect(hWnd, out var rect)) return null;
        return (rect.Left, rect.Top, rect.Right, rect.Bottom);
    }

    private static nint MakeLParam(int x, int y) =>
        unchecked((nint)((y << 16) | (x & 0xFFFF)));

    /// <summary>PostMessage: `lastError` SO e' lido quando `posted=false`
    /// - jamais interpretar um GetLastError residual apos uma chamada que
    /// retornou true como se fosse um erro real (correcao explicita desta
    /// fase, motivada pelo residuo observado repetidamente na sessao de
    /// homologacao manual).</summary>
    private static (bool posted, int lastError) Post(nint hWnd, uint msg, nint wParam, nint lParam)
    {
        var posted = Win32NexClientNavigationInterop.PostMessage(hWnd, msg, wParam, lParam);
        if (posted) return (true, 0);
        return (false, System.Runtime.InteropServices.Marshal.GetLastWin32Error());
    }
}

/// <summary>Helper minimo isolado so para obter o thread id de retorno de
/// GetWindowThreadProcessId (a assinatura publica do adapter expoe
/// apenas o PID via out-param, seguindo o mesmo padrao ja usado em
/// INativeWindowApi.GetOwningProcessId) - necessario separadamente aqui
/// porque GetGUIThreadInfo exige o THREAD id, nao o PID.</summary>
internal static class Win32NativeThreadIdReader
{
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(nint hWnd, out uint lpdwProcessId);

    internal static uint GetThreadId(nint hWnd) => GetWindowThreadProcessId(hWnd, out _);
}
