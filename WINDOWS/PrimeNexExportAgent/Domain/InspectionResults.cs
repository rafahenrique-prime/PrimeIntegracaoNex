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
/// controles esperados (1148/1137/1136/1/2), todos Enabled=True. So
/// retorna a SaveDialogIdentity (F6.14B2) quando tudo isso for verdadeiro -
/// essa mesma identidade flui, sem ser recalculada, ate Configure/
/// ClickSave/CancelSaveDialog.
public sealed class SaveDialogIdentityResult
{
    public bool Passed { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }
    public SaveDialogIdentity? Dialog { get; }

    private SaveDialogIdentityResult(bool passed, AgentErrorCode errorCode, string reason, SaveDialogIdentity? dialog)
    {
        Passed = passed;
        ErrorCode = errorCode;
        Reason = reason;
        Dialog = dialog;
    }

    public static SaveDialogIdentityResult Pass(SaveDialogIdentity dialog) =>
        new(true, AgentErrorCode.None, string.Empty, dialog);

    public static SaveDialogIdentityResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason, null);
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

/// Resultado de IProcessRunner.Run() (F6.14B2.10A) - somente os dados
/// necessarios para o chamador decidir fail-closed. `Started=false`
/// significa que o processo nem chegou a iniciar (ex.: executavel nao
/// encontrado) - nesse caso ExitCode/StdOut/StdErr sao irrelevantes.
/// `TimedOut=true` significa que o processo foi encerrado (Kill) por
/// exceder o timeout - NUNCA uma segunda tentativa e' feita a partir
/// disso, e o processo morto e' responsabilidade exclusiva de quem o
/// iniciou (nunca APIs de memoria remota).
public sealed class ProcessRunResult
{
    public bool Started { get; }
    public bool TimedOut { get; }
    public int? ExitCode { get; }
    public string StdOut { get; }
    public string StdErr { get; }

    public ProcessRunResult(bool started, bool timedOut, int? exitCode, string stdOut, string stdErr)
    {
        Started = started;
        TimedOut = timedOut;
        ExitCode = exitCode;
        StdOut = stdOut;
        StdErr = stdErr;
    }

    public static ProcessRunResult FailedToStart() => new(false, false, null, string.Empty, string.Empty);
}

/// Resultado de ValidatedExportPublicationCoordinator.Execute()
/// (F6.14B2.11B) - distingue as 3 saidas possiveis (rejeicao na
/// validacao, rejeicao na publicacao, sucesso) sem PII, carregando os
/// resultados originais de Validate()/Publish() para diagnostico (nunca
/// reimplementando a semantica deles).
public sealed class ValidatedPublicationResult
{
    public bool Success { get; }
    public bool ValidationFailed { get; }
    public bool PublicationFailed { get; }
    public ExportValidationResult Validation { get; }
    public PublishResult? Publication { get; }

    private ValidatedPublicationResult(bool success, bool validationFailed, bool publicationFailed, ExportValidationResult validation, PublishResult? publication)
    {
        Success = success;
        ValidationFailed = validationFailed;
        PublicationFailed = publicationFailed;
        Validation = validation;
        Publication = publication;
    }

    /// <summary>Validate() reprovou - Publish() NUNCA foi chamado.</summary>
    public static ValidatedPublicationResult ValidationRejected(ExportValidationResult validation) =>
        new(success: false, validationFailed: true, publicationFailed: false, validation, publication: null);

    /// <summary>Validate() aprovou, mas Publish() falhou - zero retry de
    /// qualquer um dos dois.</summary>
    public static ValidatedPublicationResult PublicationRejected(ExportValidationResult validation, PublishResult publication) =>
        new(success: false, validationFailed: false, publicationFailed: true, validation, publication);

    public static ValidatedPublicationResult Succeeded(ExportValidationResult validation, PublishResult publication) =>
        new(success: true, validationFailed: false, publicationFailed: false, validation, publication);
}

/// Resultado do IExportStageWatcher (F6.14B2.9A) - confirmacao de
/// diretorio vazio antes da acao, e observacao pos-acao ate o unico
/// arquivo esperado estabilizar. Nunca reaproveita FileStabilityResult
/// (que observa um UNICO caminho ja conhecido) porque este tipo tambem
/// precisa expressar "diretorio nao vazio antes" e "arquivo(s)
/// inesperado(s) depois" - problemas distintos do de um unico arquivo.
public sealed class ExportStageWatchResult
{
    public bool Passed { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }

    private ExportStageWatchResult(bool passed, AgentErrorCode errorCode, string reason)
    {
        Passed = passed;
        ErrorCode = errorCode;
        Reason = reason;
    }

    public static ExportStageWatchResult Pass() => new(true, AgentErrorCode.None, string.Empty);

    public static ExportStageWatchResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason);
}

/// Resultado de IConfirmedSaveDialogCommitter.CommitOnce() (F6.14B2.12C1).
/// Dispatched=true significa SOMENTE que BM_CLICK foi despachado
/// exatamente 1 vez ao CtrlId 1 (Salvar) ja revalidado - NUNCA que o
/// arquivo foi salvo/o dialogo fechou/o XLS e valido. A prova real
/// continua sendo obtida depois, via IFileStabilityChecker/
/// IExportStageWatcher contra o sistema de arquivos.
public sealed class SaveDialogCommitResult
{
    public bool Dispatched { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }

    private SaveDialogCommitResult(bool dispatched, AgentErrorCode errorCode, string reason)
    {
        Dispatched = dispatched;
        ErrorCode = errorCode;
        Reason = reason;
    }

    public static SaveDialogCommitResult Pass() => new(true, AgentErrorCode.None, string.Empty);

    public static SaveDialogCommitResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason);
}

/// Resultado de INexClientNavigator.OpenClientByCode() - V1 do fluxo de
/// extrato individual por cliente. So retorna a OpenedClientIdentity
/// quando F2 abriu exatamente 1 TFrmCadCli E a identidade pos-abertura
/// (Codigo sempre, Nome quando esperado) bateu exatamente.
public sealed class ClientOpenResult
{
    public bool Passed { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }
    public OpenedClientIdentity? Client { get; }

    private ClientOpenResult(bool passed, AgentErrorCode errorCode, string reason, OpenedClientIdentity? client)
    {
        Passed = passed;
        ErrorCode = errorCode;
        Reason = reason;
        Client = client;
    }

    public static ClientOpenResult Pass(OpenedClientIdentity client) =>
        new(true, AgentErrorCode.None, string.Empty, client);

    public static ClientOpenResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason, null);
}

/// Resultado de INexClientNavigator.OpenTransactionsTab() - PASS somente
/// se o PostMessage DOWN/UP foi despachado, os 5 indicadores estruturais
/// da aba Transacoes apareceram, E a identidade do cliente (Codigo +
/// Nome ja confirmados/capturados em OpenedClientIdentity) permaneceu
/// identica apos a troca de aba.
public sealed class TransactionsTabResult
{
    public bool Passed { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }

    private TransactionsTabResult(bool passed, AgentErrorCode errorCode, string reason)
    {
        Passed = passed;
        ErrorCode = errorCode;
        Reason = reason;
    }

    public static TransactionsTabResult Pass() => new(true, AgentErrorCode.None, string.Empty);

    public static TransactionsTabResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason);
}

/// Resultado de INexOverflowMenuOpener.OpenOverflowMenu() - carrega
/// APENAS dados imutaveis e re-verificaveis do popup (owner class/title).
/// NUNCA carrega um objeto IAccessible/COM vivo entre chamadas - qualquer
/// referencia MSAA e' sempre reobtida do zero por quem precisar dela
/// (INexExportTrigger), nunca transportada por este tipo.
public sealed class OverflowMenuResult
{
    public bool Passed { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }
    public string? PopupOwnerClass { get; }
    public string? PopupOwnerTitle { get; }

    private OverflowMenuResult(bool passed, AgentErrorCode errorCode, string reason, string? popupOwnerClass, string? popupOwnerTitle)
    {
        Passed = passed;
        ErrorCode = errorCode;
        Reason = reason;
        PopupOwnerClass = popupOwnerClass;
        PopupOwnerTitle = popupOwnerTitle;
    }

    public static OverflowMenuResult Pass(string popupOwnerClass, string popupOwnerTitle) =>
        new(true, AgentErrorCode.None, string.Empty, popupOwnerClass, popupOwnerTitle);

    public static OverflowMenuResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason, null, null);
}

/// Resultado de INexExportTrigger.TriggerExport() - Dispatched=true
/// significa SOMENTE que accDoDefaultAction foi despachado exatamente 1
/// vez no item "Exportar lista de transacoes" recem-revalidado. NUNCA
/// significa "Save Dialog abriu" - essa prova continua vindo de
/// ISaveDialogWaiter, depois, no mesmo espirito de
/// SaveDialogCommitResult.
public sealed class ExportTriggerResult
{
    public bool Dispatched { get; }
    public AgentErrorCode ErrorCode { get; }
    public string Reason { get; }

    private ExportTriggerResult(bool dispatched, AgentErrorCode errorCode, string reason)
    {
        Dispatched = dispatched;
        ErrorCode = errorCode;
        Reason = reason;
    }

    public static ExportTriggerResult Pass() => new(true, AgentErrorCode.None, string.Empty);

    public static ExportTriggerResult Fail(AgentErrorCode errorCode, string reason) =>
        new(false, errorCode, reason);
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
