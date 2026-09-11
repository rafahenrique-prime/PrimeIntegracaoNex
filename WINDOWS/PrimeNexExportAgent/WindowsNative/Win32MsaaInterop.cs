using System.Runtime.InteropServices;

namespace PrimeNexExportAgent.WindowsNative;

/// <summary>UNICO ponto do projeto com DllImport de MSAA (oleacc.dll).</summary>
internal static class Win32MsaaInterop
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct POINT { public int X; public int Y; }

    [DllImport("oleacc.dll")]
    internal static extern int AccessibleObjectFromPoint(
        POINT pt,
        [MarshalAs(UnmanagedType.IDispatch)] out object accObj,
        out object childId);

    /// <summary>Scheduler V2 - ancora o IAccessible diretamente a um HWND
    /// especifico (nunca ao desktop), tornando o hit-test subsequente
    /// (accHitTest, chamado pelo lado gerenciado via COM late-binding)
    /// IMUNE a oclusao por outra janela em primeiro plano (Chrome/Claude)
    /// - decisao de design homologada, evidenciada em runtime real nas
    /// Fases A.5/A.10 (AccessibleObjectFromWindow(hwnd, OBJID_CLIENT) ->
    /// HRESULT=0x0, seguido de accHitTest direto no objeto retornado).
    /// riid = IID_IAccessible sempre - nunca outro IID.</summary>
    [DllImport("oleacc.dll")]
    internal static extern int AccessibleObjectFromWindow(
        nint hwnd,
        uint dwObjectId,
        ref Guid riid,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppvObject);

    internal static Guid IID_IAccessible = new("618736e0-3c3d-11cf-810c-00aa00389b71");
    internal const uint OBJID_CLIENT = 0xFFFFFFFC;

    [DllImport("user32.dll")]
    internal static extern nint SetThreadDpiAwarenessContext(nint dpiContext);

    internal static readonly nint DPI_AWARENESS_CONTEXT_UNAWARE = new(-1);
}
