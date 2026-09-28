using System.IO;
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
        Assert.DoesNotContain("GetEnvironmentVariable", source);
        Assert.DoesNotContain("HttpClient", source);
        Assert.DoesNotContain("api.deepseek.com", source, StringComparison.OrdinalIgnoreCase);
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
