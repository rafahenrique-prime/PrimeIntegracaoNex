using System.IO;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.WindowsInput;
using PrimeNexExportAgent.WindowsNative;
using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// V1 (extrato individual por cliente) - PROBE SUPERVISIONADO one-shot,
/// mesmo padrao ja homologado de RunOnceOperationalEntrypoint (Vendas):
/// unico ponto do projeto capaz de conduzir uma execucao REAL completa
/// do fluxo Cliente-&gt;Transacoes-&gt;"..."-&gt;Exportar-&gt;SaveDialog-&gt;
/// EXPORT_STAGE-&gt;Validate-&gt;Publish-&gt;EXPORTADOS, SO alcancavel via o
/// argumento EXATO "--diagnostic-individual-statement-once" em Program.cs
/// (nunca por prefixo/substring/env var, nunca no startup default, nunca
/// durante `dotnet test`/`dotnet build`).
///
/// BuildOrchestrator() e' puramente composicao (nenhuma acao real no
/// construtor de nenhum componente, exceto a criacao do Mutex nomeado por
/// Win32ExecutionLock - identico ao Vendas) - seguro de chamar offline,
/// inclusive em teste automatizado, desde que Run() nunca seja invocado.
///
/// Reaproveita 100% os componentes REAIS ja homologados nesta fase
/// (lock, sessao, inspetor de janela, save dialog completo, watcher,
/// publisher, logger) - a UNICA diferenca em relacao a
/// RunOnceOperationalEntrypoint e' a composicao de disparo: em vez de
/// IInputSender/Shift+F5, usa INexClientNavigator+INexOverflowMenuOpener+
/// INexExportTrigger (V1), delegando toda a orquestracao real a
/// IndividualStatementExportOrchestrator - nenhuma logica de gate e'
/// duplicada aqui.
///
/// Downstream (Base44/Supabase/financeiro) permanece INTEIRAMENTE fora do
/// escopo - o trabalho termina em Publish() para EXPORTADOS, mesma
/// fronteira EXPORT-FIRST do pipeline de Vendas.
/// </summary>
internal static class IndividualStatementOnceProbe
{
    /// <summary>
    /// CORRECAO ARQUITETURAL: NAO existe um mutex proprio para este fluxo.
    /// Vendas e Extrato Individual operam o MESMO NexAdmin e manipulam a
    /// mesma UI global do NEX (mesma janela TFrmPri, mesmo teclado/mouse
    /// direcionado a ela) - portanto NUNCA podem executar concorrentemente,
    /// e o lock que os protege precisa ser o MESMO objeto de kernel, nao
    /// dois mutexes distintos com nomes diferentes (dois nomes distintos
    /// NAO se excluem mutuamente - cada instancia adquiriria o seu proprio
    /// livremente, permitindo as duas automacoes operarem o NEX ao mesmo
    /// tempo, exatamente o cenario que o lock existe para impedir).
    ///
    /// Por isso este probe reutiliza, sem duplicar a constante,
    /// EXATAMENTE RunOnceOperationalEntrypoint.ProductionMutexName - o
    /// mesmo nome (e portanto o mesmo kernel Mutex object do Windows) ja
    /// usado pelo pipeline de Vendas. Qualquer instancia deste probe e
    /// qualquer instancia do entrypoint operacional de Vendas disputam o
    /// MESMO lock: se uma estiver rodando, TryAcquire() da outra retorna
    /// false imediatamente (WaitOne(0), sem espera, sem fila) e a
    /// respectiva execucao termina fail-closed sem tocar o NEX.
    /// </summary>
    internal const string ExportStagePath = @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE";
    internal const string ExportadosPath = @"C:\Nex\PrimeIntegracaoNex\EXPORTADOS";
    private const string ExpectedFileType = "Excel";

    /// <summary>Comparacao EXATA do primeiro argumento - mesma disciplina
    /// de RunOnceOperationalEntrypoint.IsOperationalFlag. CORRECAO
    /// pos-primeiro OnceProbe real: ExpectedClientName agora e'
    /// OBRIGATORIO (ClientNavigationTarget nao aceita mais null) - a
    /// forma com apenas 2 argumentos (sem nome esperado) NAO e' mais
    /// aceita. O ClientCode e o ExpectedClientName vem exclusivamente dos
    /// argumentos, nunca hardcoded aqui - o valor usado na homologacao
    /// futura (292 / MATHEUS HENRIQUE DEPRE) e' responsabilidade
    /// exclusiva de quem invoca o processo.</summary>
    public static bool IsProbeFlag(string[] args) =>
        args.Length == 3 && args[0] == "--diagnostic-individual-statement-once"
        && !string.IsNullOrWhiteSpace(args[1]) && !string.IsNullOrWhiteSpace(args[2]);

    /// <summary>
    /// Constroi o IndividualStatementExportOrchestrator com TODAS as
    /// implementacoes REAIS (nenhum Fake*, nenhum placeholder). Puramente
    /// composicao - seguro de chamar offline (o unico efeito colateral e'
    /// a criacao do Mutex nomeado, que nao toca NEX/filesystem de
    /// EXPORT_STAGE-EXPORTADOS/rede).
    /// </summary>
    public static IndividualStatementExportOrchestrator BuildOrchestrator()
    {
        var clock = new SystemClock();
        var delay = new ThreadSleepDelay();
        var nativeWindows = new Win32NativeWindowApi();
        var controlApi = new Win32SaveDialogControlApi();

        var executionLock = new Win32ExecutionLock(RunOnceOperationalEntrypoint.ProductionMutexName);
        var sessionInspector = new WindowsSessionInspector(new Win32SessionNativeApi());
        var windowInspector = new WindowsNexWindowInspector(new Win32NexProcessScanner(), nativeWindows, new UiAutomationNexReader());

        var clientNavigationNative = new Win32NexClientNavigationNativeApi();
        var clientNavigator = new WindowsNexClientNavigator(nativeWindows, clientNavigationNative, delay);

        var overflowHitTest = new Win32OverflowHitTestNativeApi();
        var msaa = new Win32MsaaAccessibilityApi();
        var overflowMenuOpener = new WindowsNexOverflowMenuOpener(overflowHitTest, msaa, delay);
        var exportTrigger = new WindowsNexExportTrigger(overflowHitTest, msaa);

        var saveDialogInspector = new WindowsSaveDialogInspector(nativeWindows, controlApi);
        var saveDialogController = new WindowsSaveDialogController(nativeWindows, controlApi);
        var saveDialogWaiter = new PollingSaveDialogWaiter(saveDialogInspector, delay, clock);
        var saveDialogCommitter = new WindowsConfirmedSaveDialogCommitter(saveDialogInspector, controlApi, nativeWindows);

        var exportStageWatcher = new PollingExportStageWatcher(delay, clock);

        var processRunner = new Win32ProcessRunner();
        var cliScriptPath = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "SCRIPTS", "validar-export-transacoes-cliente.js"));
        var exportValidator = new NodeExportValidator(processRunner, cliScriptPath);

        var fileMover = new Win32FileMover();
        var atomicPublisher = new FileMoveAtomicPublisher(fileMover, ExportStagePath, ExportadosPath);

        var logger = new ConsoleAgentLogger();

        return new IndividualStatementExportOrchestrator(
            executionLock,
            sessionInspector,
            windowInspector,
            clientNavigator,
            overflowMenuOpener,
            exportTrigger,
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
    /// IsProbeFlag(args) for verdadeiro. NAO chamado por nenhum teste
    /// desta tarefa, NAO chamado nesta rodada de preparacao.
    /// </summary>
    public static void Run(string[] args)
    {
        var clientCode = args[1];
        var expectedClientName = args[2];

        Console.WriteLine("=== PRIME NEX EXPORT AGENT - PROBE ONE-SHOT do IndividualStatementExportOrchestrator (V1) ===");
        Console.WriteLine($"ClientCode='{clientCode}' ExpectedClientName='{expectedClientName}'");
        Console.WriteLine("ATENCAO: este comando PODE navegar ate o cliente, enviar F2 real, abrir a aba Transacoes, abrir o menu '...', acionar Exportar via MSAA, e escrever/clicar no dialogo Salvar Como.");
        Console.WriteLine("Nao mexa no mouse/teclado durante a execucao.");
        Console.WriteLine();

        var orchestrator = BuildOrchestrator();
        var result = orchestrator.Run(new ClientNavigationTarget(clientCode, expectedClientName));

        Console.WriteLine();
        Console.WriteLine($"=== RESULTADO: Success={result.Success} FinalStage={result.FinalStage} ErrorCode={result.ErrorCode} PublishedFilePath={result.PublishedFilePath} ===");

        Environment.ExitCode = result.Success ? 0 : 1;
    }
}
