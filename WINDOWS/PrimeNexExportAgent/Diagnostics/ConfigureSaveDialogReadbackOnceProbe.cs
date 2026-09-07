using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.WindowsInput;
using PrimeNexExportAgent.WindowsNative;
using PrimeNexExportAgent.WindowsSaveDialog;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// Probe one-shot supervisionado (F6.14B2) - executa toda a cadeia real ate
/// READ-BACK do dialogo "Salvar como", SEM NUNCA clicar Salvar ou
/// Cancelar. Usa EXPORT_STAGE (nunca EXPORTADOS) e um nome de arquivo
/// inequivocamente de teste. Encerra imediatamente apos reportar o
/// resultado do read-back - nao chama ClickSave/CancelSaveDialog em
/// nenhuma circunstancia (a implementacao real dessas duas lanca
/// NotSupportedException de qualquer forma, mas o probe nem tenta).
///
/// So alcancavel via o argumento explicito
/// --diagnostic-configure-save-dialog-readback-once (ver Program.cs).
/// </summary>
internal static class ConfigureSaveDialogReadbackOnceProbe
{
    private const string ExportStagePath = @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE";
    private const string ExpectedFileType = "Excel";

    public static void Run()
    {
        Console.WriteLine("=== PRIME NEX EXPORT AGENT - PROBE ONE-SHOT Configure+ReadBack do Save Dialog (F6.14B2) ===");
        Console.WriteLine("ATENCAO: este comando PODE enviar Shift+F5 real e ESCREVER nos campos do dialogo.");
        Console.WriteLine("NUNCA clica Salvar nem Cancelar. Nao mexa no mouse/teclado durante a execucao.");
        Console.WriteLine();

        var sessionInspector = new WindowsSessionInspector(new Win32SessionNativeApi());
        var session = sessionInspector.CheckSession();
        Console.WriteLine($"[G2] CheckSession() -> Passed={session.Passed} ErrorCode={session.ErrorCode}");
        if (!session.Passed) { Console.WriteLine("Abortando. ZERO acao."); return; }

        var nativeWindows = new Win32NativeWindowApi();
        var windowInspector = new WindowsNexWindowInspector(new Win32NexProcessScanner(), nativeWindows, new UiAutomationNexReader());

        var locate = windowInspector.LocateNexAdmin(session.AgentSessionId!.Value);
        Console.WriteLine($"[G1] LocateNexAdmin() -> Passed={locate.Passed} ErrorCode={locate.ErrorCode} Reason={locate.Reason}");
        if (!locate.Passed) { Console.WriteLine("Abortando. ZERO acao."); return; }
        var target = locate.Identity!;
        Console.WriteLine($"     Target: PID={target.ProcessId} HWND=0x{target.MainWindowHandle:X}");

        var safeState = windowInspector.CheckSafeState(target);
        Console.WriteLine($"[G3-G6] CheckSafeState() -> Passed={safeState.Passed} ErrorCode={safeState.ErrorCode} Reason={safeState.Reason}");
        if (!safeState.Passed) { Console.WriteLine("Abortando. ZERO acao."); return; }

        var clock = new SystemClock();

        Console.WriteLine();
        Console.WriteLine("Todos os gates PASS. Enviando SendExportShortcut(target) UMA vez...");
        var inputNative = new Win32InputNativeApi();
        var foregroundWaiter = new PollingForegroundWaiter(inputNative, new ThreadSleepDelay(), clock);
        var inputSender = new WindowsInputSender(nativeWindows, inputNative, foregroundWaiter);
        try
        {
            inputSender.SendExportShortcut(target);
            Console.WriteLine("Shift+F5 enviado 1x sem excecao.");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SendExportShortcut FALHOU: {ex.Message}. ZERO segunda tentativa. Encerrando.");
            return;
        }

        var controlApi = new Win32SaveDialogControlApi();
        var saveDialogInspector = new WindowsSaveDialogInspector(nativeWindows, controlApi);
        var saveDialogController = new WindowsSaveDialogController(nativeWindows, controlApi);
        var saveDialogWaiter = new PollingSaveDialogWaiter(saveDialogInspector, new ThreadSleepDelay(), clock);

        Console.WriteLine();
        Console.WriteLine($"Aguardando o dialogo aparecer (timeout {PollingSaveDialogWaiter.DefaultTimeout.TotalSeconds}s, poll a cada {PollingSaveDialogWaiter.DefaultPollInterval.TotalMilliseconds}ms - somente leitura, ZERO novo Shift+F5)...");
        var identity = saveDialogWaiter.WaitForSaveDialog(target);
        Console.WriteLine($"[G8+G9] WaitForSaveDialog() -> Passed={identity.Passed} ErrorCode={identity.ErrorCode} Reason={identity.Reason}");
        if (!identity.Passed) { Console.WriteLine("Abortando - dialogo/controles nao identificados dentro do timeout. ZERO Configure. ZERO novo Shift+F5."); return; }
        var dialog = identity.Dialog!;
        Console.WriteLine($"     Dialog HWND=0x{dialog.DialogHandle:X}");

        var fileName = FileNaming.GerarNomeArquivoVendas(clock);
        // Nome inequivocamente de teste (F6.14B2 secao 8) - nunca reaproveita
        // o padrao de producao "vendas-auto-...".
        fileName = fileName.Replace("vendas-auto-", "vendas-auto-readback-test-");

        Console.WriteLine();
        Console.WriteLine($"Configurando: destino='{ExportStagePath}' nome='{fileName}' tipo='{ExpectedFileType}'...");
        try
        {
            saveDialogController.Configure(dialog, ExportStagePath, fileName, ExpectedFileType);
            Console.WriteLine("Configure concluido sem excecao.");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Configure FALHOU: {ex.Message}. Encerrando sem ReadBack.");
            return;
        }

        var readback = saveDialogInspector.ReadBack(dialog, ExportStagePath, fileName, ExpectedFileType);
        Console.WriteLine($"[G10-G12] ReadBack() -> Passed={readback.Passed} ErrorCode={readback.ErrorCode} Reason={readback.Reason}");

        Console.WriteLine();
        Console.WriteLine("=== PROBE ENCERRADO - ClickSave/CancelSaveDialog NUNCA foram chamados. Peca a Rafael para clicar CANCELAR manualmente. ===");
    }
}
