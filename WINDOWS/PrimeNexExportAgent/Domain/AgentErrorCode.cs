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

    // Codigos NOVOS do fluxo de extrato individual por cliente (V1).
    ClientSearchReadbackMismatch,
    ClientFocusUnresolved,
    F2DownPostFailed,
    F2UpPostFailed,
    ClientWindowNotFound,
    ClientWindowAmbiguous,
    ClientIdentityMismatch,
    ClientIdentityAmbiguous,
    ClientContextChangedDuringSettle,
    ClientGridNotFound,
    ClientGridAmbiguous,
    ClientGridGeometryMismatch,
    ClientGridClickFailed,
    TransactionsTabNotFound,
    TransactionsTabAmbiguous,
    TransactionsTabNoEffect,
    AmbiguousIdentityAfterNavigation,
    OverflowGeometryMismatch,
    OverflowHandleInvalidated,
    OverflowTargetNotMapped,
    OverflowTargetOccluded,
    OverflowPostFailed,
    OverflowPopupNotFound,
    OverflowWrongPopup,
    ExportItemNotFound,
    ExportItemAmbiguous,
    ExportItemNotActionable,
    ZeroRecords,

    // Modo scheduled-safe (--run-once-scheduled-safe).
    NotForeground,
}
