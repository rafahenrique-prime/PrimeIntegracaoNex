using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.WindowsInput;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// Probe one-shot supervisionado (F6.14B1) - a UNICA rotina do projeto que
/// pode, de fato, enviar Shift+F5 real ao NexAdmin. Deliberadamente
/// separada de qualquer ExportAgentOrchestrator: NAO trata Salvar Como, NAO
/// clica Salvar, NAO clica Cancelar, NAO publica nada - encerra
/// IMEDIATAMENTE apos o SendExportShortcut(target) unico.
///
/// So e alcancavel via o argumento explicito
/// --diagnostic-send-export-shortcut-once (ver Program.cs) - nunca
/// executada automaticamente, nunca agendada, nunca em loop.
/// </summary>
internal static class SendExportShortcutOnceProbe
{
    public static void Run()
    {
        Console.WriteLine("=== PRIME NEX EXPORT AGENT - PROBE ONE-SHOT SendExportShortcut (F6.14B1) ===");
        Console.WriteLine("ATENCAO: este comando PODE enviar Shift+F5 real ao NexAdmin.");
        Console.WriteLine("Nao mexa no mouse/teclado durante a execucao.");
        Console.WriteLine();

        var sessionInspector = new WindowsSessionInspector(new Win32SessionNativeApi());
        var session = sessionInspector.CheckSession();

        Console.WriteLine($"[G2] CheckSession() -> Passed={session.Passed} ErrorCode={session.ErrorCode}");
        if (!session.Passed)
        {
            Console.WriteLine("Abortando - sessao do Agent nao esta utilizavel. ZERO input enviado.");
            return;
        }

        var nativeWindows = new Win32NativeWindowApi();
        var windowInspector = new WindowsNexWindowInspector(new Win32NexProcessScanner(), nativeWindows, new UiAutomationNexReader());

        var locate = windowInspector.LocateNexAdmin(session.AgentSessionId!.Value);
        Console.WriteLine($"[G1] LocateNexAdmin() -> Passed={locate.Passed} ErrorCode={locate.ErrorCode} Reason={locate.Reason}");
        if (!locate.Passed)
        {
            Console.WriteLine("Abortando - NexAdmin/TfrmPri nao localizado. ZERO input enviado.");
            return;
        }

        var target = locate.Identity!;
        Console.WriteLine($"     Target: PID={target.ProcessId} HWND=0x{target.MainWindowHandle:X}");

        var safeState = windowInspector.CheckSafeState(target);
        Console.WriteLine($"[G3-G6] CheckSafeState() -> Passed={safeState.Passed} ErrorCode={safeState.ErrorCode} Reason={safeState.Reason}");
        if (!safeState.Passed)
        {
            Console.WriteLine("Abortando - estado nao seguro. ZERO input enviado.");
            return;
        }

        Console.WriteLine();
        Console.WriteLine("Todos os gates PASS. Enviando SendExportShortcut(target) UMA vez...");

        var inputSender = new WindowsInputSender(nativeWindows, new Win32InputNativeApi());
        try
        {
            inputSender.SendExportShortcut(target);
            Console.WriteLine("SendExportShortcut concluido sem excecao (Shift+F5 enviado 1x).");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SendExportShortcut FALHOU: {ex.Message}");
            Console.WriteLine("ZERO segunda tentativa (nunca ha retry).");
        }

        Console.WriteLine();
        Console.WriteLine("=== PROBE ENCERRADO - nenhuma outra acao sera executada (sem Salvar Como/Salvar/Cancelar) ===");
    }
}
