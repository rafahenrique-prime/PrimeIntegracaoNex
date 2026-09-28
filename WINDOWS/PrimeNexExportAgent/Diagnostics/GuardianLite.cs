using System.IO;
using System.Diagnostics;
using System.Net.Http;
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

internal sealed record GuardianAiDiagnostic(
    [property: JsonPropertyName("classification")] string Classification,
    [property: JsonPropertyName("confidence")] int Confidence,
    [property: JsonPropertyName("summary")] string Summary,
    [property: JsonPropertyName("evidence")] IReadOnlyList<string> Evidence,
    [property: JsonPropertyName("recommended_action")] string RecommendedAction,
    [property: JsonPropertyName("safe_to_auto_fix")] bool SafeToAutoFix,
    [property: JsonPropertyName("needs_human")] bool NeedsHuman);

internal sealed record GuardianUsage(
    [property: JsonPropertyName("timestamp")] DateTimeOffset Timestamp,
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("finish_reason")] string? FinishReason,
    [property: JsonPropertyName("input_tokens")] int? InputTokens,
    [property: JsonPropertyName("output_tokens")] int? OutputTokens,
    [property: JsonPropertyName("latency_ms")] long LatencyMs,
    [property: JsonPropertyName("http_status")] int? HttpStatus,
    [property: JsonPropertyName("success")] bool Success,
    [property: JsonPropertyName("error_code")] string? ErrorCode);

internal sealed record GuardianAnalysisDocument(
    [property: JsonPropertyName("schema_version")] string SchemaVersion,
    [property: JsonPropertyName("generated_at")] DateTimeOffset GeneratedAt,
    [property: JsonPropertyName("diagnostic_source")] string DiagnosticSource,
    [property: JsonPropertyName("ai_called")] bool AiCalled,
    [property: JsonPropertyName("ai_call_count")] int AiCallCount,
    [property: JsonPropertyName("snapshot")] GuardianSnapshot Snapshot,
    [property: JsonPropertyName("diagnostic")] GuardianAiDiagnostic? Diagnostic,
    [property: JsonPropertyName("safe_to_auto_fix_final")] bool SafeToAutoFixFinal,
    [property: JsonPropertyName("error_code")] string? ErrorCode);

internal sealed record GuardianAnalyzeResult(
    GuardianSnapshot Snapshot,
    string DiagnosticSource,
    bool AiCalled,
    int AiCallCount,
    string Model,
    string? FinishReason,
    int? HttpStatus,
    long LatencyMs,
    int? InputTokens,
    int? OutputTokens,
    bool PiiScanPassed,
    GuardianAiDiagnostic? Diagnostic,
    string? ErrorCode,
    string AnalysisPath,
    string UsagePath);

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

    public static bool IsAnalyzeFlag(string[] args) =>
        args.Length == 1 && string.Equals(args[0], "--guardian-analyze", StringComparison.Ordinal);

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

    public static void RunAnalyze()
    {
        var now = DateTimeOffset.Now;
        var nex = ReadCurrentNexState();
        var result = ExecuteAnalyze(
            ProductionLogsPath,
            ProductionStagePath,
            Path.GetTempPath(),
            now,
            nex,
            "UNKNOWN",
            apiKey: null,
            clientFactory: null);

        Console.WriteLine("PRIME_NEX_GUARDIAN_LITE_V0_1=ANALYZE");
        Console.WriteLine($"RULE_CLASSIFICATION={result.Snapshot.RuleResult.ClassificationCandidate}");
        Console.WriteLine($"NEEDS_AI={(result.Snapshot.RuleResult.NeedsAi ? "YES" : "NO")}");
        Console.WriteLine($"DIAGNOSTIC_SOURCE={result.DiagnosticSource}");
        Console.WriteLine($"AI_CALLED={(result.AiCalled ? "TRUE" : "FALSE")}");
        Console.WriteLine($"AI_CALL_COUNT={result.AiCallCount}");
        Console.WriteLine($"MODEL={result.Model}");
        Console.WriteLine($"HTTP_STATUS={result.HttpStatus?.ToString() ?? "UNKNOWN"}");
        Console.WriteLine($"LATENCY_MS={result.LatencyMs}");
        Console.WriteLine($"INPUT_TOKENS={result.InputTokens?.ToString() ?? "UNKNOWN"}");
        Console.WriteLine($"OUTPUT_TOKENS={result.OutputTokens?.ToString() ?? "UNKNOWN"}");
        Console.WriteLine($"PII_SCAN={(result.PiiScanPassed ? "PASS" : "FAIL")}");
        Console.WriteLine($"AI_CLASSIFICATION={result.Diagnostic?.Classification ?? "UNKNOWN"}");
        Console.WriteLine($"AI_CONFIDENCE={result.Diagnostic?.Confidence.ToString() ?? "UNKNOWN"}");
        Console.WriteLine($"AI_SUMMARY={result.Diagnostic?.Summary ?? result.ErrorCode ?? "UNKNOWN"}");
        Console.WriteLine($"AI_EVIDENCE={(result.Diagnostic is null ? "UNKNOWN" : string.Join(" | ", result.Diagnostic.Evidence))}");
        Console.WriteLine($"AI_RECOMMENDED_ACTION={(result.Diagnostic?.RecommendedAction ?? "UNKNOWN")}");
        Console.WriteLine("SAFE_TO_AUTO_FIX_FINAL=FALSE");
        Console.WriteLine($"NEEDS_HUMAN_FINAL={(result.Diagnostic?.NeedsHuman.ToString().ToUpperInvariant() ?? "UNKNOWN")}");
        Console.WriteLine($"ANALYSIS_PATH={result.AnalysisPath}");
        Console.WriteLine($"USAGE_PATH={result.UsagePath}");
        Console.WriteLine($"AI_CALL_BLOCKED_BY_PII_SCAN={(result.ErrorCode == "PII_SCAN_FAILED" ? "YES" : "NO")}");
        Console.WriteLine("RECOMMENDED_ACTION_EXECUTED=NO");
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

    internal static GuardianAnalyzeResult ExecuteAnalyze(
        string logsPath,
        string stagePath,
        string tempRoot,
        DateTimeOffset now,
        GuardianNexState nex,
        string taskState,
        string? apiKey,
        Func<HttpClient>? clientFactory)
    {
        var outputRoot = Path.GetFullPath(Path.Combine(tempRoot, OutputDirectoryName));
        EnsureOutputUnderTemp(outputRoot, tempRoot);
        var snapshot = BuildSnapshot(logsPath, stagePath, now, nex, NormalizeTaskState(taskState));
        var snapshotJson = JsonSerializer.Serialize(snapshot, JsonOptions);
        var prompt = BuildPrompt(snapshotJson);
        var piiSafe = IsSanitized(snapshotJson) && IsSanitized(prompt);
        var model = "deepseek-flash";
        string? finishReason = null;
        GuardianAiDiagnostic? diagnostic = null;
        var diagnosticSource = "RULE";
        var aiCalled = false;
        var aiCallCount = 0;
        int? httpStatus = null;
        long latencyMs = 0;
        int? inputTokens = null;
        int? outputTokens = null;
        string? errorCode = null;

        if (!piiSafe)
        {
            errorCode = "PII_SCAN_FAILED";
        }
        else if (!snapshot.RuleResult.NeedsAi)
        {
            diagnostic = BuildRuleDiagnostic(snapshot.RuleResult);
        }
        else
        {
            diagnosticSource = "AI";
            var resolvedKey = apiKey ?? Environment.GetEnvironmentVariable("DEEPSEEK_API_KEY");
            if (string.IsNullOrWhiteSpace(resolvedKey))
            {
                errorCode = "DEEPSEEK_CONFIG_MISSING";
            }
            else
            {
                aiCalled = true;
                aiCallCount = 1;
                var stopwatch = Stopwatch.StartNew();
                try
                {
                    using var client = clientFactory?.Invoke() ?? new HttpClient();
                    client.Timeout = TimeSpan.FromSeconds(15);
                    using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.deepseek.com/chat/completions");
                    request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + resolvedKey);
                    var body = new
                    {
                        model,
                        messages = new[]
                        {
                            new { role = "system", content = prompt },
                            new { role = "user", content = "Return the requested diagnostic JSON object." },
                        },
                        response_format = new { type = "json_object" },
                        max_tokens = 1000,
                        stream = false,
                        thinking = new { type = "disabled" },
                    };
                    request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
                    using var response = client.SendAsync(request).GetAwaiter().GetResult();
                    httpStatus = (int)response.StatusCode;
                    if (!response.IsSuccessStatusCode)
                    {
                        errorCode = "HTTP_STATUS_" + httpStatus.Value;
                    }
                    else
                    {
                        var responseText = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                        if (!TryParseAiResponse(responseText, out diagnostic, out finishReason, out inputTokens, out outputTokens, out errorCode))
                        {
                            diagnostic = null;
                        }
                    }
                }
                catch (TaskCanceledException)
                {
                    errorCode = "TIMEOUT";
                }
                catch (HttpRequestException)
                {
                    errorCode = "HTTP_EXCEPTION";
                }
                catch (JsonException)
                {
                    errorCode = "INVALID_RESPONSE_JSON";
                }
                catch
                {
                    errorCode = "ANALYZE_FAILED";
                }
                finally
                {
                    stopwatch.Stop();
                    latencyMs = stopwatch.ElapsedMilliseconds;
                }
            }
        }

        Directory.CreateDirectory(outputRoot);
        var stamp = now.ToUniversalTime().ToString("yyyyMMdd-HHmmss-fff");
        var analysisPath = Path.Combine(outputRoot, $"guardian-analysis-{stamp}.json");
        var usagePath = Path.Combine(outputRoot, $"guardian-usage-{stamp}.json");
        var analysis = new GuardianAnalysisDocument(
            SchemaVersion, now, diagnosticSource, aiCalled, aiCallCount, snapshot,
            diagnostic, false, errorCode);
        var usage = new GuardianUsage(now, model, finishReason, inputTokens, outputTokens, latencyMs, httpStatus, diagnostic is not null, errorCode);
        File.WriteAllText(analysisPath, JsonSerializer.Serialize(analysis, JsonOptions), new UTF8Encoding(false));
        File.WriteAllText(usagePath, JsonSerializer.Serialize(usage, JsonOptions), new UTF8Encoding(false));
        return new GuardianAnalyzeResult(snapshot, diagnosticSource, aiCalled, aiCallCount, model, finishReason, httpStatus, latencyMs, inputTokens, outputTokens, piiSafe, diagnostic, errorCode, analysisPath, usagePath);
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
        Analyze only the sanitized technical snapshot below. Return exactly ONE RFC 8259 JSON object: no Markdown, ```json, code fences, comments, or text before or after it. Use double quotes for property names and strings; no trailing commas.
        Use exactly this schema (example values show form/types only; do not copy values):
        {
          "classification": "AMBIGUOUS",
          "confidence": 50,
          "summary": "Short text.",
          "evidence": ["Technical evidence 1", "Technical evidence 2"],
          "recommended_action": "Recommended action for a human only.",
          "safe_to_auto_fix": false,
          "needs_human": true
        }
        Do not add fields or omit fields. confidence must be an integer 0-100; evidence must be a JSON array of strings; safe_to_auto_fix must be boolean false; needs_human must be boolean.
        Allowed classifications: UI_FOREGROUND, UI_UNSAFE_STATE, NEX_MINIMIZED, NEX_CLOSED,
        G13_RESIDUE, VALIDATOR, TASK, NETWORK, DOWNSTREAM, FILE, AMBIGUOUS, UNKNOWN.
        Do not invent evidence. Use AMBIGUOUS or UNKNOWN when evidence is insufficient or contradictory.
        safe_to_auto_fix must always be false. Never request or perform destructive or automatic corrective actions.
        SNAPSHOT:
        {{sanitizedSnapshotJson}}
        """;

    private static readonly HashSet<string> AllowedClassifications = new(StringComparer.Ordinal)
    {
        "UI_FOREGROUND", "UI_UNSAFE_STATE", "NEX_MINIMIZED", "NEX_CLOSED", "G13_RESIDUE",
        "VALIDATOR", "TASK", "NETWORK", "DOWNSTREAM", "FILE", "AMBIGUOUS", "UNKNOWN",
    };

    private static GuardianAiDiagnostic BuildRuleDiagnostic(GuardianRuleResult rule)
    {
        var summary = rule.ClassificationCandidate switch
        {
            "NEX_CLOSED" => "Regra local confirmou que o NEX está fechado.",
            "NEX_MINIMIZED" => "Regra local confirmou que o NEX está minimizado.",
            "G13_RESIDUE" => "Regra local identificou resíduo elegível do G13.",
            _ => "Regra local não encontrou evidência determinística suficiente para uma conclusão única.",
        };
        return new GuardianAiDiagnostic(
            rule.ClassificationCandidate,
            100,
            summary,
            rule.Evidence,
            "Nenhuma ação automática; manter somente observação read-only.",
            false,
            true);
    }

    private static bool TryParseAiResponse(
        string responseText,
        out GuardianAiDiagnostic? diagnostic,
        out string? finishReason,
        out int? inputTokens,
        out int? outputTokens,
        out string? errorCode)
    {
        diagnostic = null;
        finishReason = null;
        inputTokens = null;
        outputTokens = null;
        errorCode = null;
        try
        {
            using var rootDocument = JsonDocument.Parse(responseText);
            var root = rootDocument.RootElement;
            if (root.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
            {
                if (usage.TryGetProperty("prompt_tokens", out var promptTokens) && promptTokens.TryGetInt32(out var input)) inputTokens = input;
                if (usage.TryGetProperty("completion_tokens", out var completionTokens) && completionTokens.TryGetInt32(out var output)) outputTokens = output;
            }

            if (!root.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0)
            {
                errorCode = "EMPTY_RESPONSE";
                return false;
            }

            var choice = choices[0];
            var rawFinishReason = choice.TryGetProperty("finish_reason", out var finish) && finish.ValueKind == JsonValueKind.String
                ? finish.GetString()
                : null;
            finishReason = SafeEnum(rawFinishReason, "UNKNOWN");
            if (!string.Equals(rawFinishReason, "stop", StringComparison.OrdinalIgnoreCase))
            {
                errorCode = string.Equals(rawFinishReason, "length", StringComparison.OrdinalIgnoreCase)
                    ? "TRUNCATED_RESPONSE"
                    : "UNEXPECTED_FINISH_REASON";
                return false;
            }

            if (!choice.TryGetProperty("message", out var message) ||
                !message.TryGetProperty("content", out var content) ||
                content.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(content.GetString()))
            {
                errorCode = "EMPTY_RESPONSE";
                return false;
            }

            if (!TryValidateDiagnostic(content.GetString()!, out diagnostic, out errorCode)) return false;
            diagnostic = diagnostic! with { SafeToAutoFix = false };
            return true;
        }
        catch (JsonException)
        {
            errorCode = "INVALID_RESPONSE_JSON";
            return false;
        }
    }

    private static bool TryValidateDiagnostic(string content, out GuardianAiDiagnostic? diagnostic, out string? errorCode)
    {
        diagnostic = null;
        errorCode = null;
        try
        {
            using var document = JsonDocument.Parse(content);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                errorCode = "INVALID_DIAGNOSTIC_SCHEMA";
                return false;
            }

            var required = new[] { "classification", "confidence", "summary", "evidence", "recommended_action", "safe_to_auto_fix", "needs_human" };
            if (required.Any(name => !root.TryGetProperty(name, out _)))
            {
                errorCode = "INVALID_DIAGNOSTIC_SCHEMA";
                return false;
            }

            diagnostic = JsonSerializer.Deserialize<GuardianAiDiagnostic>(content, JsonOptions);
            if (diagnostic is null || !AllowedClassifications.Contains(diagnostic.Classification) ||
                diagnostic.Confidence is < 0 or > 100 ||
                string.IsNullOrWhiteSpace(diagnostic.Summary) || diagnostic.Summary.Length > 1000 ||
                diagnostic.Evidence is null || diagnostic.Evidence.Count > 8 ||
                diagnostic.Evidence.Any(e => string.IsNullOrWhiteSpace(e) || e.Length > 300) ||
                string.IsNullOrWhiteSpace(diagnostic.RecommendedAction) || diagnostic.RecommendedAction.Length > 1000)
            {
                diagnostic = null;
                errorCode = "INVALID_DIAGNOSTIC_SCHEMA";
                return false;
            }

            return true;
        }
        catch (JsonException)
        {
            errorCode = "INVALID_DIAGNOSTIC_JSON";
            return false;
        }
    }

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
        var blockedTerms = new[] { "DEEPSEEK_API_KEY", "NEX_PRIME_INTEGRATION_SECRET", "Authorization:", "Bearer ", @"C:\Users\", @"C:\\Users\\" };
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
