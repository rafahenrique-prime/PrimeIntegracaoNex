namespace PrimeNexExportAgent.Logging;

/// <summary>
/// Evento de log estruturado (F6.12 secao 17). Carrega SOMENTE metadados
/// operacionais - nunca payload de venda/cliente/valor/itens. O campo
/// FileName so e preenchido quando estritamente necessario (ex.: nome do
/// arquivo gerado), nunca conteudo do arquivo.
/// </summary>
public sealed class AgentLogEvent
{
    public DateTime Timestamp { get; }
    public Guid RunId { get; }
    public string Stage { get; }
    public string? ErrorCode { get; }
    public string? FileName { get; }

    public AgentLogEvent(DateTime timestamp, Guid runId, string stage, string? errorCode = null, string? fileName = null)
    {
        Timestamp = timestamp;
        RunId = runId;
        Stage = stage;
        ErrorCode = errorCode;
        FileName = fileName;
    }
}

/// <summary>
/// Nomes dos eventos previstos (F6.12 secao 17) - constantes de string
/// para evitar erros de digitacao espalhados pelo codigo/testes.
/// </summary>
public static class AgentLogEventNames
{
    public const string AgentStarted = "AGENT_STARTED";
    public const string SessionUnavailable = "SESSION_UNAVAILABLE";
    public const string NexNotFound = "NEX_NOT_FOUND";
    public const string UnsafeState = "UNSAFE_STATE";
    public const string ExportTriggered = "EXPORT_TRIGGERED";
    public const string SaveDialogFound = "SAVE_DIALOG_FOUND";
    public const string StagingWritten = "STAGING_WRITTEN";
    public const string ReaderValidated = "READER_VALIDATED";
    public const string Published = "PUBLISHED";
    public const string Failed = "FAILED";
    public const string SkippedBusy = "SKIPPED_BUSY";
}
