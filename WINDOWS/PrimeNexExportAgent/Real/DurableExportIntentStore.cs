using System.IO;
using System.Text;
using System.Text.Json;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;

namespace PrimeNexExportAgent.Real;

/// <summary>Append-only JSONL evidence of an export expected by the Agent.
/// The record is flushed through the FileStream before the caller is allowed
/// to dispatch the Save action. Malformed or partial records fail closed.</summary>
public sealed class DurableExportIntentStore : IExportIntentStore
{
    private readonly string _path;
    private readonly Action<FileStream>? _flush;

    public DurableExportIntentStore(string path, Action<FileStream>? flush = null)
    {
        _path = path;
        _flush = flush;
    }

    public bool RecordExpected(DurableExportIntent intent, out string reason) =>
        Append(new
        {
            recordType = "ExpectedExport",
            runId = intent.RunId,
            correlationId = intent.CorrelationId,
            expectedBasename = intent.ExpectedBasename,
            expectedExtension = intent.ExpectedExtension,
            createdAtUtc = intent.CreatedAtUtc.ToUniversalTime().ToString("O"),
            state = "ExpectedExport",
        }, out reason);

    public bool Resolve(DurableExportIntent intent, out string reason) =>
        Append(new
        {
            recordType = "Resolved",
            runId = intent.RunId,
            correlationId = intent.CorrelationId,
            expectedBasename = intent.ExpectedBasename,
            expectedExtension = intent.ExpectedExtension,
            resolvedAtUtc = DateTime.UtcNow.ToString("O"),
            state = "Resolved",
        }, out reason);

    public DurableIntentLookup FindPending(string expectedBasename)
    {
        if (!File.Exists(_path)) return DurableIntentLookup.Missing();

        var pending = new List<DurableExportIntent>();
        var resolved = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (var line in File.ReadLines(_path))
            {
                if (string.IsNullOrWhiteSpace(line))
                    return DurableIntentLookup.Invalid("linha vazia no durable intent");
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                var type = RequiredString(root, "recordType");
                var basename = RequiredString(root, "expectedBasename");
                var runId = RequiredGuid(root, "runId");
                var correlationId = RequiredGuid(root, "correlationId");
                if (type == "ExpectedExport")
                {
                    var extension = RequiredString(root, "expectedExtension");
                    var createdAt = DateTime.Parse(RequiredString(root, "createdAtUtc"), null, System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();
                    if (!string.Equals(RequiredString(root, "state"), "ExpectedExport", StringComparison.Ordinal))
                        return DurableIntentLookup.Invalid("estado de durable intent inconsistente");
                    if (string.Equals(basename, expectedBasename, StringComparison.OrdinalIgnoreCase))
                        pending.Add(new DurableExportIntent(runId, correlationId, basename, extension, createdAt, "ExpectedExport"));
                }
                else if (type == "Resolved")
                {
                    if (!string.Equals(RequiredString(root, "state"), "Resolved", StringComparison.Ordinal))
                        return DurableIntentLookup.Invalid("resolucao de durable intent inconsistente");
                    resolved.Add(Key(runId, basename));
                }
                else
                {
                    return DurableIntentLookup.Invalid("tipo de durable intent desconhecido");
                }
            }
        }
        catch (Exception ex)
        {
            return DurableIntentLookup.Invalid($"durable intent invalido ou truncado: {ex.Message}");
        }

        pending.RemoveAll(x => resolved.Contains(Key(x.RunId, x.ExpectedBasename)));
        if (pending.Count == 0) return DurableIntentLookup.Missing();
        if (pending.Count != 1) return DurableIntentLookup.Invalid("mais de um durable intent pendente para o basename");
        return DurableIntentLookup.FoundIntent(pending[0]);
    }

    private bool Append(object value, out string reason)
    {
        try
        {
            var directory = Path.GetDirectoryName(Path.GetFullPath(_path));
            if (string.IsNullOrEmpty(directory)) throw new IOException("diretorio do durable intent ausente");
            Directory.CreateDirectory(directory);
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
            reason = $"falha ao persistir durable intent: {ex.Message}";
            return false;
        }
    }

    private static string Key(Guid runId, string basename) => $"{runId:N}|{basename}";
    private static string RequiredString(JsonElement root, string name) => root.GetProperty(name).GetString() ?? throw new FormatException($"campo {name} vazio");
    private static Guid RequiredGuid(JsonElement root, string name) => Guid.Parse(root.GetProperty(name).GetString() ?? throw new FormatException($"campo {name} vazio"));
}
