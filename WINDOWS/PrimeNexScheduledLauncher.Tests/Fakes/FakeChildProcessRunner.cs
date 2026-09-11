using PrimeNexScheduledLauncher;

namespace PrimeNexScheduledLauncher.Tests.Fakes;

/// <summary>Fake de IChildProcessRunner - nunca inicia nenhum processo
/// real, nunca toca PrimeNexExportAgent.exe/NEX. Registra a chamada
/// recebida para os testes confirmarem exatamente-1-chamada e o argumento
/// exato passado.</summary>
public sealed class FakeChildProcessRunner : IChildProcessRunner
{
    public int RunCalls { get; private set; }
    public string? LastFileName { get; private set; }
    public string? LastWorkingDirectory { get; private set; }
    public string? LastArgument { get; private set; }

    public ChildProcessResult ResultToReturn { get; set; } = new(0, string.Empty, string.Empty);

    public ChildProcessResult Run(string fileName, string workingDirectory, string argument)
    {
        RunCalls++;
        LastFileName = fileName;
        LastWorkingDirectory = workingDirectory;
        LastArgument = argument;
        return ResultToReturn;
    }
}
