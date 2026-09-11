using System.Diagnostics;
using System.Text;

namespace PrimeNexScheduledLauncher;

/// <summary>
/// Implementacao REAL de IChildProcessRunner. NUNCA usa cmd.exe/
/// powershell.exe/qualquer shell como intermediario - FileName aponta
/// SEMPRE diretamente para o executavel real (UseShellExecute=false).
/// CreateNoWindow=true garante que nem o processo filho abre janela
/// alguma, mesmo que ele proprio seja um app console (subsystem console) -
/// o pai (este launcher) ja e' WinExe e tambem nunca cria janela.
///
/// Drenagem de stdout/stderr e' ASSINCRONA/CONCORRENTE (BeginOutputReadLine/
/// BeginErrorReadLine, nunca ReadToEnd sincrono) para nunca arriscar
/// deadlock classico (processo filho bloqueado escrevendo num buffer OS
/// cheio enquanto o pai esta bloqueado esperando o processo terminar antes
/// de ler o outro stream).
/// </summary>
public sealed class RealChildProcessRunner : IChildProcessRunner
{
    public ChildProcessResult Run(string fileName, string workingDirectory, string argument) =>
        RunWithArguments(fileName, workingDirectory, argument);

    /// <summary>Variante interna com N argumentos - o contrato publico
    /// (IChildProcessRunner.Run) sempre chama isto com exatamente 1
    /// elemento; exposta para permitir testes de robustez de drenagem de
    /// stdout/stderr (RealChildProcessRunnerTests) contra um processo real
    /// que precisa de mais de um argumento para gerar volume, sem afetar o
    /// contrato de producao.</summary>
    internal static ChildProcessResult RunWithArguments(string fileName, string workingDirectory, params string[] arguments)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in arguments)
        {
            startInfo.ArgumentList.Add(arg);
        }

        using var process = new Process { StartInfo = startInfo };

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();

        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data is not null) stdout.Append(e.Data).Append('\n');
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is not null) stderr.Append(e.Data).Append('\n');
        };

        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        // WaitForExit() sem argumento aguarda tambem o encerramento das
        // threads assincronas de leitura de stdout/stderr (garantia
        // documentada do .NET desde que BeginOutputReadLine/
        // BeginErrorReadLine tenham sido chamados) - por isso os
        // StringBuilder acima ja estao completamente preenchidos quando
        // este metodo retorna, sem necessidade de sincronizacao manual.
        process.WaitForExit();

        return new ChildProcessResult(process.ExitCode, stdout.ToString(), stderr.ToString());
    }
}
