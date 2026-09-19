using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes de COMPORTAMENTO do Core do Monitor (PrimeNexMonitor.Core.ps1),
/// executando as funcoes reais via powershell.exe com dot-source.
///
/// Todas as fixtures vivem em Path.GetTempPath(). Nenhum teste le ou escreve
/// em EXPORT_STAGE, EXPORTADOS, LOGS ou OUTPUT de producao, nao inicia Agent
/// ou Launcher, nao toca a Task nem o NEX.
/// </summary>
public sealed class MonitorCoreBehaviorTests : IDisposable
{
    private readonly string _fixtureRoot = Path.Combine(
        Path.GetTempPath(),
        "PrimeNexMonitorCoreTests-" + Guid.NewGuid().ToString("N"));

    public MonitorCoreBehaviorTests() => Directory.CreateDirectory(_fixtureRoot);

    public void Dispose()
    {
        try { Directory.Delete(_fixtureRoot, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    // ---------------------------------------------------------------- A / B / C
    // Outbox: classificacao a partir do snapshot.

    [Fact]
    public void A_OutboxSemPendenciaFicaVerde()
    {
        var health = EvaluateOutbox("@{ 'SENT' = 12; 'REVIEW_STORED' = 17 }", oldestOpen: null);

        Assert.Equal("NORMAL", health.Level);
        Assert.Contains("12 SENT", health.Summary);
        Assert.Contains("0 abertos", health.Summary);
        Assert.Equal(string.Empty, health.Detail);
    }

    [Fact]
    public void B_OutboxComFailedFicaVermelhoEExpoeIdentificacao()
    {
        var health = EvaluateOutbox(
            "@{ 'SENT' = 12; 'FAILED' = 1 }",
            oldestOpen: OpenItem("SALE_PAID:NEX:15798", "15798", "FAILED", 5, minutesAgo: 6000, error: "Erro de rede apos 3 tentativa(s)."));

        Assert.Equal("PROBLEMA", health.Level);
        Assert.Contains("SALE_PAID:NEX:15798", health.Detail);
        Assert.Contains("NEX 15798", health.Detail);
        Assert.Contains("tentativas 5", health.Detail);
        Assert.Contains("Erro de rede", health.Detail);
    }

    [Fact]
    public void C_PendingRecenteFicaVerdeEEnvelhecidoEscala()
    {
        var recente = EvaluateOutbox("@{ 'PENDING' = 1 }", OpenItem("E:1", "1", "PENDING", 0, minutesAgo: 0.5));
        Assert.Equal("NORMAL", recente.Level);

        var intermediario = EvaluateOutbox("@{ 'PENDING' = 1 }", OpenItem("E:1", "1", "PENDING", 1, minutesAgo: 5));
        Assert.Equal("ATENCAO", intermediario.Level);

        var antigo = EvaluateOutbox("@{ 'SENDING' = 1 }", OpenItem("E:1", "1", "SENDING", 2, minutesAgo: 20));
        Assert.Equal("PROBLEMA", antigo.Level);

        // RETRY e amarelo mesmo recem-criado: ja houve falha de transporte.
        var retry = EvaluateOutbox("@{ 'RETRY' = 1 }", OpenItem("E:1", "1", "RETRY", 1, minutesAgo: 0.2));
        Assert.Equal("ATENCAO", retry.Level);
    }

    [Fact]
    public void C2_FonteIndisponivelSoElevaAposFalhasConsecutivas()
    {
        var isolada = RunHealth("Get-OutboxHealth -Outbox ([pscustomobject]@{ Available = $false; Error = 'timeout' }) -ConsecutiveFailures 1");
        Assert.Equal("NORMAL", isolada.Level);

        var persistente = RunHealth("Get-OutboxHealth -Outbox ([pscustomobject]@{ Available = $false; Error = 'timeout' }) -ConsecutiveFailures 3");
        Assert.Equal("ATENCAO", persistente.Level);
        Assert.Contains("timeout", persistente.Detail);
    }

    [Fact]
    public void C3_LeituraRealDeBancoTemporarioClassificaFailed()
    {
        var node = ResolveNodeExe();
        if (node is null) return; // ambiente sem node: os demais testes ja cobrem a classificacao

        var db = Path.Combine(_fixtureRoot, "outbox-fixture.db");
        var seed = """
            const { DatabaseSync } = require("node:sqlite");
            const db = new DatabaseSync(process.argv[2]);
            db.exec("CREATE TABLE outbox (event_id TEXT PRIMARY KEY, nex_transaction_id TEXT, status TEXT, tentativas INTEGER, created_at TEXT, updated_at TEXT, ultimo_erro TEXT, result TEXT, http_status INTEGER, payload_json TEXT)");
            db.exec("INSERT INTO outbox VALUES ('SALE_PAID:NEX:99','99','FAILED',5,'2026-09-14T18:20:28.874Z','2026-09-14T18:28:10.449Z','falha simulada','ERROR',NULL,'{\"segredo\":\"nao deve vazar\"}')");
            db.close();
            """;
        RunNode(node, seed, db);

        var health = RunHealth($"Get-OutboxHealth -Outbox (Get-OutboxSnapshot -DbPath '{db}')");

        Assert.Equal("PROBLEMA", health.Level);
        Assert.Contains("SALE_PAID:NEX:99", health.Detail);
        Assert.DoesNotContain("nao deve vazar", health.Detail);
        Assert.DoesNotContain("segredo", health.Detail);
    }

    // ---------------------------------------------------------------- D / E
    // EXPORT_STAGE: classificacao a partir do diretorio real.

    [Fact]
    public void D_StageVazioFicaVerde()
    {
        var stage = Path.Combine(_fixtureRoot, "stage-vazio");
        Directory.CreateDirectory(stage);

        var health = EvaluateStage(stage, g13Blocked: false);

        Assert.Equal("NORMAL", health.Level);
        Assert.Equal("vazio", health.Summary);
    }

    [Fact]
    public void D2_StageVazioNaoQuebraASomaDeTamanho()
    {
        // Regressao: Measure-Object sobre pipeline vazio devolve $null no PS 5.1,
        // e sob Set-StrictMode ler .Sum de $null derrubava a leitura inteira para
        // "Leitura indisponivel" mesmo com o diretorio simplesmente vazio.
        var stage = Path.Combine(_fixtureRoot, "stage-vazio-soma");
        Directory.CreateDirectory(stage);

        var snapshot = ReadStageSnapshot(stage);

        Assert.Equal("True", snapshot["AVAILABLE"]);
        Assert.Equal(string.Empty, snapshot["ERROR"]);
        Assert.Equal("0", snapshot["COUNT"]);
        Assert.Equal("0", snapshot["TOTALBYTES"]);
        Assert.Equal(string.Empty, snapshot["OLDEST"]);
        Assert.Equal(string.Empty, snapshot["OLDESTAGE"]);
    }

    [Fact]
    public void D3_StageComUmArquivoSomaTamanho()
    {
        var stage = CreateStage("stage-um-arquivo", ("vendas-auto-20260918-120000.xls", 1));
        File.WriteAllText(Path.Combine(stage, "vendas-auto-20260918-120000.xls"), new string('x', 1234));

        var snapshot = ReadStageSnapshot(stage);

        Assert.Equal("True", snapshot["AVAILABLE"]);
        Assert.Equal("1", snapshot["COUNT"]);
        Assert.Equal("1234", snapshot["TOTALBYTES"]);
    }

    [Fact]
    public void D4_StageComVariosArquivosSomaTamanhoTotal()
    {
        var stage = Path.Combine(_fixtureRoot, "stage-varios");
        Directory.CreateDirectory(stage);
        File.WriteAllText(Path.Combine(stage, "vendas-auto-20260918-120000.xls"), new string('x', 100));
        File.WriteAllText(Path.Combine(stage, "vendas-auto-20260918-120500.xls"), new string('y', 250));
        File.WriteAllText(Path.Combine(stage, "vendas-auto-20260918-121000.csv"), new string('z', 650));

        var snapshot = ReadStageSnapshot(stage);

        Assert.Equal("True", snapshot["AVAILABLE"]);
        Assert.Equal("3", snapshot["COUNT"]);
        Assert.Equal("1000", snapshot["TOTALBYTES"]);
    }

    [Fact]
    public void E_StageComArquivoAntigoOuAnormalFicaVermelho()
    {
        var recente = CreateStage("stage-recente", ("vendas-auto-20260918-120000.xls", 1));
        Assert.Equal("NORMAL", EvaluateStage(recente, false).Level);

        var intermediario = CreateStage("stage-intermediario", ("vendas-auto-20260918-120000.xls", 10));
        Assert.Equal("ATENCAO", EvaluateStage(intermediario, false).Level);

        var antigo = CreateStage("stage-antigo", ("vendas-auto-20260918-120000.xls", 45));
        var antigoHealth = EvaluateStage(antigo, false);
        Assert.Equal("PROBLEMA", antigoHealth.Level);
        Assert.Contains("vendas-auto-20260918-120000.xls", antigoHealth.Detail);

        var duplicado = CreateStage("stage-duplicado",
            ("vendas-auto-20260918-120000.xls", 1),
            ("vendas-auto-20260918-120500.xls", 1));
        Assert.Equal("PROBLEMA", EvaluateStage(duplicado, false).Level);

        var inesperado = CreateStage("stage-inesperado", ("arquivo-estranho.txt", 1));
        Assert.Equal("PROBLEMA", EvaluateStage(inesperado, false).Level);

        // G13 confirmado e vermelho mesmo com arquivo recentissimo.
        var g13 = CreateStage("stage-g13", ("vendas-auto-20260918-120000.xls", 1));
        Assert.Equal("PROBLEMA", EvaluateStage(g13, true).Level);
    }

    // ---------------------------------------------------------------- F / G
    // ULTIMO SUCCESS: streak de ciclos anomalos.

    [Fact]
    public void F_SuccessRecenteFicaVerde()
    {
        var health = EvaluateSuccess(streak: 0, nexPosition: "BACKGROUND");

        Assert.Equal("NORMAL", health.Level);
        Assert.Equal(string.Empty, health.Detail);
    }

    [Fact]
    public void G_StreakEscalaParaAmareloEVermelho()
    {
        Assert.Equal("NORMAL", EvaluateSuccess(2, "BACKGROUND").Level);
        Assert.Equal("ATENCAO", EvaluateSuccess(3, "BACKGROUND").Level);
        Assert.Equal("ATENCAO", EvaluateSuccess(9, "BACKGROUND").Level);

        var vermelho = EvaluateSuccess(10, "FOREGROUND");
        Assert.Equal("PROBLEMA", vermelho.Level);
        Assert.Contains("streak 10", vermelho.Detail);

        // NEX indisponivel suspende a contagem: noite nunca vira alarme.
        Assert.Equal("NORMAL", EvaluateSuccess(50, "CLOSED").Level);
        Assert.Equal("NORMAL", EvaluateSuccess(50, "MINIMIZED").Level);
    }

    [Fact]
    public void G2_StreakIgnoraEstagiosNeutrosENaoZeraComEles()
    {
        var logDir = Path.Combine(_fixtureRoot, "logs-streak");
        Directory.CreateDirectory(logDir);

        // Do mais antigo para o mais novo: Success, depois anomalos intercalados
        // com neutros. O streak deve contar 3 (dois UnsafeState + um Failed).
        var linhas = new[]
        {
            Jsonl("r1", "Success", "2026-09-18T10:00:00.0000000-03:00"),
            Jsonl("r2", "NEX_MINIMIZED", "2026-09-18T10:05:00.0000000-03:00"),
            Jsonl("r3", "UnsafeState", "2026-09-18T10:10:00.0000000-03:00"),
            Jsonl("r4", "SkippedNotForeground", "2026-09-18T10:15:00.0000000-03:00"),
            Jsonl("r5", "UnsafeState", "2026-09-18T10:20:00.0000000-03:00"),
            Jsonl("r6", "NEX_CLOSED", "2026-09-18T10:25:00.0000000-03:00"),
            Jsonl("r7", "Failed", "2026-09-18T10:30:00.0000000-03:00"),
        };
        File.WriteAllLines(
            Path.Combine(logDir, "prime-nex-export-agent-scheduled-2026-09-18.jsonl"),
            linhas);

        var streak = RunCore($"""
            $script:LogDirectory = '{logDir}'
            $p = Get-PipelineSnapshot
            Write-Output ('STREAK=' + $p.AnomalousStreak)
            Write-Output ('DOM=' + $p.StreakDominantCode)
            Write-Output ('LASTSUCCESS=' + $p.LastSuccess.stage)
            """);

        Assert.Contains("STREAK=3", streak);
        Assert.Contains("DOM=UnsafeState", streak);
        Assert.Contains("LASTSUCCESS=Success", streak);
    }

    // ---------------------------------------------------------------- H / I

    [Fact]
    public void H_CoreNaoPossuiCapacidadeMutante()
    {
        var core = File.ReadAllText(CorePath());
        var ui = File.ReadAllText(UiPath());
        var ambos = core + "\n" + ui;

        foreach (var proibido in new[]
        {
            "SetForegroundWindow", "SetActiveWindow", "BringWindowToTop", "SwitchToThisWindow",
            "SendInput", "SetCursorPos", "PostMessage", "SendMessage", "SetFocus", "SetCapture",
            "AttachThreadInput", "ShowWindow", "SetWindowPos", "BlockInput", "InvokePattern",
            "accDoDefaultAction", "System.Windows.Automation", "schtasks",
            "Start-Process", "Stop-Process", "Remove-Item", "Move-Item", "Rename-Item",
            "Copy-Item", "New-Item", "Set-Content", "Add-Content", "Out-File",
            "Enable-ScheduledTask", "Disable-ScheduledTask", "Set-ScheduledTask",
            "Start-ScheduledTask", "Invoke-WebRequest", "Invoke-RestMethod", "Set-ItemProperty",
        })
        {
            Assert.DoesNotContain(proibido, ambos, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void I_ConsultaDaOutboxEEstritamenteSomenteLeitura()
    {
        var core = File.ReadAllText(CorePath());
        var inicio = core.IndexOf("$script:OutboxQueryScript = @'", StringComparison.Ordinal);
        Assert.True(inicio >= 0, "script de consulta da outbox nao encontrado");
        var fim = core.IndexOf("'@", inicio, StringComparison.Ordinal);
        var consulta = core.Substring(inicio, fim - inicio);

        Assert.Contains("readOnly: true", consulta);
        Assert.Contains("SELECT", consulta);
        Assert.DoesNotContain("payload_json", consulta);

        // Palavra inteira, nao substring: "updated_at" contem "UPDATE" e nao e
        // uma escrita.
        foreach (var proibido in new[] { "UPDATE", "INSERT", "DELETE", "DROP", "ATTACH", "PRAGMA", "VACUUM", "wal_checkpoint" })
        {
            Assert.False(
                Regex.IsMatch(consulta, $@"\b{Regex.Escape(proibido)}\b", RegexOptions.IgnoreCase),
                $"comando proibido '{proibido}' presente na consulta da outbox");
        }

        // O processo filho nunca passa por shell e sempre tem timeout.
        Assert.Contains("$psi.UseShellExecute = $false", core);
        Assert.Contains("WaitForExit($script:OutboxQueryTimeoutMs)", core);
        Assert.Contains("$script:OutboxQueryTimeoutMs = 3000", core);

        // Leitura de log continua compartilhando o arquivo com o Agent.
        Assert.Contains("[System.IO.FileShare]::ReadWrite", core);
    }

    // ---------------------------------------------------------------- infra

    private sealed record Health(string Level, string Summary, string Detail);

    private static string Jsonl(string runId, string stage, string timestamp)
        => $$"""{"timestamp":"{{timestamp}}","runId":"{{runId}}","stage":"{{stage}}","errorCode":null,"fileName":null,"reason":null,"hybridRoute":null,"nexPosition":null,"routeReason":null}""";

    private Health EvaluateOutbox(string countsLiteral, string? oldestOpen)
    {
        var open = oldestOpen ?? "$null";
        return RunHealth($"Get-OutboxHealth -Outbox ([pscustomobject]@{{ Available = $true; Counts = {countsLiteral}; OldestOpen = {open} }})");
    }

    private static string OpenItem(string eventId, string nexId, string status, int tentativas, double minutesAgo, string error = "")
    {
        var created = DateTimeOffset.Now.AddMinutes(-minutesAgo).ToString("o");
        return $"([pscustomobject]@{{ event_id = '{eventId}'; nex_transaction_id = '{nexId}'; status = '{status}'; tentativas = {tentativas}; created_at = '{created}'; ultimo_erro = '{error}' }})";
    }

    private string CreateStage(string name, params (string FileName, double MinutesOld)[] files)
    {
        var dir = Path.Combine(_fixtureRoot, name);
        Directory.CreateDirectory(dir);
        foreach (var (fileName, minutesOld) in files)
        {
            var path = Path.Combine(dir, fileName);
            File.WriteAllText(path, "fixture");
            File.SetLastWriteTime(path, DateTime.Now.AddMinutes(-minutesOld));
        }

        return dir;
    }

    private Dictionary<string, string> ReadStageSnapshot(string directory)
    {
        var output = RunCore($$"""
            $s = Get-ExportStageSnapshot -Directory '{{directory}}'
            Write-Output ('AVAILABLE=' + $s.Available)
            Write-Output ('COUNT=' + $s.Count)
            Write-Output ('TOTALBYTES=' + $s.TotalBytes)
            Write-Output ('OLDEST=' + $(if ($null -ne $s.Oldest) { $s.Oldest.Name } else { '' }))
            Write-Output ('OLDESTAGE=' + $(if ($null -ne $s.OldestAgeMinutes) { [math]::Floor($s.OldestAgeMinutes) } else { '' }))
            Write-Output ('ERROR=' + $s.Error)
            """);

        var mapa = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var chave in new[] { "AVAILABLE", "COUNT", "TOTALBYTES", "OLDEST", "OLDESTAGE", "ERROR" })
        {
            mapa[chave] = ExtractLine(output, chave + "=");
        }

        return mapa;
    }

    private Health EvaluateStage(string directory, bool g13Blocked)
        => RunHealth($"Get-StageHealth -Stage (Get-ExportStageSnapshot -Directory '{directory}') -G13Blocked ${g13Blocked.ToString().ToLowerInvariant()}");

    private Health EvaluateSuccess(int streak, string nexPosition)
        => RunHealth($"Get-SuccessHealth -Pipeline ([pscustomobject]@{{ AnomalousStreak = {streak}; StreakDominantCode = 'UnsafeState'; LastSuccess = $null }}) -Nex ([pscustomobject]@{{ Position = '{nexPosition}' }})");

    private Health RunHealth(string expression)
    {
        var output = RunCore($"""
            $h = {expression}
            Write-Output ('LEVEL=' + $h.Level)
            Write-Output ('SUMMARY=' + $h.Summary)
            Write-Output ('DETAIL=' + $h.Detail)
            """);

        return new Health(
            ExtractLine(output, "LEVEL="),
            ExtractLine(output, "SUMMARY="),
            ExtractLine(output, "DETAIL="));
    }

    private static string ExtractLine(string output, string prefix)
    {
        foreach (var line in output.Split('\n'))
        {
            var trimmed = line.TrimEnd('\r');
            if (trimmed.StartsWith(prefix, StringComparison.Ordinal))
            {
                return trimmed.Substring(prefix.Length);
            }
        }

        throw new InvalidOperationException($"Prefixo '{prefix}' ausente na saida:\n{output}");
    }

    private string RunCore(string body)
    {
        // Replica o preambulo real de PrimeNexMonitor.ps1 (linhas 3-4). Sem isto o
        // teste roda mais permissivo que o Monitor: um acesso a propriedade
        // inexistente devolveria $null em silencio em vez de lancar, e o teste
        // passaria enquanto a tela real quebraria.
        var preambulo = "Set-StrictMode -Version Latest\n$ErrorActionPreference = 'Stop'\n";
        var scriptPath = Path.Combine(_fixtureRoot, "runner-" + Guid.NewGuid().ToString("N") + ".ps1");
        File.WriteAllText(scriptPath, preambulo + ". '" + CorePath() + "'\n" + body, new UTF8Encoding(false));

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
            throw new InvalidOperationException($"Core retornou {process.ExitCode}.\nSTDOUT:\n{stdout.Result}\nSTDERR:\n{stderr.Result}");
        }

        return stdout.Result;
    }

    private static void RunNode(string nodeExe, string script, string dbPath)
    {
        var psi = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = $"- \"{dbPath}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };

        using var process = Process.Start(psi)!;
        process.StandardInput.Write(script);
        process.StandardInput.Close();
        var stderr = process.StandardError.ReadToEndAsync();
        Assert.True(process.WaitForExit(30_000), "node nao terminou dentro do timeout");
        Assert.True(process.ExitCode == 0, "falha ao montar o banco de fixture: " + stderr.Result);
    }

    private static string? ResolveNodeExe()
    {
        var candidato = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        return File.Exists(candidato) ? candidato : null;
    }

    private static string CorePath() => Path.Combine(MonitorDirectory(), "PrimeNexMonitor.Core.ps1");

    private static string UiPath() => Path.Combine(MonitorDirectory(), "PrimeNexMonitor.ps1");

    private static string MonitorDirectory([CallerFilePath] string testSourcePath = "")
    {
        for (var directory = new DirectoryInfo(Path.GetDirectoryName(testSourcePath)!); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "WINDOWS", "PrimeNexMonitor");
            if (File.Exists(Path.Combine(candidate, "PrimeNexMonitor.Core.ps1"))) return candidate;
        }

        throw new DirectoryNotFoundException("WINDOWS\\PrimeNexMonitor nao encontrado a partir do fonte de teste.");
    }
}
