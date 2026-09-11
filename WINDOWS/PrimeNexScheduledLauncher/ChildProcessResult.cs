namespace PrimeNexScheduledLauncher;

/// <summary>Resultado completo e imutavel de uma execucao de processo
/// filho: exit code real + tudo que foi escrito em stdout/stderr, ja
/// totalmente drenado (o processo ja terminou quando este objeto existe -
/// nunca um resultado parcial).</summary>
public sealed class ChildProcessResult
{
    public int ExitCode { get; }
    public string Stdout { get; }
    public string Stderr { get; }

    public ChildProcessResult(int exitCode, string stdout, string stderr)
    {
        ExitCode = exitCode;
        Stdout = stdout;
        Stderr = stderr;
    }
}
