using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;

namespace PrimeNexExportAgent.Real;

/// <summary>Append-only, fail-closed ledger for G13 moves.</summary>
public sealed class RecoveryLedger : IRecoveryLedger
{
    private readonly string _path;
    private readonly Action<FileStream>? _flush;

    public RecoveryLedger(string path, Action<FileStream>? flush = null)
    {
        _path = path;
        _flush = flush;
    }

    public bool IsHealthy(out string reason)
    {
        return TryRead(out _, out reason);
    }

    public bool HasPublishedXlsHash(string sha256, out string reason)
    {
        if (!TryRead(out var states, out reason)) return true;
        var key = XlsKey(NormalizeHash(sha256));
        return states.TryGetValue(key, out _);
    }

    public bool HasCsvRecoveryIncident(Guid runId, Guid correlationId, string fileName, string sha256, out string reason)
    {
        if (!TryRead(out var states, out reason)) return true;
        var key = CsvKey(runId, correlationId, fileName, NormalizeHash(sha256));
        return states.TryGetValue(key, out _);
    }

    public bool AppendIntentPending(Guid runId, Guid correlationId, string fileName, string classification, string sha256, string sourcePath, string destinationPath, out string reason) =>
        Append(runId, correlationId, fileName, classification, sha256, sourcePath, destinationPath, RecoveryLedgerState.IntentPending.ToString(), null, out reason);

    public bool AppendCompleted(Guid runId, Guid correlationId, string fileName, string classification, string sha256, string sourcePath, string destinationPath, out string reason) =>
        Append(runId, correlationId, fileName, classification, sha256, sourcePath, destinationPath, RecoveryLedgerState.Completed.ToString(), null, out reason);

    public bool AppendFailed(Guid runId, Guid correlationId, string fileName, string classification, string sha256, string sourcePath, string destinationPath, string failureReason, out string reason) =>
        Append(runId, correlationId, fileName, classification, sha256, sourcePath, destinationPath, RecoveryLedgerState.Failed.ToString(), failureReason, out reason);

    public bool TryAppendMoveUnknown(Guid runId, Guid correlationId, string fileName, string classification, string sha256, string sourcePath, string destinationPath, string failureReason) =>
        Append(runId, correlationId, fileName, classification, sha256, sourcePath, destinationPath, RecoveryLedgerState.MoveUnknown.ToString(), failureReason, out _);

    private bool Append(Guid runId, Guid correlationId, string fileName, string classification, string sha256, string sourcePath, string destinationPath, string state, string? failureReason, out string reason)
    {
        try
        {
            var hash = NormalizeHash(sha256);
            var directory = Path.GetDirectoryName(Path.GetFullPath(_path));
            if (string.IsNullOrEmpty(directory)) throw new IOException("diretorio do ledger ausente");
            Directory.CreateDirectory(directory);
            var value = new
            {
                recordType = "Recovery",
                runId,
                correlationId,
                fileName,
                classification,
                sha256 = hash,
                sourcePath,
                destinationPath,
                state,
                reason = failureReason,
                timestampUtc = DateTime.UtcNow.ToString("O"),
            };
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value) + Environment.NewLine);
            using var stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
            stream.Write(bytes, 0, bytes.Length);
            if (_flush is not null) _flush(stream);
            else stream.Flush(flushToDisk: true);
            reason = string.Empty;
            return true;
        }
        catch (Exception ex)
        {
            reason = $"falha ao persistir ledger: {ex.Message}";
            return false;
        }
    }

    private bool TryRead(out Dictionary<string, RecoveryLedgerState> states, out string reason)
    {
        states = new Dictionary<string, RecoveryLedgerState>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(_path)) { reason = string.Empty; return true; }
        try
        {
            foreach (var line in File.ReadLines(_path))
            {
                if (string.IsNullOrWhiteSpace(line)) throw new FormatException("linha vazia");
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (!string.Equals(root.GetProperty("recordType").GetString(), "Recovery", StringComparison.Ordinal)) throw new FormatException("recordType desconhecido");
                var hash = NormalizeHash(root.GetProperty("sha256").GetString() ?? string.Empty);
                var runId = Guid.Parse(root.GetProperty("runId").GetString() ?? throw new FormatException("runId vazio"));
                var correlationId = Guid.Parse(root.GetProperty("correlationId").GetString() ?? throw new FormatException("correlationId vazio"));
                var fileName = root.GetProperty("fileName").GetString() ?? throw new FormatException("fileName vazio");
                var classification = root.GetProperty("classification").GetString() ?? throw new FormatException("classification vazia");
                var key = classification switch
                {
                    nameof(AutoRecoveryClassification.FINAL_XLS_ORPHAN) => XlsKey(hash),
                    nameof(AutoRecoveryClassification.TRANSIENT_CSV_ORPHAN) => CsvKey(runId, correlationId, fileName, hash),
                    _ => throw new FormatException("classification desconhecida"),
                };
                var state = Enum.Parse<RecoveryLedgerState>(root.GetProperty("state").GetString() ?? string.Empty, ignoreCase: false);
                if (!states.TryGetValue(key, out var previous))
                {
                    if (state != RecoveryLedgerState.IntentPending) throw new FormatException("ledger sem IntentPending inicial");
                    states.Add(key, state);
                }
                else if (previous == RecoveryLedgerState.IntentPending &&
                    state is RecoveryLedgerState.Completed or RecoveryLedgerState.Failed or RecoveryLedgerState.MoveUnknown)
                {
                    states[key] = state;
                }
                else
                {
                    throw new FormatException("transicao de ledger duplicada ou inconsistente");
                }
            }
            reason = string.Empty;
            return true;
        }
        catch (Exception ex)
        {
            reason = $"ledger invalido ou truncado: {ex.Message}";
            return false;
        }
    }

    private static string NormalizeHash(string value)
    {
        var normalized = value.Trim().ToUpperInvariant();
        if (normalized.Length != 64 || normalized.Any(c => !Uri.IsHexDigit(c))) throw new FormatException("SHA256 invalido");
        return normalized;
    }

    private static string XlsKey(string hash) => $"XLS:{hash}";

    private static string CsvKey(Guid runId, Guid correlationId, string fileName, string hash)
    {
        var basename = Path.GetFileNameWithoutExtension(Path.GetFileName(fileName));
        if (string.IsNullOrWhiteSpace(basename)) throw new FormatException("basename CSV vazio");
        return $"CSV:{runId:N}:{correlationId:N}:{basename.ToUpperInvariant()}:{hash}";
    }
}
