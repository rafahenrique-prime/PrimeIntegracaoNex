using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes de comportamento do ViewModel da V3 (PrimeNexMonitor.ViewModel.ps1),
/// executando as funcoes reais via powershell.exe. Todos os snapshots sao
/// fixtures em memoria: nenhum teste le NEX, Task, G13, logs ou faz rede.
/// A saida dos scripts e' somente ASCII (codigos/booleanos) para nao depender
/// da codificacao do console.
/// </summary>
public sealed class MonitorV3ViewModelTests : IDisposable
{
    private readonly string _fixtureRoot = Path.Combine(
        Path.GetTempPath(),
        "PrimeNexMonitorV3Tests-" + Guid.NewGuid().ToString("N"));

    public MonitorV3ViewModelTests() => Directory.CreateDirectory(_fixtureRoot);

    public void Dispose()
    {
        try { Directory.Delete(_fixtureRoot, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private const string Fixtures = """
        $now = [datetime]'2026-09-29T16:30:00'
        function Emit { param([string]$Name, $Value) Write-Output ($Name + '=' + $Value) }
        function Ascii { param([string]$Text) -join ($Text.ToCharArray() | ForEach-Object { if ([int]$_ -gt 127) { '\u{0:x4}' -f [int]$_ } else { $_ } }) }
        $cycleEvents = @(
          [pscustomobject]@{ timestamp='2026-09-29T16:25:02-03:00'; runId='r1'; stage='Start'; errorCode=$null; hybridRoute=$null; nexPosition=$null; routeReason=$null; reason=$null; fileName=$null },
          [pscustomobject]@{ timestamp='2026-09-29T16:25:18-03:00'; runId='r1'; stage='Success'; errorCode=$null; hybridRoute='V2'; nexPosition='BACKGROUND'; routeReason='FOREGROUND_NOT_OWNED_BY_NEX'; reason=$null; fileName='vendas-auto-20260929-162506.xls' }
        )
        $pipeline = [pscustomobject]@{ Available=$true; InProgress=$false; CurrentRun=$null; AnomalousStreak=0; StreakDominantCode=$null; LastSuccess=$cycleEvents[1]; LatestTerminal=$cycleEvents[1]; PreviousTerminal=$null
          LatestCycle=[pscustomobject]@{ Start=$cycleEvents[0].timestamp; End=$cycleEvents[1].timestamp; Events=$cycleEvents; Terminal=$cycleEvents[1]; RouteEvent=$cycleEvents[1] } }
        $task = [pscustomobject]@{ Available=$true; Enabled=$true; State='Ready'; LastRunTime=[datetime]'2026-09-29T16:25:01'; LastTaskResult=0; NextRunTime=[datetime]'2026-09-29T16:35:00'; Error=$null }
        $nex = [pscustomobject]@{ Available=$true; Position='BACKGROUND'; PathUnconfirmed=$false }
        $stage = [pscustomobject]@{ Available=$true; Count=0; Files=@() }
        $export = [pscustomobject]@{ Available=$true; IsStale=$false; File=$null }
        $overall = [pscustomobject]@{ Level='NORMAL'; Detail='Leituras coerentes e ultimo pipeline concluido com sucesso' }
        $guardian = [ordered]@{ State='Aguardando clique manual'; Source='-'; Classification='-'; Confidence='-'; Summary='-'; EvidenceLines=@(); Action='-'; NeedsHuman='-'; AutoFix='-'; LastAnalysis='-' }
        function Sender { param($enabled = $true, $reason = 'ENABLED', $last = 'IDLE', $sent = 0, $pending = $null)
          [pscustomobject]@{ Config=[pscustomobject]@{ Enabled=$enabled; Reason=$reason }; LastResult=$last; Sent=$sent; Failed=0; Dropped=0; Rejected=0; Pending=$pending; Queue=[System.Collections.Generic.Queue[object]]::new() } }
        function VM { param($o = $overall, $n = $nex, $t = $task, $s = $stage, $p = $pipeline, $g13 = $false, $snd = $null, $acc = $null, $gv = $guardian, $sh = $null)
          Get-MonitorViewModel -Task $t -Pipeline $p -Export $export -Stage $s -Nex $n -Overall $o -G13Blocked $g13 -StageHealth $sh -Sender $snd -LastAcceptedSendAt $acc -Guardian $gv -LastRefreshAt $now.AddSeconds(-7) -Now $now }
        function Card { param($vm, $key) $vm.Cards | Where-Object { $_.Key -eq $key } | Select-Object -First 1 }
        """;

    // ------------------------------------------------------------ headline

    [Theory]
    [InlineData("NORMAL", "OK", "25CF", "NORMAL")]
    [InlineData("ATENCAO", "WARN", "25CF", "ATEN\\u00c7\\u00c3O")]
    [InlineData("PROBLEMA", "BAD", "25CF", "PROBLEMA")]
    [InlineData("QUALQUER", "OFF", "25CF", "CARREGANDO")]
    public void Headline_MapeiaOverallSemAlterarLevel(string level, string expectedLevel, string codepoint, string word)
    {
        var output = Run($$"""
            $o = [pscustomobject]@{ Level='{{level}}'; Detail='detalhe do core' }
            $before = ConvertTo-Json -InputObject $o -Compress
            $vm = VM -o $o
            Emit 'LEVEL' $vm.Headline.Level
            Emit 'CP' ([char]::ConvertToUtf32($vm.Headline.Icon, 0).ToString('X'))
            Emit 'TEXT' (Ascii $vm.Headline.Text)
            Emit 'SUBTITLE' $vm.Subtitle
            Emit 'OVERALL_UNCHANGED' ($before -eq (ConvertTo-Json -InputObject $o -Compress))
            """);

        Assert.Equal(expectedLevel, Line(output, "LEVEL="));
        Assert.Equal(codepoint, Line(output, "CP="));
        // Texto sem simbolo: o estado vem do indicador U+25CF colorido (Label separado na V3).
        Assert.Equal("PRIME NEX \\u2014 " + word, Line(output, "TEXT="));
        Assert.Equal("detalhe do core", Line(output, "SUBTITLE="));
        Assert.Equal("True", Line(output, "OVERALL_UNCHANGED="));
    }

    [Fact]
    public void Updated_MostraIdadeDaUltimaLeitura()
    {
        var output = Run("""
            Emit 'UPDATED' (Ascii (VM).Updated)
            Emit 'AGE_90' (Format-V3Age -Since $now.AddSeconds(-90) -Now $now)
            Emit 'AGE_2H' (Format-V3Age -Since $now.AddMinutes(-125) -Now $now)
            """);
        Assert.Equal("atualizado h\\u00e1 7 s", Line(output, "UPDATED="));
        Assert.Equal("1 min", Line(output, "AGE_90="));
        Assert.Equal("2 h 05 min", Line(output, "AGE_2H="));
    }

    // ------------------------------------------------------------ cards

    [Theory]
    [InlineData("FOREGROUND", "$false", "$true", "OK", "Aberto")]
    [InlineData("BACKGROUND", "$false", "$true", "OK", "Aberto")]
    [InlineData("MINIMIZED", "$false", "$true", "WARN", "Minimizado")]
    [InlineData("CLOSED", "$false", "$true", "WARN", "Fechado")]
    [InlineData("UNKNOWN", "$false", "$true", "WARN", "Indeterminado")]
    [InlineData("UNKNOWN", "$true", "$true", "WARN", "Indeterminado")]
    [InlineData("BACKGROUND", "$false", "$false", "WARN", "Indeterminado")]
    public void Nex_EstadosDaJanela(string position, string unconfirmed, string available, string level, string primary)
    {
        var output = Run($$"""
            $c = Card (VM -n ([pscustomobject]@{ Available={{available}}; Position='{{position}}'; PathUnconfirmed={{unconfirmed}} })) 'NEX'
            Emit 'LEVEL' $c.Level
            Emit 'PRIMARY' $c.Primary
            """);
        Assert.Equal(level, Line(output, "LEVEL="));
        Assert.Equal(primary, Line(output, "PRIMARY="));
    }

    [Theory]
    [InlineData("Ready", "$true", "$true", "OK", "Pronta")]
    [InlineData("Running", "$true", "$true", "OK", "Em execu\\u00e7\\u00e3o")]
    [InlineData("Disabled", "$true", "$true", "WARN", "Desabilitada")]
    [InlineData("Ready", "$false", "$true", "WARN", "Desabilitada")]
    [InlineData("Indisponivel", "$true", "$true", "WARN", "Desconhecida")]
    [InlineData("Ready", "$true", "$false", "BAD", "Indispon\\u00edvel")]
    public void Task_Estados(string state, string enabled, string available, string level, string primary)
    {
        var output = Run($$"""
            $t = [pscustomobject]@{ Available={{available}}; Enabled={{enabled}}; State='{{state}}'; NextRunTime=[datetime]'2026-09-29T16:35:00'; LastRunTime=$null; LastTaskResult=0 }
            $c = Card (VM -t $t) 'TASK'
            Emit 'LEVEL' $c.Level
            Emit 'PRIMARY' (Ascii $c.Primary)
            Emit 'SECONDARY' (Ascii $c.Secondary)
            """);
        Assert.Equal(level, Line(output, "LEVEL="));
        Assert.Equal(primary, Line(output, "PRIMARY="));
        if (available == "$true") Assert.Contains("16:35 (em 5 min)", Line(output, "SECONDARY="));
    }

    [Fact]
    public void Stage_VazioEComPendencias()
    {
        var output = Run("""
            $empty = Card (VM) 'STAGE'
            Emit 'EMPTY' ($empty.Level + '|' + $empty.Primary)
            $one = Card (VM -s ([pscustomobject]@{ Available=$true; Count=1 }) -sh ([pscustomobject]@{ Level='ATENCAO'; Summary='1 pendente' })) 'STAGE'
            Emit 'ONE' ($one.Level + '|' + $one.Primary)
            $many = Card (VM -s ([pscustomobject]@{ Available=$true; Count=3 }) -sh ([pscustomobject]@{ Level='PROBLEMA'; Summary='antigo' })) 'STAGE'
            Emit 'MANY' ($many.Level + '|' + $many.Primary)
            $na = Card (VM -s ([pscustomobject]@{ Available=$false; Count=0 })) 'STAGE'
            Emit 'NA' $na.Level
            """);
        Assert.Equal("OK|Vazio", Line(output, "EMPTY="));
        Assert.Equal("WARN|1 arquivo pendente", Line(output, "ONE="));
        Assert.Equal("BAD|3 arquivos pendentes", Line(output, "MANY="));
        Assert.Equal("WARN", Line(output, "NA="));
    }

    [Fact]
    public void G13_LivreEBloqueado()
    {
        var output = Run("""
            $free = Card (VM -g13 $false) 'G13'
            $blocked = Card (VM -g13 $true) 'G13'
            Emit 'FREE' ($free.Level + '|' + $free.Primary)
            Emit 'BLOCKED' ($blocked.Level + '|' + $blocked.Primary)
            """);
        Assert.Equal("OK|Sem bloqueio", Line(output, "FREE="));
        Assert.Equal("BAD|Bloqueando novas tentativas", Line(output, "BLOCKED="));
    }

    [Fact]
    public void Export_SucessoNormalEStale()
    {
        var output = Run("""
            $ok = Card (VM) 'EXPORT'
            Emit 'OK' ($ok.Level + '|' + (Ascii $ok.Primary) + '|' + (Ascii $ok.Secondary))
            $script:export = [pscustomobject]@{ Available=$true; IsStale=$true; File=$null }
            $stale = Card (VM) 'EXPORT'
            Emit 'STALE' ($stale.Level + '|' + (Ascii $stale.Primary) + '|' + (Ascii $stale.Secondary))
            $script:export = [pscustomobject]@{ Available=$false; IsStale=$true; File=$null }
            $na = Card (VM) 'EXPORT'
            Emit 'NA' ($na.Level + '|' + (Ascii $na.Primary) + '|' + (Ascii $na.Secondary))
            """);
        Assert.Equal("OK|\\u00daltimo sucesso \\u00b7 16:25|V2 \\u00b7 sucesso \\u00b7 16 s", Line(output, "OK="));
        Assert.Equal("WARN|Sem exporta\\u00e7\\u00e3o > 15 min|\\u00daltimo sucesso \\u00b7 16:25", Line(output, "STALE="));
        Assert.Equal("WARN|Arquivo indispon\\u00edvel|V2 \\u00b7 sucesso \\u00b7 16 s", Line(output, "NA="));
    }

    [Fact]
    public void Export_FalhaDuracaoLongaESemSucesso()
    {
        var output = Run("""
            $fail = [pscustomobject]@{ timestamp='2026-09-29T16:26:07-03:00'; runId='r2'; stage='Failed'; errorCode='UnsafeState'; hybridRoute='V1'; nexPosition='FOREGROUND'; routeReason='FOREGROUND_HWND_OR_PID_MATCHED_NEX'; reason=$null; fileName=$null }
            $p = [pscustomobject]@{ InProgress=$false; CurrentRun=$null; LastSuccess=$null; LatestTerminal=$fail
              LatestCycle=[pscustomobject]@{ Start='2026-09-29T16:25:02-03:00'; End=$fail.timestamp; Terminal=$fail; RouteEvent=$fail } }
            $c = Card (VM -p $p) 'EXPORT'
            Emit 'FAIL' ($c.Level + '|' + (Ascii $c.Primary) + '|' + (Ascii $c.Secondary))
            $noRoute = [pscustomobject]@{ timestamp='2026-09-29T16:25:09-03:00'; runId='r3'; stage='NEX_MINIMIZED'; errorCode=$null; hybridRoute=$null; nexPosition=$null; routeReason=$null; reason=$null; fileName=$null }
            $p2 = [pscustomobject]@{ InProgress=$false; CurrentRun=$null; LastSuccess=$null; LatestTerminal=$noRoute
              LatestCycle=[pscustomobject]@{ Start='2026-09-29T16:25:02-03:00'; End=$noRoute.timestamp; Terminal=$noRoute; RouteEvent=$null } }
            Emit 'NOROUTE' (Ascii (Card (VM -p $p2) 'EXPORT').Secondary)
            Emit 'SECS_59' (Format-V3CycleSeconds -Start '2026-09-29T16:25:00-03:00' -End '2026-09-29T16:25:59-03:00')
            Emit 'SECS_60' (Format-V3CycleSeconds -Start '2026-09-29T16:25:00-03:00' -End '2026-09-29T16:26:00-03:00')
            Emit 'SECS_NULL' ($null -eq (Format-V3CycleSeconds -Start $null -End '2026-09-29T16:26:00-03:00'))
            """);
        Assert.Equal("WARN|Sem sucesso registrado|V1 \\u00b7 Failed (UnsafeState) \\u00b7 1 min 05 s", Line(output, "FAIL="));
        Assert.Equal("\\u2014 \\u00b7 NEX_MINIMIZED \\u00b7 7 s", Line(output, "NOROUTE="));
        Assert.Equal("59 s", Line(output, "SECS_59="));
        Assert.Equal("1 min 00 s", Line(output, "SECS_60="));
        Assert.Equal("True", Line(output, "SECS_NULL="));
    }

    [Fact]
    public void Glifos_NenhumSimboloForaDoBmpNaV3()
    {
        var dir = MonitorDirectory();
        foreach (var file in new[] { "PrimeNexMonitorV3.ps1", "PrimeNexMonitor.ViewModel.ps1" })
        {
            var source = File.ReadAllText(Path.Combine(dir, file));
            Assert.DoesNotContain("ConvertFromUtf32", source);
            Assert.DoesNotMatch(@"\\[uU][dD][89abAB][0-9a-fA-F]{2}", source);
            Assert.DoesNotMatch(@"0x1[0-9A-Fa-f]{4}\b", source);
            Assert.DoesNotMatch("[^\\x00-\\x7F]", source);
        }
        var v3 = File.ReadAllText(Path.Combine(dir, "PrimeNexMonitorV3.ps1"));
        Assert.Contains("[char]0x25CF", v3);
        Assert.Contains("$headlineDot.ForeColor = Get-V3LevelColor -Level $ViewModel.Headline.Level", v3);
        Assert.Contains("$guardianButton.Text = 'Analisar com Guardian'", v3);
    }
    [Fact]
    public void Guardian_EstadosDoCard()
    {
        var output = Run("""
            Emit 'IDLE' (Card (VM) 'GUARDIAN').Level
            $running = [ordered]@{ State='Analisando...' }
            Emit 'RUNNING' (Card (VM -gv $running) 'GUARDIAN').Primary
            $done = [ordered]@{ State='Concluido'; Classification='AMBIGUOUS'; Confidence='40%'; NeedsHuman='SIM'; Source='IA' }
            $c = Card (VM -gv $done) 'GUARDIAN'
            Emit 'DONE' ($c.Level + '|' + (Ascii $c.Primary) + '|' + (Ascii $c.Secondary))
            $err = [ordered]@{ State='Erro: falhou' }
            Emit 'ERROR' (Card (VM -gv $err) 'GUARDIAN').Level
            """);
        Assert.Equal("INFO", Line(output, "IDLE="));
        Assert.Equal("Analisando...", Line(output, "RUNNING="));
        Assert.Equal("INFO|AMBIGUOUS \\u00b7 40%|requer humano \\u00b7 origem IA", Line(output, "DONE="));
        Assert.Equal("WARN", Line(output, "ERROR="));
    }

    [Fact]
    public void ExecucaoAtual_SomenteComCicloEmAndamento()
    {
        var output = Run("""
            Emit 'IDLE' (VM).CurrentRun.Visible
            $run = [pscustomobject]@{ Start='2026-09-29T16:30:02-03:00'; LastRecord=[pscustomobject]@{ stage='ExportTriggered' }; RouteEvent=[pscustomobject]@{ hybridRoute='V2'; nexPosition='BACKGROUND' } }
            $p = [pscustomobject]@{ InProgress=$true; CurrentRun=$run; LatestCycle=$null; LastSuccess=$null; LatestTerminal=$null }
            $vm = VM -p $p
            Emit 'RUNNING' $vm.CurrentRun.Visible
            Emit 'TEXT' (Ascii $vm.CurrentRun.Text)
            """);
        Assert.Equal("False", Line(output, "IDLE="));
        Assert.Equal("True", Line(output, "RUNNING="));
        Assert.Contains("Exportacao iniciada", Line(output, "TEXT="));
        Assert.Contains("V2 / BACKGROUND", Line(output, "TEXT="));
    }

    // ------------------------------------------------------------ supervisor

    [Theory]
    [InlineData("$null", "$null", "OFF", "Supervisor desligado")]
    [InlineData("(Sender -enabled $false -reason 'CONFIG_MISSING')", "$null", "OFF", "Supervisor desligado")]
    [InlineData("(Sender -enabled $false -reason 'DISABLED')", "$null", "OFF", "Supervisor desligado")]
    [InlineData("(Sender -last 'SECRET_UNAVAILABLE')", "$null", "BAD", "Segredo indispon\\u00edvel")]
    [InlineData("(Sender -last 'HTTP_401' -sent 3)", "$now.AddSeconds(-30)", "BAD", "Envio recusado (credencial)")]
    [InlineData("(Sender -last 'HTTP_403')", "$null", "BAD", "Envio recusado (credencial)")]
    [InlineData("(Sender -last 'HTTP_400')", "$null", "BAD", "Envio recusado (HTTP 400)")]
    [InlineData("(Sender -last 'HTTP_500' -sent 3)", "$now.AddSeconds(-30)", "WARN", "Falha tempor\\u00e1ria de envio")]
    [InlineData("(Sender -last 'NETWORK_ERROR')", "$null", "WARN", "Falha tempor\\u00e1ria de envio")]
    [InlineData("(Sender -last 'TIMEOUT')", "$null", "WARN", "Falha tempor\\u00e1ria de envio")]
    [InlineData("(Sender -last 'IDLE')", "$null", "INFO", "Aguardando primeiro envio")]
    [InlineData("(Sender -last 'HTTP_204' -sent 5)", "$now.AddSeconds(-40)", "OK", "Supervisor conectado")]
    [InlineData("(Sender -last 'HTTP_204' -sent 5)", "$now.AddSeconds(-600)", "OK", "Supervisor conectado")]
    [InlineData("(Sender -last 'HTTP_204' -sent 5)", "$now.AddSeconds(-601)", "WARN", "Sem envio recente")]
    [InlineData("(Sender -last 'SENDING' -sent 5 -pending 'x')", "$now.AddSeconds(-40)", "OK", "Supervisor conectado \\u00b7 enviando\\u2026")]
    [InlineData("(Sender -last 'SENDING' -pending 'x')", "$null", "INFO", "Aguardando primeiro envio \\u00b7 enviando\\u2026")]
    public void Supervisor_RegrasDeApresentacao(string sender, string acceptedAt, string level, string primary)
    {
        var output = Run($$"""
            $i = Get-V3SupervisorIndicator -Sender {{sender}} -LastAcceptedAt {{acceptedAt}} -Now $now
            Emit 'LEVEL' $i.Level
            Emit 'PRIMARY' (Ascii $i.Primary)
            $card = Card (VM -snd {{sender}} -acc {{acceptedAt}}) 'SUPERVISOR'
            Emit 'CARD_MATCH' ($card.Level -eq $i.Level -and $card.Primary -eq $i.Primary)
            $vm = VM -snd {{sender}} -acc {{acceptedAt}}
            Emit 'HEADLINE_UNAFFECTED' ($vm.Headline.Level -eq 'OK')
            """);
        Assert.Equal(level, Line(output, "LEVEL="));
        Assert.Equal(primary, Line(output, "PRIMARY="));
        Assert.Equal("True", Line(output, "CARD_MATCH="));
        Assert.Equal("True", Line(output, "HEADLINE_UNAFFECTED="));
    }

    [Fact]
    public void Supervisor_ObservacaoDoUltimoEnvioAceito()
    {
        var output = Run("""
            $t0 = $now.AddMinutes(-3)
            Emit 'INCREMENT' ((Update-V3SupervisorObservation -PreviousSent 2 -CurrentSent 3 -PreviousAcceptedAt $t0 -Now $now) -eq $now)
            Emit 'SAME' ((Update-V3SupervisorObservation -PreviousSent 3 -CurrentSent 3 -PreviousAcceptedAt $t0 -Now $now) -eq $t0)
            Emit 'NONE' ($null -eq (Update-V3SupervisorObservation -PreviousSent 0 -CurrentSent 0 -PreviousAcceptedAt $null -Now $now))
            $i = Get-V3SupervisorIndicator -Sender (Sender -last 'HTTP_204' -sent 5) -LastAcceptedAt $now -Now $now
            Emit 'COUNTERS' (Ascii $i.Counters)
            """);
        Assert.Equal("True", Line(output, "INCREMENT="));
        Assert.Equal("True", Line(output, "SAME="));
        Assert.Equal("True", Line(output, "NONE="));
        Assert.Equal("enviados 5 \\u00b7 falhas 0 \\u00b7 descartados 0 \\u00b7 rejeitados 0 \\u00b7 fila 0", Line(output, "COUNTERS="));
    }

    // ------------------------------------------------------------ clipboard / instancia

    [Fact]
    public void Clipboard_MesmoFormatoESanitizacao()
    {
        var output = Run("""
            $g = [ordered]@{ State='Concluido'; Source='IA'; Classification='AMBIGUOUS'; Confidence='40%'
              Summary='Chave sk-abcdef1234567890 em C:\Users\rafae\x.json'; EvidenceLines=@('- ev1 Bearer tok123', 'ev2 \\srv\share\f', 'api-key=XYZ123')
              Action='Verificar Authorization: Basic abc'; NeedsHuman='SIM'; AutoFix='NAO'; LastAnalysis='29/09/2026 16:30:00' }
            $text = ConvertTo-V3GuardianClipboardText -Guardian $g
            Emit 'TEXT' (Ascii ($text -replace "`r`n", '|'))
            """);
        var text = Line(output, "TEXT=");
        Assert.StartsWith("PRIME NEX GUARDIAN||Estado: Concluido|Origem: IA|Classifica\\u00e7\\u00e3o: AMBIGUOUS|Confian\\u00e7a: 40%||Resumo:|", text);
        Assert.Contains("|Evid\\u00eancias:|- ev1 ", text);
        Assert.Contains("|- ev2 ", text);
        Assert.Contains("Humano necess\\u00e1rio: Sim|Auto-fix: N\\u00e3o||\\u00daltima an\\u00e1lise:|29/09/2026 16:30:00", text);
        foreach (var forbidden in new[] { "sk-abcdef", "rafae", "tok123", "srv", "XYZ123", "Basic abc" })
        {
            Assert.DoesNotContain(forbidden, text, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void InstanciaUnica_DetectaV2EV3SemFalsoPositivo()
    {
        var output = Run("""
            $procs = @(
              [pscustomobject]@{ ProcessId=10; CommandLine='powershell.exe -File "C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexMonitor\PrimeNexMonitor.ps1"' },
              [pscustomobject]@{ ProcessId=11; CommandLine='powershell.exe -File "C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexMonitor\PrimeNexMonitorV3.ps1"' },
              [pscustomobject]@{ ProcessId=12; CommandLine='powershell.exe -File C:\temp\runner.ps1 . C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexMonitor\PrimeNexMonitor.Core.ps1' },
              [pscustomobject]@{ ProcessId=13; CommandLine=$null },
              [pscustomobject]@{ ProcessId=99; CommandLine='powershell.exe -File "C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexMonitor\PrimeNexMonitorV3.ps1"' }
            )
            Emit 'FOUND' ((Find-V3OtherMonitorInstances -Processes $procs -SelfPid 99) -join ',')
            Emit 'NONE' ((Find-V3OtherMonitorInstances -Processes @() -SelfPid 99).Count)
            """);
        Assert.Equal("10,11", Line(output, "FOUND="));
        Assert.Equal("0", Line(output, "NONE="));
    }

    [Fact]
    public void Detalhes_ContemCamposTecnicosDaV2()
    {
        var output = Run("""
            $labels = @((VM).Details | ForEach-Object { $_.Label })
            Emit 'LABELS' ($labels -join '|')
            """);
        var labels = Line(output, "LABELS=");
        foreach (var expected in new[] { "LastTaskResult", "Ultimo ciclo error code", "Rota", "Motivo rota", "Ultimo erro / motivo", "Proxima acao do sistema", "Bloqueio atual (G13)" })
        {
            Assert.Contains(expected, labels);
        }
    }

    // ------------------------------------------------------------ infra

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
                     ". '" + Path.Combine(dir, "PrimeNexMonitor.ViewModel.ps1") + "'\n" +
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
        };

        using var process = Process.Start(psi)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        Assert.True(process.WaitForExit(60_000), "powershell.exe nao terminou dentro do timeout");
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"ViewModel retornou {process.ExitCode}.\nSTDOUT:\n{stdout.Result}\nSTDERR:\n{stderr.Result}");
        }
        return stdout.Result;
    }

    private static string MonitorDirectory([CallerFilePath] string testSourcePath = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(testSourcePath)!, "..", "PrimeNexMonitor"));
}
