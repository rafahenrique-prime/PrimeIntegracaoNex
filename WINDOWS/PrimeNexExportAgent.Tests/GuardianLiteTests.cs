using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.CompilerServices;
using System.Text.Json;
using PrimeNexExportAgent.Diagnostics;
using Xunit;

namespace PrimeNexExportAgent.Tests;

public sealed class GuardianLiteTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "PrimeNexGuardianTests-" + Guid.NewGuid().ToString("N"));
    private string Logs => Path.Combine(_root, "LOGS");
    private string Stage => Path.Combine(_root, "EXPORT_STAGE");
    private string Temp => Path.Combine(_root, "TEMP");
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-09-28T17:00:00-03:00");

    public GuardianLiteTests()
    {
        Directory.CreateDirectory(Logs);
        Directory.CreateDirectory(Stage);
        Directory.CreateDirectory(Temp);
    }

    [Fact]
    public void AgrupaRunId_LimitaDez_CalculaDuracaoUltimoSuccessEStreak()
    {
        var lines = new List<string>();
        for (var i = 0; i < 12; i++)
        {
            var id = Guid.NewGuid();
            var start = Now.AddMinutes(-60 + i * 2);
            lines.Add(Log(start, id, "Start"));
            lines.Add(Log(start.AddSeconds(2), id, i == 5 ? "Success" : "UnsafeState", i == 5 ? null : "UnsafeState", "aba 'Vendas' nao encontrada na arvore de UI Automation"));
        }
        File.WriteAllLines(Path.Combine(Logs, "prime-nex-export-agent-scheduled-2026-09-28.jsonl"), lines);

        var snapshot = GuardianLite.BuildSnapshot(Logs, Stage, Now, new GuardianNexState("OPEN", "BACKGROUND"), "UNKNOWN");

        Assert.Equal(10, snapshot.LastCycles.Count);
        Assert.Equal(2_000, snapshot.LastCycles[0].DurationMs);
        Assert.Equal(49, snapshot.LastSuccessAgeMinutes);
        Assert.Equal(6, snapshot.CyclesWithoutExport);
        Assert.Equal("UnsafeState", snapshot.DominantReason);
    }

    [Theory]
    [InlineData("CLOSED", "UNKNOWN", "NEX_CLOSED")]
    [InlineData("OPEN", "MINIMIZED", "NEX_MINIMIZED")]
    public void RegrasLocaisDeNexSaoDeterministicas(string state, string position, string expected)
    {
        var result = GuardianLite.Classify(new GuardianNexState(state, position), new GuardianG13State("CLEAN", 0, 0), Array.Empty<GuardianCycle>(), 0);
        Assert.Equal(expected, result.ClassificationCandidate);
        Assert.False(result.SafeToAutoFix);
        Assert.False(result.NeedsAi);
    }

    [Fact]
    public void G13ResidueSoClassifica_NuncaExecutaRecovery()
    {
        var result = GuardianLite.Classify(new GuardianNexState("OPEN", "BACKGROUND"), new GuardianG13State("RESIDUE_ELIGIBLE", 1, 1), Array.Empty<GuardianCycle>(), 0);
        Assert.Equal("G13_RESIDUE", result.ClassificationCandidate);
        Assert.False(result.SafeToAutoFix);
        Assert.False(result.NeedsAi);
    }

    [Fact]
    public void IncidenteContraditorioPermaneceAmbiguo()
    {
        var cycles = new[]
        {
            Cycle("SkippedNotForeground", "NotForeground", "NOT_FOREGROUND", "V1", "FOREGROUND"),
            Cycle("Failed", "UnexpectedException", "EXPORT_ITEM_NOT_FOUND", "V2", "BACKGROUND"),
            Cycle("NEX_MINIMIZED", "NONE", "NEX_MINIMIZED_CONFIRMED", "NONE", "MINIMIZED"),
        };
        var result = GuardianLite.Classify(new GuardianNexState("OPEN", "BACKGROUND"), new GuardianG13State("CLEAN", 0, 0), cycles, 1);
        Assert.Equal("AMBIGUOUS", result.ClassificationCandidate);
        Assert.True(result.NeedsAi);
        Assert.False(result.SafeToAutoFix);
    }

    [Fact]
    public void AllowlistRemovePiiSecretPathEReasonDesconhecido_DoSnapshotEDoPrompt()
    {
        var secretName = "DEEP" + "SEEK_API_KEY";
        var raw = $"Cliente Fulano (11) 99999-8888 CPF 123.456.789-00 CNPJ 12.345.678/0001-90 C:\\Users\\fulano {secretName}=nao-vazar";
        var id = Guid.NewGuid();
        File.WriteAllText(Path.Combine(Logs, "prime-nex-export-agent-scheduled-2026-09-28.jsonl"), Log(Now, id, "Failed", "UnexpectedException", raw));

        var result = GuardianLite.ExecuteDryRun(Logs, Stage, Temp, Now, new GuardianNexState("OPEN", "BACKGROUND"), "UNKNOWN");
        var snapshot = File.ReadAllText(result.SnapshotPath);
        var prompt = File.ReadAllText(result.PromptPath);

        Assert.Contains("UNKNOWN_REASON", snapshot);
        Assert.DoesNotContain(raw, snapshot);
        Assert.DoesNotContain("Fulano", snapshot);
        Assert.DoesNotContain("123.456.789-00", prompt);
        Assert.DoesNotContain("12.345.678/0001-90", prompt);
        Assert.DoesNotContain("99999-8888", prompt);
        Assert.DoesNotContain(@"C:\Users\", prompt);
        Assert.DoesNotContain(secretName, prompt);
        Assert.True(result.PiiScanPassed);
    }

    [Fact]
    public void DryRunNaoLeDeepSeekNaoTemHttpESoEscreveSobTemp()
    {
        var old = Environment.GetEnvironmentVariable("DEEPSEEK_API_KEY");
        Environment.SetEnvironmentVariable("DEEPSEEK_API_KEY", "sentinela-nao-pode-vazar");
        try
        {
            var result = GuardianLite.ExecuteDryRun(Logs, Stage, Temp, Now, new GuardianNexState("UNKNOWN", "UNKNOWN"), "READY");
            Assert.StartsWith(Path.GetFullPath(Path.Combine(Temp, "PrimeNexGuardian")), result.SnapshotPath, StringComparison.OrdinalIgnoreCase);
            Assert.StartsWith(Path.GetFullPath(Path.Combine(Temp, "PrimeNexGuardian")), result.PromptPath, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("sentinela-nao-pode-vazar", File.ReadAllText(result.PromptPath));
            Assert.Contains("safe_to_auto_fix must always be false", File.ReadAllText(result.PromptPath));
            Assert.False(result.Snapshot.AiCalled);
        }
        finally { Environment.SetEnvironmentVariable("DEEPSEEK_API_KEY", old); }

        var source = File.ReadAllText(FindRepoFile(new[] { "WINDOWS", "PrimeNexExportAgent", "Diagnostics", "GuardianLite.cs" }));
        var dryRunStart = source.IndexOf("public static void RunDryRun", StringComparison.Ordinal);
        var executeStart = source.IndexOf("internal static GuardianDryRunResult ExecuteDryRun", StringComparison.Ordinal);
        var dryRunSource = source.Substring(dryRunStart, executeStart - dryRunStart);
        Assert.DoesNotContain("GetEnvironmentVariable", dryRunSource);
        Assert.DoesNotContain("HttpClient", dryRunSource);
    }

    [Fact]
    public void PromptExigeJsonEstritoComContratoCompleto()
    {
        var prompt = GuardianLite.BuildPrompt("{}");

        Assert.Contains("exactly ONE RFC 8259 JSON object", prompt);
        Assert.Contains("no Markdown, ```json, code fences, comments, or text before or after it", prompt);
        Assert.Contains("Use double quotes for property names and strings; no trailing commas.", prompt);
        Assert.Contains("\"classification\": \"AMBIGUOUS\"", prompt);
        Assert.Contains("\"confidence\": 50", prompt);
        Assert.Contains("\"summary\": \"Short text.\"", prompt);
        Assert.Contains("\"evidence\": [\"Technical evidence 1\", \"Technical evidence 2\"]", prompt);
        Assert.Contains("\"recommended_action\": \"Recommended action for a human only.\"", prompt);
        Assert.Contains("\"safe_to_auto_fix\": false", prompt);
        Assert.Contains("\"needs_human\": true", prompt);
        Assert.Contains("Do not add fields or omit fields.", prompt);
        Assert.Contains("confidence must be an integer 0-100", prompt);
        Assert.Contains("evidence must be a JSON array of strings", prompt);
        Assert.Contains("safe_to_auto_fix must be boolean false", prompt);
        Assert.Contains("needs_human must be boolean", prompt);
        Assert.Contains("UI_FOREGROUND", prompt);
        Assert.Contains("UNKNOWN", prompt);
    }

    [Fact]
    public void Analyze_RegraDeterministicaNaoFazHttpNemLeChave()
    {
        var handler = new CountingHandler(_ => throw new InvalidOperationException("HTTP nao deveria ser chamado"));
        var result = GuardianLite.ExecuteAnalyze(Logs, Stage, Temp, Now,
            new GuardianNexState("CLOSED", "UNKNOWN"), "UNKNOWN", null,
            () => new HttpClient(handler));

        Assert.Equal("RULE", result.DiagnosticSource);
        Assert.False(result.AiCalled);
        Assert.Equal(0, result.AiCallCount);
        Assert.Equal(0, handler.Calls);
        Assert.Equal("NEX_CLOSED", result.Diagnostic!.Classification);
        Assert.False(result.Diagnostic.SafeToAutoFix);
    }

    [Fact]
    public void Analyze_AmbiguoFazExatamenteUmaChamadaEValidaJson()
    {
        WriteAmbiguousLogs();
        var handler = new CountingHandler(_ => JsonResponse("UI_UNSAFE_STATE", 92, "Instabilidade de estado/UI do NEX."));
        var result = AnalyzeWith(handler);

        Assert.Equal("AI", result.DiagnosticSource);
        Assert.True(result.AiCalled);
        Assert.Equal(1, result.AiCallCount);
        Assert.Equal(1, handler.Calls);
        Assert.Equal(HttpStatusCode.OK, handler.StatusCode);
        Assert.Contains("\"max_tokens\":1000", handler.RequestBody);
        Assert.Contains("\"response_format\":{\"type\":\"json_object\"}", handler.RequestBody);
        Assert.Contains("\"thinking\":{\"type\":\"disabled\"}", handler.RequestBody);
        Assert.Equal("stop", result.FinishReason);
        Assert.Equal("UI_UNSAFE_STATE", result.Diagnostic!.Classification);
        Assert.Equal(92, result.Diagnostic.Confidence);
        Assert.Equal(12, result.InputTokens);
        Assert.Equal(8, result.OutputTokens);
    }

    [Fact]
    public void Analyze_ChaveAusenteFalhaControladoSemHttp()
    {
        WriteAmbiguousLogs();
        var old = Environment.GetEnvironmentVariable("DEEPSEEK_API_KEY");
        Environment.SetEnvironmentVariable("DEEPSEEK_API_KEY", null);
        try
        {
            var handler = new CountingHandler(_ => throw new InvalidOperationException());
            var result = GuardianLite.ExecuteAnalyze(Logs, Stage, Temp, Now,
                new GuardianNexState("OPEN", "BACKGROUND"), "UNKNOWN", null,
                () => new HttpClient(handler));
            Assert.Equal("DEEPSEEK_CONFIG_MISSING", result.ErrorCode);
            Assert.False(result.AiCalled);
            Assert.Equal(0, handler.Calls);
        }
        finally { Environment.SetEnvironmentVariable("DEEPSEEK_API_KEY", old); }
    }

    [Fact]
    public void Analyze_NuncaPersisteAuthorizationNemRecommendedActionExecutada()
    {
        WriteAmbiguousLogs();
        var handler = new CountingHandler(_ => ResponseWithRawField());
        var result = AnalyzeWith(handler, "secret-value-that-must-not-appear");
        var analysis = File.ReadAllText(result.AnalysisPath);
        var usage = File.ReadAllText(result.UsagePath);

        Assert.DoesNotContain("secret-value-that-must-not-appear", analysis);
        Assert.DoesNotContain("secret-value-that-must-not-appear", usage);
        Assert.DoesNotContain("Authorization", analysis, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Authorization", usage, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("RAW_RESPONSE_SENTINEL", analysis);
        Assert.DoesNotContain("RAW_RESPONSE_SENTINEL", usage);
        Assert.False(File.Exists(Path.Combine(Temp, "SHOULD_NOT_RUN")));
    }

    [Theory]
    [InlineData("not-json", "INVALID_RESPONSE_JSON")]
    [InlineData("{\"choices\":[],\"usage\":{}}", "EMPTY_RESPONSE")]
    [InlineData("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"```json\\n{}\"}}]}", "INVALID_DIAGNOSTIC_JSON")]
    [InlineData("{\"choices\":[{\"finish_reason\":\"length\",\"message\":{\"content\":\"{}\"}}]}", "TRUNCATED_RESPONSE")]
    [InlineData("{\"choices\":[{\"finish_reason\":\"content_filter\",\"message\":{\"content\":\"{}\"}}]}", "UNEXPECTED_FINISH_REASON")]
    [InlineData("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"{\\\"classification\\\":\\\"NOT_ALLOWED\\\",\\\"confidence\\\":50,\\\"summary\\\":\\\"x\\\",\\\"evidence\\\":[],\\\"recommended_action\\\":\\\"x\\\",\\\"safe_to_auto_fix\\\":true,\\\"needs_human\\\":true}\"}}]}", "INVALID_DIAGNOSTIC_SCHEMA")]
    [InlineData("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"{\\\"classification\\\":\\\"UNKNOWN\\\",\\\"confidence\\\":101,\\\"summary\\\":\\\"x\\\",\\\"evidence\\\":[],\\\"recommended_action\\\":\\\"x\\\",\\\"safe_to_auto_fix\\\":false,\\\"needs_human\\\":true}\"}}]}", "INVALID_DIAGNOSTIC_SCHEMA")]
    public void Analyze_RespostaInvalidaFalhaFechadoSemRetry(string body, string expectedError)
    {
        WriteAmbiguousLogs();
        var handler = new CountingHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(body),
        });
        var result = AnalyzeWith(handler);
        Assert.Equal(expectedError, result.ErrorCode);
        Assert.Equal(1, handler.Calls);
        Assert.Null(result.Diagnostic);
    }

    [Fact]
    public void Analyze_LengthCapturaFinishReasonEUsageAntesDoFailClosed()
    {
        WriteAmbiguousLogs();
        var handler = new CountingHandler(_ => ResponseWithFinish("length", includeDiagnostic: true, inputTokens: 21, outputTokens: 100));
        var result = AnalyzeWith(handler);
        var usage = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(result.UsagePath));

        Assert.Equal("length", result.FinishReason);
        Assert.Equal("TRUNCATED_RESPONSE", result.ErrorCode);
        Assert.Equal(21, result.InputTokens);
        Assert.Equal(100, result.OutputTokens);
        Assert.Equal("length", usage.GetProperty("finish_reason").GetString());
        Assert.Equal(21, usage.GetProperty("input_tokens").GetInt32());
        Assert.Equal(100, usage.GetProperty("output_tokens").GetInt32());
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public void Analyze_ForcaSafeToAutoFixFalseMesmoQuandoIaRetornaTrue()
    {
        WriteAmbiguousLogs();
        var handler = new CountingHandler(_ => JsonResponse("AMBIGUOUS", 50, "Sinais mistos.", safeToAutoFix: true));
        var result = AnalyzeWith(handler);
        var analysis = File.ReadAllText(result.AnalysisPath);
        Assert.False(result.Diagnostic!.SafeToAutoFix);
        Assert.Contains("\"safe_to_auto_fix_final\": false", analysis);
    }

    [Fact]
    public void Analyze_TimeoutNaoFazRetry()
    {
        WriteAmbiguousLogs();
        var handler = new CountingHandler(_ => throw new TaskCanceledException("timeout"));
        var result = AnalyzeWith(handler);
        Assert.Equal("TIMEOUT", result.ErrorCode);
        Assert.Equal(1, handler.Calls);
        Assert.False(result.Diagnostic is not null);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public void Analyze_Http4xx5xxNaoFazRetry(HttpStatusCode status)
    {
        WriteAmbiguousLogs();
        var handler = new CountingHandler(_ => new HttpResponseMessage(status));
        var result = AnalyzeWith(handler);
        Assert.Equal($"HTTP_STATUS_{(int)status}", result.ErrorCode);
        Assert.Equal(1, handler.Calls);
        Assert.Equal((int)status, result.HttpStatus);
    }

    [Fact]
    public void Analyze_PiiScanFailImpedeHttp()
    {
        WriteAmbiguousLogs();
        var handler = new CountingHandler(_ => throw new InvalidOperationException());
        var result = GuardianLite.ExecuteAnalyze(Logs, Stage, Temp, Now,
            new GuardianNexState(@"C:\Users\nao-enviar", "BACKGROUND"), "UNKNOWN", "fake-key",
            () => new HttpClient(handler));
        Assert.Equal("PII_SCAN_FAILED", result.ErrorCode);
        Assert.False(result.AiCalled);
        Assert.Equal(0, handler.Calls);
        Assert.False(result.PiiScanPassed);
    }

    [Fact]
    public void Analyze_OutputSomenteSobTemp()
    {
        WriteAmbiguousLogs();
        var handler = new CountingHandler(_ => JsonResponse("UNKNOWN", 10, "Sem conclusao."));
        var result = AnalyzeWith(handler);
        Assert.StartsWith(Path.GetFullPath(Path.Combine(Temp, "PrimeNexGuardian")), result.AnalysisPath, StringComparison.OrdinalIgnoreCase);
        Assert.StartsWith(Path.GetFullPath(Path.Combine(Temp, "PrimeNexGuardian")), result.UsagePath, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ProgramMantemFlagIsoladaAntesDoScheduledHybrid()
    {
        var source = File.ReadAllText(FindRepoFile(new[] { "WINDOWS", "PrimeNexExportAgent", "Program.cs" }));
        var guardian = source.IndexOf("GuardianLite.IsDryRunFlag", StringComparison.Ordinal);
        var hybrid = source.IndexOf("RunOnceScheduledHybridEntrypoint.IsScheduledHybridFlag", StringComparison.Ordinal);
        Assert.True(guardian >= 0 && guardian < hybrid);
        Assert.Contains("GuardianLite.RunDryRun();\n    return;", source.Replace("\r\n", "\n"));
        Assert.True(GuardianLite.IsDryRunFlag(new[] { "--guardian-dry-run" }));
        Assert.False(GuardianLite.IsDryRunFlag(new[] { "--run-once-scheduled-hybrid" }));
    }

    private static GuardianCycle Cycle(string stage, string error, string reason, string route, string position) =>
        new(Now, Guid.NewGuid().ToString(), route, position, stage, error, reason, 1000);

    private void WriteAmbiguousLogs()
    {
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        var third = Guid.NewGuid();
        File.WriteAllLines(Path.Combine(Logs, "prime-nex-export-agent-scheduled-2026-09-28.jsonl"), new[]
        {
            Log(Now.AddMinutes(-3), first, "SkippedNotForeground", "NotForeground", "SCHEDULED-SAFE GATE T3 falhou: NexAdmin nao esta em primeiro plano"),
            Log(Now.AddMinutes(-2), second, "Failed", "UnexpectedException", "item 'Exportar' nao localizado de forma inequivoca"),
            Log(Now.AddMinutes(-1), third, "NEX_MINIMIZED", null, "TApplication (PID 123) IsIconic=true"),
        });
    }

    private GuardianAnalyzeResult AnalyzeWith(CountingHandler handler, string apiKey = "fake-key") =>
        GuardianLite.ExecuteAnalyze(Logs, Stage, Temp, Now,
            new GuardianNexState("OPEN", "BACKGROUND"), "UNKNOWN", apiKey,
            () => new HttpClient(handler));

    private static HttpResponseMessage JsonResponse(string classification, int confidence, string summary, bool safeToAutoFix = false)
    {
        var diagnostic = JsonSerializer.Serialize(new
        {
            classification,
            confidence,
            summary,
            evidence = new[] { "EXPORT_STAGE vazio", "sinais tecnicos correlacionados" },
            recommended_action = "Aguardar e revisar o proximo ciclo.",
            safe_to_auto_fix = safeToAutoFix,
            needs_human = true,
        });
        return ResponseWithDiagnostic("stop", diagnostic, 12, 8);
    }

    private static HttpResponseMessage ResponseWithFinish(string finishReason, bool includeDiagnostic, int inputTokens, int outputTokens)
    {
        var diagnostic = includeDiagnostic ? JsonSerializer.Serialize(new
        {
            classification = "UI_UNSAFE_STATE",
            confidence = 92,
            summary = "Instabilidade de estado/UI do NEX.",
            evidence = new[] { "EXPORT_STAGE vazio" },
            recommended_action = "Aguardar e revisar o proximo ciclo.",
            safe_to_auto_fix = true,
            needs_human = true,
        }) : "{}";
        return ResponseWithDiagnostic(finishReason, diagnostic, inputTokens, outputTokens);
    }

    private static HttpResponseMessage ResponseWithDiagnostic(string finishReason, string diagnostic, int inputTokens, int outputTokens)
    {
        var payload = JsonSerializer.Serialize(new
        {
            choices = new[] { new { finish_reason = finishReason, message = new { content = diagnostic } } },
            usage = new { prompt_tokens = inputTokens, completion_tokens = outputTokens },
        });
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(payload) };
    }

    private static HttpResponseMessage ResponseWithRawField()
    {
        var diagnostic = JsonSerializer.Serialize(new
        {
            classification = "AMBIGUOUS",
            confidence = 70,
            summary = "Sinais contraditorios.",
            evidence = new[] { "sinais tecnicos correlacionados" },
            recommended_action = "Aguardar e revisar o proximo ciclo.",
            safe_to_auto_fix = true,
            needs_human = true,
        });
        var payload = JsonSerializer.Serialize(new
        {
            raw_response = "RAW_RESPONSE_SENTINEL",
            choices = new[] { new { finish_reason = "stop", message = new { content = diagnostic } } },
            usage = new { prompt_tokens = 12, completion_tokens = 8 },
        });
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(payload) };
    }

    private sealed class CountingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _handler;
        public int Calls { get; private set; }
        public HttpStatusCode? StatusCode { get; private set; }
        public string RequestBody { get; private set; } = string.Empty;
        public string? AuthorizationHeader { get; private set; }

        public CountingHandler(Func<HttpRequestMessage, HttpResponseMessage> handler) => _handler = handler;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            RequestBody = request.Content?.ReadAsStringAsync().GetAwaiter().GetResult() ?? string.Empty;
            AuthorizationHeader = request.Headers.Authorization?.ToString();
            var response = _handler(request);
            StatusCode = response.StatusCode;
            return Task.FromResult(response);
        }
    }

    private static string Log(DateTimeOffset timestamp, Guid runId, string stage, string? error = null, string? reason = null) =>
        JsonSerializer.Serialize(new { timestamp = timestamp.ToString("O"), runId, stage, errorCode = error, reason, hybridRoute = "V1", nexPosition = "FOREGROUND", routeReason = "SAFE" });

    private static string FindRepoFile(string[] parts, [CallerFilePath] string testSourcePath = "")
    {
        var testsDirectory = new FileInfo(testSourcePath).Directory;
        var repositoryRoot = testsDirectory?.Parent?.Parent;
        Assert.NotNull(repositoryRoot);
        return Path.Combine(new[] { repositoryRoot!.FullName }.Concat(parts).ToArray());
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }
}
