using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Logging;

namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Orquestrador do fluxo V1 de extrato individual por cliente. Mesma
/// disciplina de ExportAgentOrchestrator (maquina de estados sem
/// nenhuma aresta de retorno, nenhuma acao mutante repetida) - arquivo
/// NOVO e completamente separado, NUNCA modifica ExportAgentOrchestrator
/// nem o pipeline de Vendas. Reaproveita 100% os componentes genericos
/// ja homologados (lock, sessao, save dialog, watcher, validator,
/// publisher) e troca apenas o disparo (IInputSender/Shift+F5) pelos
/// componentes NOVOS de navegacao por cliente (INexClientNavigator,
/// INexOverflowMenuOpener, INexExportTrigger).
///
/// NUNCA referencia Base44/Supabase/qualquer operacao financeira -
/// termina exclusivamente na publicacao do .xls validado em EXPORTADOS,
/// mesma fronteira EXPORT-FIRST do pipeline de Vendas.
/// </summary>
public sealed class IndividualStatementExportOrchestrator
{
    private readonly IExecutionLock _lock;
    private readonly ISessionInspector _sessionInspector;
    private readonly INexWindowInspector _nexWindowInspector;
    private readonly INexClientNavigator _clientNavigator;
    private readonly INexOverflowMenuOpener _overflowMenuOpener;
    private readonly INexExportTrigger _exportTrigger;
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

    public IndividualStatementExportOrchestrator(
        IExecutionLock @lock,
        ISessionInspector sessionInspector,
        INexWindowInspector nexWindowInspector,
        INexClientNavigator clientNavigator,
        INexOverflowMenuOpener overflowMenuOpener,
        INexExportTrigger exportTrigger,
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
        _clientNavigator = clientNavigator;
        _overflowMenuOpener = overflowMenuOpener;
        _exportTrigger = exportTrigger;
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

    public AgentRunResult Run(ClientNavigationTarget navigationTarget)
    {
        var runId = Guid.NewGuid();

        try
        {
            Log(runId, AgentStage.Start);

            if (!_lock.TryAcquire())
            {
                Log(runId, AgentStage.SkippedBusy, AgentErrorCode.LockBusy);
                return AgentRunResult.Stop(runId, AgentStage.SkippedBusy, AgentErrorCode.LockBusy);
            }

            try
            {
                Log(runId, AgentStage.LockAcquired);

                var session = _sessionInspector.CheckSession();
                if (!session.Passed)
                {
                    Log(runId, AgentStage.SkippedSessionUnavailable, session.ErrorCode);
                    return AgentRunResult.Stop(runId, AgentStage.SkippedSessionUnavailable, session.ErrorCode);
                }
                Log(runId, AgentStage.SessionValidated);

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

                // ---- Variante do fluxo de cliente: NAO exige Vendas/Historico ----
                var safeState = _nexWindowInspector.CheckSafeStateForClientNavigation(target);
                if (!safeState.Passed)
                {
                    Log(runId, AgentStage.UnsafeState, safeState.ErrorCode);
                    return AgentRunResult.Stop(runId, AgentStage.UnsafeState, safeState.ErrorCode);
                }
                Log(runId, AgentStage.SafeStateValidated);

                var emptyCheck = _exportStageWatcher.ConfirmEmptyBeforeAction(_exportStagePath);
                if (!emptyCheck.Passed)
                {
                    Log(runId, AgentStage.Failed, emptyCheck.ErrorCode);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, emptyCheck.ErrorCode);
                }

                // ==================================================
                // A PARTIR DAQUI: G1-G7(variante)+StageEmpty = PASS. Autorizado
                // exatamente 1 OpenClientByCode() (que internamente ja e'
                // fail-closed/sem-retry no F2), dirigido a MESMA `target`.
                // ==================================================
                var clientOpen = _clientNavigator.OpenClientByCode(target, navigationTarget);
                if (!clientOpen.Passed)
                {
                    Log(runId, AgentStage.Failed, clientOpen.ErrorCode);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, clientOpen.ErrorCode);
                }
                Log(runId, AgentStage.ClientOpened);

                var client = clientOpen.Client!;

                var tabResult = _clientNavigator.OpenTransactionsTab(target, client);
                if (!tabResult.Passed)
                {
                    Log(runId, AgentStage.Failed, tabResult.ErrorCode);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, tabResult.ErrorCode);
                }
                Log(runId, AgentStage.TransactionsTabActive);

                var overflow = _overflowMenuOpener.OpenOverflowMenu(target, client);
                if (!overflow.Passed)
                {
                    Log(runId, AgentStage.Failed, overflow.ErrorCode, reason: overflow.Reason);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, overflow.ErrorCode);
                }
                Log(runId, AgentStage.OverflowMenuOpened);

                var exportTrigger = _exportTrigger.TriggerExport(target, overflow);
                if (!exportTrigger.Dispatched)
                {
                    Log(runId, AgentStage.Failed, exportTrigger.ErrorCode, reason: exportTrigger.Reason);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, exportTrigger.ErrorCode);
                }
                Log(runId, AgentStage.ExportTriggered);

                // ---- Daqui em diante, pipeline de Save Dialog 100% reaproveitado ----
                var identity = _saveDialogWaiter.WaitForSaveDialog(target);
                if (!identity.Passed)
                {
                    Log(runId, AgentStage.Failed, identity.ErrorCode);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, identity.ErrorCode);
                }
                Log(runId, AgentStage.SaveDialogIdentified);
                Log(runId, AgentStage.SaveControlsValidated, fileName: null);

                var dialog = identity.Dialog!;

                var fileName = FileNaming.GerarNomeArquivoExtratoIndividual(navigationTarget.ClientCode, _clock);
                _saveDialogController.Configure(dialog, _exportStagePath, fileName, _expectedFileType);
                Log(runId, AgentStage.SaveDialogConfigured, fileName: fileName);

                var readback = _saveDialogInspector.ReadBack(dialog, _exportStagePath, fileName, _expectedFileType);
                if (!readback.Passed)
                {
                    Log(runId, AgentStage.Failed, readback.ErrorCode);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, readback.ErrorCode);
                }
                Log(runId, AgentStage.SaveDialogReadbackValidated, fileName: fileName);

                var commit = _saveDialogCommitter.CommitOnce(target, dialog);
                if (!commit.Dispatched)
                {
                    Log(runId, AgentStage.Failed, commit.ErrorCode, fileName: fileName);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, commit.ErrorCode);
                }
                Log(runId, AgentStage.FileSaveTriggered, fileName: fileName);

                var stagedFilePath = Path.Combine(_exportStagePath, fileName);

                var stability = _exportStageWatcher.WaitForExpectedFileOnly(_exportStagePath, fileName, _watcherTimeout);
                if (!stability.Passed)
                {
                    Log(runId, AgentStage.Failed, stability.ErrorCode, fileName: fileName);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, stability.ErrorCode);
                }
                Log(runId, AgentStage.FileStable, fileName: fileName);

                var validation = _exportValidator.Validate(stagedFilePath);
                // RecordCount > 0 e' um gate ADICIONAL explicito deste
                // fluxo (V1): mesmo um XLS estruturalmente valido (colunas
                // corretas) mas com 0 transacoes nunca e' publicado.
                if (!validation.Valid || validation.RecordCount == 0)
                {
                    var code = !validation.Valid ? validation.ErrorCode : AgentErrorCode.ZeroRecords;
                    Log(runId, AgentStage.Failed, code, fileName: fileName);
                    return AgentRunResult.Stop(runId, AgentStage.Failed, code);
                }
                Log(runId, AgentStage.ReaderValidated, fileName: fileName);

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
            TryLog(runId, AgentStage.Failed, AgentErrorCode.UnexpectedException, reason: ex.Message);
            return AgentRunResult.Stop(runId, AgentStage.Failed, AgentErrorCode.UnexpectedException);
        }
    }

    private void Log(Guid runId, AgentStage stage, AgentErrorCode? errorCode = null, string? fileName = null, string? reason = null)
    {
        var errorCodeText = errorCode is null or AgentErrorCode.None ? null : errorCode.ToString();
        _logger.Log(new AgentLogEvent(_clock.Now, runId, stage.ToString(), errorCodeText, fileName, reason));
    }

    private void TryLog(Guid runId, AgentStage stage, AgentErrorCode? errorCode = null, string? fileName = null, string? reason = null)
    {
        try
        {
            Log(runId, stage, errorCode, fileName, reason);
        }
        catch
        {
            // Intencional - mesma disciplina de ExportAgentOrchestrator.
        }
    }
}
