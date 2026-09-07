using System.Threading;
using PrimeNexExportAgent.Real;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// F6.14B2.12B - helper de teste PURO, sem NENHUMA relacao com NEX/UI/
/// Publisher/downstream. Existe exclusivamente para permitir um teste de
/// integracao offline provar concorrencia REAL entre PROCESSOS do
/// Win32ExecutionLock (nao apenas dois objetos no mesmo processo) -
/// tentar adquirir um Mutex nomeado, opcionalmente segura-lo por um
/// periodo curto controlado, e reportar o resultado por stdout/exit code
/// para o processo de teste que o invocou (via Process.Start).
///
/// Uso: --diagnostic-mutex-hold &lt;nomeDoMutex&gt; &lt;holdMs&gt;
/// stdout: "ACQUIRED" seguido de espera de holdMs, depois "RELEASED"; ou
/// "BUSY" imediatamente se nao conseguir adquirir. Exit code 0 se
/// ACQUIRED+RELEASED, 1 se BUSY.
/// </summary>
internal static class MutexHoldTestHost
{
    public static void Run(string[] args)
    {
        if (args.Length != 2 || !int.TryParse(args[1], out var holdMs))
        {
            Console.WriteLine("Uso: --diagnostic-mutex-hold <nomeDoMutex> <holdMs>");
            Environment.ExitCode = 2;
            return;
        }

        var mutexName = args[0];
        using var executionLock = new Win32ExecutionLock(mutexName);

        if (!executionLock.TryAcquire())
        {
            Console.WriteLine("BUSY");
            Environment.ExitCode = 1;
            return;
        }

        Console.WriteLine("ACQUIRED");
        Console.Out.Flush();
        Thread.Sleep(holdMs);
        executionLock.Release();
        Console.WriteLine("RELEASED");
        Environment.ExitCode = 0;
    }
}
