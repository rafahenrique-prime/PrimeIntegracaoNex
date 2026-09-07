using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.WindowsInput;
using PrimeNexExportAgent.WindowsNative;
using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// F6.14B2.12C2 - resultado interno do RunCore (sem efeito operacional, so
/// para clareza fail-closed e testabilidade).
/// </summary>
internal enum ConfirmedCommitterProbeOutcome
{
    Passed,
    FailedSession,
    FailedLocateNexAdmin,
    FailedSafeState,
    FailedStageNotEmpty,
    FailedShiftF5,
    FailedWaitForSaveDialog,
    FailedPathValidation,
    FailedConfigure,
    FailedReadBack,
    FailedCommit,
    FailedFilesystemTimeout,
    FailedExportadosChanged,
}

/// <summary>
/// Probe one-shot supervisionado (F6.14B2.12C2) - homologa
/// WindowsConfirmedSaveDialogCommitter REAL (o Committer operacional
/// estreito de F6.14B2.12C1) contra o NEX real, ate o arquivo estabilizar
/// em EXPORT_STAGE - NUNCA avanca para Validator/Publisher/EXPORTADOS.
///
/// Reaproveita 100% a mesma cadeia ja homologada em
/// ConfigureSaveDialogClickSaveOnceProbe (sessao -> janela -> foreground ->
/// Shift+F5 -> WaitForSaveDialog -> Configure -> ReadBack) - arquivo esse
/// que permanece INTOCADO por esta tarefa, servindo como evidencia
/// historica independente da logica de clique ORIGINAL (revalidacao +
/// ClickButton inline). Este NOVO probe difere dele em exatamente 1 ponto:
/// em vez de revalidar o dialogo e chamar ISaveDialogControlApi.ClickButton
/// diretamente, ele delega toda essa responsabilidade a
/// IConfirmedSaveDialogCommitter.CommitOnce(target, dialog) - o probe NUNCA
/// chama ClickButton/BM_CLICK/SendMessageInt diretamente; o UNICO call site
/// de ClickButton alcancavel a partir deste arquivo e' indireto, atraves do
/// Committer.
///
/// ISaveDialogController.ClickSave()/CancelSaveDialog() continuam
/// bloqueados (NotSupportedException) em todos os caminhos, nunca
/// alterados por esta classe.
/// </summary>
internal static class ConfirmedSaveDialogCommitterOnceProbe
{
    private const string ExportStagePath = @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE";
    private const string ExportadosPath = @"C:\Nex\PrimeIntegracaoNex\EXPORTADOS";
    private const string ExpectedFileType = "Excel";

    public static void Run()
    {
        Console.WriteLine("=== PRIME NEX EXPORT AGENT - PROBE ONE-SHOT do WindowsConfirmedSaveDialogCommitter (F6.14B2.12C2) ===");
        Console.WriteLine("ATENCAO: este comando PODE enviar Shift+F5 real, ESCREVER nos campos do dialogo, E CLICAR SALVAR (via Committer) exatamente 1 vez.");
        Console.WriteLine("Nao mexa no mouse/teclado durante a execucao. NUNCA avanca para Validator/Publisher/EXPORTADOS.");
        Console.WriteLine();

        var nativeWindows = new Win32NativeWindowApi();
        var controlApi = new Win32SaveDialogControlApi();
        var clock = new SystemClock();
        var delay = new ThreadSleepDelay();

        var sessionInspector = new WindowsSessionInspector(new Win32SessionNativeApi());
        var windowInspector = new WindowsNexWindowInspector(new Win32NexProcessScanner(), nativeWindows, new UiAutomationNexReader());
        var inputNative = new Win32InputNativeApi();
        var foregroundWaiter = new PollingForegroundWaiter(inputNative, delay, clock);
        var inputSender = new WindowsInputSender(nativeWindows, inputNative, foregroundWaiter);
        var saveDialogInspector = new WindowsSaveDialogInspector(nativeWindows, controlApi);
        var saveDialogController = new WindowsSaveDialogController(nativeWindows, controlApi);
        var saveDialogWaiter = new PollingSaveDialogWaiter(saveDialogInspector, delay, clock);
        var exportStageWatcher = new PollingExportStageWatcher(delay, clock);
        var committer = new WindowsConfirmedSaveDialogCommitter(saveDialogInspector, controlApi, nativeWindows);

        RunCore(
            sessionInspector, windowInspector, inputSender, saveDialogWaiter, saveDialogInspector,
            saveDialogController, committer, exportStageWatcher, clock,
            ExportStagePath, ExportadosPath, ExpectedFileType, Console.WriteLine);
    }

    /// <summary>
    /// F6.14B2.12C2 - orquestracao testavel. Recebe todas as dependencias
    /// por interface (nenhuma instanciada aqui dentro) - Run() constroi as
    /// implementacoes reais; testes offline injetam fakes.
    /// </summary>
    internal static ConfirmedCommitterProbeOutcome RunCore(
        ISessionInspector sessionInspector,
        INexWindowInspector windowInspector,
        IInputSender inputSender,
        ISaveDialogWaiter saveDialogWaiter,
        ISaveDialogInspector saveDialogInspector,
        ISaveDialogController saveDialogController,
        IConfirmedSaveDialogCommitter committer,
        IExportStageWatcher exportStageWatcher,
        IClock clock,
        string exportStagePath,
        string exportadosPath,
        string expectedFileType,
        Action<string> log)
    {
        var session = sessionInspector.CheckSession();
        log($"[G2] CheckSession() -> Passed={session.Passed} ErrorCode={session.ErrorCode}");
        if (!session.Passed) { log("Abortando. ZERO acao."); return ConfirmedCommitterProbeOutcome.FailedSession; }

        var locate = windowInspector.LocateNexAdmin(session.AgentSessionId!.Value);
        log($"[G1] LocateNexAdmin() -> Passed={locate.Passed} ErrorCode={locate.ErrorCode} Reason={locate.Reason}");
        if (!locate.Passed) { log("Abortando. ZERO acao."); return ConfirmedCommitterProbeOutcome.FailedLocateNexAdmin; }
        var target = locate.Identity!;
        log($"     Target: PID={target.ProcessId} HWND=0x{target.MainWindowHandle:X}");

        var safeState = windowInspector.CheckSafeState(target);
        log($"[G3-G6] CheckSafeState() -> Passed={safeState.Passed} ErrorCode={safeState.ErrorCode} Reason={safeState.Reason}");
        if (!safeState.Passed) { log("Abortando. ZERO acao."); return ConfirmedCommitterProbeOutcome.FailedSafeState; }

        // ---- EXPORT_STAGE obrigatoriamente vazia ANTES de qualquer acao
        // real (inclusive antes do Shift+F5) - fail-closed, nunca apagado
        // automaticamente. ----
        var emptyCheck = exportStageWatcher.ConfirmEmptyBeforeAction(exportStagePath);
        log($"[G13] ConfirmEmptyBeforeAction(EXPORT_STAGE) -> Passed={emptyCheck.Passed} ErrorCode={emptyCheck.ErrorCode} Reason={emptyCheck.Reason}");
        if (!emptyCheck.Passed) { log("Abortando. ZERO acao."); return ConfirmedCommitterProbeOutcome.FailedStageNotEmpty; }

        // ---- Snapshot READ-ONLY de EXPORTADOS ANTES de qualquer acao real. ----
        var exportadosSnapshotBefore = SnapshotDirectory(exportadosPath);
        log($"     Snapshot EXPORTADOS antes da acao: {exportadosSnapshotBefore.Count} arquivo(s).");

        log(string.Empty);
        log("Todos os gates PASS. Enviando SendExportShortcut(target) UMA vez...");
        try
        {
            inputSender.SendExportShortcut(target);
            log("Shift+F5 enviado 1x sem excecao.");
        }
        catch (Exception ex)
        {
            log($"SendExportShortcut FALHOU: {ex.Message}. ZERO segunda tentativa. Encerrando.");
            return ConfirmedCommitterProbeOutcome.FailedShiftF5;
        }

        log(string.Empty);
        log($"Aguardando o dialogo aparecer (timeout {PollingSaveDialogWaiter.DefaultTimeout.TotalSeconds}s, poll a cada {PollingSaveDialogWaiter.DefaultPollInterval.TotalMilliseconds}ms - somente leitura, ZERO novo Shift+F5)...");
        var identity = saveDialogWaiter.WaitForSaveDialog(target);
        log($"[G8+G9] WaitForSaveDialog() -> Passed={identity.Passed} ErrorCode={identity.ErrorCode} Reason={identity.Reason}");
        if (!identity.Passed) { log("Abortando - dialogo/controles nao identificados dentro do timeout. ZERO Configure. ZERO novo Shift+F5."); return ConfirmedCommitterProbeOutcome.FailedWaitForSaveDialog; }
        var dialog = identity.Dialog!;
        log($"     Dialog HWND=0x{dialog.DialogHandle:X}");

        var fileName = FileNaming.GerarNomeArquivoVendas(clock);
        // Nome inequivocamente de teste, DIFERENTE do padrao usado pelo
        // probe historico ("vendas-auto-clicksave-test-...") - nunca
        // reaproveita o nome de producao nem o do outro probe.
        fileName = fileName.Replace("vendas-auto-", "vendas-auto-committer-test-");
        var expectedFullPath = Path.Combine(exportStagePath, fileName);
        log($"     TEST_FILENAME={fileName}");
        log($"     EXPECTED_FULL_PATH={expectedFullPath}");

        if (!IsExpectedPathWithinStage(expectedFullPath, exportStagePath))
        {
            log("EXPECTED_FULL_PATH nao pertence a EXPORT_STAGE - abortando. ZERO acao.");
            return ConfirmedCommitterProbeOutcome.FailedPathValidation;
        }

        log(string.Empty);
        log($"Configurando: destino='{exportStagePath}' nome='{fileName}' tipo='{expectedFileType}'...");
        try
        {
            saveDialogController.Configure(dialog, exportStagePath, fileName, expectedFileType);
            log("Configure concluido sem excecao.");
        }
        catch (Exception ex)
        {
            log($"Configure FALHOU: {ex.Message}. Encerrando sem ReadBack/CommitOnce.");
            return ConfirmedCommitterProbeOutcome.FailedConfigure;
        }

        var readback = saveDialogInspector.ReadBack(dialog, exportStagePath, fileName, expectedFileType);
        log($"[G10-G12] ReadBack() -> Passed={readback.Passed} ErrorCode={readback.ErrorCode} Reason={readback.Reason}");
        if (!readback.Passed) { log("ReadBack NAO passou. CommitOnce = ZERO. Abortando."); return ConfirmedCommitterProbeOutcome.FailedReadBack; }

        log(string.Empty);
        log("ReadBack PASS. Delegando o commit final EXATAMENTE 1x ao WindowsConfirmedSaveDialogCommitter (reidentifica o dialogo, exige mesmo HWND, resolve CtrlId 1, despacha BM_CLICK)...");
        log("ATENCAO: Dispatched=true NAO e' prova de sucesso - a prova real vem do IExportStageWatcher abaixo.");
        var commit = committer.CommitOnce(target, dialog);
        log($"[COMMIT] CommitOnce() -> Dispatched={commit.Dispatched} ErrorCode={commit.ErrorCode} Reason={commit.Reason}");
        if (!commit.Dispatched)
        {
            log("CommitOnce NAO despachou o clique. ZERO watcher. Abortando. NUNCA um segundo CommitOnce.");
            return ConfirmedCommitterProbeOutcome.FailedCommit;
        }
        log("CommitOnce despachou BM_CLICK 1x (via Committer - probe NUNCA chamou ClickButton diretamente).");

        log(string.Empty);
        log($"Aguardando EXPORT_STAGE estabilizar (timeout {PollingExportStageWatcher.DefaultTimeout.TotalSeconds}s, poll a cada {PollingExportStageWatcher.DefaultPollInterval.TotalMilliseconds}ms - somente leitura, ZERO novo CommitOnce)...");
        var watchResult = exportStageWatcher.WaitForExpectedFileOnly(exportStagePath, fileName, PollingExportStageWatcher.DefaultTimeout);
        log($"[PROVA DE FILESYSTEM] WaitForExpectedFileOnly() -> Passed={watchResult.Passed} ErrorCode={watchResult.ErrorCode} Reason={watchResult.Reason}");

        var exportadosSnapshotAfter = SnapshotDirectory(exportadosPath);
        var exportadosUnchanged = SnapshotsEqual(exportadosSnapshotBefore, exportadosSnapshotAfter);
        log($"[PROVA DE FILESYSTEM] EXPORTADOS inalterada (snapshot antes/depois identico) -> {exportadosUnchanged}");

        log(string.Empty);
        if (!watchResult.Passed)
        {
            log("=== PROBE CONCLUIDO COM DIVERGENCIA - reportar exatamente a saida acima, NAO reexecutar. ===");
            log("Nenhum Validator/Publisher/EXPORTADOS foi tentado - fora do escopo desta fase.");
            return ConfirmedCommitterProbeOutcome.FailedFilesystemTimeout;
        }

        if (!exportadosUnchanged)
        {
            log("=== PROBE CONCLUIDO COM DIVERGENCIA - EXPORTADOS mudou durante a execucao - reportar exatamente a saida acima, NAO reexecutar. ===");
            log("Nenhum Validator/Publisher foi tentado - fora do escopo desta fase.");
            return ConfirmedCommitterProbeOutcome.FailedExportadosChanged;
        }

        log($"=== PROBE CONCLUIDO: arquivo '{fileName}' nasceu e estabilizou em EXPORT_STAGE via WindowsConfirmedSaveDialogCommitter, EXPORTADOS permaneceu inalterada. ===");
        log("Nenhum Validator/Publisher/EXPORTADOS foi tentado - fora do escopo desta fase.");
        return ConfirmedCommitterProbeOutcome.Passed;
    }

    /// <summary>Checagem canonical/anti-escape - mesma logica ja usada e
    /// homologada no probe historico, reaproveitada aqui identicamente
    /// (nao duplicada em intencao, apenas replicada porque cada probe e'
    /// uma classe internal independente).</summary>
    internal static bool IsExpectedPathWithinStage(string expectedFullPath, string exportStagePath) =>
        string.Equals(
            Path.GetFullPath(Path.GetDirectoryName(expectedFullPath) ?? string.Empty),
            Path.GetFullPath(exportStagePath),
            StringComparison.OrdinalIgnoreCase);

    private static Dictionary<string, (long Length, DateTime LastWriteUtc)> SnapshotDirectory(string directoryPath)
    {
        var result = new Dictionary<string, (long, DateTime)>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in Directory.GetFiles(directoryPath))
        {
            var info = new FileInfo(path);
            result[info.Name] = (info.Length, info.LastWriteTimeUtc);
        }
        return result;
    }

    private static bool SnapshotsEqual(
        Dictionary<string, (long Length, DateTime LastWriteUtc)> before,
        Dictionary<string, (long Length, DateTime LastWriteUtc)> after)
    {
        if (before.Count != after.Count) return false;
        foreach (var (name, value) in before)
        {
            if (!after.TryGetValue(name, out var otherValue)) return false;
            if (value.Length != otherValue.Length || value.LastWriteUtc != otherValue.LastWriteUtc) return false;
        }
        return true;
    }
}
