using System.IO;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.WindowsInput;
using PrimeNexExportAgent.WindowsNative;
using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// F6.14B2.12E - ENTRYPOINT OPERACIONAL REAL, unico ponto do projeto que
/// pode conduzir uma execucao completa gates-&gt;Shift+F5-&gt;SaveDialog-&gt;
/// CommitOnce-&gt;Watcher-&gt;Validate-&gt;Publish-&gt;EXPORTADOS. So alcancavel via o
/// argumento EXATO "--run-once-operational" (Program.cs), nunca por
/// prefixo/substring/env var. AINDA NAO EXECUTADO em producao - esta
/// classe existe para permitir a COMPOSICAO ser testada offline (via
/// BuildOrchestrator(), que apenas constroi objetos reais - nenhum deles
/// faz I/O no construtor exceto Win32ExecutionLock, que so cria um
/// kernel Mutex nomeado, nunca toca NEX/filesystem/rede) sem jamais
/// chamar Run() contra o NEX real dentro de um teste automatizado.
///
/// UMA execucao -&gt; termina o processo. Nenhuma automacao recorrente
/// (Task Scheduler/Startup/loop/timer) e criada aqui - isso fica para uma
/// fase futura, depois do primeiro go-live supervisionado.
///
/// Downstream (DetectorExportsNex/BootstrapIntegracaoNex/outbox/checkpoint/
/// repositorio-eventos-http/Base44/HTTP) permanece INTEIRAMENTE fora do
/// escopo deste Agent - o trabalho termina em Publish() para EXPORTADOS.
/// Nenhum secret de downstream (NEX_PRIME_ENDPOINT/NEX_PRIME_INTEGRATION_SECRET)
/// e' lido por este processo.
/// </summary>
internal static class RunOnceOperationalEntrypoint
{
    /// <summary>Nome final de producao do Mutex (F6.14B2.12D), determinado
    /// pela arquitetura real: o proprio gate de sessao (LocateNexAdmin)
    /// ja torna interferencia cross-session estruturalmente impossivel -
    /// o Mutex so precisa cobrir duas instancias na MESMA sessao
    /// interativa, por isso o escopo minimo suficiente e' `Local\`, nunca
    /// `Global\` (privilegio maior que o necessario).</summary>
    internal const string ProductionMutexName = @"Local\PrimeNexExportAgent.Lock";

    internal const string ExportStagePath = @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE";
    internal const string ExportadosPath = @"C:\Nex\PrimeIntegracaoNex\EXPORTADOS";
    private const string ExpectedFileType = "Excel";

    /// <summary>Comparacao EXATA - nunca StartsWith/Contains/prefix
    /// matching. Um segundo argumento, ou qualquer variacao de
    /// maiusculas/minusculas, NUNCA arma o modo operacional.</summary>
    public static bool IsOperationalFlag(string[] args) =>
        args.Length == 1 && args[0] == "--run-once-operational";

    /// <summary>
    /// Constroi o ExportAgentOrchestrator com TODAS as implementacoes
    /// REAIS ja homologadas (nenhum Fake*, nenhum placeholder). Puramente
    /// composicao - NUNCA chama .Run() aqui, entao chamar este metodo em
    /// um teste offline e' seguro (a unica acao real e' a criacao do
    /// Mutex nomeado pelo construtor de Win32ExecutionLock, que nao toca
    /// NEX/filesystem de EXPORT_STAGE-EXPORTADOS/rede).
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
        var foregroundWaiter = new PollingForegroundWaiter(inputNative, delay, clock);
        var inputSender = new WindowsInputSender(nativeWindows, inputNative, foregroundWaiter);

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
    /// real - so alcancavel por Program.cs, exclusivamente quando
    /// IsOperationalFlag(args) for verdadeiro. NAO chamado por nenhum
    /// teste desta tarefa.
    /// </summary>
    public static void Run()
    {
        var orchestrator = BuildOrchestrator();
        var result = orchestrator.Run();
        Environment.ExitCode = result.Success ? 0 : 1;
    }
}
