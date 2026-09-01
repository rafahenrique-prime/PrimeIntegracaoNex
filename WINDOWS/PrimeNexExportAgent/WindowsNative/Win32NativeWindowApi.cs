using System.Text;

namespace PrimeNexExportAgent.WindowsNative;

/// <summary>Implementacao real (F6.14A/F6.14A.1) de INativeWindowApi -
/// estritamente somente leitura. Nenhum metodo aqui envia mensagem, foco,
/// tecla ou clique a nenhuma janela.</summary>
public sealed class Win32NativeWindowApi : INativeWindowApi
{
    private const int MaxClassNameLength = 256;

    public bool IsWindowValid(nint hWnd) => hWnd != 0 && Win32Interop.IsWindow(hWnd);

    public bool IsWindowCurrentlyVisible(nint hWnd) => IsWindowValid(hWnd) && Win32Interop.IsWindowVisible(hWnd);

    public int? GetOwningProcessId(nint hWnd)
    {
        if (!IsWindowValid(hWnd)) return null;

        var threadId = Win32Interop.GetWindowThreadProcessId(hWnd, out var pid);
        if (threadId == 0) return null; // falha na consulta (GetLastError)

        return (int)pid;
    }

    public string? GetClassName(nint hWnd)
    {
        if (!IsWindowValid(hWnd)) return null;

        var sb = new StringBuilder(MaxClassNameLength);
        var length = Win32Interop.GetClassName(hWnd, sb, MaxClassNameLength);
        return length > 0 ? sb.ToString(0, length) : null;
    }

    public nint GetOwner(nint hWnd)
    {
        if (!IsWindowValid(hWnd)) return 0;
        return Win32Interop.GetWindow(hWnd, Win32Interop.GW_OWNER);
    }

    public bool TryGetWindowRect(nint hWnd, out int width, out int height)
    {
        width = 0;
        height = 0;

        if (!IsWindowValid(hWnd)) return false;
        if (!Win32Interop.GetWindowRect(hWnd, out var rect)) return false;

        width = rect.Right - rect.Left;
        height = rect.Bottom - rect.Top;
        return true;
    }

    public IReadOnlyList<nint> GetVisibleTopLevelWindowsForProcess(int processId)
    {
        var result = new List<nint>();

        bool Callback(nint hWnd, nint lParam)
        {
            if (!Win32Interop.IsWindowVisible(hWnd)) return true; // continua enumerando

            // F6.14A.1: NAO filtrar por GW_OWNER == 0 aqui - evidencia real
            // (inspecao ao vivo F6.14A) provou que a janela de negocio
            // TfrmPri tem Owner != 0 (owner = TApplication oculto). EnumWindows
            // ja so retorna janelas top-level por definicao (independente
            // de terem ou nao um Owner).
            var owningPid = GetOwningProcessId(hWnd);
            if (owningPid == processId)
            {
                result.Add(hWnd);
            }
            return true;
        }

        Win32Interop.EnumWindows(Callback, 0);
        return result;
    }
}
