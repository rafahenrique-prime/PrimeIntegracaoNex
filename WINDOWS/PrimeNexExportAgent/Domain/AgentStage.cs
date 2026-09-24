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
    RecoveryCompleted,
    AutoRecoveryDetected,
    AutoRecoveryEligible,
    AutoRecoveryRejected,
    AutoRecoveryXlsPublished,
    AutoRecoveryCsvQuarantined,
    AutoRecoveryFailed,

    // Estagios NOVOS do fluxo de extrato individual por cliente (V1) -
    // inseridos entre SafeStateValidated e ExportTriggered, nunca
    // reordenam nem substituem os estagios ja existentes do pipeline de
    // Vendas.
    ClientOpened,
    TransactionsTabActive,
    OverflowMenuOpened,

    // Terminais de falha/skip - NUNCA tem transicao de saida.
    Failed,
    SkippedBusy,
    SkippedSessionUnavailable,
    NexNotFound,
    UnsafeState,

    // Modo scheduled-safe (--run-once-scheduled-safe): NexAdmin nao esta
    // em primeiro plano no momento do input (WindowsScheduledSafeInputSender,
    // T3/T4) - nunca forca foreground, so desiste e relata. Resultado
    // esperado e frequente num polling de 5min, nunca tratado como Failed.
    SkippedNotForeground,
}
