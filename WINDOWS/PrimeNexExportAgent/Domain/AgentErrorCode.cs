namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Codigos de erro/motivo de parada - nunca um bool ambiguo. Qualquer
/// incerteza (excecao, timeout, resultado inesperado de uma inspecao)
/// deve ser mapeada para um destes codigos, nunca tratada como sucesso
/// por omissao (fail-closed, F6.12 secao 6/F6.12.1 secao 3).
/// </summary>
public enum AgentErrorCode
{
    None,
    LockBusy,
    SessionUnavailable,
    NexNotFound,
    UnsafeState,
    DialogNotFound,
    DialogIdentityMismatch,
    ControlMissing,
    ReadbackMismatch,
    FileUnstable,
    ReaderRejected,
    PublishFailed,
    UnexpectedException,
}
