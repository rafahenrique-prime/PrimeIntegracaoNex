using System.Text.Json;
using PrimeNexExportAgent.Logging;
using PrimeNexExportAgent.Real;
using Xunit;

namespace PrimeNexExportAgent.Tests;

public sealed class ConsoleAgentLoggerTests
{
    [Fact]
    public void Log_PreservaCamposLegadosEAcrescentaTelemetriaOpcional()
    {
        var serialized = ConsoleAgentLogger.Serialize(new AgentLogEvent(
            new DateTime(2026, 9, 12, 14, 40, 0, DateTimeKind.Utc),
            Guid.Parse("c737ffed-435f-4faf-8179-a25e529ce7fc"),
            "Success",
            fileName: "vendas-auto-20260912-144006.xls",
            hybridRoute: "V2",
            nexPosition: "BACKGROUND",
            routeReason: "FOREGROUND_NOT_OWNED_BY_NEX"));

        using var json = JsonDocument.Parse(serialized);
        var root = json.RootElement;
        Assert.Equal("Success", root.GetProperty("stage").GetString());
        Assert.True(root.TryGetProperty("timestamp", out _));
        Assert.True(root.TryGetProperty("runId", out _));
        Assert.True(root.TryGetProperty("errorCode", out _));
        Assert.True(root.TryGetProperty("fileName", out _));
        Assert.True(root.TryGetProperty("reason", out _));
        Assert.Equal("V2", root.GetProperty("hybridRoute").GetString());
        Assert.Equal("BACKGROUND", root.GetProperty("nexPosition").GetString());
        Assert.Equal("FOREGROUND_NOT_OWNED_BY_NEX", root.GetProperty("routeReason").GetString());
    }

    [Fact]
    public void Log_ModoSemContextoMantemTelemetriaNula()
    {
        var serialized = ConsoleAgentLogger.Serialize(new AgentLogEvent(DateTime.UtcNow, Guid.NewGuid(), "Success"));

        using var json = JsonDocument.Parse(serialized);
        var root = json.RootElement;
        Assert.Equal(JsonValueKind.Null, root.GetProperty("hybridRoute").ValueKind);
        Assert.Equal(JsonValueKind.Null, root.GetProperty("nexPosition").ValueKind);
        Assert.Equal(JsonValueKind.Null, root.GetProperty("routeReason").ValueKind);
    }
}
