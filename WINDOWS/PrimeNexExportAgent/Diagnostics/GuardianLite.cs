using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Diagnostics;

internal sealed record GuardianCycle(
    [property: JsonPropertyName("timestamp")] DateTimeOffset Timestamp,
    [property: JsonPropertyName("run_id")] string RunId,
    [property: JsonPropertyName("route")] string Route,
    [property: JsonPropertyName("nex_position")] string NexPosition,
    [property: JsonPropertyName("stage")] string Stage,
    [property: JsonPropertyName("error_code")] string ErrorCode,
    [property: JsonPropertyName("reason_code")] string ReasonCode,
    [property: JsonPropertyName("duration_ms")] long DurationMs);

internal sealed record GuardianNexState(
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("position")] string Position);

internal sealed record GuardianG13State(
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("stage_count")] int StageCount,
    [property: JsonPropertyName("pending_intent_count")] int PendingIntentCount);

internal sealed record GuardianRuleResult(
    [property: JsonPropertyName("classification_candidate")] string ClassificationCandidate,
    [property: JsonPropertyName("evidence")] IReadOnlyList<string> Evidence,
    [property: JsonPropertyName("safe_to_auto_fix")] bool SafeToAutoFix,
    [property: JsonPropertyName("needs_ai")] bool NeedsAi);

internal sealed record GuardianSnapshot(
    [property: JsonPropertyName("schema_version")] string SchemaVersion,
    [property: JsonPropertyName("generated_at")] DateTimeOffset GeneratedAt,
    [property: JsonPropertyName("monitor_state")] string MonitorState,
    [property: JsonPropertyName("last_success_age_minutes")] long? LastSuccessAgeMinutes,
    [property: JsonPropertyName("cycles_without_export")] int CyclesWithoutExport,
    [property: JsonPropertyName("dominant_reason")] string DominantReason,
    [property: JsonPropertyName("export_stage_count")] int ExportStageCount,
    [property: JsonPropertyName("task_state")] string TaskState,
    [property: JsonPropertyName("nex")] GuardianNexState Nex,
    [property: JsonPropertyName("g13")] GuardianG13State G13,
    [property: JsonPropertyName("last_cycles")] IReadOnlyList<GuardianCycle> LastCycles,
    [property: JsonPropertyName("rule_result")] GuardianRuleResult RuleResult,
    [property: JsonPropertyName("ai_called")] bool AiCalled);

internal sealed record GuardianDryRunResult(GuardianSnapshot Snapshot, string SnapshotPath, string PromptPath, bool PiiScanPassed);

internal static class GuardianLite
{
    internal const string SchemaVersion = "guardian-lite-v0";
    internal const string ProductionLogsPath = @"C:\Nex\PrimeIntegracaoNex\LOGS";
    internal const string ProductionStagePath = @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE";
    private const string OutputDirectoryName = "PrimeNexGuardian";

    private static readonly HashSet<string> TerminalStages = new(StringComparer.OrdinalIgnoreCase)
    {
        "Success", "Failed", "SkippedBusy", "SkippedSessionUnavailable", "NexNotFound",
        "UnsafeState", "SkippedNotForeground", "NEX_CLOSED", "NEX_MINIMIZED",
        "NEX_BLOCKING_UNKNOWN", "RecoveryCompleted",
    };

    private static readonly HashSet<string> AnomalousStages = new(StringComparer.OrdinalIgnoreCase)
    {
        "UnsafeState", "Failed", "NEX_BLOCKING_UNKNOWN",
    };

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    public static bool IsDryRunFlag(string[] args) =>
        args.Length == 1 && string.Equals(args[0], "--guardian-dry-run", StringComparison.Ordinal);

    public static void RunDryRun()
    {
        var now = DateTimeOffset.Now;
        var nex = ReadCurrentNexState();
        var result = ExecuteDryRun(ProductionLogsPath, ProductionStagePath, Path.GetTempPath(), now, nex, "UNKNOWN");

        Console.WriteLine("PRIME_NEX_GUARDIAN_LITE_V0=DRY_RUN");
        Console.WriteLine("GUARDIAN_FLAG_ISOLATED=YES");
        Console.WriteLine("AI_CALLED=FALSE");
        Console.WriteLine($"SNAPSHOT_PATH={result.SnapshotPath}");
        Console.WriteLine($"PROMPT_PATH={result.PromptPath}");
        Console.WriteLine($"LAST_CYCLES_COUNT={result.Snapshot.LastCycles.Count}");
        Console.WriteLine($"LAST_SUCCESS_AGE_MINUTES={result.Snapshot.LastSuccessAgeMinutes?.ToString() ?? "UNKNOWN"}");
        Console.WriteLine($"CYCLES_WITHOUT_EXPORT={result.Snapshot.CyclesWithoutExport}");
        Console.WriteLine($"DOMINANT_REASON={result.Snapshot.DominantReason}");
        Console.WriteLine($"EXPORT_STAGE_COUNT={result.Snapshot.ExportStageCount}");
        Console.WriteLine($"NEX_STATE={result.Snapshot.Nex.State}");
        Console.WriteLine($"NEX_POSITION={result.Snapshot.Nex.Position}");
        Console.WriteLine($"TASK_STATE={result.Snapshot.TaskState}");
        Console.WriteLine($"RULE_CLASSIFICATION={result.Snapshot.RuleResult.ClassificationCandidate}");
        Console.WriteLine($"NEEDS_AI={(result.Snapshot.RuleResult.NeedsAi ? "YES" : "NO")}");
        Console.WriteLine($"PII_SCAN={(result.PiiScanPassed ? "PASS" : "FAIL")}");
        Console.WriteLine("PRODUCTION_MUTATION=NO");
    }

    internal static GuardianDryRunResult ExecuteDryRun(
        string logsPath,
        string stagePath,
        string tempRoot,
        DateTimeOffset now,
        GuardianNexState nex,
        string taskState)
    {
        var outputRoot = Path.GetFullPath(Path.Combine(tempRoot, OutputDirectoryName));
        EnsureOutputUnderTemp(outputRoot, tempRoot);
        var snapshot = BuildSnapshot(logsPath, stagePath, now, nex, NormalizeTaskState(taskState));
        var snapshotJson = JsonSerializer.Serialize(snapshot, JsonOptions);
        var prompt = BuildPrompt(snapshotJson);
        var piiSafe = IsSanitized(snapshotJson) && IsSanitized(prompt);

        Directory.CreateDirectory(outputRoot);
        var stamp = now.ToUniversalTime().ToString("yyyyMMdd-HHmmss-fff");
        var snapshotPath = Path.Combine(outputRoot, $"guardian-snapshot-{stamp}.json");
        var promptPath = Path.Combine(outputRoot, $"guardian-prompt-{stamp}.txt");
        File.WriteAllText(snapshotPath, snapshotJson, new UTF8Encoding(false));
        File.WriteAllText(promptPath, prompt, new UTF8Encoding(false));
        return new GuardianDryRunResult(snapshot, snapshotPath, promptPath, piiSafe);
    }

    internal static GuardianSnapshot BuildSnapshot(
        string logsPath,
        string stagePath,
        DateTimeOffset now,
        GuardianNexState nex,
        string taskState)
    {
        var cycles = ReadCycles(logsPath);
        var recent = cycles.OrderByDescending(x => x.Timestamp).Take(10).ToArray();
        var lastSuccess = cycles.Where(x => x.Stage == "Success").OrderByDescending(x => x.Timestamp).FirstOrDefault();
        long? successAge = lastSuccess is null ? null : Math.Max(0, (long)Math.Floor((now - lastSuccess.Timestamp).TotalMinutes));

        var streakCycles = cycles.OrderByDescending(x => x.Timestamp).TakeWhile(x => x.Stage != "Success").ToArray();
        var anomalous = streakCycles.Where(x => AnomalousStages.Contains(x.Stage)).ToArray();
        var dominant = anomalous
            .GroupBy(x => x.ErrorCode != "NONE" ? x.ErrorCode : x.ReasonCode, StringComparer.OrdinalIgnoreCase)
            .OrderByDescending(x => x.Count()).ThenBy(x => x.Key, StringComparer.Ordinal)
            .Select(x => x.Key).FirstOrDefault() ?? "NONE";

        var stageCount = SafeFileCount(stagePath);
        var pendingIntents = ReadPendingIntentCount(Path.Combine(logsPath, "g13-export-intents.jsonl"));
        var g13State = stageCount > 0 && pendingIntents > 0 ? "RESIDUE_ELIGIBLE" :
            stageCount > 0 ? "RESIDUE_UNPROVEN" : "CLEAN";
        var g13 = new GuardianG13State(g13State, stageCount, pendingIntents);
        var rule = Classify(nex, g13, recent, anomalous.Length);
        var monitorState = g13State == "RESIDUE_ELIGIBLE" || anomalous.Length >= 10 ? "PROBLEM" :
            anomalous.Length >= 3 ? "ATTENTION" : "NORMAL";

        return new GuardianSnapshot(
            SchemaVersion, now, monitorState, successAge, anomalous.Length, dominant, stageCount,
            taskState, nex, g13, recent, rule, false);
    }

    internal static IReadOnlyList<GuardianCycle> ReadCycles(string logsPath)
    {
        if (!Directory.Exists(logsPath)) return Array.Empty<GuardianCycle>();
        var records = new List<RawRecord>();
        foreach (var file in Directory.EnumerateFiles(logsPath, "prime-nex-export-agent-scheduled-*.jsonl").OrderBy(x => x, StringComparer.Ordinal))
        {
            foreach (var line in File.ReadLines(file))
            {
                if (TryReadRecord(line, out var record)) records.Add(record!);
            }
        }

        return records
            .GroupBy(x => x.RunId, StringComparer.OrdinalIgnoreCase)
            .Select(ProjectCycle)
            .Where(x => x is not null)
            .Cast<GuardianCycle>()
            .OrderByDescending(x => x.Timestamp)
            .ToArray();
    }

    private static GuardianCycle? ProjectCycle(IGrouping<string, RawRecord> group)
    {
        var ordered = group.OrderBy(x => x.Timestamp).ToArray();
        var terminal = ordered.LastOrDefault(x => TerminalStages.Contains(x.Stage));
        if (terminal is null) return null;
        var route = ordered.LastOrDefault(x => x.Route != "NONE");
        return new GuardianCycle(
            terminal.Timestamp, SafeIdentifier(terminal.RunId), SafeEnum(route?.Route, "NONE"),
            SafeEnum(route?.NexPosition, "UNKNOWN"), SafeEnum(terminal.Stage, "UNKNOWN"),
            SafeEnum(terminal.ErrorCode, "NONE"), NormalizeReason(terminal.Reason, terminal.Stage, terminal.ErrorCode),
            Math.Max(0, (long)Math.Round((terminal.Timestamp - ordered[0].Timestamp).TotalMilliseconds)));
    }

    internal static GuardianRuleResult Classify(GuardianNexState nex, GuardianG13State g13, IReadOnlyList<GuardianCycle> recent, int anomalousCount)
    {
        if (g13.State == "RESIDUE_ELIGIBLE")
            return new GuardianRuleResult("G13_RESIDUE", new[] { "EXPORT_STAGE_NONEMPTY", "G13_PENDING_INTENT_PRESENT" }, false, false);
        if (nex.State == "CLOSED")
            return new GuardianRuleResult("NEX_CLOSED", new[] { "NEX_STATE_CLOSED" }, false, false);
        if (nex.Position == "MINIMIZED")
            return new GuardianRuleResult("NEX_MINIMIZED", new[] { "NEX_POSITION_MINIMIZED" }, false, false);

        var signals = recent.Select(x => x.Stage).Where(x => x is "Failed" or "UnsafeState" or "SkippedNotForeground" or "NEX_MINIMIZED").Distinct().Count();
        if (signals > 1)
            return new GuardianRuleResult("AMBIGUOUS", new[] { "MIXED_RECENT_TERMINAL_SIGNALS", $"ANOMALOUS_CYCLES_{anomalousCount}" }, false, true);
        if (anomalousCount > 0)
            return new GuardianRuleResult("UI_UNSAFE_STATE", new[] { "RECENT_UNSAFE_OR_FAILED_CYCLES" }, false, true);
        return new GuardianRuleResult("UNKNOWN", new[] { "INSUFFICIENT_EVIDENCE" }, false, true);
    }

    internal static string BuildPrompt(string sanitizedSnapshotJson) => $$"""
        You are PRIME NEX GUARDIAN LITE V0, a read-only diagnostic assistant.
        Analyze only the sanitized technical snapshot below. Return JSON only with:
        classification, confidence, summary, evidence, recommended_action, safe_to_auto_fix, needs_human.
        Allowed classifications: UI_FOREGROUND, UI_UNSAFE_STATE, NEX_MINIMIZED, NEX_CLOSED,
        G13_RESIDUE, VALIDATOR, TASK, NETWORK, DOWNSTREAM, FILE, AMBIGUOUS, UNKNOWN.
        Do not invent evidence. Use AMBIGUOUS or UNKNOWN when evidence is insufficient or contradictory.
        safe_to_auto_fix must always be false. Never request or perform destructive or automatic corrective actions.
        SNAPSHOT:
        {{sanitizedSnapshotJson}}
        """;

    internal static string NormalizeReason(string? reason, string stage, string? errorCode)
    {
        var value = reason ?? string.Empty;
        if (stage == "NEX_CLOSED" || value.Contains("zero processos NexAdmin", StringComparison.OrdinalIgnoreCase)) return "NEX_CLOSED_CONFIRMED";
        if (stage == "NEX_MINIMIZED" || value.Contains("IsIconic=true", StringComparison.OrdinalIgnoreCase)) return "NEX_MINIMIZED_CONFIRMED";
        if (errorCode == "NotForeground" || value.Contains("nao esta em primeiro plano", StringComparison.OrdinalIgnoreCase)) return "NOT_FOREGROUND";
        if (value.Contains("aba 'Vendas' nao encontrada", StringComparison.OrdinalIgnoreCase)) return "VENDAS_TAB_NOT_FOUND";
        if (value.Contains("item 'Exportar' nao localizado", StringComparison.OrdinalIgnoreCase)) return "EXPORT_ITEM_NOT_FOUND";
        if (value.Contains("Exportar", StringComparison.OrdinalIgnoreCase) && value.Contains("ambigu", StringComparison.OrdinalIgnoreCase)) return "EXPORT_ITEM_AMBIGUOUS";
        if (string.IsNullOrWhiteSpace(value)) return "NONE";
        return "UNKNOWN_REASON";
    }

    internal static bool IsSanitized(string value)
    {
        var blockedTerms = new[] { "DEEPSEEK_API_KEY", "NEX_PRIME_INTEGRATION_SECRET", "Authorization:", "Bearer ", @"C:\Users\" };
        if (blockedTerms.Any(x => value.Contains(x, StringComparison.OrdinalIgnoreCase))) return false;
        if (Regex.IsMatch(value, @"\b\d{3}\.\d{3}\.\d{3}-\d{2}\b")) return false;
        if (Regex.IsMatch(value, @"\b\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}\b")) return false;
        if (Regex.IsMatch(value, @"\(\d{2}\)\s*\d{4,5}-\d{4}")) return false;
        return true;
    }

    private static GuardianNexState ReadCurrentNexState()
    {
        try
        {
            var scanner = new Win32NexProcessScanner();
            var windows = new Win32NativeWindowApi();
            var state = new Win32NexRuntimeStateProbe(scanner, windows).Classify().State;
            if (state == NexRuntimeState.Closed) return new GuardianNexState("CLOSED", "UNKNOWN");
            if (state == NexRuntimeState.Minimized) return new GuardianNexState("OPEN", "MINIMIZED");
            if (state != NexRuntimeState.Open) return new GuardianNexState("UNKNOWN", "UNKNOWN");

            var foreground = new Win32NexClientNavigationNativeApi().GetForegroundWindow();
            var foregroundPid = windows.GetOwningProcessId(foreground);
            var nexPids = scanner.FindProcessesByName("NexAdmin")
                .Where(x => string.Equals(x.ExecutablePath, @"C:\Nex\NexAdmin.exe", StringComparison.OrdinalIgnoreCase))
                .Select(x => x.ProcessId).ToHashSet();
            return new GuardianNexState("OPEN", foregroundPid is not null && nexPids.Contains(foregroundPid.Value) ? "FOREGROUND" : "BACKGROUND");
        }
        catch
        {
            return new GuardianNexState("UNKNOWN", "UNKNOWN");
        }
    }

    private static bool TryReadRecord(string line, out RawRecord? record)
    {
        record = null;
        try
        {
            using var json = JsonDocument.Parse(line);
            var root = json.RootElement;
            var runId = Text(root, "runId");
            var stage = Text(root, "stage");
            if (string.IsNullOrWhiteSpace(runId) || string.IsNullOrWhiteSpace(stage) || !DateTimeOffset.TryParse(Text(root, "timestamp"), out var timestamp)) return false;
            record = new RawRecord(timestamp, runId, stage, Text(root, "errorCode"), Text(root, "reason"), Text(root, "hybridRoute"), Text(root, "nexPosition"));
            return true;
        }
        catch { return false; }
    }

    private static string? Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static int SafeFileCount(string path)
    {
        try { return Directory.Exists(path) ? Directory.EnumerateFiles(path).Count() : 0; }
        catch { return 0; }
    }

    private static int ReadPendingIntentCount(string path)
    {
        if (!File.Exists(path)) return 0;
        var states = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (var line in File.ReadLines(path))
            {
                using var json = JsonDocument.Parse(line);
                var root = json.RootElement;
                var runId = Text(root, "runId");
                var basename = Text(root, "expectedBasename");
                var state = Text(root, "state");
                if (runId is not null && basename is not null && state is not null) states[$"{runId}:{basename}"] = state;
            }
        }
        catch { return 0; }
        return states.Values.Count(x => x.Equals("ExpectedExport", StringComparison.OrdinalIgnoreCase));
    }

    private static void EnsureOutputUnderTemp(string outputRoot, string tempRoot)
    {
        var normalizedTemp = Path.GetFullPath(tempRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var normalizedOutput = Path.GetFullPath(outputRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!normalizedOutput.StartsWith(normalizedTemp, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Guardian output must remain under the supplied TEMP root.");
    }

    private static string SafeIdentifier(string value) => Guid.TryParse(value, out var id) ? id.ToString() : "UNKNOWN";
    private static string SafeEnum(string? value, string fallback) =>
        !string.IsNullOrWhiteSpace(value) && Regex.IsMatch(value, "^[A-Za-z0-9_]+$") ? value : fallback;
    private static string NormalizeTaskState(string value) => value.ToUpperInvariant() is "READY" or "RUNNING" ? value.ToUpperInvariant() : "UNKNOWN";

    private sealed record RawRecord(DateTimeOffset Timestamp, string RunId, string Stage, string? ErrorCode, string? Reason, string? Route, string? NexPosition);
}
