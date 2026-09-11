using System.IO;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.WindowsInput;
using PrimeNexExportAgent.WindowsNative;
using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// ENTRYPOINT OPERACIONAL REAL do modo scheduled-safe, destinado a
/// invocacao recorrente via Task Scheduler (--run-once-scheduled-safe).
/// Espelha RunOnceOperationalEntrypoint - MESMA composicao, MESMOS
/// gates, MESMO ExportAgentOrchestrator (nenhuma maquina de estados
/// duplicada) - a UNICA diferenca e' o IInputSender injetado:
/// WindowsScheduledSafeInputSender em vez de WindowsInputSender, que nunca
/// forca foreground (ver WindowsScheduledSafeInputSender.cs).
///
/// So alcancavel via o argumento EXATO "--run-once-scheduled-safe"
/// (Program.cs), nunca por prefixo/substring/env var - mesmo padrao de
/// RunOnceOperationalEntrypoint.
///
/// Mapeamento de exit code (Run()) e' DELIBERADAMENTE diferente do modo
/// manual: SkippedNotForeground/SkippedBusy/SkippedSessionUnavailable/
/// NexNotFound/UnsafeState sao resultados ESPERADOS e frequentes num
/// polling de poucos minutos - tratados como exit 0 (sucesso operacional
/// do PONTO DE VISTA do Task Scheduler: "nada quebrado, so nao era a hora
/// certa"), reservando exit code nao-zero estritamente para falhas reais
/// (Failed e qualquer AgentErrorCode que nao seja um dos SKIPPED_*/
/// Success). Isso NAO altera o mapeamento do modo manual
/// (RunOnceOperationalEntrypoint continua usando Success ? 0 : 1).
/// </summary>
internal static class RunOnceScheduledSafeEntrypoint
{
    internal const string ProductionMutexName = RunOnceOperationalEntrypoint.ProductionMutexName;
    internal const string ExportStagePath = RunOnceOperationalEntrypoint.ExportStagePath;
    internal const string ExportadosPath = RunOnceOperationalEntrypoint.ExportadosPath;
    private const string ExpectedFileType = "Excel";

    /// <summary>Comparacao EXATA - nunca StartsWith/Contains/prefix
    /// matching. Mesmo padrao de RunOnceOperationalEntrypoint.IsOperationalFlag.</summary>
    public static bool IsScheduledSafeFlag(string[] args) =>
        args.Length == 1 && args[0] == "--run-once-scheduled-safe";

    /// <summary>
    /// Constroi o ExportAgentOrchestrator com as MESMAS implementacoes
    /// reais de RunOnceOperationalEntrypoint.BuildOrchestrator(), exceto
    /// pelo IInputSender: WindowsScheduledSafeInputSender em vez de
    /// WindowsInputSender. Puramente composicao - NUNCA chama .Run() aqui,
    /// mesma seguranca para testes offline ja documentada no entrypoint
    /// manual.
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
        // NUNCA WindowsInputSender/PollingForegroundWaiter aqui - o modo
        // scheduled-safe nunca forca foreground (ver
        // WindowsScheduledSafeInputSender.cs). Win32InputNativeApi ja
        // implementa IForegroundReader (mesma classe reaproveitada pelo
        // modo manual para a leitura, nunca para a escrita de foreground).
        var inputSender = new WindowsScheduledSafeInputSender(nativeWindows, inputNative, inputNative);

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

    /// <summary>Mapeamento explicito e testavel de AgentStage para exit
    /// code - nunca `result.Success ? 0 : 1` (isso trataria todo
    /// SKIPPED_* como falha, poluindo o historico do Task Scheduler a cada
    /// ciclo ocioso). Success e todo terminal SKIPPED_*/estado-esperado
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
    /// IsScheduledSafeFlag(args) for verdadeiro. NAO chamado por nenhum
    /// teste desta tarefa.
    /// </summary>
    public static void Run()
    {
        var orchestrator = BuildOrchestrator();
        var result = orchestrator.Run();
        Environment.ExitCode = MapExitCode(result);
    }
}
