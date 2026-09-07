using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL de IMsaaAccessibilityApi - usa late-binding COM
/// (dynamic) sobre o IDispatch retornado por AccessibleObjectFromPoint,
/// mesma tecnica ja validada nesta investigacao (equivalente ao late
/// binding usado nos probes PowerShell). SetThreadDpiAwarenessContext
/// (UNAWARE) e' aplicado antes de cada hit-test - achado necessario desta
/// investigacao para hit-testing correto neste aplicativo legado.
/// </summary>
public sealed class Win32MsaaAccessibilityApi : IMsaaAccessibilityApi
{
    public MsaaElementHandle? HitTest(int screenX, int screenY)
    {
        Win32MsaaInterop.SetThreadDpiAwarenessContext(Win32MsaaInterop.DPI_AWARENESS_CONTEXT_UNAWARE);

        var pt = new Win32MsaaInterop.POINT { X = screenX, Y = screenY };
        var hr = Win32MsaaInterop.AccessibleObjectFromPoint(pt, out var accObj, out var childId);
        if (hr != 0 || accObj is null) return null;

        return new MsaaElementHandle(accObj, childId);
    }

    public string? GetName(MsaaElementHandle element)
    {
        try
        {
            dynamic acc = element.AccessibleObject;
            return (string?)acc.accName(element.ChildId);
        }
        catch
        {
            return null;
        }
    }

    public int GetRole(MsaaElementHandle element)
    {
        try
        {
            dynamic acc = element.AccessibleObject;
            var role = acc.accRole(element.ChildId);
            return Convert.ToInt32(role);
        }
        catch
        {
            return 0;
        }
    }

    public int GetState(MsaaElementHandle element)
    {
        try
        {
            dynamic acc = element.AccessibleObject;
            var state = acc.accState(element.ChildId);
            return Convert.ToInt32(state);
        }
        catch
        {
            return 0;
        }
    }

    public (int left, int top, int width, int height)? GetLocation(MsaaElementHandle element)
    {
        try
        {
            dynamic acc = element.AccessibleObject;
            acc.accLocation(out int left, out int top, out int width, out int height, element.ChildId);
            return (left, top, width, height);
        }
        catch
        {
            return null;
        }
    }

    public string DescribeChildId(MsaaElementHandle element)
    {
        try
        {
            return Convert.ToInt32(element.ChildId).ToString();
        }
        catch
        {
            return element.ChildId?.ToString() ?? "null";
        }
    }

    public bool DoDefaultAction(MsaaElementHandle element)
    {
        try
        {
            dynamic acc = element.AccessibleObject;
            acc.accDoDefaultAction(element.ChildId);
            return true;
        }
        catch
        {
            return false;
        }
    }
}
