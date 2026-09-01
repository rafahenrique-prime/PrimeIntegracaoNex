namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Estagios da maquina de estados do PRIME NEX EXPORT AGENT (F6.12.1).
/// Grafo ACICLICO por design - nenhuma transicao de retorno existe em
/// nenhum lugar do codigo. Nao ha "retry de UI": uma falha em qualquer
/// estagio leva direto a um estagio terminal (<see cref="Failed"/> ou um
/// dos SKIPPED_*), nunca de volta a um estagio anterior.
/// </summary>
public enum AgentStage
{
    Start,
    LockAcquired,
    SessionValidated,
    NexValidated,
    SafeStateValidated,
    ExportTriggered,
    SaveDialogIdentified,
    SaveControlsValidated,
    SaveDialogConfigured,
    SaveDialogReadbackValidated,
    FileSaveTriggered,
    FileStable,
    ReaderValidated,
    Published,
    Success,

    // Terminais de falha/skip - NUNCA tem transicao de saida.
    Failed,
    SkippedBusy,
    SkippedSessionUnavailable,
    NexNotFound,
    UnsafeState,
}
