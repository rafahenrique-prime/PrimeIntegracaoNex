using System.Text;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL de IOverflowHitTestNativeApi.
///
/// CORRECAO POS-PROBE 12A (DPI): GetWindowRect e' virtualizado por DPI
/// (documentacao oficial Microsoft), e o profile homologado
/// (NexOverflowButtonProfile: 0,0,1536,864 / 1489,146) foi calibrado
/// inteiramente sob DPI_AWARENESS_CONTEXT_UNAWARE (ferramentas
/// PowerShell). Comprovado em runtime real (Probe 12A): o MESMO HWND vivo
/// mede (0,0,1536,864) sob UNAWARE e (0,0,1920,1080) sob qualquer
/// contexto DPI-aware - sem nenhuma mudanca real de janela. Por isso,
/// TODAS as operacoes deste adapter que participam do espaco de
/// coordenadas calibrado (GetWindowRectPhysical, WindowFromPhysicalPoint,
/// ScreenToClient, PostMouseDown/Up) rodam dentro de um
/// DpiAwarenessScope.TryEnterUnaware - nunca via
/// SetProcessDpiAwareness/SetProcessDpiAwarenessContext (isso alteraria o
/// processo inteiro, afetando WPF/UI Automation/Vendas) - somente
/// thread-local, sempre restaurado ao sair (inclusive em excecao).
///
/// NOTA DE NOMENCLATURA: "GetWindowRectPhysical" mantem o nome historico
/// por decisao explicita (evitar diff amplo nos varios chamadores/testes)
/// mas, apos esta correcao, o resultado NAO esta necessariamente em
/// pixels fisicos de tela - esta no espaco de coordenadas UNAWARE
/// (96 DPI virtualizado), o mesmo espaco em que NexOverflowButtonProfile
/// foi homologado. Ver DpiAwarenessScope para o porque.
/// </summary>
public sealed class Win32OverflowHitTestNativeApi : IOverflowHitTestNativeApi
{
    private static bool TryEnterUnaware(out DpiAwarenessScope? scope) =>
        DpiAwarenessScope.TryEnterUnaware(Win32OverflowHitTestInterop.SetThreadDpiAwarenessContext, out scope);

    public (int left, int top, int right, int bottom)? GetWindowRectPhysical(nint hWnd)
    {
        if (!TryEnterUnaware(out var scope)) return null; // fail closed - zero GetWindowRect
        using (scope)
        {
            if (!Win32OverflowHitTestInterop.GetWindowRect(hWnd, out var rect)) return null;
            return (rect.Left, rect.Top, rect.Right, rect.Bottom);
        }
    }

    public nint WindowFromPhysicalPoint(int screenX, int screenY)
    {
        if (!TryEnterUnaware(out var scope)) return 0; // fail closed - zero hit-test
        using (scope)
        {
            var pt = new Win32OverflowHitTestInterop.POINT { X = screenX, Y = screenY };
            return Win32OverflowHitTestInterop.WindowFromPhysicalPoint(pt);
        }
    }

    public int GetOwningProcessId(nint hWnd)
    {
        Win32OverflowHitTestInterop.GetWindowThreadProcessId(hWnd, out var pid);
        return (int)pid;
    }

    public string? GetClassName(nint hWnd)
    {
        var sb = new StringBuilder(256);
        var len = Win32OverflowHitTestInterop.GetClassName(hWnd, sb, sb.Capacity);
        return len > 0 ? sb.ToString(0, len) : null;
    }

    public (int clientX, int clientY)? ScreenToClient(nint hWnd, int screenX, int screenY)
    {
        if (!TryEnterUnaware(out var scope)) return null; // fail closed - zero ScreenToClient
        using (scope)
        {
            var pt = new Win32OverflowHitTestInterop.POINT { X = screenX, Y = screenY };
            if (!Win32OverflowHitTestInterop.ScreenToClient(hWnd, ref pt)) return null;
            return (pt.X, pt.Y);
        }
    }

    public (bool posted, int lastError) PostMouseDown(nint hWnd, int clientX, int clientY)
    {
        if (!TryEnterUnaware(out var scope)) return (false, 0); // fail closed - zero PostMessage
        using (scope)
        {
            return Post(hWnd, Win32OverflowHitTestInterop.WM_LBUTTONDOWN, Win32OverflowHitTestInterop.MK_LBUTTON, MakeLParam(clientX, clientY));
        }
    }

    public (bool posted, int lastError) PostMouseUp(nint hWnd, int clientX, int clientY)
    {
        if (!TryEnterUnaware(out var scope)) return (false, 0); // fail closed - zero PostMessage
        using (scope)
        {
            return Post(hWnd, Win32OverflowHitTestInterop.WM_LBUTTONUP, 0, MakeLParam(clientX, clientY));
        }
    }

    public IReadOnlyList<nint> FindVisibleTopLevelByClass(int processId, string className)
    {
        var result = new List<nint>();
        bool Callback(nint hWnd, nint lParam)
        {
            Win32OverflowHitTestInterop.GetWindowThreadProcessId(hWnd, out var pid);
            if ((int)pid == processId && Win32OverflowHitTestInterop.IsWindowVisible(hWnd))
            {
                var cls = GetClassName(hWnd);
                if (string.Equals(cls, className, StringComparison.Ordinal))
                {
                    result.Add(hWnd);
                }
            }
            return true;
        }
        Win32OverflowHitTestInterop.EnumWindows(Callback, 0);
        return result;
    }

    public bool IsWindowValid(nint hWnd) => Win32OverflowHitTestInterop.IsWindow(hWnd);

    public nint GetParent(nint hWnd) => Win32OverflowHitTestInterop.GetParent(hWnd);

    public string? GetWindowTitle(nint hWnd)
    {
        var sb = new StringBuilder(512);
        var len = Win32OverflowHitTestInterop.GetWindowText(hWnd, sb, sb.Capacity);
        return len >= 0 ? sb.ToString(0, len) : null;
    }

    private static nint MakeLParam(int x, int y) => unchecked((nint)((y << 16) | (x & 0xFFFF)));

    private static (bool posted, int lastError) Post(nint hWnd, uint msg, nint wParam, nint lParam)
    {
        var posted = Win32OverflowHitTestInterop.PostMessage(hWnd, msg, wParam, lParam);
        if (posted) return (true, 0);
        return (false, System.Runtime.InteropServices.Marshal.GetLastWin32Error());
    }
}
