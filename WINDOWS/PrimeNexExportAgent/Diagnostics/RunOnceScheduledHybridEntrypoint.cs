using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Logging;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.WindowsInput;
using PrimeNexExportAgent.WindowsNative;
using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// Hybrid V3 - resultado do ciclo completo (classificacao + eventual
/// execucao do orchestrator). `AgentResult` e' null quando o ciclo parou
/// ANTES do orchestrator (Closed/Minimized/BlockingUnknown) - nesses
/// casos `State` + `Reason` sao a UNICA fonte de verdade do resultado.</summary>
public sealed record HybridRunResult(Guid RunId, NexRuntimeState State, AgentRunResult? AgentResult, string Reason);

/// <summary>
/// ENTRYPOINT do modo Hybrid V3 (--run-once-scheduled-hybrid). NAO
/// redesenha V1/V2 - COMPOE os dois mecanismos ja homologados
/// (WindowsScheduledSafeInputSender / WindowsBackgroundExportTrigger) via
/// HybridInputSender, e adiciona uma classificacao PRE-orchestrator
/// (INexRuntimeStateProbe) para distinguir Minimized/Closed/BlockingUnknown
/// - estados que INexWindowInspector.LocateNexAdmin colapsaria no mesmo
/// NexNotFound.
///
/// V1 standalone (--run-once-scheduled-safe) e V2 standalone
/// (--run-once-scheduled-background-safe) continuam existindo, intocados,
/// para rollback/diagnostico - nenhuma linha de
/// WindowsScheduledSafeInputSender/WindowsBackgroundExportTrigger/
/// Win32InputNativeApi/Win32BackgroundClickNativeApi e alterada por este
/// arquivo.
/// </summary>
internal static class RunOnceScheduledHybridEntrypoint
{
    internal const string ProductionMutexName = RunOnceOperationalEntrypoint.ProductionMutexName;
    internal const string ExportStagePath = RunOnceOperationalEntrypoint.ExportStagePath;
    internal const string ExportadosPath = RunOnceOperationalEntrypoint.ExportadosPath;
    private const string ExpectedFileType = "Excel";

    /// <summary>Comparacao EXATA - nunca StartsWith/Contains/prefix
    /// matching. Mesmo padrao de IsScheduledSafeFlag/IsScheduledBackgroundSafeFlag.</summary>
    public static bool IsScheduledHybridFlag(string[] args) =>
        args.Length == 1 && args[0] == "--run-once-scheduled-hybrid";

    /// <summary>
    /// Nucleo testavel (F6.12-style): recebe TODAS as dependencias por
    /// parametro, nunca constroi Win32 real diretamente. `buildOrchestrator`
    /// so' e' invocado quando a classificacao for NexRuntimeState.Open -
    /// Closed/Minimized/BlockingUnknown NUNCA constroem nem executam o
    /// orchestrator (zero V1, zero V2, zero input em qualquer um desses
    /// 3 casos).
    /// </summary>
    internal static HybridRunResult RunCore(
        INexRuntimeStateProbe probe,
        Func<MutationWitness, ExportAgentOrchestrator> buildOrchestrator,
        IHybridAlertSounds sounds,
        IAgentLogger logger,
        IClock clock)
    {
        var runId = Guid.NewGuid();
        var classification = probe.Classify();

        switch (classification.State)
        {
            case NexRuntimeState.Closed:
                TryLog(logger, clock, runId, "NEX_CLOSED", classification.Reason);
                // Silencioso por design (mesma justificativa de SUCCESS: NEX
                // fechado fora do expediente e' o estado mais frequente e
                // esperado - alarme aqui viraria ruido).
                return new HybridRunResult(runId, NexRuntimeState.Closed, null, classification.Reason);

            case NexRuntimeState.Minimized:
                TryLog(logger, clock, runId, "NEX_MINIMIZED", classification.Reason);
                sounds.PlayMinimizedWarning();
                return new HybridRunResult(runId, NexRuntimeState.Minimized, null, classification.Reason);

            case NexRuntimeState.BlockingUnknown:
                TryLog(logger, clock, runId, "NEX_BLOCKING_UNKNOWN", classification.Reason);
                // Silencioso + fail-closed - nenhuma tentativa otimista.
                return new HybridRunResult(runId, NexRuntimeState.BlockingUnknown, null, classification.Reason);

            case NexRuntimeState.Open:
            default:
                var witness = new MutationWitness();
                var orchestrator = buildOrchestrator(witness);
                var agentResult = orchestrator.Run();

                // TECHNICAL_FAILURE: 3 beeps SOMENTE se Failed E a primeira
                // acao mutavel real (SendShiftF5/WM_COMMAND) chegou a ser
                // tentada. Failed sem mutacao tentada (ex.: gate T1/T2 do
                // V1, ou G13 EXPORT_STAGE nao vazio) fica silencioso - nunca
                // alarme forte para algo que nao chegou a mexer em nada.
                // SUCCESS permanece silencioso por padrao (Task roda a cada
                // ~5min - beep a cada ciclo bem-sucedido viraria ruido).
                if (agentResult.FinalStage == AgentStage.Failed && witness.MutationAttempted)
                {
                    sounds.PlayTechnicalFailureAfterAction();
                }

                return new HybridRunResult(runId, NexRuntimeState.Open, agentResult, classification.Reason);
        }
    }

    private static void TryLog(IAgentLogger logger, IClock clock, Guid runId, string stage, string reason)
    {
        try
        {
            logger.Log(new AgentLogEvent(clock.Now, runId, stage, reason: reason));
        }
        catch
        {
            // Mesma disciplina de ExportAgentOrchestrator.TryLog - uma
            // falha do logger aqui nunca pode escalar/mascarar o resultado
            // ja decidido.
        }
    }

    /// <summary>Mapeamento de exit code: Closed/Minimized/BlockingUnknown
    /// sao resultados ESPERADOS e frequentes num polling recorrente - exit
    /// 0. Quando o orchestrator chegou a rodar (Open), reaproveita
    /// EXATAMENTE o mesmo mapeamento ja homologado de
    /// RunOnceScheduledSafeEntrypoint.MapExitCode (Success/Skipped*/
    /// NexNotFound/UnsafeState -> 0, qualquer outro Failed -> 1).</summary>
    internal static int MapExitCode(HybridRunResult result) => result.State switch
    {
        NexRuntimeState.Closed => 0,
        NexRuntimeState.Minimized => 0,
        NexRuntimeState.BlockingUnknown => 0,
        NexRuntimeState.Open => RunOnceScheduledSafeEntrypoint.MapExitCode(result.AgentResult!),
        _ => 1,
    };

    /// <summary>
    /// Composicao REAL (producao) - MESMOS componentes de
    /// RunOnceScheduledSafeEntrypoint/RunOnceScheduledBackgroundSafeEntrypoint,
    /// exceto pelo IInputSender: HybridInputSender delegando para as
    /// MESMAS classes homologadas (WindowsScheduledSafeInputSender/
    /// WindowsBackgroundExportTrigger), com as APIs nativas de mutacao
    /// (SendShiftF5/WM_COMMAND) envolvidas pelos decorators de
    /// MutationWitness - Win32InputNativeApi/Win32BackgroundClickNativeApi
    /// em si NUNCA sao alterados.
    /// </summary>
    private static ExportAgentOrchestrator BuildOrchestrator(MutationWitness witness)
    {
        var clock = new SystemClock();
        var delay = new ThreadSleepDelay();
        var nativeWindows = new Win32NativeWindowApi();
        var controlApi = new Win32SaveDialogControlApi();

        var executionLock = new Win32ExecutionLock(ProductionMutexName);
        var sessionInspector = new WindowsSessionInspector(new Win32SessionNativeApi());
        var windowInspector = new WindowsNexWindowInspector(new Win32NexProcessScanner(), nativeWindows, new UiAutomationNexReader());

        var inputNative = new Win32InputNativeApi();
        var witnessedInputNative = new WitnessingInputNativeApi(inputNative, inputNative, witness);
        var foregroundSender = new WindowsScheduledSafeInputSender(nativeWindows, witnessedInputNative, witnessedInputNative);

        var hitTest = new Win32OverflowHitTestNativeApi();
        var msaa = new Win32MsaaAccessibilityApi();
        var backgroundClick = new Win32BackgroundClickNativeApi();
        var witnessedBackgroundClick = new WitnessingBackgroundClickNativeApi(backgroundClick, witness);
        var backgroundSender = new WindowsBackgroundExportTrigger(nativeWindows, hitTest, msaa, witnessedBackgroundClick, witnessedInputNative, delay, clock);

        var inputSender = new HybridInputSender(nativeWindows, witnessedInputNative, foregroundSender, backgroundSender);

        var saveDialogInspector = new WindowsSaveDialogInspector(nativeWindows, controlApi);
        var saveDialogController = new WindowsSaveDialogController(nativeWindows, controlApi);
        var saveDialogWaiter = new PollingSaveDialogWaiter(saveDialogInspector, delay, clock);
        var saveDialogCommitter = new WindowsConfirmedSaveDialogCommitter(saveDialogInspector, controlApi, nativeWindows);

        var exportStageWatcher = new PollingExportStageWatcher(delay, clock);

        var processRunner = new Win32ProcessRunner();
        var cliScriptPath = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "SCRIPTS", "validar-export-vendas.js"));
        var exportValidator = new NodeExportValidator(processRunner, cliScriptPath);

        var fileMover = new Win32FileMover();
        var atomicPublisher = new FileMoveAtomicPublisher(fileMover, ExportStagePath, ExportadosPath);

        var logger = new ConsoleAgentLogger();

        return new ExportAgentOrchestrator(
            executionLock,
            sessionInspector,
            windowInspector,
            inputSender,
            saveDialogWaiter,
            saveDialogInspector,
            saveDialogController,
            saveDialogCommitter,
            exportStageWatcher,
            exportValidator,
            atomicPublisher,
            logger,
            clock,
            ExportStagePath,
            ExportadosPath,
            ExpectedFileType);
    }

    /// <summary>
    /// UNICO metodo desta classe que efetivamente executa contra o NEX
    /// real - so' alcancavel por Program.cs, exclusivamente quando
    /// IsScheduledHybridFlag(args) for verdadeiro. NAO chamado por nenhum
    /// teste desta tarefa.
    /// </summary>
    public static void Run()
    {
        var probe = new Win32NexRuntimeStateProbe(new Win32NexProcessScanner(), new Win32NativeWindowApi());
        var sounds = new WindowsHybridAlertSounds();
        var logger = new ConsoleAgentLogger();
        var clock = new SystemClock();

        var result = RunCore(probe, BuildOrchestrator, sounds, logger, clock);
        Environment.ExitCode = MapExitCode(result);
    }
}
