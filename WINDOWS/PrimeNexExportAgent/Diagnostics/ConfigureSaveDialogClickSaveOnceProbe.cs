using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.WindowsInput;
using PrimeNexExportAgent.WindowsNative;
using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// F6.14B2.9C - resultado interno do RunCore (sem efeito operacional, so
/// para clareza fail-closed e testabilidade) - NUNCA altera o protocolo
/// externo do CLI (Run() continua só escrevendo no Console e retornando
/// void, exatamente como antes).
/// </summary>
internal enum ClickSaveProbeOutcome
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
    FailedDialogRevalidation,
    FailedDialogHandleMismatch,
    FailedSaveButtonMissing,
    FailedFilesystemTimeout,
    FailedExportadosChanged,
}

/// <summary>
/// Probe one-shot supervisionado (F6.14B2.9A, refatorado em F6.14B2.9C para
/// testabilidade) - reaproveita 100% da cadeia ja homologada em
/// ConfigureSaveDialogReadbackOnceProbe (sessao -> janela -> foreground ->
/// Shift+F5 -> WaitForSaveDialog -> Configure -> ReadBack) e adiciona os
/// passos finais para clicar Salvar EXATAMENTE 1 vez e observar o resultado
/// via sistema de arquivos.
///
/// UNICO ponto do projeto que pode chegar a ISaveDialogControlApi.ClickButton
/// (BM_CLICK) - ISaveDialogController.ClickSave() continua lancando
/// NotSupportedException incondicionalmente em todos os outros caminhos
/// (modo normal e o probe de F6.14B2.8), nunca alterado por esta classe.
///
/// O retorno de ClickButton NUNCA e' tratado como prova de sucesso - a
/// prova vem exclusivamente de IExportStageWatcher, apos o clique, contra
/// o sistema de arquivos real. Zero retry em qualquer estagio: qualquer
/// divergencia encerra a orquestracao imediatamente (return), nunca uma
/// segunda tentativa de SetForegroundWindow, Shift+F5, ou ClickButton.
///
/// F6.14B2.9C - REFATORACAO MINIMA PARA TESTABILIDADE: a logica de
/// orquestracao foi extraida para RunCore(...), que recebe TODAS as
/// dependencias por parametro (interfaces ja existentes no projeto - nenhuma
/// abstracao nova alem do necessario) - permite testes offline injetarem
/// fakes e provarem objetivamente cada gate/decisao, sem tocar Win32/NEX
/// real. Run() (o entrypoint real, unico alcancavel via
/// --diagnostic-configure-save-dialog-click-save-once) continua construindo
/// EXATAMENTE as mesmas implementacoes reais de antes e chamando RunCore com
/// elas + Console.WriteLine como logger - o comportamento/output observavel
/// em producao e' idêntico ao de antes da refatoracao. Nenhuma logica foi
/// movida para ExportAgentOrchestrator; o mecanismo continua estritamente
/// dentro de Diagnostics.
/// </summary>
internal static class ConfigureSaveDialogClickSaveOnceProbe
{
    private const string ExportStagePath = @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE";
    private const string ExportadosPath = @"C:\Nex\PrimeIntegracaoNex\EXPORTADOS";
    private const string ExpectedFileType = "Excel";

    public static void Run()
    {
        Console.WriteLine("=== PRIME NEX EXPORT AGENT - PROBE ONE-SHOT Configure+ReadBack+ClickSave do Save Dialog (F6.14B2.9A) ===");
        Console.WriteLine("ATENCAO: este comando PODE enviar Shift+F5 real, ESCREVER nos campos do dialogo, E CLICAR SALVAR (BM_CLICK) exatamente 1 vez.");
        Console.WriteLine("Nao mexa no mouse/teclado durante a execucao.");
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

        RunCore(
            sessionInspector, windowInspector, inputSender, saveDialogWaiter, saveDialogInspector,
            saveDialogController, controlApi, nativeWindows, exportStageWatcher, clock,
            ExportStagePath, ExportadosPath, ExpectedFileType, Console.WriteLine);
    }

    /// <summary>
    /// F6.14B2.9C - orquestracao testavel. Recebe todas as dependencias por
    /// interface (nenhuma instanciada aqui dentro) - Run() constroi as
    /// implementacoes reais; testes offline injetam fakes. `log` recebe
    /// exatamente as mesmas mensagens que antes iam direto para
    /// Console.WriteLine - nenhuma mudanca de comportamento observavel em
    /// producao.
    /// </summary>
    internal static ClickSaveProbeOutcome RunCore(
        ISessionInspector sessionInspector,
        INexWindowInspector windowInspector,
        IInputSender inputSender,
        ISaveDialogWaiter saveDialogWaiter,
        ISaveDialogInspector saveDialogInspector,
        ISaveDialogController saveDialogController,
        ISaveDialogControlApi controlApi,
        INativeWindowApi nativeWindows,
        IExportStageWatcher exportStageWatcher,
        IClock clock,
        string exportStagePath,
        string exportadosPath,
        string expectedFileType,
        Action<string> log)
    {
        var session = sessionInspector.CheckSession();
        log($"[G2] CheckSession() -> Passed={session.Passed} ErrorCode={session.ErrorCode}");
        if (!session.Passed) { log("Abortando. ZERO acao."); return ClickSaveProbeOutcome.FailedSession; }

        var locate = windowInspector.LocateNexAdmin(session.AgentSessionId!.Value);
        log($"[G1] LocateNexAdmin() -> Passed={locate.Passed} ErrorCode={locate.ErrorCode} Reason={locate.Reason}");
        if (!locate.Passed) { log("Abortando. ZERO acao."); return ClickSaveProbeOutcome.FailedLocateNexAdmin; }
        var target = locate.Identity!;
        log($"     Target: PID={target.ProcessId} HWND=0x{target.MainWindowHandle:X}");

        var safeState = windowInspector.CheckSafeState(target);
        log($"[G3-G6] CheckSafeState() -> Passed={safeState.Passed} ErrorCode={safeState.ErrorCode} Reason={safeState.Reason}");
        if (!safeState.Passed) { log("Abortando. ZERO acao."); return ClickSaveProbeOutcome.FailedSafeState; }

        // ---- G13 (F6.14B2.9A): EXPORT_STAGE obrigatoriamente vazia ANTES
        // de qualquer acao real (inclusive antes do Shift+F5) - fail-closed,
        // nunca apagado automaticamente. ----
        var emptyCheck = exportStageWatcher.ConfirmEmptyBeforeAction(exportStagePath);
        log($"[G13] ConfirmEmptyBeforeAction(EXPORT_STAGE) -> Passed={emptyCheck.Passed} ErrorCode={emptyCheck.ErrorCode} Reason={emptyCheck.Reason}");
        if (!emptyCheck.Passed) { log("Abortando. ZERO acao."); return ClickSaveProbeOutcome.FailedStageNotEmpty; }

        // ---- Snapshot READ-ONLY de EXPORTADOS ANTES de qualquer acao real
        // (F6.14B2.9A secao 7) - comparado de novo depois da estabilizacao. ----
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
            return ClickSaveProbeOutcome.FailedShiftF5;
        }

        log(string.Empty);
        log($"Aguardando o dialogo aparecer (timeout {PollingSaveDialogWaiter.DefaultTimeout.TotalSeconds}s, poll a cada {PollingSaveDialogWaiter.DefaultPollInterval.TotalMilliseconds}ms - somente leitura, ZERO novo Shift+F5)...");
        var identity = saveDialogWaiter.WaitForSaveDialog(target);
        log($"[G8+G9] WaitForSaveDialog() -> Passed={identity.Passed} ErrorCode={identity.ErrorCode} Reason={identity.Reason}");
        if (!identity.Passed) { log("Abortando - dialogo/controles nao identificados dentro do timeout. ZERO Configure. ZERO novo Shift+F5."); return ClickSaveProbeOutcome.FailedWaitForSaveDialog; }
        var dialog = identity.Dialog!;
        log($"     Dialog HWND=0x{dialog.DialogHandle:X}");

        var fileName = FileNaming.GerarNomeArquivoVendas(clock);
        // Nome inequivocamente de teste (mesmo padrao de F6.14B2/F6.14B2.8) -
        // nunca reaproveita o padrao de producao "vendas-auto-...".
        fileName = fileName.Replace("vendas-auto-", "vendas-auto-clicksave-test-");
        var expectedFullPath = Path.Combine(exportStagePath, fileName);
        log($"     TEST_FILENAME={fileName}");
        log($"     EXPECTED_FULL_PATH={expectedFullPath}");

        // ---- Prova preventiva (F6.14B2.9A secao 8): EXPECTED_FULL_PATH tem
        // que pertencer literalmente a EXPORT_STAGE - nunca escapar via
        // caminho inesperado. Extraido em metodo proprio (F6.14B2.9C) para
        // ser testavel isoladamente com entradas adversariais, mesmo que
        // FileNaming nunca produza um nome capaz de escapar hoje. ----
        if (!IsExpectedPathWithinStage(expectedFullPath, exportStagePath))
        {
            log("EXPECTED_FULL_PATH nao pertence a EXPORT_STAGE - abortando. ZERO acao.");
            return ClickSaveProbeOutcome.FailedPathValidation;
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
            log($"Configure FALHOU: {ex.Message}. Encerrando sem ReadBack/ClickSave.");
            return ClickSaveProbeOutcome.FailedConfigure;
        }

        var readback = saveDialogInspector.ReadBack(dialog, exportStagePath, fileName, expectedFileType);
        log($"[G10-G12] ReadBack() -> Passed={readback.Passed} ErrorCode={readback.ErrorCode} Reason={readback.Reason}");
        if (!readback.Passed) { log("ReadBack NAO passou. ClickButton = ZERO. Abortando."); return ClickSaveProbeOutcome.FailedReadBack; }

        // ---- Revalidacao FINAL, imediatamente antes do clique (F6.14B2.9A
        // secao 5): protege contra mudanca de estado entre a identificacao
        // original e a acao final. Reaproveita IdentifySaveDialog (mesmas
        // checagens de ClassName/Titulo/PID/5 CtrlIds/Enabled), nunca
        // duplica a logica - so exige, adicionalmente, que seja o MESMO
        // HWND de dialogo ja identificado nesta execucao. ----
        var revalidation = saveDialogInspector.IdentifySaveDialog(target);
        log($"[REVALIDACAO FINAL] IdentifySaveDialog() -> Passed={revalidation.Passed} ErrorCode={revalidation.ErrorCode} Reason={revalidation.Reason}");
        if (!revalidation.Passed)
        {
            log("Revalidacao final NAO passou (dialogo/controles nao confirmados agora). ClickButton = ZERO. Abortando.");
            return ClickSaveProbeOutcome.FailedDialogRevalidation;
        }
        if (revalidation.Dialog!.DialogHandle != dialog.DialogHandle)
        {
            log($"Revalidacao final encontrou um dialogo DIFERENTE (HWND=0x{revalidation.Dialog.DialogHandle:X} != HWND original=0x{dialog.DialogHandle:X}). ClickButton = ZERO. Abortando.");
            return ClickSaveProbeOutcome.FailedDialogHandleMismatch;
        }
        log("Revalidacao final confirmou: mesmo dialogo, mesmos 5 controles presentes/Enabled.");

        var saveButtonHwnd = controlApi.GetControl(dialog.DialogHandle, WindowsSaveDialogInspector.CtrlIdSave);
        if (saveButtonHwnd == 0 || !nativeWindows.IsWindowValid(saveButtonHwnd) || !controlApi.IsControlEnabled(saveButtonHwnd))
        {
            log("CtrlId 1 (Salvar) ausente/invalido/desabilitado na revalidacao final. ClickButton = ZERO. Abortando.");
            return ClickSaveProbeOutcome.FailedSaveButtonMissing;
        }

        log(string.Empty);
        log("Todos os gates (incluindo revalidacao final) PASS. Enviando BM_CLICK ao CtrlId 1 (Salvar) UMA unica vez...");
        log("ATENCAO: o retorno de BM_CLICK NAO e' prova de sucesso - a prova real vem do IExportStageWatcher abaixo.");
        controlApi.ClickButton(saveButtonHwnd);
        log("BM_CLICK enviado 1x (dispatch apenas - nao e' confirmacao de salvamento).");

        log(string.Empty);
        log($"Aguardando EXPORT_STAGE estabilizar (timeout {PollingExportStageWatcher.DefaultTimeout.TotalSeconds}s, poll a cada {PollingExportStageWatcher.DefaultPollInterval.TotalMilliseconds}ms - somente leitura, ZERO novo ClickButton)...");
        var watchResult = exportStageWatcher.WaitForExpectedFileOnly(exportStagePath, fileName, PollingExportStageWatcher.DefaultTimeout);
        log($"[PROVA DE FILESYSTEM] WaitForExpectedFileOnly() -> Passed={watchResult.Passed} ErrorCode={watchResult.ErrorCode} Reason={watchResult.Reason}");

        var exportadosSnapshotAfter = SnapshotDirectory(exportadosPath);
        var exportadosUnchanged = SnapshotsEqual(exportadosSnapshotBefore, exportadosSnapshotAfter);
        log($"[PROVA DE FILESYSTEM] EXPORTADOS inalterada (snapshot antes/depois identico) -> {exportadosUnchanged}");

        log(string.Empty);
        if (!watchResult.Passed)
        {
            log("=== PROBE CONCLUIDO COM DIVERGENCIA - reportar exatamente a saida acima, NAO reexecutar. ===");
            log("Nenhuma publicacao (Reader/move para EXPORTADOS) foi tentada - fora do escopo desta fase.");
            return ClickSaveProbeOutcome.FailedFilesystemTimeout;
        }

        if (!exportadosUnchanged)
        {
            log("=== PROBE CONCLUIDO COM DIVERGENCIA - EXPORTADOS mudou durante a execucao - reportar exatamente a saida acima, NAO reexecutar. ===");
            log("Nenhuma publicacao (Reader/move para EXPORTADOS) foi tentada - fora do escopo desta fase.");
            return ClickSaveProbeOutcome.FailedExportadosChanged;
        }

        log($"=== PROBE CONCLUIDO: arquivo '{fileName}' nasceu e estabilizou em EXPORT_STAGE, EXPORTADOS permaneceu inalterada. ===");
        log("Nenhuma publicacao (Reader/move para EXPORTADOS) foi tentada - fora do escopo desta fase.");
        return ClickSaveProbeOutcome.Passed;
    }

    /// <summary>F6.14B2.9C - checagem canonical/anti-escape, extraida para
    /// ser testavel com entradas adversariais isoladamente (ex.: nomes com
    /// "..", separadores, caminhos absolutos alheios) - independente de
    /// FileNaming hoje nunca produzir um nome capaz de disparar isto.</summary>
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
