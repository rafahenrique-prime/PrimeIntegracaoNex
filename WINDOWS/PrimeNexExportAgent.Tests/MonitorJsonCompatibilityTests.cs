using System.Runtime.CompilerServices;
using System.Text.Json;
using Xunit;

namespace PrimeNexExportAgent.Tests;

public sealed class MonitorJsonCompatibilityTests
{
    [Fact]
    public void PipelineParser_UsaSomenteCamposLegadosNomeadosEConverteJsonComTelemetriaAdicional()
    {
        var monitorSource = ReadMonitorSource();

        Assert.Contains("ConvertFrom-Json -ErrorAction Stop", monitorSource);
        Assert.Contains("$record.runId", monitorSource);
        Assert.Contains("$record.stage", monitorSource);
        Assert.Contains("[datetimeoffset]$_.timestamp", monitorSource);
        Assert.Contains("Get-ExportStageSnapshot", monitorSource);
        Assert.Contains("Test-G13CurrentBlock", monitorSource);
        Assert.Contains("Format-Countdown", monitorSource);
        Assert.Contains("Get-FriendlyStage", monitorSource);
        Assert.Contains("GetForegroundWindow", monitorSource);
        Assert.Contains("Exportacao bloqueada: existe arquivo pendente em EXPORT_STAGE.", monitorSource);
        Assert.DoesNotContain(".psobject.Properties", monitorSource, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Enable-ScheduledTask", monitorSource, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Disable-ScheduledTask", monitorSource, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Start-ScheduledTask", monitorSource, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Move-Item", monitorSource, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Copy-Item", monitorSource, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Remove-Item", monitorSource, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("SetForegroundWindow", monitorSource, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("SendInput", monitorSource, StringComparison.OrdinalIgnoreCase);

        using var json = JsonDocument.Parse("""
            {"timestamp":"2026-09-12T14:40:00.0000000-03:00","runId":"c737ffed-435f-4faf-8179-a25e529ce7fc","stage":"Success","errorCode":null,"fileName":"vendas-auto-20260912-144006.xls","reason":null,"hybridRoute":null,"nexPosition":null,"routeReason":null}
            """);

        var record = json.RootElement;
        Assert.Equal("Success", record.GetProperty("stage").GetString());
        Assert.Equal(JsonValueKind.Null, record.GetProperty("hybridRoute").ValueKind);
        Assert.Equal(JsonValueKind.Null, record.GetProperty("nexPosition").ValueKind);
        Assert.Equal(JsonValueKind.Null, record.GetProperty("routeReason").ValueKind);

        using var active = JsonDocument.Parse("""
            {"stage":"FileStable","hybridRoute":"V2","nexPosition":"BACKGROUND","routeReason":"FOREGROUND_NOT_OWNED_BY_NEX","extra":"ignored"}
            """);
        Assert.Equal("FileStable", active.RootElement.GetProperty("stage").GetString());
        Assert.Equal("V2", active.RootElement.GetProperty("hybridRoute").GetString());
    }

    [Fact]
    public void V2_G13_ExigeStagingMaisSafeStateSemExportTriggered()
    {
        var monitorSource = ReadMonitorSource();

        Assert.Contains("$Stage.Count -eq 0", monitorSource);
        Assert.Contains("SafeStateValidated", monitorSource);
        Assert.Contains("ExportTriggered", monitorSource);
        Assert.Contains("-not $hasExport", monitorSource);
        Assert.Contains("$terminal.stage -eq 'Failed'", monitorSource);
        Assert.Contains("$terminal.errorCode -eq 'UnsafeState'", monitorSource);
    }

    [Fact]
    public void V2_ExplicitaProjecoesReadOnlyDeCicloExecucaoERefresh()
    {
        var monitorSource = ReadMonitorSource();

        Assert.Contains("LatestCycle", monitorSource);
        Assert.Contains("CurrentRun", monitorSource);
        Assert.Contains("Format-Duration", monitorSource);
        Assert.Contains("Format-Countdown", monitorSource);
        Assert.Contains("Proxima tentativa", monitorSource);
        Assert.Contains("Proxima atualizacao", monitorSource);
        Assert.Contains("$foregroundWindow -eq $form.Handle", monitorSource);
    }

    [Fact]
    public void V2_RenderizacaoProtegeRouteEventNuloEAceitaDuracoesDeterministicas()
    {
        var monitorSource = ReadMonitorSource();

        Assert.Contains("$cycleRouteEvent = $cycle.RouteEvent", monitorSource);
        Assert.Contains("$currentRouteEvent = $currentRun.RouteEvent", monitorSource);
        Assert.Contains("if ($null -ne $cycleRouteEvent)", monitorSource);
        Assert.Contains("if ($null -ne $currentRouteEvent)", monitorSource);
        Assert.Contains("-Fallback '-'", monitorSource);
        Assert.Contains("[int64]$totalSeconds = [math]::Max(0, [math]::Floor($duration.TotalSeconds))", monitorSource);
        Assert.Contains("[int64]$totalMinutes = [math]::Floor($totalSeconds / 60)", monitorSource);
        Assert.Contains("[int64]$seconds = $totalSeconds % 60", monitorSource);
        Assert.Contains("'{0:D2}:{1:D2}' -f $totalMinutes, $seconds", monitorSource);
        Assert.Contains("[int64]$minutes = [math]::Floor($remaining.TotalMinutes)", monitorSource);
        Assert.Contains("[int64]$seconds = [math]::Floor($remaining.TotalSeconds % 60)", monitorSource);
        Assert.Contains("'faltam {0:D2}min {1:D2}s' -f $minutes, $seconds", monitorSource);
        Assert.DoesNotContain("'{0:mm\\\\:ss}' -f $duration", monitorSource);
        Assert.DoesNotContain("'faltam {0:D2}min {1:D2}s' -f [math]::Floor($remaining.TotalMinutes)", monitorSource);
        Assert.Contains("$form.Text = 'PRIME NEX Monitor V2'", monitorSource);
        Assert.Contains("$label.Margin = [System.Windows.Forms.Padding]::new(3, 2, 3, 2)", monitorSource);
        Assert.Contains("$box.Margin = [System.Windows.Forms.Padding]::new(0, 0, 0, 4)", monitorSource);
        Assert.Contains("-Title 'TASK / PROXIMA TENTATIVA' -Height 210", monitorSource);
        Assert.Contains("-Title 'ULTIMO CICLO' -Height 250", monitorSource);

        Assert.Equal("00:02", FormatExpectedDuration(2.0));
        Assert.Equal("00:29", FormatExpectedDuration(29.850));
        Assert.Equal("01:02", FormatExpectedDuration(62.0));
        Assert.Equal("faltam 04min 18s", FormatExpectedCountdown(258.0));
        Assert.Equal("-", RenderRouteValue(null));
        Assert.Equal("V2", RenderRouteValue("V2"));
    }

    [Fact]
    public void V2_LayoutDuasColunasMantemProjecoesReadOnlyEHistoricoDeSucesso()
    {
        var monitorSource = ReadMonitorSource();

        Assert.Contains("[System.Drawing.Size]::new(1120, 720)", monitorSource);
        Assert.Contains("$content = [System.Windows.Forms.TableLayoutPanel]::new()", monitorSource);
        Assert.Contains("$content.ColumnCount = 2", monitorSource);
        Assert.Contains("$leftColumn = [System.Windows.Forms.Panel]::new()", monitorSource);
        Assert.Contains("$rightColumn = [System.Windows.Forms.Panel]::new()", monitorSource);
        Assert.Contains("-Title 'EXPORT_STAGE'", monitorSource);
        Assert.Contains("-Title 'NEX' -Height 78", monitorSource);
        Assert.Contains("-Title 'EXPORT_STAGE' -Height 78", monitorSource);
        Assert.Contains("-Title 'ULTIMA TENTATIVA' -Height 90", monitorSource);
        Assert.Contains("-Title 'PROXIMA ACAO DO SISTEMA' -Height 60", monitorSource);
        Assert.Contains("-Title 'ULTIMO ARQUIVO EXPORTADO' -Height 125", monitorSource);
        Assert.Contains("-Title 'ULTIMO SUCESSO' -Height 135", monitorSource);
        Assert.Contains("$stageCount.Text", monitorSource);
        Assert.Contains("$stageState.Text", monitorSource);
        Assert.Contains("-Title 'ULTIMA TENTATIVA'", monitorSource);
        Assert.Contains("$lastAttemptTime.Text", monitorSource);
        Assert.Contains("$lastAttemptResult.Text", monitorSource);
        Assert.Contains("LastSuccess", monitorSource);
        Assert.Contains("$stage -eq 'Success'", monitorSource);
        Assert.Contains("Get-SuccessExportSnapshot", monitorSource);
        Assert.Contains("-Title 'ULTIMO SUCESSO'", monitorSource);
        Assert.Contains("$blockSection.Box.Visible = $isG13Blocked", monitorSource);
        Assert.Contains("$errorSection.Box.Visible", monitorSource);
        Assert.Contains("$currentRunSection.Box.Visible = $pipelineSnapshot.InProgress", monitorSource);
        Assert.Contains("$currentRunSection.Box.Visible = $false", monitorSource);
        Assert.Contains("$blockSection.Box.Visible = $false", monitorSource);
        Assert.Contains("$errorSection.Box.Visible = $false", monitorSource);
        Assert.Contains("$script:AgentRuntimeId = Get-AgentRuntimeId", monitorSource);
        Assert.Equal(1, CountOccurrences(monitorSource, "Get-FileHash -LiteralPath $script:AgentRuntimePath"));
        Assert.Contains("catch { return 'indisponivel' }", monitorSource);
        Assert.Contains("Agent runtime: ' + $script:AgentRuntimeId", monitorSource);
        using var historical = JsonDocument.Parse("""
            [{"timestamp":"2026-09-14T07:50:00-03:00","stage":"Failed"},{"timestamp":"2026-09-14T07:45:00-03:00","stage":"Success"}]
            """);
        Assert.Equal("Failed", historical.RootElement[0].GetProperty("stage").GetString());
        Assert.Equal("Success", historical.RootElement[1].GetProperty("stage").GetString());
    }

    private static string FormatExpectedDuration(double durationSeconds)
    {
        var totalSeconds = (long)Math.Floor(durationSeconds);
        var minutes = totalSeconds / 60;
        var seconds = totalSeconds % 60;
        return $"{minutes:D2}:{seconds:D2}";
    }

    private static string FormatExpectedCountdown(double remainingSeconds)
    {
        var totalSeconds = (long)Math.Floor(remainingSeconds);
        var minutes = totalSeconds / 60;
        var seconds = totalSeconds % 60;
        return $"faltam {minutes:D2}min {seconds:D2}s";
    }

    private static string RenderRouteValue(string? value) => value ?? "-";

    private static int CountOccurrences(string text, string value)
    {
        var count = 0;
        var index = 0;
        while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }

        return count;
    }

    /// <summary>O Monitor foi dividido em Core (funcoes de leitura, dot-source)
    /// e UI (bootstrap WinForms). As assercoes deste arquivo valem para o
    /// conjunto, entao o texto dos dois e concatenado.
    ///
    /// A busca parte do caminho deste proprio arquivo-fonte, nao de
    /// AppContext.BaseDirectory: com --artifacts-path o binario de teste roda
    /// fora da arvore do repositorio e a busca por diretorio-pai nunca
    /// encontraria WINDOWS\PrimeNexMonitor.</summary>
    private static string ReadMonitorSource([CallerFilePath] string testSourcePath = "")
    {
        var origins = new[] { Path.GetDirectoryName(testSourcePath), AppContext.BaseDirectory };

        foreach (var origin in origins)
        {
            if (string.IsNullOrEmpty(origin)) continue;

            for (var directory = new DirectoryInfo(origin); directory is not null; directory = directory.Parent)
            {
                var monitorDirectory = Path.Combine(directory.FullName, "WINDOWS", "PrimeNexMonitor");
                var ui = Path.Combine(monitorDirectory, "PrimeNexMonitor.ps1");
                var core = Path.Combine(monitorDirectory, "PrimeNexMonitor.Core.ps1");
                if (File.Exists(ui) && File.Exists(core))
                {
                    return File.ReadAllText(core) + "\n" + File.ReadAllText(ui);
                }
            }
        }

        throw new FileNotFoundException("PrimeNexMonitor.Core.ps1/PrimeNexMonitor.ps1 nao encontrados a partir do diretorio de testes.");
    }
}
