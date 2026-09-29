using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes do transporte da Telemetry V1 (PrimeNexMonitor.TelemetryTransport.ps1)
/// SEM internet: todo HttpClient usa um HttpMessageHandler mockado. Segredo e
/// config sao gerados em diretorio temporario; o segredo bruto nunca e' impresso
/// (os scripts so' emitem booleanos/contadores).
/// </summary>
public sealed class MonitorTelemetryTransportTests : IDisposable
{
    private const string Endpoint = "https://mbbgqasvssueirynnoyk.supabase.co/functions/v1/nex-telemetry-ingest";

    private readonly string _fixtureRoot = Path.Combine(
        Path.GetTempPath(),
        "PrimeNexTelemetryTransportTests-" + Guid.NewGuid().ToString("N"));

    public MonitorTelemetryTransportTests() => Directory.CreateDirectory(_fixtureRoot);

    public void Dispose()
    {
        try { Directory.Delete(_fixtureRoot, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private const string MockHandlerSource = """
        Add-Type -ReferencedAssemblies System.Net.Http -TypeDefinition @'
        using System;
        using System.Net;
        using System.Net.Http;
        using System.Threading;
        using System.Threading.Tasks;
        public class PrimeNexMockHandler : HttpMessageHandler
        {
            public int Calls;
            public int Mode;          // 0 = responde Status; 1 = nunca responde; 2 = falha de rede
            public int Status = 204;
            public string LastUrl;
            public string LastHeader;
            public string LastBody;
            public string LastContentType;
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                Calls++;
                LastUrl = request.RequestUri.ToString();
                System.Collections.Generic.IEnumerable<string> values;
                LastHeader = request.Headers.TryGetValues("x-prime-nex-ingest", out values) ? string.Join(",", values) : null;
                LastBody = request.Content == null ? null : request.Content.ReadAsStringAsync().Result;
                LastContentType = request.Content == null ? null : request.Content.Headers.ContentType.MediaType;
                if (Mode == 2)
                {
                    var failed = new TaskCompletionSource<HttpResponseMessage>();
                    failed.SetException(new HttpRequestException("DNS/offline simulado"));
                    return failed.Task;
                }
                if (Mode == 1)
                {
                    return Task.Delay(Timeout.Infinite, cancellationToken).ContinueWith<HttpResponseMessage>(t => { throw new TaskCanceledException(); });
                }
                return Task.FromResult(new HttpResponseMessage((HttpStatusCode)Status) { Content = new StringContent("{\"cmd\":\"ignorar\"}") });
            }
        }
        '@
        """;

    private string Fixtures => $$"""
        $root = '{{_fixtureRoot}}'
        $secretPath = Join-Path $root 'telemetry.secret'
        $configPath = Join-Path $root 'telemetry.json'
        function Write-Config { param($enabled = $true, $endpoint = '{{Endpoint}}', $source = 'PRIME_NEX_MAIN')
            $obj = [ordered]@{ enabled = $enabled; endpoint = $endpoint; source_id = $source }
            [System.IO.File]::WriteAllText($configPath, (ConvertTo-Json $obj -Compress)) }
        $cycleEvents = @(
          [pscustomobject]@{ timestamp='2026-09-29T13:30:02.027-03:00'; runId='3f711207-f7f2-4841-8b43-4ffaada69f69'; stage='Start'; errorCode=$null; hybridRoute=$null; nexPosition=$null; routeReason=$null },
          [pscustomobject]@{ timestamp='2026-09-29T13:30:18.186-03:00'; runId='3f711207-f7f2-4841-8b43-4ffaada69f69'; stage='Success'; errorCode=$null; hybridRoute='V2'; nexPosition='BACKGROUND'; routeReason='FOREGROUND_NOT_OWNED_BY_NEX' }
        )
        $pipeline = [pscustomobject]@{ Available=$true; InProgress=$false; AnomalousStreak=0; StreakDominantCode=$null; LastSuccess=$cycleEvents[1]; PreviousTerminal=$null; LatestTerminal=$cycleEvents[1]
          LatestCycle=[pscustomobject]@{ Start=$cycleEvents[0].timestamp; End=$cycleEvents[1].timestamp; Events=$cycleEvents; Terminal=$cycleEvents[1]; RouteEvent=$cycleEvents[1] } }
        $task = [pscustomobject]@{ Available=$true; Enabled=$true; State='Ready'; LastRunTime=[datetime]'2026-09-29T13:30:01'; LastTaskResult=0; NextRunTime=[datetime]'2026-09-29T13:35:00'; Error=$null }
        $nex = [pscustomobject]@{ Available=$true; Position='BACKGROUND'; PathUnconfirmed=$false }
        $stage = [pscustomobject]@{ Available=$true; Count=0 }
        $export = [pscustomobject]@{ Available=$true; IsStale=$false }
        $overall = Get-OverallStatus -Task $task -Pipeline $pipeline -Export $export -Nex $nex
        $now = [datetime]'2026-09-29T13:31:00'
        $status = New-TelemetryStatusPayload -Task $task -Pipeline $pipeline -Nex $nex -Stage $stage -Overall $overall -G13Blocked $false -CapturedAt $now
        $cycle = New-TelemetryCyclePayload -Pipeline $pipeline -CapturedAt $now
        $guardianResult = [pscustomobject]@{ Success=$true; DiagnosticSource='RULE'; Classification='NEX_MINIMIZED'; Confidence=100; Summary='NEX minimizado.'; Evidence='NEX_POSITION_MINIMIZED'; RecommendedAction='Restaurar a janela do NEX.'; NeedsHuman=$true; SafeToAutoFixFinal=$false; AiCalled=$false; GeneratedAt='2026-09-29T13:31:17-03:00' }
        $guardian = New-TelemetryGuardianPayload -Guardian $guardianResult -CapturedAt $now
        function New-MockSender { param($handler, [int]$timeoutSeconds = 5)
            $factory = { $c = [System.Net.Http.HttpClient]::new($handler); $c.Timeout = [TimeSpan]::FromSeconds($timeoutSeconds); $c }.GetNewClosure()
            New-TelemetrySender -ConfigPath $configPath -SecretPath $secretPath -ClientFactory $factory }
        function Wait-Sender { param($sender) $limit = (Get-Date).AddSeconds(15); while ($null -ne $sender.Pending -and -not $sender.Pending.IsCompleted -and (Get-Date) -lt $limit) { Start-Sleep -Milliseconds 50 }; Step-TelemetrySender -Sender $sender }
        function Emit { param([string]$Name, $Value) Write-Output ($Name + '=' + $Value) }
        """;

    // ------------------------------------------------------------ CONFIG / GATES

    [Fact]
    public void EnabledFalse_ConfigAusenteOuInvalida_ZeroChamada()
    {
        var output = Run("""
            [void](New-TelemetryIngestSecret -Path $secretPath)
            $h = [PrimeNexMockHandler]::new()
            $missing = New-MockSender $h
            Emit 'MISSING_REASON' $missing.Config.Reason
            Emit 'MISSING_ACCEPTED' (Submit-TelemetryPayload -Sender $missing -Payload $status)
            Write-Config -enabled $false
            $off = New-MockSender $h
            Emit 'OFF_REASON' $off.Config.Reason
            Emit 'OFF_ACCEPTED' (Submit-TelemetryPayload -Sender $off -Payload $status)
            Write-Config -enabled 'true'
            Emit 'STRING_TRUE_REASON' (New-MockSender $h).Config.Reason
            [System.IO.File]::WriteAllText($configPath, '{ nao e json')
            Emit 'BROKEN_REASON' (New-MockSender $h).Config.Reason
            Emit 'CALLS' $h.Calls
            """);

        Assert.Equal("CONFIG_MISSING", Line(output, "MISSING_REASON="));
        Assert.Equal("False", Line(output, "MISSING_ACCEPTED="));
        Assert.Equal("DISABLED", Line(output, "OFF_REASON="));
        Assert.Equal("False", Line(output, "OFF_ACCEPTED="));
        Assert.Equal("DISABLED", Line(output, "STRING_TRUE_REASON="));
        Assert.Equal("CONFIG_UNREADABLE", Line(output, "BROKEN_REASON="));
        Assert.Equal("0", Line(output, "CALLS="));
    }

    [Theory]
    [InlineData("https://evil.example.com/functions/v1/nex-telemetry-ingest")]
    [InlineData("http://mbbgqasvssueirynnoyk.supabase.co/functions/v1/nex-telemetry-ingest")]
    [InlineData("https://mbbgqasvssueirynnoyk.supabase.co/functions/v1/nex-telemetry-ingest/../outra")]
    [InlineData("https://mbbgqasvssueirynnoyk.supabase.co/rest/v1/nex_status")]
    public void EndpointDiferente_Bloqueado(string endpoint)
    {
        var output = Run($$"""
            [void](New-TelemetryIngestSecret -Path $secretPath)
            Write-Config -endpoint '{{endpoint}}'
            $h = [PrimeNexMockHandler]::new()
            $s = New-MockSender $h
            Emit 'REASON' $s.Config.Reason
            Emit 'ACCEPTED' (Submit-TelemetryPayload -Sender $s -Payload $status)
            Emit 'CALLS' $h.Calls
            """);

        Assert.Equal("ENDPOINT_NOT_ALLOWED", Line(output, "REASON="));
        Assert.Equal("False", Line(output, "ACCEPTED="));
        Assert.Equal("0", Line(output, "CALLS="));
    }

    [Fact]
    public void SourceIdDiferente_Bloqueado()
    {
        var output = Run("""
            [void](New-TelemetryIngestSecret -Path $secretPath)
            Write-Config -source 'OUTRA_FONTE'
            $h = [PrimeNexMockHandler]::new()
            $s = New-MockSender $h
            Emit 'REASON' $s.Config.Reason
            Emit 'ACCEPTED' (Submit-TelemetryPayload -Sender $s -Payload $status)
            Emit 'CALLS' $h.Calls
            """);

        Assert.Equal("SOURCE_ID_INVALID", Line(output, "REASON="));
        Assert.Equal("False", Line(output, "ACCEPTED="));
        Assert.Equal("0", Line(output, "CALLS="));
    }

    [Fact]
    public void SegredoAusenteOuCorrompido_ZeroChamada()
    {
        var output = Run("""
            Write-Config
            $h = [PrimeNexMockHandler]::new()
            $s = New-MockSender $h
            Emit 'ACCEPTED' (Submit-TelemetryPayload -Sender $s -Payload $status)
            Emit 'RESULT' $s.LastResult
            [System.IO.File]::WriteAllBytes($secretPath, [byte[]](1,2,3,4))
            Emit 'CORRUPT_ACCEPTED' (Submit-TelemetryPayload -Sender $s -Payload $cycle)
            Emit 'CALLS' $h.Calls
            """);

        Assert.Equal("False", Line(output, "ACCEPTED="));
        Assert.Equal("SECRET_UNAVAILABLE", Line(output, "RESULT="));
        Assert.Equal("False", Line(output, "CORRUPT_ACCEPTED="));
        Assert.Equal("0", Line(output, "CALLS="));
    }

    // ------------------------------------------------------------ SEGREDO / DPAPI

    [Fact]
    public void Dpapi_RoundTripSemPlaintextEmDisco()
    {
        var output = Run("""
            $hash = New-TelemetryIngestSecret -Path $secretPath
            Write-Config -enabled $false
            $secret = Read-TelemetryIngestSecret -Path $secretPath
            Emit 'SECRET_FORMAT' ($secret -match '^[0-9a-f]{64}$')
            Emit 'HASH_FORMAT' ($hash -match '^[0-9a-f]{64}$')
            Emit 'HASH_MATCHES' ($hash -eq (Get-TelemetrySha256 -Text $secret))
            Emit 'HASH_NOT_SECRET' ($hash -ne $secret)
            $bytes = [System.IO.File]::ReadAllBytes($secretPath)
            $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
            $utf16 = [System.Text.Encoding]::Unicode.GetString($bytes)
            Emit 'FILE_HAS_PLAINTEXT' ($ascii.Contains($secret) -or $utf16.Contains($secret) -or $ascii.Contains($secret.Substring(0, 16)))
            Emit 'CONFIG_HAS_SECRET' ([System.IO.File]::ReadAllText($configPath).Contains($secret))
            Emit 'CONFIG_HAS_HASH' ([System.IO.File]::ReadAllText($configPath).Contains($hash))
            $acl = [System.IO.File]::GetAccessControl($secretPath)
            $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
            Emit 'ACL_PROTECTED' $acl.AreAccessRulesProtected
            Emit 'ACL_ONLY_ME' (@($rules | Where-Object { $_.IdentityReference.Value -ne $me }).Count -eq 0)
            $again = $null
            try { [void](New-TelemetryIngestSecret -Path $secretPath) } catch { $again = 'REFUSED' }
            Emit 'NO_OVERWRITE' ($again -eq 'REFUSED' -and (Read-TelemetryIngestSecret -Path $secretPath) -eq $secret)
            $secret = $null
            """);

        Assert.Equal("True", Line(output, "SECRET_FORMAT="));
        Assert.Equal("True", Line(output, "HASH_FORMAT="));
        Assert.Equal("True", Line(output, "HASH_MATCHES="));
        Assert.Equal("True", Line(output, "HASH_NOT_SECRET="));
        Assert.Equal("False", Line(output, "FILE_HAS_PLAINTEXT="));
        Assert.Equal("False", Line(output, "CONFIG_HAS_SECRET="));
        Assert.Equal("False", Line(output, "CONFIG_HAS_HASH="));
        Assert.Equal("True", Line(output, "ACL_PROTECTED="));
        Assert.Equal("True", Line(output, "ACL_ONLY_ME="));
        Assert.Equal("True", Line(output, "NO_OVERWRITE="));
    }

    // ------------------------------------------------------------ ENVIO MOCKADO

    [Theory]
    [InlineData("status")]
    [InlineData("cycle")]
    [InlineData("guardian")]
    public void PayloadValido_SerializadoComHeaderSomenteNaRequisicao(string kind)
    {
        var output = Run($$"""
            [void](New-TelemetryIngestSecret -Path $secretPath)
            Write-Config
            $h = [PrimeNexMockHandler]::new()
            $s = New-MockSender $h
            $payload = ${{kind}}
            Emit 'ACCEPTED' (Submit-TelemetryPayload -Sender $s -Payload $payload)
            Wait-Sender $s
            $secret = Read-TelemetryIngestSecret -Path $secretPath
            Emit 'CALLS' $h.Calls
            Emit 'URL' $h.LastUrl
            Emit 'CONTENT_TYPE' $h.LastContentType
            Emit 'HEADER_IS_SECRET' ($h.LastHeader -eq $secret)
            Emit 'BODY_HAS_SECRET' ($h.LastBody.Contains($secret))
            Emit 'BODY_TYPE' (($h.LastBody | ConvertFrom-Json).type)
            Emit 'BODY_EQUALS_PAYLOAD' ($h.LastBody -eq (ConvertTo-TelemetryJson -Payload $payload))
            Emit 'SENDER_HAS_SECRET' ((($s | Select-Object Config, SecretPath, LastResult, Sent, Failed | ConvertTo-Json -Compress -Depth 3)).Contains($secret))
            Emit 'RESULT' $s.LastResult
            Emit 'SENT' $s.Sent
            Emit 'PENDING_CLEARED' ($null -eq $s.Pending -and $null -eq $s.PendingRequest)
            $secret = $null
            """);

        Assert.Equal("True", Line(output, "ACCEPTED="));
        Assert.Equal("1", Line(output, "CALLS="));
        Assert.Equal(Endpoint, Line(output, "URL="));
        Assert.Equal("application/json", Line(output, "CONTENT_TYPE="));
        Assert.Equal("True", Line(output, "HEADER_IS_SECRET="));
        Assert.Equal("False", Line(output, "BODY_HAS_SECRET="));
        Assert.Equal(kind, Line(output, "BODY_TYPE="));
        Assert.Equal("True", Line(output, "BODY_EQUALS_PAYLOAD="));
        Assert.Equal("False", Line(output, "SENDER_HAS_SECRET="));
        Assert.Equal("HTTP_204", Line(output, "RESULT="));
        Assert.Equal("1", Line(output, "SENT="));
        Assert.Equal("True", Line(output, "PENDING_CLEARED="));
        Assert.DoesNotContain("x-prime-nex-ingest", output);
    }

    [Fact]
    public void PayloadInvalido_NuncaEnviado()
    {
        var output = Run("""
            [void](New-TelemetryIngestSecret -Path $secretPath)
            Write-Config
            $h = [PrimeNexMockHandler]::new()
            $s = New-MockSender $h
            $bad = New-TelemetryStatusPayload -Task $task -Pipeline $pipeline -Nex $nex -Stage $stage -Overall $overall -G13Blocked $false -CapturedAt $now
            $bad['outbox_sent'] = 3
            Emit 'EXTRA' (Submit-TelemetryPayload -Sender $s -Payload $bad)
            $bad2 = New-TelemetryCyclePayload -Pipeline $pipeline -CapturedAt $now
            $bad2['run_key'] = '3f711207-f7f2-4841-8b43-4ffaada69f69'
            Emit 'RAW_RUNID' (Submit-TelemetryPayload -Sender $s -Payload $bad2)
            Emit 'NULL' (Submit-TelemetryPayload -Sender $s -Payload $null)
            Emit 'CALLS' $h.Calls
            Emit 'REJECTED' $s.Rejected
            """);

        Assert.Equal("False", Line(output, "EXTRA="));
        Assert.Equal("False", Line(output, "RAW_RUNID="));
        Assert.Equal("False", Line(output, "NULL="));
        Assert.Equal("0", Line(output, "CALLS="));
        Assert.Equal("3", Line(output, "REJECTED="));
    }

    [Theory]
    [InlineData(0, 400, "HTTP_400")]
    [InlineData(0, 401, "HTTP_401")]
    [InlineData(0, 500, "HTTP_500")]
    [InlineData(2, 0, "NETWORK_ERROR")]
    [InlineData(1, 0, "TIMEOUT")]
    public void FalhaDeTransporte_NaoAfetaMonitorNemOverallESemRetry(int mode, int status, string expected)
    {
        var output = Run($$"""
            [void](New-TelemetryIngestSecret -Path $secretPath)
            Write-Config
            $h = [PrimeNexMockHandler]::new()
            $h.Mode = {{mode}}
            $h.Status = {{status}}
            $s = New-MockSender $h 1
            $before = ConvertTo-Json -InputObject $overall -Compress -Depth 4
            $started = Get-Date
            Emit 'ACCEPTED' (Submit-TelemetryPayload -Sender $s -Payload $cycle)
            Emit 'SUBMIT_MS_UNDER_1000' (((Get-Date) - $started).TotalMilliseconds -lt 1000)
            Wait-Sender $s
            Step-TelemetrySender -Sender $s
            Step-TelemetrySender -Sender $s
            $after = ConvertTo-Json -InputObject (Get-OverallStatus -Task $task -Pipeline $pipeline -Export $export -Nex $nex) -Compress -Depth 4
            Emit 'RESULT' $s.LastResult
            Emit 'FAILED' $s.Failed
            Emit 'CALLS' $h.Calls
            Emit 'OVERALL_UNCHANGED' ($before -eq $after)
            Emit 'MONITOR_ALIVE' 'YES'
            """);

        Assert.Equal("True", Line(output, "ACCEPTED="));
        Assert.Equal("True", Line(output, "SUBMIT_MS_UNDER_1000="));
        Assert.Equal(expected, Line(output, "RESULT="));
        Assert.Equal("1", Line(output, "FAILED="));
        Assert.Equal("1", Line(output, "CALLS="));
        Assert.Equal("True", Line(output, "OVERALL_UNCHANGED="));
        Assert.Equal("YES", Line(output, "MONITOR_ALIVE="));
    }

    [Fact]
    public void Prioridade_StatusDescartadoCycleEGuardianAguardam()
    {
        var output = Run("""
            [void](New-TelemetryIngestSecret -Path $secretPath)
            Write-Config
            $h = [PrimeNexMockHandler]::new()
            $h.Mode = 1
            $s = New-MockSender $h 30
            Emit 'FIRST' (Submit-TelemetryPayload -Sender $s -Payload $status)
            Emit 'STATUS_WHILE_BUSY' (Submit-TelemetryPayload -Sender $s -Payload $status)
            Emit 'CYCLE_WHILE_BUSY' (Submit-TelemetryPayload -Sender $s -Payload $cycle)
            Emit 'GUARDIAN_WHILE_BUSY' (Submit-TelemetryPayload -Sender $s -Payload $guardian)
            Emit 'QUEUE' $s.Queue.Count
            Emit 'DROPPED' $s.Dropped
            Emit 'CALLS_WHILE_BUSY' $h.Calls
            $h.Mode = 0
            $s.Client.CancelPendingRequests()
            Wait-Sender $s
            Emit 'AFTER_FIRST_TYPE' $s.PendingType
            Wait-Sender $s
            Emit 'AFTER_SECOND_TYPE' $s.PendingType
            Wait-Sender $s
            Emit 'QUEUE_END' $s.Queue.Count
            Emit 'CALLS_END' $h.Calls
            Emit 'LAST_BODY_TYPE' (($h.LastBody | ConvertFrom-Json).type)
            """);

        Assert.Equal("True", Line(output, "FIRST="));
        Assert.Equal("False", Line(output, "STATUS_WHILE_BUSY="));
        Assert.Equal("True", Line(output, "CYCLE_WHILE_BUSY="));
        Assert.Equal("True", Line(output, "GUARDIAN_WHILE_BUSY="));
        Assert.Equal("2", Line(output, "QUEUE="));
        Assert.Equal("1", Line(output, "DROPPED="));
        Assert.Equal("1", Line(output, "CALLS_WHILE_BUSY="));
        Assert.Equal("cycle", Line(output, "AFTER_FIRST_TYPE="));
        Assert.Equal("guardian", Line(output, "AFTER_SECOND_TYPE="));
        Assert.Equal("0", Line(output, "QUEUE_END="));
        Assert.Equal("3", Line(output, "CALLS_END="));
        Assert.Equal("guardian", Line(output, "LAST_BODY_TYPE="));
    }

    [Fact]
    public void FalhasInternas_NuncaLancamParaOMonitor()
    {
        var output = Run("""
            [void](New-TelemetryIngestSecret -Path $secretPath)
            Write-Config
            Emit 'NULL_SENDER' (Submit-TelemetryPayload -Sender $null -Payload $status)
            Step-TelemetrySender -Sender $null
            $broken = New-TelemetrySender -ConfigPath $configPath -SecretPath $secretPath -ClientFactory { throw 'factory quebrada' }
            Emit 'BROKEN_FACTORY' (Submit-TelemetryPayload -Sender $broken -Payload $status)
            Emit 'BROKEN_RESULT' $broken.LastResult
            Step-TelemetrySender -Sender $broken
            Emit 'SURVIVED' 'YES'
            """);

        Assert.Equal("False", Line(output, "NULL_SENDER="));
        Assert.Equal("False", Line(output, "BROKEN_FACTORY="));
        Assert.Equal("SEND_ERROR", Line(output, "BROKEN_RESULT="));
        Assert.Equal("YES", Line(output, "SURVIVED="));
    }

    // ------------------------------------------------------------ ISOLAMENTO (fonte)

    [Fact]
    public void Fonte_IsolamentoEEndpointUnico()
    {
        var dir = MonitorDirectory();
        var transport = File.ReadAllText(Path.Combine(dir, "PrimeNexMonitor.TelemetryTransport.ps1"));
        var monitor = File.ReadAllText(Path.Combine(dir, "PrimeNexMonitor.ps1"));

        Assert.Equal(1, CountOccurrences(transport, "https://"));
        Assert.Contains($"'{Endpoint}'", transport);
        Assert.Contains("DataProtectionScope]::CurrentUser", transport);
        Assert.DoesNotContain("LocalMachine", transport);
        foreach (var forbidden in new[]
        {
            "Write-Host", "Write-Output", "Write-Verbose", "Write-Debug", "Out-File", "Add-Content", "Set-Content",
            "Start-Process", "Invoke-Expression", "ScheduledTask", "NexAdmin", "EXPORT_STAGE", "service_role",
            "ReadAsString", "Content.Read",
        })
        {
            Assert.DoesNotContain(forbidden, transport, StringComparison.OrdinalIgnoreCase);
        }

        Assert.Contains(". (Join-Path $PSScriptRoot 'PrimeNexMonitor.TelemetryTransport.ps1')", monitor);
        Assert.Equal(1, CountOccurrences(monitor, "$overall = Get-OverallStatus"));
        Assert.DoesNotContain("HttpClient", monitor, StringComparison.OrdinalIgnoreCase);
        Assert.True(monitor.IndexOf("Step-TelemetrySender", StringComparison.Ordinal) > monitor.IndexOf("$overall = Get-OverallStatus", StringComparison.Ordinal));
        Assert.DoesNotContain("x-prime-nex-ingest", monitor);
    }

    [Fact]
    public void Repo_NaoContemConfigOuSegredoDeTelemetria()
    {
        var dir = MonitorDirectory();
        Assert.False(File.Exists(Path.Combine(dir, "telemetry.json")));
        Assert.False(File.Exists(Path.Combine(dir, "telemetry.secret")));
        var transport = File.ReadAllText(Path.Combine(dir, "PrimeNexMonitor.TelemetryTransport.ps1"));
        Assert.Contains("GetFolderPath('LocalApplicationData')", transport);
        Assert.DoesNotMatch("[0-9a-f]{64}", transport);
    }

    // ------------------------------------------------------------ infra

    private static int CountOccurrences(string source, string value)
    {
        var count = 0;
        var index = 0;
        while ((index = source.IndexOf(value, index, StringComparison.Ordinal)) >= 0) { count++; index += value.Length; }
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
        var dir = MonitorDirectory();
        var script = "Set-StrictMode -Version Latest\n$ErrorActionPreference = 'Stop'\n" +
                     ". '" + Path.Combine(dir, "PrimeNexMonitor.Core.ps1") + "'\n" +
                     ". '" + Path.Combine(dir, "PrimeNexMonitor.Telemetry.ps1") + "'\n" +
                     ". '" + Path.Combine(dir, "PrimeNexMonitor.TelemetryTransport.ps1") + "'\n" +
                     MockHandlerSource + "\n" + Fixtures + "\n" + body;
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
        };

        using var process = Process.Start(psi)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        Assert.True(process.WaitForExit(90_000), "powershell.exe nao terminou dentro do timeout");
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"Transport retornou {process.ExitCode}.\nSTDOUT:\n{stdout.Result}\nSTDERR:\n{stderr.Result}");
        }

        // Nenhuma saida pode conter um segredo hex de 64 caracteres.
        Assert.DoesNotMatch("(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])", stdout.Result);
        return stdout.Result;
    }

    private static string MonitorDirectory([CallerFilePath] string testSourcePath = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(testSourcePath)!, "..", "PrimeNexMonitor"));
}
