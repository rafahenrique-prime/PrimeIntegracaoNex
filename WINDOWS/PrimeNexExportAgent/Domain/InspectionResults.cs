namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Resultados tipados das inspecoes (G1-G12). Cada tipo carrega somente
/// os campos necessarios para o gate correspondente - nunca reaproveita
/// um "bool generico" entre gates diferentes, para nao arriscar misturar
/// a semantica de um gate com outro por engano.
/// </summary>

/// G2 (parte de sessao): verifica SOMENTE se a sessao Windows do proprio
/// Agent esta ativa/desbloqueada (WTSActive) - F6.13.2 correcao. NUNCA
/// localiza, identifica ou conhece o NexAdmin - isso agora e
/// responsabilidade exclusiva de INexWindowInspector.LocateNexAdmin().
public sealed class SessionCheckResult
{
    public bool Passed { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }
    public int? AgentSessionId { get; }

    private SessionCheckResult(bool passed, AgentErrorCode errorCode, string reason, int? agentSessionId)
    {
        Passed = passed;
        ErrorCode = errorCode;
        Reason = reason;
        AgentSessionId = agentSessionId;
    }

    public static SessionCheckResult Pass(int agentSessionId) =>
        new(true, AgentErrorCode.None, string.Empty, agentSessionId);

    public static SessionCheckResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason, null);
}

/// G1 (identidade do NexAdmin) + a parte de G2 que depende de comparar
/// com o NexAdmin encontrado (F6.13.2 correcao): localiza o processo,
/// confirma ClassName TfrmPri, e confirma que o SessionId do processo
/// encontrado bate com o `expectedSessionId` ja validado por
/// ISessionInspector. Retorna a identidade completa da janela (PID +
/// HWND, F6.13.4) somente quando tudo isso for verdadeiro - essa mesma
/// identidade flui, sem ser recalculada, ate CheckSafeState() e ate
/// IInputSender.SendExportShortcut().
public sealed class NexAdminLocateResult
{
    public bool Passed { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }
    public NexAdminWindowIdentity? Identity { get; }

    private NexAdminLocateResult(bool passed, AgentErrorCode errorCode, string reason, NexAdminWindowIdentity? identity)
    {
        Passed = passed;
        ErrorCode = errorCode;
        Reason = reason;
        Identity = identity;
    }

    public static NexAdminLocateResult Pass(NexAdminWindowIdentity identity) =>
        new(true, AgentErrorCode.None, string.Empty, identity);

    public static NexAdminLocateResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason, null);
}

/// G3-G6: topologia de janelas e abas do NexAdmin (janela unica, Vendas,
/// Historico visivel, nenhum modal financeiro). Um unico resultado
/// composto porque, na pratica, todas essas checagens dependem da MESMA
/// leitura de arvore (evita 4 consultas UI Automation separadas e
/// potencialmente inconsistentes entre si).
public sealed class NexWindowCheckResult
{
    public bool Passed { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }

    private NexWindowCheckResult(bool passed, AgentErrorCode errorCode, string reason)
    {
        Passed = passed;
        ErrorCode = errorCode;
        Reason = reason;
    }

    public static NexWindowCheckResult Pass() => new(true, AgentErrorCode.None, string.Empty);

    public static NexWindowCheckResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason);
}

/// G8+G9: identidade do dialogo "Salvar como" (#32770) e presenca dos 5
/// controles esperados (1148/1137/1136/1/2), todos Enabled=True.
public sealed class SaveDialogIdentityResult
{
    public bool Passed { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }

    private SaveDialogIdentityResult(bool passed, AgentErrorCode errorCode, string reason)
    {
        Passed = passed;
        ErrorCode = errorCode;
        Reason = reason;
    }

    public static SaveDialogIdentityResult Pass() => new(true, AgentErrorCode.None, string.Empty);

    public static SaveDialogIdentityResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason);
}

/// G10-G12: releitura pos-configuracao (destino/nome/tipo). Nunca reaproveita
/// o valor que foi escrito - e sempre uma nova leitura independente.
public sealed class SaveDialogReadbackResult
{
    public bool Passed { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }

    private SaveDialogReadbackResult(bool passed, AgentErrorCode errorCode, string reason)
    {
        Passed = passed;
        ErrorCode = errorCode;
        Reason = reason;
    }

    public static SaveDialogReadbackResult Pass() => new(true, AgentErrorCode.None, string.Empty);

    public static SaveDialogReadbackResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason);
}

/// Resultado da checagem de estabilidade de arquivo (F6.12 secao 11).
public sealed class FileStabilityResult
{
    public bool Stable { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }

    private FileStabilityResult(bool stable, AgentErrorCode errorCode, string reason)
    {
        Stable = stable;
        ErrorCode = errorCode;
        Reason = reason;
    }

    public static FileStabilityResult Stabilized() => new(true, AgentErrorCode.None, string.Empty);

    public static FileStabilityResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason);
}

/// Resultado da validacao via SCRIPTS/validar-export-vendas.js (F6.12
/// secao 12) - so o contrato do lado C#, o CLI Node ainda nao existe
/// nesta fase (F6.15).
public sealed class ExportValidationResult
{
    public bool Valid { get; }
    public int RecordCount { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }

    private ExportValidationResult(bool valid, int recordCount, AgentErrorCode errorCode, string reason)
    {
        Valid = valid;
        RecordCount = recordCount;
        ErrorCode = errorCode;
        Reason = reason;
    }

    public static ExportValidationResult Ok(int recordCount) => new(true, recordCount, AgentErrorCode.None, string.Empty);

    public static ExportValidationResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, 0, errorCode, reason);
}

/// Resultado da publicacao atomica (move EXPORT_STAGE -> EXPORTADOS).
public sealed class PublishResult
{
    public bool Published { get; }
    public string? DestinationPath { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }

    private PublishResult(bool published, string? destinationPath, AgentErrorCode errorCode, string reason)
    {
        Published = published;
        DestinationPath = destinationPath;
        ErrorCode = errorCode;
        Reason = reason;
    }

    public static PublishResult Ok(string destinationPath) => new(true, destinationPath, AgentErrorCode.None, string.Empty);

    public static PublishResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, null, errorCode, reason);
}
