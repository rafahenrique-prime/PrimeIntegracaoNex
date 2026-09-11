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

    public MsaaElementHandle? HitTestWithinWindow(nint hWnd, int screenX, int screenY)
    {
        Win32MsaaInterop.SetThreadDpiAwarenessContext(Win32MsaaInterop.DPI_AWARENESS_CONTEXT_UNAWARE);

        var riid = Win32MsaaInterop.IID_IAccessible;
        var hr = Win32MsaaInterop.AccessibleObjectFromWindow(hWnd, Win32MsaaInterop.OBJID_CLIENT, ref riid, out var rootAccObj);
        if (hr != 0 || rootAccObj is null) return null;

        object? hitResult;
        try
        {
            dynamic acc = rootAccObj;
            hitResult = acc.accHitTest(screenX, screenY);
        }
        catch
        {
            return null;
        }

        // accHitTest devolve um VARIANT: VT_I4 = childId simples do
        // objeto raiz consultado; VT_DISPATCH = um objeto acessivel
        // ANINHADO distinto (o alvo real, com seu proprio CHILDID_SELF=0)
        // - comportamento documentado da API, confirmado em runtime real
        // (Fases A.5/A.10, onde todos os itens de barra/popup retornaram
        // KIND=VT_DISPATCH). Nunca assumir um dos dois formatos sem checar.
        if (hitResult is int childId)
        {
            return new MsaaElementHandle(rootAccObj, childId);
        }
        if (hitResult is not null)
        {
            return new MsaaElementHandle(hitResult, 0);
        }
        return null; // VT_EMPTY - hit-test nao encontrou nada nesse ponto
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
