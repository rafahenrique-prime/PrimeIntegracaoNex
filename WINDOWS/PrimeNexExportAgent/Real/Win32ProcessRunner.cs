using System.Diagnostics;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (F6.14B2.10A) de IProcessRunner - via
/// System.Diagnostics.Process. Usa ArgumentList (nunca concatenacao de
/// string) para passar o caminho do arquivo literalmente, sem risco de
/// quoting/injecao de argumento. Nunca herda shell (UseShellExecute=false,
/// sem cmd.exe intermediario), nunca abre janela. Se o processo exceder o
/// timeout, e' encerrado (Kill) - isso e' limpeza do proprio subprocesso
/// que este runner iniciou, nunca uma acao de memoria remota contra outro
/// processo, e nunca e' seguido de uma segunda tentativa.
/// </summary>
public sealed class Win32ProcessRunner : IProcessRunner
{
    public ProcessRunResult Run(string fileName, IReadOnlyList<string> arguments, TimeSpan timeout)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in arguments)
        {
            startInfo.ArgumentList.Add(arg);
        }

        using var process = new Process { StartInfo = startInfo };

        try
        {
            if (!process.Start())
            {
                return ProcessRunResult.FailedToStart();
            }
        }
        catch (Exception)
        {
            // Executavel nao encontrado, sem permissao, etc. - fail-closed,
            // nunca tentado de novo aqui (o chamador decide, e nunca chama
            // Run() uma segunda vez para o mesmo Validate()).
            return ProcessRunResult.FailedToStart();
        }

        var stdOutTask = process.StandardOutput.ReadToEndAsync();
        var stdErrTask = process.StandardError.ReadToEndAsync();

        var exited = process.WaitForExit((int)timeout.TotalMilliseconds);
        if (!exited)
        {
            try { process.Kill(entireProcessTree: true); } catch (Exception) { /* melhor esforco - processo pode ja ter saido na corrida */ }
            return new ProcessRunResult(started: true, timedOut: true, exitCode: null, stdOut: string.Empty, stdErr: string.Empty);
        }

        // Garante que os streams terminaram de ser lidos antes de acessar
        // o resultado (evita truncar stdout/stderr em corridas raras).
        stdOutTask.Wait();
        stdErrTask.Wait();

        return new ProcessRunResult(started: true, timedOut: false, exitCode: process.ExitCode, stdOut: stdOutTask.Result, stdErr: stdErrTask.Result);
    }
}
