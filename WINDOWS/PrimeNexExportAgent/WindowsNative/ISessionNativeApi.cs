namespace PrimeNexExportAgent.WindowsNative;

/// <summary>
/// Fronteira mockavel para a checagem de sessao Windows (F6.14A). Separada
/// de INativeWindowApi porque pertence a uma API nativa diferente
/// (wtsapi32.dll, nao user32.dll) e a um gate conceitualmente distinto (G2).
/// </summary>
public interface ISessionNativeApi
{
    /// <summary>SessionId do processo atual (do proprio Agent) - API
    /// gerenciada do .NET (Process.SessionId), nao requer P/Invoke.</summary>
    int GetCurrentProcessSessionId();

    /// <summary>Consulta WTSQuerySessionInformation(WTSConnectState) para o
    /// sessionId informado. Retorna null se a consulta falhar (erro Win32) -
    /// o chamador deve tratar null como "estado desconhecido", NUNCA como
    /// "deve estar ativo" (fail-closed, F6.14A secao 3).</summary>
    WtsConnectState? QueryConnectState(int sessionId);
}
