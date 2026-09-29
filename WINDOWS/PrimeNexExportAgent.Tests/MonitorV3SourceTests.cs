using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Contratos de fonte da V3 (PrimeNexMonitorV3.ps1 + PrimeNexMonitor.ViewModel.ps1):
/// isolamento (sem mutacao, sem rede nova, ViewModel sem I/O), paridade da
/// orquestracao critica com a V2 e preservacao do fluxo Guardian/Copiar.
/// Deliberadamente NAO testa layout (coordenadas, tamanhos, ordem de controles).
/// </summary>
public sealed class MonitorV3SourceTests
{
    private static readonly string Dir = MonitorDirectory();
    private static readonly string V2 = File.ReadAllText(Path.Combine(Dir, "PrimeNexMonitor.ps1"));
    private static readonly string V3 = File.ReadAllText(Path.Combine(Dir, "PrimeNexMonitorV3.ps1"));
    private static readonly string ViewModel = File.ReadAllText(Path.Combine(Dir, "PrimeNexMonitor.ViewModel.ps1"));

    private static readonly string[] CriticalCalls =
    {
        "Get-TaskSnapshot", "Get-PipelineSnapshot", "Get-ExportSnapshot", "Get-ExportStageSnapshot", "Get-NexSnapshot",
        "Get-OutboxSnapshot", "Test-G13CurrentBlock", "Get-OutboxHealth", "Get-StageHealth", "Get-SuccessHealth",
        "Get-OverallStatus", "New-TelemetryStatusPayload", "New-TelemetryCyclePayload", "Test-TelemetryPayload",
        "Step-TelemetrySender", "Test-TelemetryCycleShouldSend", "Submit-TelemetryPayload", "Register-TelemetryCycleSent",
        "Test-TelemetryStatusShouldSend", "Register-TelemetryStatusSent",
    };

    [Fact]
    public void Fontes_SomenteAscii()
    {
        Assert.DoesNotMatch("[^\\x00-\\x7F]", V3);
        Assert.DoesNotMatch("[^\\x00-\\x7F]", ViewModel);
    }

    [Fact]
    public void ViewModel_SemIoRedeProcessosOuMutacao()
    {
        var code = StripComments(ViewModel);
        foreach (var forbidden in new[]
        {
            "Get-ChildItem", "Get-Content", "Set-Content", "Add-Content", "Out-File", "New-Item", "Remove-Item",
            "Copy-Item", "Move-Item", "Get-Item", "Test-Path", "System.IO", "[IO.", "Get-Process", "Get-CimInstance",
            "Start-Process", "Stop-Process", "Invoke-WebRequest", "Invoke-RestMethod", "HttpClient", "WebClient",
            "ScheduledTask", "Get-Date", "Get-OverallStatus", "Get-NexSnapshot", "Get-TaskSnapshot", "Get-PipelineSnapshot",
            "Submit-TelemetryPayload", "Step-TelemetrySender", "Windows.Forms",
        })
        {
            Assert.DoesNotContain(forbidden, code, StringComparison.OrdinalIgnoreCase);
        }
        Assert.DoesNotMatch(@"\$overall\s*=", code);
    }

    [Fact]
    public void V3_SemComandosDeMutacaoNemRedeNova()
    {
        var code = StripComments(V3);
        foreach (var forbidden in new[]
        {
            "Stop-Process", ".Kill(", "Start-ScheduledTask", "Enable-ScheduledTask", "Disable-ScheduledTask",
            "Set-ScheduledTask", "Register-ScheduledTask", "Unregister-ScheduledTask", "Remove-Item", "Move-Item",
            "Copy-Item", "Set-Content", "Add-Content", "Out-File", "WriteAll", "HttpClient", "WebClient",
            "Invoke-RestMethod", "Invoke-WebRequest", "SetForegroundWindow", "SendInput", "Invoke-Expression",
            "DEEPSEEK_API_KEY", "x-prime-nex-ingest", "telemetry.secret", "telemetry.json",
        })
        {
            Assert.DoesNotContain(forbidden, code, StringComparison.OrdinalIgnoreCase);
        }
        Assert.Equal(1, Count(V3, "$overall = Get-OverallStatus"));
        Assert.Single(Regex.Matches(V3, @"\$overall\s*="));
    }

    [Fact]
    public void Orquestracao_MesmaSequenciaCriticaDaV2()
    {
        var v2 = RefreshBlock(V2, "$palette = switch");
        var v3 = RefreshBlock(V3, "# Apresentacao");
        Assert.Equal(CallSequence(v2), CallSequence(v3));
        Assert.Contains("Get-OutboxSnapshot", CallSequence(v3));
    }

    [Fact]
    public void Orquestracao_OverallETelemetriaIdenticosAV2()
    {
        var overallLine = Regex.Match(V2, @"\$overall = Get-OverallStatus[^\r\n]*").Value;
        Assert.False(string.IsNullOrEmpty(overallLine));
        Assert.Contains(overallLine, V3);

        var telemetryV2 = Normalize(Between(V2, "# Best-effort e isolado", "catch { $script:TelemetryLastErrors"));
        var telemetryV3 = Normalize(Between(V3, "# Best-effort e isolado", "catch { $script:TelemetryLastErrors"));
        Assert.Equal(telemetryV2, telemetryV3);

        // Mesma inicializacao do transporte (config externa; enabled=false => zero rede).
        Assert.Contains("try { $script:TelemetrySender = New-TelemetrySender } catch { $script:TelemetrySender = $null }", V3);
        Assert.Contains(". (Join-Path $PSScriptRoot 'PrimeNexMonitor.Core.ps1')", V3);
        Assert.Contains(". (Join-Path $PSScriptRoot 'PrimeNexMonitor.Telemetry.ps1')", V3);
        Assert.Contains(". (Join-Path $PSScriptRoot 'PrimeNexMonitor.TelemetryTransport.ps1')", V3);
        Assert.Contains(". (Join-Path $PSScriptRoot 'PrimeNexMonitor.ViewModel.ps1')", V3);
    }

    [Fact]
    public void Apresentacao_OcorreDepoisDoOverallENaoParticipaDele()
    {
        var overall = V3.IndexOf("$overall = Get-OverallStatus", StringComparison.Ordinal);
        var viewModel = V3.IndexOf("Get-MonitorViewModel -Task", StringComparison.Ordinal);
        var supervisor = V3.IndexOf("Update-V3SupervisorObservation -PreviousSent", StringComparison.Ordinal);
        Assert.True(overall > 0 && viewModel > overall && supervisor > overall);
        Assert.DoesNotContain("Supervisor", Between(V3, "$refreshAction = {", "$overall = Get-OverallStatus"));
    }

    [Fact]
    public void Guardian_FluxoManualPreservado()
    {
        foreach (var contract in new[]
        {
            "$psi.Arguments = '--guardian-analyze --task-state ' + (ConvertTo-GuardianTaskStateArgument -State $script:LastTaskSnapshotState)",
            "$paths = Get-GuardianResultPathsFromStdOut -StdOut $stdout",
            "$guardian = Get-GuardianMonitorResult -AnalysisPath $paths.AnalysisPath -UsagePath $paths.UsagePath",
            "if ($null -ne $script:GuardianProcess) { return }",
            "$guardianButton.Enabled = $false",
            "$guardianButton.Enabled = $true",
            "$guardianTimer.Interval = 150",
            "$process.StandardOutput.ReadToEndAsync()",
            "$process.StandardError.ReadToEndAsync()",
            "Resolve-GuardianAgentPath",
        })
        {
            Assert.Contains(contract, V2);
            Assert.Contains(contract, V3);
        }
        Assert.Equal(1, Count(V3, "$process.Start()"));

        var hookV2 = Normalize(Between(V2, "$script:TelemetryLastGuardian = New-TelemetryGuardianPayload", "catch { $script:TelemetryLastGuardian = $null }"));
        var hookV3 = Normalize(Between(V3, "$script:TelemetryLastGuardian = New-TelemetryGuardianPayload", "catch { $script:TelemetryLastGuardian = $null }"));
        Assert.Equal(hookV2, hookV3);
    }

    [Fact]
    public void Copiar_UsaMesmaSanitizacaoDaV2()
    {
        Assert.Contains("[System.Windows.Forms.Clipboard]::SetText((ConvertTo-V3GuardianClipboardText -Guardian $script:GuardianView))", V3);
        foreach (var line in Regex.Matches(V2, @"\$text = \[regex\]::Replace\([^\r\n]+").Select(m => m.Value))
        {
            Assert.Contains(line, ViewModel);
        }
        Assert.Equal(4, Regex.Matches(ViewModel, @"\$text = \[regex\]::Replace\(").Count);
    }

    [Fact]
    public void InstanciaUnica_ReadOnlyEAntesDaTelemetria()
    {
        var guard = V3.IndexOf("Find-V3OtherMonitorInstances -Processes", StringComparison.Ordinal);
        var sender = V3.IndexOf("$script:TelemetrySender = New-TelemetrySender", StringComparison.Ordinal);
        Assert.True(guard > 0 && sender > guard);
        var block = Between(V3, "# Somente leitura: se outro Monitor", "# Telemetry V1");
        Assert.Contains("Get-CimInstance Win32_Process", block);
        Assert.Contains("return", block);
        Assert.DoesNotContain("Stop-Process", block);
        Assert.DoesNotContain("Kill", block);
        Assert.DoesNotContain("CloseMainWindow", block);
    }

    [Fact]
    public void V2_NaoReferenciaV3()
    {
        Assert.DoesNotContain("ViewModel", V2);
        Assert.DoesNotContain("PrimeNexMonitorV3", V2);
        Assert.Contains("$form.Text = 'PRIME NEX Monitor V2'", V2);
    }

    // ------------------------------------------------------------ infra

    private static string RefreshBlock(string source, string endMarker) =>
        Between(source, "$refreshAction = {", endMarker);

    private static string[] CallSequence(string block)
    {
        var pattern = @"\b(" + string.Join("|", CriticalCalls.Select(Regex.Escape)) + @")\b";
        return Regex.Matches(block, pattern).Select(m => m.Value).ToArray();
    }

    private static string Between(string source, string start, string end)
    {
        var i = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(i >= 0, $"Marcador ausente: {start}");
        var j = source.IndexOf(end, i + start.Length, StringComparison.Ordinal);
        Assert.True(j > i, $"Marcador ausente: {end}");
        return source.Substring(i, j - i);
    }

    private static string Normalize(string text) =>
        Regex.Replace(text.Replace("\r\n", "\n"), @"[ \t]+", " ").Trim();

    private static string StripComments(string source) =>
        string.Join("\n", source.Replace("\r\n", "\n").Split('\n').Where(l => !l.TrimStart().StartsWith('#')));

    private static int Count(string source, string value)
    {
        var count = 0;
        var index = 0;
        while ((index = source.IndexOf(value, index, StringComparison.Ordinal)) >= 0) { count++; index += value.Length; }
        return count;
    }

    private static string MonitorDirectory([CallerFilePath] string testSourcePath = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(testSourcePath)!, "..", "PrimeNexMonitor"));
}
