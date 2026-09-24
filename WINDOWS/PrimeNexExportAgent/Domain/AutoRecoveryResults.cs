namespace PrimeNexExportAgent.Domain;

public enum AutoRecoveryClassification
{
    EMPTY,
    FINAL_XLS_ORPHAN,
    TRANSIENT_CSV_ORPHAN,
    AMBIGUOUS,
}

public enum AutoRecoveryOutcome
{
    NoAction,
    XlsPublished,
    CsvQuarantined,
    Rejected,
}

public sealed class AutoRecoveryResult
{
    private AutoRecoveryResult(
        AutoRecoveryClassification classification,
        AutoRecoveryOutcome outcome,
        AgentErrorCode errorCode,
        string reason,
        string? destinationPath)
    {
        Classification = classification;
        Outcome = outcome;
        ErrorCode = errorCode;
        Reason = reason;
        DestinationPath = destinationPath;
    }

    public AutoRecoveryClassification Classification { get; }
    public AutoRecoveryOutcome Outcome { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }
    public string? DestinationPath { get; }
    public bool ShouldStopRun => Classification != AutoRecoveryClassification.EMPTY;
    public bool Succeeded => Outcome is AutoRecoveryOutcome.XlsPublished or AutoRecoveryOutcome.CsvQuarantined;

    public static AutoRecoveryResult Empty() => new(AutoRecoveryClassification.EMPTY, AutoRecoveryOutcome.NoAction, AgentErrorCode.None, string.Empty, null);
    public static AutoRecoveryResult Rejected(AutoRecoveryClassification classification, AgentErrorCode code, string reason) =>
        new(classification, AutoRecoveryOutcome.Rejected, code, reason, null);
    public static AutoRecoveryResult PublishedXls(string path) =>
        new(AutoRecoveryClassification.FINAL_XLS_ORPHAN, AutoRecoveryOutcome.XlsPublished, AgentErrorCode.None, string.Empty, path);
    public static AutoRecoveryResult QuarantinedCsv(string path) =>
        new(AutoRecoveryClassification.TRANSIENT_CSV_ORPHAN, AutoRecoveryOutcome.CsvQuarantined, AgentErrorCode.None, string.Empty, path);
}

public sealed record DurableExportIntent(
    Guid RunId,
    Guid CorrelationId,
    string ExpectedBasename,
    string ExpectedExtension,
    DateTime CreatedAtUtc,
    string State);

public sealed class DurableIntentLookup
{
    private DurableIntentLookup(bool healthy, bool found, bool ambiguous, DurableExportIntent? intent, string reason)
    {
        Healthy = healthy;
        Found = found;
        Ambiguous = ambiguous;
        Intent = intent;
        Reason = reason;
    }

    public bool Healthy { get; }
    public bool Found { get; }
    public bool Ambiguous { get; }
    public DurableExportIntent? Intent { get; }
    public string Reason { get; }

    public static DurableIntentLookup Missing() => new(true, false, false, null, "durable intent ausente");
    public static DurableIntentLookup FoundIntent(DurableExportIntent intent) => new(true, true, false, intent, string.Empty);
    public static DurableIntentLookup Invalid(string reason, bool ambiguous = true) => new(false, false, ambiguous, null, reason);
}

public enum RecoveryLedgerState
{
    IntentPending,
    Completed,
    Failed,
    MoveUnknown,
}
