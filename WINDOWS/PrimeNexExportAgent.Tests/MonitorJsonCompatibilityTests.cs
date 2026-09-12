using System.Text.Json;
using Xunit;

namespace PrimeNexExportAgent.Tests;

public sealed class MonitorJsonCompatibilityTests
{
    [Fact]
    public void PipelineParser_UsaSomenteCamposLegadosNomeadosEConverteJsonComTelemetriaAdicional()
    {
        var monitorSource = File.ReadAllText(FindMonitorSource());

        Assert.Contains("ConvertFrom-Json -ErrorAction Stop", monitorSource);
        Assert.Contains("$record.runId", monitorSource);
        Assert.Contains("$record.stage", monitorSource);
        Assert.Contains("[datetimeoffset]$_.timestamp", monitorSource);
        Assert.DoesNotContain(".psobject.Properties", monitorSource, StringComparison.OrdinalIgnoreCase);

        using var json = JsonDocument.Parse("""
            {"timestamp":"2026-09-12T14:40:00.0000000-03:00","runId":"c737ffed-435f-4faf-8179-a25e529ce7fc","stage":"Success","errorCode":null,"fileName":"vendas-auto-20260912-144006.xls","reason":null,"hybridRoute":null,"nexPosition":null,"routeReason":null}
            """);

        var record = json.RootElement;
        Assert.Equal("Success", record.GetProperty("stage").GetString());
        Assert.Equal(JsonValueKind.Null, record.GetProperty("hybridRoute").ValueKind);
        Assert.Equal(JsonValueKind.Null, record.GetProperty("nexPosition").ValueKind);
        Assert.Equal(JsonValueKind.Null, record.GetProperty("routeReason").ValueKind);
    }

    private static string FindMonitorSource()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "WINDOWS", "PrimeNexMonitor", "PrimeNexMonitor.ps1");
            if (File.Exists(candidate)) return candidate;
        }

        throw new FileNotFoundException("PrimeNexMonitor.ps1 nao encontrado a partir do diretorio de testes.");
    }
}
