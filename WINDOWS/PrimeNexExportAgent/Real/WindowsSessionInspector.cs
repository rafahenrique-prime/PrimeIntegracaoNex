using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (F6.14A) de ISessionInspector - somente leitura.
/// Responsabilidade exclusiva (F6.13.2): verificar se a sessao Windows do
/// PROPRIO Agent esta ativa/utilizavel. Nunca toca NexAdmin, nunca
/// desbloqueia/cria sessao, nunca armazena/usa senha.
///
/// LIMITE TECNICO DOCUMENTADO (F6.14A secao 4, auditado nesta tarefa,
/// nao "assumido"): WTSQuerySessionInformation(WTSConnectState) retornando
/// WTSActive prova que a sessao esta conectada e em primeiro plano no
/// console, mas NAO prova, sozinho, que a tela esta desbloqueada - em
/// varias versoes do Windows uma sessao com a tela de bloqueio (Win+L)
/// ainda reporta WTSActive (o bloqueio de tela e uma "estacao de janela"
/// segura sobreposta, nao uma mudanca de WTS_CONNECTSTATE_CLASS). Nao
/// existe, disponivel para uso somente-leitura simples, uma API Win32
/// unica e 100% confiavel para "esta sessao esta desbloqueada agora"
/// (as alternativas conhecidas - WTSRegisterSessionNotification exige um
/// loop de mensagens/janela; GetLastInputInfo mede ociosidade, nao bloqueio)
/// - por isso este inspector NAO afirma certeza que nao tem: WTSActive e
/// tratado como necessario, mas nao suficiente. A mitigacao real contra
/// esse gap fica no PRE-INPUT TARGET GATE (T1-T4, ja documentado em
/// IInputSender - F6.13.4): se a sessao estiver de fato bloqueada,
/// SetForegroundWindow/GetForegroundWindow falharao ou nao confirmarao o
/// HWND esperado, abortando ANTES de qualquer tecla ser enviada - essa
/// parte permanece nao implementada nesta tarefa (F6.14B).
/// </summary>
public sealed class WindowsSessionInspector : ISessionInspector
{
    private readonly ISessionNativeApi _native;

    public WindowsSessionInspector(ISessionNativeApi native) => _native = native;

    public SessionCheckResult CheckSession()
    {
        int sessionId;
        try
        {
            sessionId = _native.GetCurrentProcessSessionId();
        }
        catch (Exception ex)
        {
            // Fail-closed: erro ao consultar a propria sessao nunca vira "deve
            // estar ok".
            return SessionCheckResult.Fail(AgentErrorCode.SessionUnavailable, $"erro ao obter SessionId do Agent: {ex.Message}");
        }

        WtsConnectState? state;
        try
        {
            state = _native.QueryConnectState(sessionId);
        }
        catch (Exception ex)
        {
            return SessionCheckResult.Fail(AgentErrorCode.SessionUnavailable, $"erro ao consultar WTSConnectState: {ex.Message}");
        }

        if (state is null)
        {
            // Estado desconhecido (consulta falhou/valor fora do enum) -
            // fail-closed (F6.14A secao 3).
            return SessionCheckResult.Fail(AgentErrorCode.SessionUnavailable, "WTSConnectState indisponivel/desconhecido");
        }

        if (state != WtsConnectState.Active)
        {
            return SessionCheckResult.Fail(AgentErrorCode.SessionUnavailable, $"sessao nao esta WTSActive (estado atual: {state})");
        }

        return SessionCheckResult.Pass(sessionId);
    }
}
