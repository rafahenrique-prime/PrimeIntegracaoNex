using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes da Telemetry V1 fase LOCAL (PrimeNexMonitor.Telemetry.ps1), executando
/// as funcoes reais via powershell.exe com dot-source. Todos os snapshots sao
/// fixtures em memoria: nenhum teste le NEX, Task, G13, logs de producao ou
/// faz rede.
/// </summary>
public sealed class MonitorTelemetryTests : IDisposable
{
    private const string RunId = "3f711207-f7f2-4841-8b43-4ffaada69f69";

    private readonly string _fixtureRoot = Path.Combine(
        Path.GetTempPath(),
        "PrimeNexMonitorTelemetryTests-" + Guid.NewGuid().ToString("N"));

    public MonitorTelemetryTests() => Directory.CreateDirectory(_fixtureRoot);

    public void Dispose()
    {
        try { Directory.Delete(_fixtureRoot, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    // Fixtures PowerShell reutilizaveis (mesmo formato dos snapshots do Core).
    private const string Fixtures = """
        $cycleEvents = @(
          [pscustomobject]@{ timestamp='2026-09-29T13:30:02.027-03:00'; runId='3f711207-f7f2-4841-8b43-4ffaada69f69'; stage='Start'; errorCode=$null; hybridRoute=$null; nexPosition=$null; routeReason=$null; reason='PID 23044 HWND 0x110DB0' },
          [pscustomobject]@{ timestamp='2026-09-29T13:30:18.186-03:00'; runId='3f711207-f7f2-4841-8b43-4ffaada69f69'; stage='Success'; errorCode=$null; hybridRoute='V2'; nexPosition='BACKGROUND'; routeReason='FOREGROUND_NOT_OWNED_BY_NEX'; reason='C:\Nex\secret'; fileName='vendas-auto-20260929-131506.xls' }
        )
        $pipeline = [pscustomobject]@{
          Available=$true; LogPath='C:\Nex\PrimeIntegracaoNex\LOGS\x.jsonl'; InProgress=$false; AnomalousStreak=0; StreakDominantCode=$null
          LastSuccess=$cycleEvents[1]
          LatestCycle=[pscustomobject]@{ Start=$cycleEvents[0].timestamp; End=$cycleEvents[1].timestamp; Events=$cycleEvents; Terminal=$cycleEvents[1]; RouteEvent=$cycleEvents[1] }
        }
        $task = [pscustomobject]@{ Available=$true; Enabled=$true; State='Ready'; LastRunTime=[datetime]'2026-09-29T13:30:01'; LastTaskResult=0; NextRunTime=[datetime]'2026-09-29T13:35:00'; Error=$null }
        $nex = [pscustomobject]@{ Available=$true; ProcessCount=6; ValidPids=@(23044, 25488); Position='BACKGROUND'; PathUnconfirmed=$false; MainWindow=[pscustomobject]@{ Handle=[IntPtr]1117616 }; Application=$null; Error=$null }
        $stage = [pscustomobject]@{ Available=$true; Count=0; Files=@(); Oldest=$null; OldestAgeMinutes=$null; TotalBytes=0; UnexpectedNames=@(); Error=$null }
        $overall = [pscustomobject]@{ Level='NORMAL'; Details=@() }
        $now = [datetime]'2026-09-29T13:31:00'
        function Status { param($n = $nex, $t = $task, $o = $overall, $p = $pipeline, $at = $now) New-TelemetryStatusPayload -Task $t -Pipeline $p -Nex $n -Stage $stage -Overall $o -G13Blocked $false -CapturedAt $at }
        function Emit { param([string]$Name, $Value) Write-Output ($Name + '=' + $Value) }
        """;

    // ------------------------------------------------------------ STATUS

    [Fact]
    public void Status_PayloadValidoComCamposExatos()
    {
        var output = Run("""
            $s = Status
            Emit 'JSON' (ConvertTo-TelemetryJson $s)
            Emit 'ERRORS' ((Test-TelemetryPayload $s) -join ';')
            """);

        Assert.Equal(string.Empty, Line(output, "ERRORS="));
        using var doc = JsonDocument.Parse(Line(output, "JSON="));
        var root = doc.RootElement;
        var keys = root.EnumerateObject().Select(p => p.Name).ToArray();
        Assert.Equal(new[]
        {
            "schema_version", "type", "source_id", "captured_at",
            "monitor_state", "nex_state", "nex_position", "nex_path_unconfirmed",
            "task_state", "task_enabled", "task_last_result", "task_last_run", "task_next_run",
            "last_success_at", "last_cycle_stage", "last_cycle_route", "last_cycle_ended_at",
            "cycle_in_progress", "cycles_without_export", "dominant_reason", "export_stage_count", "g13_blocked",
        }, keys);
        Assert.Equal(1, root.GetProperty("schema_version").GetInt32());
        Assert.Equal("status", root.GetProperty("type").GetString());
        Assert.Equal("PRIME_NEX_MAIN", root.GetProperty("source_id").GetString());
        Assert.Equal("NORMAL", root.GetProperty("monitor_state").GetString());
        Assert.Equal("OPEN", root.GetProperty("nex_state").GetString());
        Assert.Equal("BACKGROUND", root.GetProperty("nex_position").GetString());
        Assert.Equal("READY", root.GetProperty("task_state").GetString());
        Assert.Equal(0, root.GetProperty("task_last_result").GetInt64());
        Assert.Equal("Success", root.GetProperty("last_cycle_stage").GetString());
        Assert.Equal("V2", root.GetProperty("last_cycle_route").GetString());
        Assert.False(root.GetProperty("g13_blocked").GetBoolean());
    }

    [Theory]
    [InlineData("'CLOSED'", "$false", "$true", "CLOSED", "CLOSED")]
    [InlineData("'MINIMIZED'", "$false", "$true", "OPEN", "MINIMIZED")]
    [InlineData("'FOREGROUND'", "$false", "$true", "OPEN", "FOREGROUND")]
    [InlineData("'UNKNOWN'", "$true", "$true", "UNKNOWN", "UNKNOWN")]
    [InlineData("'UNKNOWN'", "$false", "$true", "UNKNOWN", "UNKNOWN")]
    [InlineData("'BACKGROUND'", "$false", "$false", "UNKNOWN", "BACKGROUND")]
    [InlineData("'Aberto; rm'", "$false", "$true", "UNKNOWN", "UNKNOWN")]
    public void Status_NexStateEPositionPorAllowlist(string position, string unconfirmed, string available, string expectedState, string expectedPosition)
    {
        var output = Run($$"""
            $n = [pscustomobject]@{ Available={{available}}; Position={{position}}; PathUnconfirmed={{unconfirmed}} }
            $s = Status -n $n
            Emit 'STATE' $s['nex_state']
            Emit 'POSITION' $s['nex_position']
            Emit 'ERRORS' ((Test-TelemetryPayload $s) -join ';')
            """);

        Assert.Equal(expectedState, Line(output, "STATE="));
        Assert.Equal(expectedPosition, Line(output, "POSITION="));
        Assert.Equal(string.Empty, Line(output, "ERRORS="));
    }

    [Fact]
    public void Status_EnumInvalidoViraUnknown()
    {
        var output = Run("""
            $t = [pscustomobject]@{ Available=$true; Enabled=$true; State='Indisponivel'; LastRunTime=$null; LastTaskResult='abc'; NextRunTime=[datetime]'1899-12-30' }
            $o = [pscustomobject]@{ Level='VERMELHO' }
            $s = Status -t $t -o $o
            Emit 'TASK' $s['task_state']
            Emit 'MONITOR' $s['monitor_state']
            Emit 'RESULT_NULL' ($null -eq $s['task_last_result'])
            Emit 'NEXT_NULL' ($null -eq $s['task_next_run'])
            Emit 'ERRORS' ((Test-TelemetryPayload $s) -join ';')
            """);

        Assert.Equal("UNKNOWN", Line(output, "TASK="));
        Assert.Equal("UNKNOWN", Line(output, "MONITOR="));
        Assert.Equal("True", Line(output, "RESULT_NULL="));
        Assert.Equal("True", Line(output, "NEXT_NULL="));
        Assert.Equal(string.Empty, Line(output, "ERRORS="));
    }

    [Fact]
    public void Status_NaoContemOutboxPidsHwndUsuarioComputadorOuCaminhos()
    {
        var output = Run("""
            Emit 'JSON' (ConvertTo-TelemetryJson (Status))
            Emit 'USER' $env:USERNAME
            Emit 'HOST' $env:COMPUTERNAME
            """);

        var json = Line(output, "JSON=");
        Assert.DoesNotContain("outbox", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("SENT", json, StringComparison.Ordinal);
        Assert.DoesNotContain("23044", json);
        Assert.DoesNotContain("25488", json);
        Assert.DoesNotContain("1117616", json);
        Assert.DoesNotContain("pid", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("hwnd", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(@"C:\\", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("vendas-auto", json);
        Assert.DoesNotContain(RunId, json);
        var user = Line(output, "USER=");
        var host = Line(output, "HOST=");
        if (user.Length > 0) Assert.DoesNotContain(user, json, StringComparison.OrdinalIgnoreCase);
        if (host.Length > 0) Assert.DoesNotContain(host, json, StringComparison.OrdinalIgnoreCase);
    }

    // ------------------------------------------------------------ CYCLE

    [Fact]
    public void Cycle_PayloadValidoComRunKeySha256CompletoESemRunIdBruto()
    {
        var output = Run("""
            $c = New-TelemetryCyclePayload -Pipeline $pipeline -CapturedAt $now
            Emit 'JSON' (ConvertTo-TelemetryJson $c)
            Emit 'ERRORS' ((Test-TelemetryPayload $c) -join ';')
            $c2 = New-TelemetryCyclePayload -Pipeline $pipeline -CapturedAt ([datetime]'2026-09-30T00:00:00')
            Emit 'SAME_KEY' ($c['run_key'] -eq $c2['run_key'])
            """);

        Assert.Equal(string.Empty, Line(output, "ERRORS="));
        Assert.Equal("True", Line(output, "SAME_KEY="));
        var json = Line(output, "JSON=");
        Assert.DoesNotContain(RunId, json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("PID", json);
        Assert.DoesNotContain("secret", json);
        Assert.DoesNotContain("vendas-auto", json);

        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        Assert.Equal(new[]
        {
            "schema_version", "type", "source_id", "captured_at", "run_key", "started_at", "ended_at", "duration_ms",
            "terminal_stage", "terminal_code", "route", "nex_position", "route_reason",
        }, root.EnumerateObject().Select(p => p.Name).ToArray());
        Assert.Equal(Sha256Hex(RunId), root.GetProperty("run_key").GetString());
        Assert.Equal(16159, root.GetProperty("duration_ms").GetInt64());
        Assert.Equal("Success", root.GetProperty("terminal_stage").GetString());
        Assert.Equal("V2", root.GetProperty("route").GetString());
        Assert.Equal("FOREGROUND_NOT_OWNED_BY_NEX", root.GetProperty("route_reason").GetString());
    }

    [Fact]
    public void Cycle_FailedUsaErrorCodeEEnumsInvalidosViramUnknown()
    {
        var output = Run("""
            $ev = [pscustomobject]@{ timestamp='2026-09-29T13:30:10-03:00'; runId='abc'; stage='Failed'; errorCode='UnsafeState'; hybridRoute='V9'; nexPosition='FLOATING'; routeReason='texto livre com C:\x' }
            $p = [pscustomobject]@{ LatestCycle=[pscustomobject]@{ Start='2026-09-29T13:30:02-03:00'; End=$ev.timestamp; Terminal=$ev; RouteEvent=$ev } }
            $c = New-TelemetryCyclePayload -Pipeline $p -CapturedAt $now
            Emit 'CODE' $c['terminal_code']
            Emit 'ROUTE' $c['route']
            Emit 'POS' $c['nex_position']
            Emit 'REASON' $c['route_reason']
            $ev2 = [pscustomobject]@{ timestamp='2026-09-29T13:30:10-03:00'; runId='abc'; stage='Failed'; errorCode='CodigoInventado'; hybridRoute='V1'; nexPosition='FOREGROUND'; routeReason=$null }
            $p2 = [pscustomobject]@{ LatestCycle=[pscustomobject]@{ Start='2026-09-29T13:30:02-03:00'; End=$ev2.timestamp; Terminal=$ev2; RouteEvent=$ev2 } }
            Emit 'CODE2' (New-TelemetryCyclePayload -Pipeline $p2 -CapturedAt $now)['terminal_code']
            Emit 'ERRORS' ((Test-TelemetryPayload $c) -join ';')
            """);

        Assert.Equal("UnsafeState", Line(output, "CODE="));
        Assert.Equal("UNKNOWN", Line(output, "ROUTE="));
        Assert.Equal("UNKNOWN", Line(output, "POS="));
        Assert.Equal("UNKNOWN", Line(output, "REASON="));
        Assert.Equal("UNKNOWN", Line(output, "CODE2="));
        Assert.Equal(string.Empty, Line(output, "ERRORS="));
    }

    [Fact]
    public void Cycle_SemCicloTerminalNaoGeraPayload()
    {
        var output = Run("""
            Emit 'NULL1' ($null -eq (New-TelemetryCyclePayload -Pipeline ([pscustomobject]@{ LatestCycle=$null })))
            Emit 'NULL2' ($null -eq (New-TelemetryCyclePayload -Pipeline $null))
            """);
        Assert.Equal("True", Line(output, "NULL1="));
        Assert.Equal("True", Line(output, "NULL2="));
    }

    // ------------------------------------------------------------ GUARDIAN

    private const string GuardianFixture = """
        $guardian = [pscustomobject]@{
          Success=$true; Error=''; DiagnosticSource='AI'; Classification='AMBIGUOUS'; Confidence=40
          Summary=('Resumo com chave sk-abcdef1234567890 e Bearer tok123 em C:\Users\rafae\x.json ' + ('a' * 900))
          Evidence=(@(1..12 | ForEach-Object { "ev$_ " + ('b' * 300) }) + @('path \\srv\share\f', 'api-key=XYZ123', 'Authorization: Basic abc', 'DEEPSEEK_API_KEY=zzz')) -join ' | '
          RecommendedAction=('Verificar o NEX ' + ('c' * 600)); NeedsHuman=$true; SafeToAutoFixFinal=$false
          AiCalled=$true; GeneratedAt='2026-09-29T13:31:17.1234567-03:00'
        }
        """;

    [Fact]
    public void Guardian_PayloadValidoComLimitesEAnalysisKeyEstavel()
    {
        var output = Run(GuardianFixture + """

            $g = New-TelemetryGuardianPayload -Guardian $guardian -CapturedAt $now
            Emit 'JSON' (ConvertTo-TelemetryJson $g)
            Emit 'ERRORS' ((Test-TelemetryPayload $g) -join ';')
            $g2 = New-TelemetryGuardianPayload -Guardian $guardian -CapturedAt ([datetime]'2026-09-30T00:00:00')
            Emit 'SAME_KEY' ($g['analysis_key'] -eq $g2['analysis_key'])
            Emit 'GENERATED' $g['generated_at']
            """);

        Assert.Equal(string.Empty, Line(output, "ERRORS="));
        Assert.Equal("True", Line(output, "SAME_KEY="));
        using var doc = JsonDocument.Parse(Line(output, "JSON="));
        var root = doc.RootElement;
        Assert.Equal(new[]
        {
            "schema_version", "type", "source_id", "captured_at", "analysis_key", "generated_at", "diagnostic_source",
            "ai_called", "classification", "confidence", "needs_human", "safe_to_auto_fix_final",
            "summary", "evidence", "recommended_action",
        }, root.EnumerateObject().Select(p => p.Name).ToArray());

        var expectedKey = Sha256Hex(Line(output, "GENERATED=") + "|AMBIGUOUS|AI");
        Assert.Equal(expectedKey, root.GetProperty("analysis_key").GetString());
        Assert.True(root.GetProperty("ai_called").GetBoolean());
        Assert.False(root.GetProperty("safe_to_auto_fix_final").GetBoolean());
        Assert.Equal(40, root.GetProperty("confidence").GetInt32());
        Assert.True(root.GetProperty("summary").GetString()!.Length <= 500);
        Assert.True(root.GetProperty("recommended_action").GetString()!.Length <= 300);
        var evidence = root.GetProperty("evidence").EnumerateArray().Select(e => e.GetString()!).ToArray();
        Assert.Equal(8, evidence.Length);
        Assert.All(evidence, e => Assert.True(e.Length <= 200));
    }

    [Fact]
    public void Guardian_SanitizaSegredosEPaths()
    {
        var output = Run(GuardianFixture + """

            $guardian.Evidence = @('path \\srv\share\f', 'api-key=XYZ123', 'Authorization: Basic abc', 'DEEPSEEK_API_KEY=zzz', 'x-api-key: q1', 'D:\Outro\arquivo.txt') -join ' | '
            $g = New-TelemetryGuardianPayload -Guardian $guardian -CapturedAt $now
            Emit 'JSON' (ConvertTo-TelemetryJson $g)
            Emit 'ERRORS' ((Test-TelemetryPayload $g) -join ';')
            """);

        Assert.Equal(string.Empty, Line(output, "ERRORS="));
        var json = Line(output, "JSON=");
        foreach (var forbidden in new[] { "sk-abcdef", "tok123", "XYZ123", "Basic abc", "zzz", "q1", "rafae", "srv", "share", @"C:\\", @"D:\\", "Authorization", "DEEPSEEK_API_KEY", "api-key", "Bearer" })
        {
            Assert.DoesNotContain(forbidden, json, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void Guardian_ForaDaAllowlistEAutoFixForcadoParaFalse()
    {
        var output = Run(GuardianFixture + """

            $guardian.Classification = 'EXECUTAR_COMANDO'
            $guardian.DiagnosticSource = 'HUMANO'
            $guardian.Confidence = 250
            $guardian.SafeToAutoFixFinal = $true
            $g = New-TelemetryGuardianPayload -Guardian $guardian -CapturedAt $now
            Emit 'CLASS' $g['classification']
            Emit 'SOURCE' $g['diagnostic_source']
            Emit 'CONF' $g['confidence']
            Emit 'AUTOFIX' $g['safe_to_auto_fix_final']
            $failed = [pscustomobject]@{ Success=$false; Error='x' }
            Emit 'FAILED_NULL' ($null -eq (New-TelemetryGuardianPayload -Guardian $failed))
            """);

        Assert.Equal("UNKNOWN", Line(output, "CLASS="));
        Assert.Equal("UNKNOWN", Line(output, "SOURCE="));
        Assert.Equal("100", Line(output, "CONF="));
        Assert.Equal("False", Line(output, "AUTOFIX="));
        Assert.Equal("True", Line(output, "FAILED_NULL="));
    }

    // ------------------------------------------------------------ VALIDACAO

    [Fact]
    public void Validacao_RejeitaCampoExtraSegredoECaminho()
    {
        var output = Run("""
            $s = Status
            $s['outbox_sent'] = 12
            Emit 'EXTRA' ((Test-TelemetryPayload $s) -join ';')
            $s2 = Status
            $s2['dominant_reason'] = 'sk-abcdef1234567890'
            Emit 'SECRET' ((Test-TelemetryPayload $s2) -join ';')
            $s3 = Status
            $s3['last_cycle_route'] = 'C:\Nex\x'
            Emit 'PATH' ((Test-TelemetryPayload $s3) -join ';')
            """);

        Assert.Contains("campo nao permitido: outbox_sent", Line(output, "EXTRA="));
        Assert.Contains("possivel segredo", Line(output, "SECRET="));
        Assert.Contains("caminho local", Line(output, "PATH="));
    }

    // ------------------------------------------------------------ DEDUPE

    [Fact]
    public void Dedupe_StatusPrimeiraLeituraIntervaloMudancaEHeartbeat()
    {
        var output = Run("""
            $state = New-TelemetryDedupeState
            $s = Status
            Emit 'FIRST' (Test-TelemetryStatusShouldSend -State $state -Payload $s -Now $now)
            Register-TelemetryStatusSent -State $state -Payload $s -Now $now

            $t30 = $now.AddSeconds(30)
            $changed = Status -o ([pscustomobject]@{ Level='PROBLEMA' }) -at $t30
            Emit 'CHANGED_BEFORE_1MIN' (Test-TelemetryStatusShouldSend -State $state -Payload $changed -Now $t30)

            $t90 = $now.AddSeconds(90)
            $t2 = [pscustomobject]@{ Available=$true; Enabled=$true; State='Ready'; LastRunTime=[datetime]'2026-09-29T13:30:01'; LastTaskResult=0; NextRunTime=[datetime]'2026-09-29T13:40:00' }
            $onlyTime = Status -t $t2 -at $t90
            Emit 'ONLY_TIME_FIELDS' (Test-TelemetryStatusShouldSend -State $state -Payload $onlyTime -Now $t90)

            $changed90 = Status -o ([pscustomobject]@{ Level='PROBLEMA' }) -at $t90
            Emit 'CHANGED_AFTER_1MIN' (Test-TelemetryStatusShouldSend -State $state -Payload $changed90 -Now $t90)

            $t299 = $now.AddSeconds(299)
            Emit 'NO_HEARTBEAT_YET' (Test-TelemetryStatusShouldSend -State $state -Payload (Status -at $t299) -Now $t299)
            $t300 = $now.AddSeconds(300)
            Emit 'HEARTBEAT' (Test-TelemetryStatusShouldSend -State $state -Payload (Status -at $t300) -Now $t300)
            """);

        Assert.Equal("True", Line(output, "FIRST="));
        Assert.Equal("False", Line(output, "CHANGED_BEFORE_1MIN="));
        Assert.Equal("False", Line(output, "ONLY_TIME_FIELDS="));
        Assert.Equal("True", Line(output, "CHANGED_AFTER_1MIN="));
        Assert.Equal("False", Line(output, "NO_HEARTBEAT_YET="));
        Assert.Equal("True", Line(output, "HEARTBEAT="));
    }

    [Fact]
    public void Dedupe_CycleEGuardianUmaVezPorChave()
    {
        var output = Run(GuardianFixture + """

            $state = New-TelemetryDedupeState
            $c = New-TelemetryCyclePayload -Pipeline $pipeline -CapturedAt $now
            Emit 'CYCLE_FIRST' (Test-TelemetryCycleShouldSend -State $state -Payload $c)
            Register-TelemetryCycleSent -State $state -Payload $c
            $cAgain = New-TelemetryCyclePayload -Pipeline $pipeline -CapturedAt $now.AddMinutes(1)
            Emit 'CYCLE_REPEAT' (Test-TelemetryCycleShouldSend -State $state -Payload $cAgain)
            Emit 'CYCLE_NULL' (Test-TelemetryCycleShouldSend -State $state -Payload $null)

            $g = New-TelemetryGuardianPayload -Guardian $guardian -CapturedAt $now
            Emit 'GUARDIAN_FIRST' (Test-TelemetryGuardianShouldSend -State $state -Payload $g)
            Register-TelemetryGuardianSent -State $state -Payload $g
            Emit 'GUARDIAN_REPEAT' (Test-TelemetryGuardianShouldSend -State $state -Payload (New-TelemetryGuardianPayload -Guardian $guardian -CapturedAt $now.AddMinutes(5)))
            $guardian.GeneratedAt = '2026-09-29T13:40:00-03:00'
            Emit 'GUARDIAN_NEW' (Test-TelemetryGuardianShouldSend -State $state -Payload (New-TelemetryGuardianPayload -Guardian $guardian -CapturedAt $now))
            """);

        Assert.Equal("True", Line(output, "CYCLE_FIRST="));
        Assert.Equal("False", Line(output, "CYCLE_REPEAT="));
        Assert.Equal("False", Line(output, "CYCLE_NULL="));
        Assert.Equal("True", Line(output, "GUARDIAN_FIRST="));
        Assert.Equal("False", Line(output, "GUARDIAN_REPEAT="));
        Assert.Equal("True", Line(output, "GUARDIAN_NEW="));
    }

    // ------------------------------------------------------------ ISOLAMENTO

    [Fact]
    public void Telemetria_NaoTemRedeNemDiscoNemReleituraDeProducao()
    {
        var telemetry = File.ReadAllText(Path.Combine(MonitorDirectory(), "PrimeNexMonitor.Telemetry.ps1"));
        foreach (var forbidden in new[]
        {
            "HttpClient", "WebClient", "WebRequest", "Invoke-RestMethod", "Invoke-WebRequest", "Net.Sockets", "TcpClient",
            "Set-Content", "Add-Content", "Out-File", "WriteAll", "New-Item", "Export-",
            "Get-ScheduledTask", "Get-CimInstance", "Get-Process", "Get-ChildItem", "Get-Content",
            "Get-NexSnapshot", "Get-TaskSnapshot", "Get-PipelineSnapshot", "Get-ExportStageSnapshot", "Get-OutboxSnapshot",
            "service_role", "supabase",
        })
        {
            Assert.DoesNotContain(forbidden, telemetry, StringComparison.OrdinalIgnoreCase);
        }

        var monitor = File.ReadAllText(Path.Combine(MonitorDirectory(), "PrimeNexMonitor.ps1"));
        Assert.Contains(". (Join-Path $PSScriptRoot 'PrimeNexMonitor.Telemetry.ps1')", monitor);
        Assert.DoesNotContain("HttpClient", monitor, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Invoke-RestMethod", monitor, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Invoke-WebRequest", monitor, StringComparison.OrdinalIgnoreCase);
        // A telemetria roda depois de Get-OverallStatus e nunca o reatribui.
        Assert.Equal(1, CountOccurrences(monitor, "$overall = Get-OverallStatus"));
        Assert.DoesNotContain("$overall = New-Telemetry", monitor);
    }

    // ------------------------------------------------------------ infra

    private static string Sha256Hex(string text) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    private static int CountOccurrences(string source, string value)
    {
        var count = 0;
        var index = 0;
        while ((index = source.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }
        return count;
    }

    private static string Line(string output, string prefix)
    {
        foreach (var line in output.Split('\n'))
        {
            var trimmed = line.TrimEnd('\r');
            if (trimmed.StartsWith(prefix, StringComparison.Ordinal)) return trimmed.Substring(prefix.Length);
        }
        throw new InvalidOperationException($"Prefixo '{prefix}' ausente na saida:\n{output}");
    }

    private string Run(string body)
    {
        // Mesmo preambulo estrito do Monitor real.
        var script = "Set-StrictMode -Version Latest\n$ErrorActionPreference = 'Stop'\n" +
                     ". '" + Path.Combine(MonitorDirectory(), "PrimeNexMonitor.Core.ps1") + "'\n" +
                     ". '" + Path.Combine(MonitorDirectory(), "PrimeNexMonitor.Telemetry.ps1") + "'\n" +
                     Fixtures + "\n" + body;
        var scriptPath = Path.Combine(_fixtureRoot, "runner-" + Guid.NewGuid().ToString("N") + ".ps1");
        File.WriteAllText(scriptPath, script, new UTF8Encoding(true));

        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{scriptPath}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
        };

        using var process = Process.Start(psi)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        Assert.True(process.WaitForExit(60_000), "powershell.exe nao terminou dentro do timeout");
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"Telemetry retornou {process.ExitCode}.\nSTDOUT:\n{stdout.Result}\nSTDERR:\n{stderr.Result}");
        }
        return stdout.Result;
    }

    private static string MonitorDirectory([CallerFilePath] string testSourcePath = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(testSourcePath)!, "..", "PrimeNexMonitor"));
}
