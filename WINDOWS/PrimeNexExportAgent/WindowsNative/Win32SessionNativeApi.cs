using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PrimeNexExportAgent.WindowsNative;

/// <summary>Implementacao real (F6.14A) de ISessionNativeApi. Somente
/// leitura - nunca desbloqueia, cria ou altera sessao/estado do Windows,
/// nunca toca senha nenhuma.</summary>
public sealed class Win32SessionNativeApi : ISessionNativeApi
{
    public int GetCurrentProcessSessionId()
    {
        using var current = Process.GetCurrentProcess();
        return current.SessionId;
    }

    public WtsConnectState? QueryConnectState(int sessionId)
    {
        var ok = Win32Interop.WTSQuerySessionInformation(
            Win32Interop.WTS_CURRENT_SERVER_HANDLE,
            (uint)sessionId,
            Win32Interop.WtsInfoClass.WTSConnectState,
            out var buffer,
            out var bytesReturned);

        if (!ok || buffer == 0 || bytesReturned < sizeof(int))
        {
            // Falha na consulta: estado desconhecido, NUNCA assumido ativo.
            return null;
        }

        try
        {
            var raw = Marshal.ReadInt32(buffer);
            if (!Enum.IsDefined(typeof(WtsConnectState), raw))
            {
                // Valor fora do enum documentado: estado desconhecido -
                // fail-closed, nunca interpretado como "deve estar ok".
                return null;
            }
            return (WtsConnectState)raw;
        }
        finally
        {
            Win32Interop.WTSFreeMemory(buffer);
        }
    }
}
