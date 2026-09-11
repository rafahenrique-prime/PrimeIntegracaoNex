using System.Runtime.InteropServices;

namespace PrimeNexExportAgent.WindowsInput;

/// <summary>Implementacao REAL (Scheduler V2) de IBackgroundClickNativeApi.</summary>
public sealed class Win32BackgroundClickNativeApi : IBackgroundClickNativeApi
{
    public (bool completed, nint result, int lastError) SendBnClickedViaWmCommand(
        nint parentHwnd, nint controlHwnd, int controlId, uint timeoutMs)
    {
        var wParam = BackgroundClickWParamBuilder.BuildWmCommandWParam(
            controlId, (ushort)Win32BackgroundClickInterop.BN_CLICKED);

        var sendResult = Win32BackgroundClickInterop.SendMessageTimeout(
            parentHwnd,
            Win32BackgroundClickInterop.WM_COMMAND,
            wParam,
            controlHwnd,
            Win32BackgroundClickInterop.SMTO_ABORTIFHUNG,
            timeoutMs,
            out var lpResult);

        if (sendResult == 0)
        {
            // SendMessageTimeout retornou 0: pode ser timeout
            // (SMTO_ABORTIFHUNG) ou outra falha - GetLastError distingue,
            // mas ambos os casos sao tratados como "nao confirmado" pelo
            // chamador, nunca como sucesso presumido.
            return (false, lpResult, Marshal.GetLastWin32Error());
        }

        return (true, lpResult, 0);
    }
}
