namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Resultado de um unico gate (G1-G12) - nunca um bool solto. Passed=false
/// sempre vem acompanhado de um <see cref="AgentErrorCode"/> especifico e
/// de um motivo textual (para log/diagnostico, nunca para decisao).
/// </summary>
public sealed class GateResult
{
    public bool Passed { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }

    private GateResult(bool passed, AgentErrorCode errorCode, string reason)
    {
        Passed = passed;
        ErrorCode = errorCode;
        Reason = reason;
    }

    public static GateResult Pass() => new(true, AgentErrorCode.None, string.Empty);

    public static GateResult Fail(AgentErrorCode errorCode, string reason)
    {
        if (errorCode == AgentErrorCode.None)
        {
            throw new ArgumentException("Fail() exige um AgentErrorCode diferente de None.", nameof(errorCode));
        }
        return new GateResult(false, errorCode, reason);
    }
}
