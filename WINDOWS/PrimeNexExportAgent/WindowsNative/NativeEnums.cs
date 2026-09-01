namespace PrimeNexExportAgent.WindowsNative;

/// <summary>
/// Espelha o enum nativo WTS_CONNECTSTATE_CLASS (wtsapi32.dll) usado por
/// WTSQuerySessionInformation. Valores exatamente na ordem/numeracao da
/// API Win32 - nunca reordenar (F6.14A).
/// </summary>
public enum WtsConnectState
{
    Active = 0,
    Connected = 1,
    ConnectQuery = 2,
    Shadow = 3,
    Disconnected = 4,
    Idle = 5,
    Listen = 6,
    Reset = 7,
    Down = 8,
    Init = 9,
}
