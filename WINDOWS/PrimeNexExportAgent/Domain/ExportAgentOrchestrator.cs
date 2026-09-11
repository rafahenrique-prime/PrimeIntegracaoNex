using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Logging;

namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Orquestrador central do PRIME NEX EXPORT AGENT (F6.12.1). Implementa a
/// maquina de estados sem NENHUMA aresta de retorno - uma falha em
/// qualquer estagio leva direto a um estagio terminal, nunca de volta a
/// um estagio anterior. Em particular:
///   - IInputSender.SendExportShortcut() e chamado NO MAXIMO 1 vez por
///     execucao, e somente apos G1-G7 = PASS.
///   - ISaveDialogController.ClickSave() e chamado NO MAXIMO 1 vez por
///     execucao, e somente apos G8-G12 = PASS (identidade + controles +
///     releitura confirmada).
/// Nenhuma excecao nao tratada deve escapar sem passar por FAILED com
/// AgentErrorCode.UnexpectedException - "fail-closed" tambem se aplica a
/// erros inesperados, nunca so aos esperados.
/// </summary>
public sealed class ExportAgentOrchestrator
{
    private readonly IExecutionLock _lock;
    private readonly ISessionInspector _sessionInspector;
    private readonly INexWindowInspector _nexWindowInspector;
    private readonly IInputSender _inputSender;
    private readonly ISaveDialogWaiter _saveDialogWaiter;
    private readonly ISaveDialogInspector _saveDialogInspector;
    private readonly ISaveDialogController _saveDialogController;
    private readonly IConfirmedSaveDialogCommitter _saveDialogCommitter;
    private readonly IExportStageWatcher _exportStageWatcher;
    private readonly IExportValidator _exportValidator;
    private readonly IAtomicPublisher _atomicPublisher;
    private readonly IAgentLogger _logger;
    private readonly IClock _clock;

    private readonly string _exportStagePath;
    private readonly string _exportadosPath;
    private readonly string _expectedFileType;
    private readonly TimeSpan _watcherTimeout;

    public ExportAgentOrchestrator(
        IExecutionLock @lock,
        ISessionInspector sessionInspector,
        INexWindowInspector nexWindowInspector,
        IInputSender inputSender,
        ISaveDialogWaiter saveDialogWaiter,
        ISaveDialogInspector saveDialogInspector,
        ISaveDialogController saveDialogController,
        IConfirmedSaveDialogCommitter saveDialogCommitter,
        IExportStageWatcher exportStageWatcher,
        IExportValidator exportValidator,
        IAtomicPublisher atomicPublisher,
        IAgentLogger logger,
        IClock clock,
        string exportStagePath,
        string exportadosPath,
        string expectedFileType = "Excel",
        TimeSpan? watcherTimeout = null)
    {
        _lock = @lock;
        _sessionInspector = sessionInspector;
        _nexWindowInspector = nexWindowInspector;
        _inputSender = inputSender;
        _saveDialogWaiter = saveDialogWaiter;
        _saveDialogInspector = saveDialogInspector;
        _saveDialogController = saveDialogController;
        _saveDialogCommitter = saveDialogCommitter;
        _exportStageWatcher = exportStageWatcher;
        _exportValidator = exportValidator;
        _atomicPublisher = atomicPublisher;
        _logger = logger;
        _clock = clock;
        _exportStagePath = exportStagePath;
        _exportadosPath = exportadosPath;
        _expectedFileType = expectedFileType;
        _watcherTimeout = watcherTimeout ?? TimeSpan.FromSeconds(15);
    }

    public AgentRunResult Run()
    {
        var runId = Guid.NewGuid();

        try
        {
            // F6.13.2: Log(Start) movido para DENTRO do try - se o logger
            // real lancar excecao aqui, o catch mais externo (fim deste
            // metodo) garante que Run() nunca deixa uma excecao escapar
            // sem retornar um AgentRunResult (fail-closed tambem se aplica
            // a falhas do proprio logger, nao so da UI).
            Log(runId, AgentStage.Start);

            // ---- G7: lock exclusivo ----
            if (!_lock.TryAcquire())
            {
                Log(runId, AgentStage.SkippedBusy, AgentErrorCode.LockBusy);
                return AgentRunResult.Stop(runId, AgentStage.SkippedBusy, AgentErrorCode.LockBusy);
            }

            try
            {
                Log(runId, AgentStage.LockAcquired);

                // ---- G2: sessao do proprio Agent (F6.13.2 correcao -
                // ISessionInspector nunca conhece o NexAdmin) ----
                var session = _sessionInspector.CheckSession();
                if (!session.Passed)
                {
                    Log(runId, AgentStage.SkippedSessionUnavailable, session.ErrorCode);
                    return AgentRunResult.Stop(runId, AgentStage.SkippedSessionUnavailable, session.ErrorCode);
                }
                Log(runId, AgentStage.SessionValidated);

                // ---- G1: identidade do NexAdmin + comparacao de sessao
                // (F6.13.2 correcao - agora inteiramente em INexWindowInspector) ----
                var locate = _nexWindowInspector.LocateNexAdmin(session.AgentSessionId!.Value);
                if (!locate.Passed)
                {
                    var stage = locate.ErrorCode == AgentErrorCode.NexNotFound
                        ? AgentStage.NexNotFound
                        : AgentStage.SkippedSessionUnavailable;
                    Log(runId, stage, locate.ErrorCode);
                    return AgentRunResult.Stop(runId, stage, locate.ErrorCode);
                }
                Log(runId, AgentStage.NexValidated);

                var target = locate.Identity!;

                // ---- G3-G6: topologia segura (janela unica, Vendas,
                // Historico visivel, nenhum modal financeiro) - recebe a
                // MESMA identidade ja localizada, nunca procura "algum
                // NexAdmin" de novo por conta propria (F6.13.4) ----
                var safeState = _nexWindowInspector.CheckSafeState(target);
                if (!safeState.Passed)
                {
                    // Hybrid V3 - observabilidade minima: safeState.Reason ja
                    // carrega o motivo especifico (qual gate G3-G6 falhou,
                    // ex.: "aba 'Vendas' nao encontrada", "janela top-level
                    // nao reconhecida") - antes descartado silenciosamente
                    // aqui (unico call-site de UnsafeState que ainda nao
                    // repassava reason). Nenhuma mudanca de decisao/gate.
                    Log(runId, AgentStage.UnsafeState, safeState.ErrorCode, reason: safeState.Reason);
                    return AgentRunResult.Stop(runId, AgentStage.UnsafeState, safeState.ErrorCode);
                }
                Log(runId, AgentStage.SafeStateValidated);

                // ---- G13: EXPORT_STAGE obrigatoriamente vazia ANTES de
                // qualquer acao real (inclusive antes do Shift+F5) -
                // fail-closed, nunca apagado automaticamente. Mesma regra ja
                // homologada nos probes reais (F6.14B2.9A). ----
                var emptyCheck = _exportStageWatcher.ConfirmEmptyBeforeAction(_exportStagePath);
                if (!emptyCheck.Passed)
                {
                    Log(runId, AgentStage.Failed, emptyCheck.ErrorCode);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, emptyCheck.ErrorCode);
                }

                // ==================================================
                // A PARTIR DAQUI: G1-G7+G13 = PASS confirmado. Autorizado
                // exatamente 1 SendExportShortcut(), dirigido a MESMA
                // `target` ja validada acima (nunca recalculada). Nenhum
                // caminho de codigo abaixo pode chamar isto uma segunda vez.
                // ==================================================
                try
                {
                    _inputSender.SendExportShortcut(target);
                }
                catch (NotForegroundException ex)
                {
                    // Modo scheduled-safe (WindowsScheduledSafeInputSender):
                    // NexAdmin nao esta em primeiro plano - resultado
                    // ESPERADO num polling recorrente, nunca um Failed. O
                    // sender manual (WindowsInputSender) nunca lanca este
                    // tipo, entao este catch nunca dispara para o modo
                    // homologado --run-once-operational.
                    TryLog(runId, AgentStage.SkippedNotForeground, AgentErrorCode.NotForeground, reason: ex.Message);
                    return AgentRunResult.Stop(runId, AgentStage.SkippedNotForeground, AgentErrorCode.NotForeground);
                }
                catch (BackgroundSafeSkipException ex)
                {
                    // Modo scheduled-background-safe (WindowsBackgroundExportTrigger,
                    // Scheduler V2): um gate de ESTADO OPERACIONAL SEGURO
                    // verificado ANTES do WM_COMMAND nao foi satisfeito (NEX
                    // em foreground, abridor nao identificado, "Todas
                    // vendas" nao confirmado) - resultado ESPERADO num
                    // polling recorrente, reaproveita AgentStage.UnsafeState
                    // (decisao de design homologada: nunca um novo valor de
                    // enum so para isto), nunca um Failed. Nenhum outro
                    // IInputSender lanca este tipo - este catch nunca
                    // dispara para --run-once-operational/--run-once-scheduled-safe.
                    TryLog(runId, AgentStage.UnsafeState, AgentErrorCode.UnsafeState, reason: ex.Message);
                    return AgentRunResult.Stop(runId, AgentStage.UnsafeState, AgentErrorCode.UnsafeState);
                }
                catch (Exception ex)
                {
                    // F6.13.3: TryLog (nao Log) - estamos DENTRO de um catch;
                    // se o logger tambem estiver quebrado, essa segunda falha
                    // NUNCA pode escapar e mascarar o resultado FAILED real.
                    TryLog(runId, AgentStage.Failed, AgentErrorCode.UnexpectedException, reason: ex.Message);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, AgentErrorCode.UnexpectedException);
                }
                Log(runId, AgentStage.ExportTriggered);

                // ---- G8+G9: identidade do dialogo + controles - recebe a
                // MESMA target ja validada, nunca redescoberta (F6.14B2).
                // F6.14B2.4: usa WaitForSaveDialog (polling read-only
                // bounded) em vez de uma unica checagem instantanea, pois a
                // criacao da janela pelo Windows e assincrona em relacao ao
                // Shift+F5 (evidencia real: race de tempo confirmada em
                // F6.14B2.3). Isto NAO e retry de acao - SendExportShortcut
                // ja foi chamado exatamente 1 vez, acima, e nao e chamado
                // de novo em nenhuma iteracao do wait. ----
                var identity = _saveDialogWaiter.WaitForSaveDialog(target);
                if (!identity.Passed)
                {
                    // NUNCA uma segunda chamada a SendExportShortcut() -
                    // nao ha aresta de volta a ExportTriggered.
                    Log(runId, AgentStage.Failed, identity.ErrorCode);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, identity.ErrorCode);
                }
                Log(runId, AgentStage.SaveDialogIdentified);
                Log(runId, AgentStage.SaveControlsValidated, fileName: null);

                var dialog = identity.Dialog!;

                // ---- Configuracao (escrita, ainda NAO confiada) ----
                var fileName = FileNaming.GerarNomeArquivoVendas(_clock);
                _saveDialogController.Configure(dialog, _exportStagePath, fileName, _expectedFileType);
                Log(runId, AgentStage.SaveDialogConfigured, fileName: fileName);

                // ---- G10-G12: releitura (nunca reaproveita o valor escrito) ----
                var readback = _saveDialogInspector.ReadBack(dialog, _exportStagePath, fileName, _expectedFileType);
                if (!readback.Passed)
                {
                    // Fail-closed: NUNCA ClickSave() sem readback positivo.
                    Log(runId, AgentStage.Failed, readback.ErrorCode);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, readback.ErrorCode);
                }
                Log(runId, AgentStage.SaveDialogReadbackValidated, fileName: fileName);

                // ==================================================
                // A PARTIR DAQUI: G8-G12 = PASS confirmado. Autorizado
                // exatamente 1 CommitOnce() (F6.14B2.12C1) - NUNCA
                // ISaveDialogController.ClickSave() generico, que permanece
                // bloqueado (NotSupportedException) permanentemente.
                // CommitOnce() reidentifica o dialogo do zero e exige o
                // MESMO HWND antes de despachar BM_CLICK - Dispatched=true
                // significa somente "clique despachado", nunca "arquivo
                // salvo" (essa prova continua vindo do IExportStageWatcher
                // logo abaixo).
                // ==================================================
                var commit = _saveDialogCommitter.CommitOnce(target, dialog);
                if (!commit.Dispatched)
                {
                    Log(runId, AgentStage.Failed, commit.ErrorCode, fileName: fileName);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, commit.ErrorCode);
                }
                Log(runId, AgentStage.FileSaveTriggered, fileName: fileName);

                var stagedFilePath = Path.Combine(_exportStagePath, fileName);

                // ---- Estabilidade: mesmo componente real ja homologado nos
                // probes (F6.14B2.9F) - unico arquivo esperado, tolera
                // SOMENTE o transitorio <basename>.csv, fail-closed para
                // qualquer outro nome/quantidade. ----
                var stability = _exportStageWatcher.WaitForExpectedFileOnly(_exportStagePath, fileName, _watcherTimeout);
                if (!stability.Passed)
                {
                    Log(runId, AgentStage.Failed, stability.ErrorCode, fileName: fileName);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, stability.ErrorCode);
                }
                Log(runId, AgentStage.FileStable, fileName: fileName);

                // ---- Reader como gate (F6.12 secao 12/13) ----
                var validation = _exportValidator.Validate(stagedFilePath);
                if (!validation.Valid || validation.RecordCount == 0)
                {
                    var code = validation.Valid ? AgentErrorCode.ReaderRejected : validation.ErrorCode;
                    Log(runId, AgentStage.Failed, code, fileName: fileName);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, code);
                }
                Log(runId, AgentStage.ReaderValidated, fileName: fileName);

                // ---- Publicacao atomica ----
                var publish = _atomicPublisher.Publish(stagedFilePath, _exportadosPath);
                if (!publish.Published)
                {
                    Log(runId, AgentStage.Failed, publish.ErrorCode, fileName: fileName);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, publish.ErrorCode);
                }
                Log(runId, AgentStage.Published, fileName: fileName);
                Log(runId, AgentStage.Success, fileName: fileName);

                return AgentRunResult.Ok(runId, publish.DestinationPath!);
            }
            finally
            {
                _lock.Release();
            }
        }
        catch (Exception ex)
        {
            // F6.13.3: este e o catch mais externo de Run() - se o logger
            // tambem falhar aqui (ex.: falha em TODAS as chamadas, nao so na
            // primeira), TryLog garante que essa segunda excecao NUNCA
            // escape sem retornar um AgentRunResult. O tratamento de uma
            // excecao nunca pode depender de uma segunda chamada
            // desprotegida ao mesmo componente que acabou de falhar.
            TryLog(runId, AgentStage.Failed, AgentErrorCode.UnexpectedException, reason: ex.Message);
            return AgentRunResult.Stop(runId, AgentStage.Failed, AgentErrorCode.UnexpectedException);
        }
    }

    private void Log(Guid runId, AgentStage stage, AgentErrorCode? errorCode = null, string? fileName = null, string? reason = null)
    {
        var errorCodeText = errorCode is null or AgentErrorCode.None ? null : errorCode.ToString();
        _logger.Log(new AgentLogEvent(_clock.Now, runId, stage.ToString(), errorCodeText, fileName, reason));
    }

    /// <summary>Variante segura de Log() para uso EXCLUSIVO dentro de blocos
    /// catch (F6.13.3): garante que uma falha do logger durante o proprio
    /// tratamento de uma excecao/falha nunca escale para uma segunda
    /// excecao nao tratada. Nao usar no caminho normal (fora de catch) -
    /// la, uma falha do logger deve continuar propagando ate o catch mais
    /// externo, que e o unico lugar onde "fail-closed sem UI" e garantido
    /// (nenhuma acao de UI ocorre antes desse catch decidir o resultado).</summary>
    private void TryLog(Guid runId, AgentStage stage, AgentErrorCode? errorCode = null, string? fileName = null, string? reason = null)
    {
        try
        {
            Log(runId, stage, errorCode, fileName, reason);
        }
        catch
        {
            // Intencional: nunca deixar uma falha do logger, ao tentar
            // registrar um FAILED que ja esta sendo retornado, mascarar
            // esse retorno com uma excecao nao tratada.
        }
    }
}

// NOTA DE MAPEAMENTO (F6.12.1 -> implementacao, corrigida em F6.13.2 e F6.13.4):
// G2 (sessao do proprio Agent, WTSActive) e verificado por
// ISessionInspector.CheckSession() SEM NUNCA tocar o NexAdmin - retorna
// somente o SessionId do Agent. G1 (identidade do NexAdmin: processo,
// ClassName TfrmPri) + a parte de G2 que compara com o NexAdmin
// encontrado sao verificados por INexWindowInspector.LocateNexAdmin(),
// que recebe o SessionId ja validado e so retorna Passed=true (com a
// NexAdminWindowIdentity - PID+HWND, F6.13.4) quando o processo existe,
// tem a identidade certa E esta na mesma sessao. Essa MESMA identidade
// (variavel `target`) flui sem ser recalculada ate CheckSafeState() e ate
// IInputSender.SendExportShortcut() - nunca uma segunda busca "por acaso"
// por "algum NexAdmin". Isso corrige a mistura de responsabilidade
// identificada em F6.13.1 (ISessionInspector antes resolvia identidade do NexAdmin, que
// conceitualmente pertence a INexWindowInspector). G3 (janela unica) e
// G6 (nenhum modal financeiro) sao, na pratica, a MESMA checagem (mais
// de 1 janela top-level = modal presente) - por isso INexWindowInspector
// as combina em um unico metodo CheckSafeState(), correspondendo ao
// estagio SAFE_STATE_VALIDATED. Este ultimo continua uma simplificacao
// aceita (nao uma mistura de responsabilidade), pois ambas pertencem
// legitimamente ao mesmo inspector.
