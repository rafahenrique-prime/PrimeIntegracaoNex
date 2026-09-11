using System.IO;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.WindowsInput;
using PrimeNexExportAgent.WindowsNative;
using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// ENTRYPOINT OPERACIONAL REAL do Scheduler V2
/// (--run-once-scheduled-background-safe), destinado a invocacao
/// recorrente via Task Scheduler EM PARALELO ao V1
/// (--run-once-scheduled-safe, ver RunOnceScheduledSafeEntrypoint.cs -
/// INTOCADO por este arquivo). Espelha RunOnceScheduledSafeEntrypoint -
/// MESMA composicao, MESMOS gates, MESMO ExportAgentOrchestrator, MESMO
/// mutex (ProductionMutexName reaproveitado de
/// RunOnceOperationalEntrypoint - decisao de design homologada: V1 e V2
/// NUNCA podem exportar simultaneamente) - a UNICA diferenca e' o
/// IInputSender injetado: WindowsBackgroundExportTrigger em vez de
/// WindowsScheduledSafeInputSender/WindowsInputSender. Nunca forca
/// foreground - opera com o NexAdmin em BACKGROUND (mecanismo homologado
/// nas Fases B.1.3/B.2/B.3).
///
/// So alcancavel via o argumento EXATO "--run-once-scheduled-background-safe"
/// (Program.cs), nunca por prefixo/substring/env var - mesmo padrao de
/// RunOnceScheduledSafeEntrypoint/RunOnceOperationalEntrypoint.
///
/// Mapeamento de exit code identico ao de RunOnceScheduledSafeEntrypoint:
/// Skipped*/NexNotFound/UnsafeState (inclui o skip novo de
/// BackgroundSafeSkipException, que reaproveita UnsafeState) sao
/// resultados ESPERADOS e frequentes num polling de poucos minutos -
/// exit 0; qualquer outro terminal (Failed) e' exit nao-zero.
/// </summary>
internal static class RunOnceScheduledBackgroundSafeEntrypoint
{
    internal const string ProductionMutexName = RunOnceOperationalEntrypoint.ProductionMutexName;
    internal const string ExportStagePath = RunOnceOperationalEntrypoint.ExportStagePath;
    internal const string ExportadosPath = RunOnceOperationalEntrypoint.ExportadosPath;
    private const string ExpectedFileType = "Excel";

    /// <summary>Comparacao EXATA - nunca StartsWith/Contains/prefix
    /// matching. Mesmo padrao de RunOnceScheduledSafeEntrypoint.IsScheduledSafeFlag.</summary>
    public static bool IsScheduledBackgroundSafeFlag(string[] args) =>
        args.Length == 1 && args[0] == "--run-once-scheduled-background-safe";

    /// <summary>
    /// Constroi o ExportAgentOrchestrator com as MESMAS implementacoes
    /// reais de RunOnceScheduledSafeEntrypoint.BuildOrchestrator(), exceto
    /// pelo IInputSender: WindowsBackgroundExportTrigger em vez de
    /// WindowsScheduledSafeInputSender. Puramente composicao - NUNCA chama
    /// .Run() aqui, mesma seguranca para testes offline ja documentada no
    /// entrypoint V1.
    /// </summary>
    public static ExportAgentOrchestrator BuildOrchestrator()
    {
        var clock = new SystemClock();
        var delay = new ThreadSleepDelay();
        var nativeWindows = new Win32NativeWindowApi();
        var controlApi = new Win32SaveDialogControlApi();

        var executionLock = new Win32ExecutionLock(ProductionMutexName);
        var sessionInspector = new WindowsSessionInspector(new Win32SessionNativeApi());
        var windowInspector = new WindowsNexWindowInspector(new Win32NexProcessScanner(), nativeWindows, new UiAutomationNexReader());

        var inputNative = new Win32InputNativeApi();
        var hitTest = new Win32OverflowHitTestNativeApi();
        var msaa = new Win32MsaaAccessibilityApi();
        var backgroundClick = new Win32BackgroundClickNativeApi();
        // NUNCA WindowsInputSender/WindowsScheduledSafeInputSender aqui -
        // o Scheduler V2 opera inteiramente em background, sem jamais
        // tentar foreground (ver WindowsBackgroundExportTrigger.cs).
        // Win32InputNativeApi ja implementa IForegroundReader (mesma
        // classe reaproveitada pelo V1 para a leitura, nunca para a
        // escrita de foreground).
        var inputSender = new WindowsBackgroundExportTrigger(nativeWindows, hitTest, msaa, backgroundClick, inputNative, delay, clock);

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

    /// <summary>Identico a RunOnceScheduledSafeEntrypoint.MapExitCode -
    /// Success e todo terminal Skipped*/NexNotFound/UnsafeState (inclui o
    /// skip de BackgroundSafeSkipException, que reaproveita UnsafeState)
    /// mapeiam para 0; qualquer outro terminal (falha real) mapeia para
    /// 1.</summary>
    internal static int MapExitCode(AgentRunResult result) => result.FinalStage switch
    {
        AgentStage.Success => 0,
        AgentStage.SkippedNotForeground => 0,
        AgentStage.SkippedBusy => 0,
        AgentStage.SkippedSessionUnavailable => 0,
        AgentStage.NexNotFound => 0,
        AgentStage.UnsafeState => 0,
        _ => 1,
    };

    /// <summary>
    /// UNICO metodo desta classe que efetivamente executa contra o NEX
    /// real - so alcancavel por Program.cs, exclusivamente quando
    /// IsScheduledBackgroundSafeFlag(args) for verdadeiro. NAO chamado por
    /// nenhum teste desta tarefa.
    /// </summary>
    public static void Run()
    {
        var orchestrator = BuildOrchestrator();
        var result = orchestrator.Run();
        Environment.ExitCode = MapExitCode(result);
    }
}
