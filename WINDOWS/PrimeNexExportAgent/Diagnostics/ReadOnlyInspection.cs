using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// Harness de diagnostico SOMENTE LEITURA (F6.14A secao 13-14) para exercitar
/// ISessionInspector/INexWindowInspector reais contra o NEX real, sem
/// nenhum ExportAgentOrchestrator envolvido e sem NENHUMA interface de
/// ACAO (IInputSender/ISaveDialogController) sequer referenciada aqui -
/// essas ainda nao tem implementacao real (F6.14B), entao nao ha caminho
/// de codigo, acidental ou nao, para Shift+F5 a partir deste harness.
/// So imprime resultado no console - nunca grava arquivo, nunca envia
/// tecla/clique/foco.
/// </summary>
internal static class ReadOnlyInspection
{
    public static void Run()
    {
        Console.WriteLine("=== PRIME NEX EXPORT AGENT - INSPECAO READ-ONLY (F6.14A) ===");
        Console.WriteLine("Nenhuma tecla/clique sera enviado. So leitura.");
        Console.WriteLine();

        var sessionInspector = new WindowsSessionInspector(new Win32SessionNativeApi());
        var session = sessionInspector.CheckSession();

        Console.WriteLine("[G2] ISessionInspector.CheckSession()");
        Console.WriteLine($"     Passed     = {session.Passed}");
        Console.WriteLine($"     ErrorCode  = {session.ErrorCode}");
        Console.WriteLine($"     Reason     = {session.Reason}");
        Console.WriteLine($"     SessionId  = {(session.Passed ? session.AgentSessionId!.Value.ToString() : "(n/a)")}");
        Console.WriteLine();

        if (!session.Passed)
        {
            Console.WriteLine("Abortando inspecao - sessao do Agent nao esta utilizavel.");
            return;
        }

        var windowInspector = new WindowsNexWindowInspector(
            new Win32NexProcessScanner(),
            new Win32NativeWindowApi(),
            new UiAutomationNexReader());

        var locate = windowInspector.LocateNexAdmin(session.AgentSessionId!.Value);

        Console.WriteLine("[G1] INexWindowInspector.LocateNexAdmin(expectedSessionId)");
        Console.WriteLine($"     Passed     = {locate.Passed}");
        Console.WriteLine($"     ErrorCode  = {locate.ErrorCode}");
        Console.WriteLine($"     Reason     = {locate.Reason}");
        Console.WriteLine($"     ProcessId  = {(locate.Passed ? locate.Identity!.ProcessId.ToString() : "(n/a)")}");
        Console.WriteLine($"     HWND       = {(locate.Passed ? $"0x{locate.Identity!.MainWindowHandle:X}" : "(n/a)")}");
        Console.WriteLine();

        if (!locate.Passed)
        {
            Console.WriteLine("Abortando inspecao - NexAdmin nao localizado/validado.");
            return;
        }

        var safeState = windowInspector.CheckSafeState(locate.Identity!);

        Console.WriteLine("[G3-G6] INexWindowInspector.CheckSafeState(target)");
        Console.WriteLine($"     Passed     = {safeState.Passed}");
        Console.WriteLine($"     ErrorCode  = {safeState.ErrorCode}");
        Console.WriteLine($"     Reason     = {safeState.Reason}");
        Console.WriteLine();

        Console.WriteLine("=== FIM DA INSPECAO READ-ONLY - nenhuma acao foi executada ===");
    }
}
