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

    [DllImport("user32.dll")]
    internal static extern nint SetThreadDpiAwarenessContext(nint dpiContext);

    internal static readonly nint DPI_AWARENESS_CONTEXT_UNAWARE = new(-1);
}
