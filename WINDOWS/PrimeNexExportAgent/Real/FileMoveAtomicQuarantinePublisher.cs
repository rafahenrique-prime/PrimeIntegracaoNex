using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;

namespace PrimeNexExportAgent.Real;

public sealed class FileMoveAtomicQuarantinePublisher : IAtomicQuarantinePublisher
{
    private readonly IFileMover _fileMover;
    private readonly string _sourceRoot;
    private readonly string _recoveryRoot;

    public FileMoveAtomicQuarantinePublisher(IFileMover fileMover, string sourceRoot, string recoveryRoot)
    {
        _fileMover = fileMover;
        _sourceRoot = sourceRoot;
        _recoveryRoot = recoveryRoot;
    }

    public PublishResult Publish(string sourcePath, string destinationDirectory)
    {
        try
        {
            var source = Path.GetFullPath(sourcePath);
            var sourceRoot = Path.GetFullPath(_sourceRoot);
            var dest = Path.GetFullPath(destinationDirectory);
            var recoveryRoot = Path.GetFullPath(_recoveryRoot);
            if (!string.Equals(Path.GetDirectoryName(source), sourceRoot, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(Path.GetExtension(source), ".csv", StringComparison.OrdinalIgnoreCase) ||
                !File.Exists(source) || !string.Equals(dest, recoveryRoot, StringComparison.OrdinalIgnoreCase) ||
                !Directory.Exists(dest) || !string.Equals(Path.GetPathRoot(sourceRoot), Path.GetPathRoot(recoveryRoot), StringComparison.OrdinalIgnoreCase))
                return PublishResult.Fail(AgentErrorCode.PublishFailed, "gate de quarantine CSV reprovado");
            var destination = Path.Combine(dest, Path.GetFileName(source));
            if (File.Exists(destination)) return PublishResult.Fail(AgentErrorCode.PublishFailed, "destino de quarantine ja existe");
            _fileMover.Move(source, destination);
            return PublishResult.Ok(destination);
        }
        catch (Exception ex)
        {
            return PublishResult.Fail(AgentErrorCode.PublishFailed, $"move CSV falhou: {ex.Message}");
        }
    }
}
