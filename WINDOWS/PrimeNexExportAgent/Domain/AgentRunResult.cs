namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Resultado final de uma execucao completa do Agent - sempre carrega o
/// runId (para correlacionar com os logs), o estagio final atingido e,
/// se aplicavel, o codigo de erro. Nunca um bool solto.
/// </summary>
public sealed class AgentRunResult
{
    public Guid RunId { get; }
    public bool Success { get; }
    public AgentStage FinalStage { get; }
    public AgentErrorCode ErrorCode { get; }
    public string? PublishedFilePath { get; }
    public bool RecoveryCompleted { get; }

    private AgentRunResult(Guid runId, bool success, AgentStage finalStage, AgentErrorCode errorCode, string? publishedFilePath, bool recoveryCompleted)
    {
        RunId = runId;
        Success = success;
        FinalStage = finalStage;
        ErrorCode = errorCode;
        PublishedFilePath = publishedFilePath;
        RecoveryCompleted = recoveryCompleted;
    }

    public static AgentRunResult Ok(Guid runId, string publishedFilePath) =>
        new(runId, true, AgentStage.Success, AgentErrorCode.None, publishedFilePath, false);

    public static AgentRunResult Recovered(Guid runId, string recoveredFilePath) =>
        new(runId, true, AgentStage.RecoveryCompleted, AgentErrorCode.None, recoveredFilePath, true);

    public static AgentRunResult Stop(Guid runId, AgentStage finalStage, AgentErrorCode errorCode) =>
        new(runId, false, finalStage, errorCode, null, false);
}
