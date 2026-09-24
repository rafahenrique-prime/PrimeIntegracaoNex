using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Logging;

namespace PrimeNexExportAgent.Real;

/// <summary>G13 recovery only for the Hybrid scheduled composition. It never
/// touches NEX/UI and fails closed before any move whenever evidence changes.</summary>
public sealed class FileSystemAutoRecoveryService : IAutoRecoveryService
{
    public static readonly TimeSpan MinimumOrphanAge = TimeSpan.FromMinutes(5);
    private static readonly Regex CanonicalFileName = new(@"^vendas-auto-\d{8}-\d{6}\.(xls|csv)$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    private readonly string _stagePath;
    private readonly string _exportadosPath;
    private readonly string _recoveryPath;
    private readonly IExportStageWatcher _watcher;
    private readonly IExportValidator _validator;
    private readonly IAtomicPublisher _xlsPublisher;
    private readonly IAtomicQuarantinePublisher _csvPublisher;
    private readonly IExportIntentStore _intents;
    private readonly IRecoveryLedger _ledger;
    private readonly IAgentLogger _logger;
    private readonly IClock _clock;

    public FileSystemAutoRecoveryService(
        string stagePath,
        string exportadosPath,
        string recoveryPath,
        IExportStageWatcher watcher,
        IExportValidator validator,
        IAtomicPublisher xlsPublisher,
        IAtomicQuarantinePublisher csvPublisher,
        IExportIntentStore intents,
        IRecoveryLedger ledger,
        IAgentLogger logger,
        IClock clock)
    {
        _stagePath = stagePath;
        _exportadosPath = exportadosPath;
        _recoveryPath = recoveryPath;
        _watcher = watcher;
        _validator = validator;
        _xlsPublisher = xlsPublisher;
        _csvPublisher = csvPublisher;
        _intents = intents;
        _ledger = ledger;
        _logger = logger;
        _clock = clock;
    }

    public AutoRecoveryResult TryRecover(Guid runId, Guid correlationId)
    {
        var classified = Classify(out var sourcePath, out var reason);
        if (classified == AutoRecoveryClassification.EMPTY) return AutoRecoveryResult.Empty();

        var fileName = sourcePath is null ? null : Path.GetFileName(sourcePath);
        Log(runId, correlationId, AgentStage.AutoRecoveryDetected, fileName, $"classification={classified}");
        if (classified == AutoRecoveryClassification.AMBIGUOUS || sourcePath is null)
            return Reject(runId, correlationId, classified, AgentErrorCode.AutoRecoveryRejected, fileName, reason);

        if (!TryEvaluateCandidate(sourcePath, classified, out var candidate, out reason))
            return Reject(runId, correlationId, classified, AgentErrorCode.AutoRecoveryRejected, fileName, reason);

        Log(runId, correlationId, AgentStage.AutoRecoveryEligible, candidate.FileName, $"classification={classified};sha256={candidate.Hash}");
        if (!_ledger.AppendIntentPending(candidate.Intent.RunId, candidate.Intent.CorrelationId, candidate.FileName, classified.ToString(), candidate.Hash, candidate.SourcePath, candidate.DestinationPath, out reason))
            return Reject(runId, correlationId, classified, AgentErrorCode.RecoveryLedgerCorrupt, candidate.FileName, reason);

        if (!Revalidate(candidate, out reason))
        {
            _ledger.AppendFailed(candidate.Intent.RunId, candidate.Intent.CorrelationId, candidate.FileName, classified.ToString(), candidate.Hash, candidate.SourcePath, candidate.DestinationPath, reason, out _);
            return Reject(runId, correlationId, classified, AgentErrorCode.AutoRecoveryRejected, candidate.FileName, reason);
        }

        var publish = classified == AutoRecoveryClassification.FINAL_XLS_ORPHAN
            ? _xlsPublisher.Publish(candidate.SourcePath, _exportadosPath)
            : _csvPublisher.Publish(candidate.SourcePath, _recoveryPath);
        if (!publish.Published || publish.DestinationPath is null)
        {
            var failure = publish.Reason;
            _ledger.AppendFailed(candidate.Intent.RunId, candidate.Intent.CorrelationId, candidate.FileName, classified.ToString(), candidate.Hash, candidate.SourcePath, candidate.DestinationPath, failure, out _);
            return Reject(runId, correlationId, classified, publish.ErrorCode, candidate.FileName, failure);
        }

        bool moveVerified;
        try
        {
            moveVerified = !File.Exists(candidate.SourcePath) && File.Exists(publish.DestinationPath) &&
                string.Equals(HashFile(publish.DestinationPath), candidate.Hash, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            moveVerified = false;
        }
        if (!moveVerified)
        {
            const string failure = "move concluiu em estado nao verificavel";
            _ledger.TryAppendMoveUnknown(candidate.Intent.RunId, candidate.Intent.CorrelationId, candidate.FileName, classified.ToString(), candidate.Hash, candidate.SourcePath, candidate.DestinationPath, failure);
            return Reject(runId, correlationId, classified, AgentErrorCode.RecoveryMoveUnknown, candidate.FileName, failure);
        }

        if (!_ledger.AppendCompleted(candidate.Intent.RunId, candidate.Intent.CorrelationId, candidate.FileName, classified.ToString(), candidate.Hash, candidate.SourcePath, publish.DestinationPath, out reason))
        {
            _ledger.TryAppendMoveUnknown(candidate.Intent.RunId, candidate.Intent.CorrelationId, candidate.FileName, classified.ToString(), candidate.Hash, candidate.SourcePath, publish.DestinationPath, reason);
            return Reject(runId, correlationId, classified, AgentErrorCode.RecoveryMoveUnknown, candidate.FileName, reason);
        }

        var stage = classified == AutoRecoveryClassification.FINAL_XLS_ORPHAN
            ? AgentStage.AutoRecoveryXlsPublished
            : AgentStage.AutoRecoveryCsvQuarantined;
        Log(runId, correlationId, stage, candidate.FileName, $"destination={publish.DestinationPath};sha256={candidate.Hash}");
        return classified == AutoRecoveryClassification.FINAL_XLS_ORPHAN
            ? AutoRecoveryResult.PublishedXls(publish.DestinationPath)
            : AutoRecoveryResult.QuarantinedCsv(publish.DestinationPath);
    }

    private AutoRecoveryClassification Classify(out string? sourcePath, out string reason)
    {
        sourcePath = null;
        try
        {
            var files = Directory.GetFiles(_stagePath);
            if (files.Length == 0) { reason = string.Empty; return AutoRecoveryClassification.EMPTY; }
            if (files.Length != 1) { reason = "EXPORT_STAGE contem mais de um arquivo"; return AutoRecoveryClassification.AMBIGUOUS; }
            sourcePath = files[0];
            var fileName = Path.GetFileName(sourcePath);
            if (!CanonicalFileName.IsMatch(fileName)) { reason = "nome ou extensao nao canonico"; return AutoRecoveryClassification.AMBIGUOUS; }
            var lastWrite = File.GetLastWriteTimeUtc(sourcePath);
            var age = _clock.Now.ToUniversalTime() - lastWrite;
            if (age < TimeSpan.Zero) { reason = "LastWriteTimeUtc no futuro"; return AutoRecoveryClassification.AMBIGUOUS; }
            if (age < MinimumOrphanAge) { reason = "arquivo ainda nao atingiu PT5M"; return AutoRecoveryClassification.AMBIGUOUS; }
            reason = string.Empty;
            return string.Equals(Path.GetExtension(fileName), ".xls", StringComparison.OrdinalIgnoreCase)
                ? AutoRecoveryClassification.FINAL_XLS_ORPHAN
                : AutoRecoveryClassification.TRANSIENT_CSV_ORPHAN;
        }
        catch (Exception ex)
        {
            reason = $"falha ao classificar stage: {ex.Message}";
            return AutoRecoveryClassification.AMBIGUOUS;
        }
    }

    private bool TryEvaluateCandidate(string sourcePath, AutoRecoveryClassification classification, out Candidate candidate, out string reason)
    {
        candidate = default!;
        try
        {
            if (!_ledger.IsHealthy(out reason)) return false;
            var fileName = Path.GetFileName(sourcePath);
            var basename = Path.GetFileNameWithoutExtension(sourcePath);
            if (!CanOpenExclusively(sourcePath)) { reason = "arquivo bloqueado"; return false; }
            var stability = _watcher.WaitForExpectedFileOnly(_stagePath, fileName, TimeSpan.FromSeconds(2));
            if (!stability.Passed) { reason = stability.Reason; return false; }
            var intent = _intents.FindPending(basename);
            if (!intent.Healthy || intent.Ambiguous || !intent.Found || intent.Intent is null || !string.Equals(intent.Intent.ExpectedExtension, ".xls", StringComparison.OrdinalIgnoreCase))
            { reason = intent.Reason; return false; }
            var hash = HashFile(sourcePath);
            var alreadyHandled = classification == AutoRecoveryClassification.FINAL_XLS_ORPHAN
                ? _ledger.HasPublishedXlsHash(hash, out reason)
                : _ledger.HasCsvRecoveryIncident(intent.Intent.RunId, intent.Intent.CorrelationId, fileName, hash, out reason);
            if (alreadyHandled) { reason = string.IsNullOrEmpty(reason) ? "incidente ja tratado pelo ledger" : reason; return false; }
            var destinationDirectory = classification == AutoRecoveryClassification.FINAL_XLS_ORPHAN ? _exportadosPath : _recoveryPath;
            if (classification == AutoRecoveryClassification.TRANSIENT_CSV_ORPHAN)
            {
                if (!Directory.Exists(_recoveryPath)) { reason = "RECOVERY\\EXPORT_STAGE inexistente"; return false; }
                if (File.Exists(Path.Combine(_stagePath, basename + ".xls"))) { reason = "XLS homonimo presente"; return false; }
            }
            var destination = Path.Combine(destinationDirectory, fileName);
            if (File.Exists(destination)) { reason = "destino ja existe"; return false; }
            if (!string.Equals(Path.GetPathRoot(Path.GetFullPath(_stagePath)), Path.GetPathRoot(Path.GetFullPath(destinationDirectory)), StringComparison.OrdinalIgnoreCase))
            { reason = "volumes diferentes"; return false; }
            if (classification == AutoRecoveryClassification.FINAL_XLS_ORPHAN && HashExistsInDirectory(_exportadosPath, hash))
            { reason = "hash ja existe em destino operacional"; return false; }
            if (classification == AutoRecoveryClassification.FINAL_XLS_ORPHAN)
            {
                var validation = _validator.Validate(sourcePath);
                if (!validation.Valid || validation.RecordCount == 0) { reason = validation.Reason; return false; }
            }
            var info = new FileInfo(sourcePath);
            candidate = new Candidate(sourcePath, destination, fileName, basename, hash, info.Length, info.LastWriteTimeUtc, intent.Intent);
            reason = string.Empty;
            return true;
        }
        catch (Exception ex)
        {
            reason = $"falha na elegibilidade: {ex.Message}";
            return false;
        }
    }

    private bool Revalidate(Candidate candidate, out string reason)
    {
        try
        {
            var entries = Directory.GetFiles(_stagePath);
            var info = new FileInfo(candidate.SourcePath);
            var stability = _watcher.WaitForExpectedFileOnly(_stagePath, candidate.FileName, TimeSpan.FromSeconds(2));
            if (entries.Length != 1 || !string.Equals(Path.GetFullPath(entries[0]), Path.GetFullPath(candidate.SourcePath), StringComparison.OrdinalIgnoreCase) ||
                !info.Exists || info.Length != candidate.Length || info.LastWriteTimeUtc != candidate.LastWriteUtc || !CanOpenExclusively(candidate.SourcePath) ||
                !stability.Passed || File.Exists(candidate.DestinationPath) || !string.Equals(HashFile(candidate.SourcePath), candidate.Hash, StringComparison.OrdinalIgnoreCase))
            { reason = "arquivo ou destino mudou antes do move"; return false; }
            var currentIntent = _intents.FindPending(candidate.Basename);
            if (!currentIntent.Healthy || !currentIntent.Found || currentIntent.Intent is null || currentIntent.Intent.RunId != candidate.Intent.RunId || currentIntent.Intent.CorrelationId != candidate.Intent.CorrelationId)
            { reason = "durable intent mudou antes do move"; return false; }
            if (Path.GetExtension(candidate.SourcePath).Equals(".xls", StringComparison.OrdinalIgnoreCase))
            {
                var validation = _validator.Validate(candidate.SourcePath);
                if (!validation.Valid || validation.RecordCount == 0) { reason = "validator reprovou na revalidacao"; return false; }
            }
            reason = string.Empty;
            return true;
        }
        catch (Exception ex)
        {
            reason = $"revalidacao falhou: {ex.Message}";
            return false;
        }
    }

    private AutoRecoveryResult Reject(Guid runId, Guid correlationId, AutoRecoveryClassification classification, AgentErrorCode code, string? fileName, string reason)
    {
        Log(runId, correlationId, AgentStage.AutoRecoveryRejected, fileName, reason);
        if (code != AgentErrorCode.AutoRecoveryRejected)
            Log(runId, correlationId, AgentStage.AutoRecoveryFailed, fileName, reason);
        return AutoRecoveryResult.Rejected(classification, code, reason);
    }

    private void Log(Guid runId, Guid correlationId, AgentStage stage, string? fileName, string? reason) =>
        _logger.Log(new AgentLogEvent(_clock.Now, runId, stage.ToString(), fileName: fileName, reason: reason, correlationId: correlationId));

    private static bool CanOpenExclusively(string path)
    {
        try { using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None); return true; }
        catch { return false; }
    }

    private static string HashFile(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    private static bool HashExistsInDirectory(string directory, string hash)
    {
        if (!Directory.Exists(directory)) return false;
        foreach (var path in Directory.GetFiles(directory))
            if (string.Equals(HashFile(path), hash, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private sealed record Candidate(string SourcePath, string DestinationPath, string FileName, string Basename, string Hash, long Length, DateTime LastWriteUtc, DurableExportIntent Intent);
}
