using System.Security.Cryptography;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

public sealed class AutoRecoveryV1Tests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "PrimeNex-G13-" + Guid.NewGuid().ToString("N"));
    private readonly string _stage;
    private readonly string _exportados;
    private readonly string _recovery;
    private readonly string _logs;
    private readonly FakeClock _clock = new() { Now = DateTime.UtcNow };
    private readonly FakeExportStageWatcher _watcher = new();
    private readonly FakeExportValidator _validator = new(new CallSpy());
    private readonly FakeFileMover _mover = new();
    private readonly FakeAgentLogger _logger = new();

    public AutoRecoveryV1Tests()
    {
        _stage = Path.Combine(_root, "EXPORT_STAGE");
        _exportados = Path.Combine(_root, "EXPORTADOS");
        _recovery = Path.Combine(_root, "RECOVERY", "EXPORT_STAGE");
        _logs = Path.Combine(_root, "LOGS");
        Directory.CreateDirectory(_stage);
        Directory.CreateDirectory(_exportados);
        Directory.CreateDirectory(_recovery);
        Directory.CreateDirectory(_logs);
    }

    [Fact]
    public void EMPTY_STAGE_ContinuaSemAcao()
    {
        var result = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());
        Assert.Equal(AutoRecoveryClassification.EMPTY, result.Classification);
        Assert.False(result.ShouldStopRun);
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void VALID_ORPHAN_XLS_ComDurableIntent_PublicaUmaVez()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "conteudo sintetico");
        AddIntent(source);
        var result = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());
        Assert.True(result.Succeeded);
        Assert.Equal(AutoRecoveryOutcome.XlsPublished, result.Outcome);
        Assert.False(File.Exists(source));
        Assert.True(File.Exists(Path.Combine(_exportados, Path.GetFileName(source))));
        Assert.Equal(1, _mover.MoveCalls);
    }

    [Fact]
    public void DURABLE_INTENT_ABSENT_FailClosed()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "x");
        var result = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());
        Assert.False(result.Succeeded);
        Assert.True(File.Exists(source));
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void INVALID_XLS_FailClosed()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "x");
        AddIntent(source);
        _validator.Result = ExportValidationResult.Fail(AgentErrorCode.ReaderRejected, "invalido");
        var result = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());
        Assert.False(result.Succeeded);
        Assert.True(File.Exists(source));
    }

    [Fact]
    public void LOCKED_XLS_FailClosed()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "x");
        AddIntent(source);
        using var locked = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.None);
        var result = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());
        Assert.False(result.Succeeded);
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void DUPLICATE_XLS_HASH_FailClosed()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "duplicado");
        File.WriteAllText(Path.Combine(_exportados, "anterior.xls"), "duplicado");
        AddIntent(source);
        Assert.False(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);
        Assert.True(File.Exists(source));
    }

    [Fact]
    public void DESTINATION_ALREADY_EXISTS_FailClosed()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "x");
        File.WriteAllText(Path.Combine(_exportados, Path.GetFileName(source)), "outro");
        AddIntent(source);
        Assert.False(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void ORPHAN_CSV_VaiSomenteParaRecovery()
    {
        var source = Stage("vendas-auto-20260923-201004.csv", "transitorio");
        AddIntent(source);
        var result = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());
        Assert.Equal(AutoRecoveryOutcome.CsvQuarantined, result.Outcome);
        Assert.True(File.Exists(Path.Combine(_recovery, Path.GetFileName(source))));
        Assert.False(File.Exists(Path.Combine(_exportados, Path.GetFileName(source))));
    }

    [Fact]
    public void CSV_SAME_HASH_DIFFERENT_RUN_DIFFERENT_FILENAME()
    {
        const string contents = "mesmo CSV transitorio";
        var first = Stage("vendas-auto-20260923-201004.csv", contents);
        AddIntent(first, Guid.NewGuid(), Guid.NewGuid());
        Assert.True(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);

        var second = Stage("vendas-auto-20260924-134006.csv", contents);
        AddIntent(second, Guid.NewGuid(), Guid.NewGuid());
        var result = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());

        Assert.True(result.Succeeded);
        Assert.Equal(AutoRecoveryOutcome.CsvQuarantined, result.Outcome);
        Assert.True(File.Exists(Path.Combine(_recovery, Path.GetFileName(first))));
        Assert.True(File.Exists(Path.Combine(_recovery, Path.GetFileName(second))));
        Assert.Equal(2, _mover.MoveCalls);
    }

    [Fact]
    public void CSV_SAME_HASH_SAME_RUN_SAME_FILENAME()
    {
        var runId = Guid.NewGuid();
        var correlationId = Guid.NewGuid();
        const string name = "vendas-auto-20260924-134006.csv";
        const string contents = "mesmo incidente";
        var source = Stage(name, contents);
        AddIntent(source, runId, correlationId);
        Assert.True(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);

        File.Delete(Path.Combine(_recovery, name));
        Stage(name, contents);
        var replay = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());

        Assert.False(replay.Succeeded);
        Assert.Equal(1, _mover.MoveCalls);
    }

    [Fact]
    public void CSV_SAME_HASH_DIFFERENT_RUN_BUT_MISSING_ORIGIN_PROOF()
    {
        const string contents = "mesmo hash sem prova";
        File.WriteAllText(Path.Combine(_recovery, "vendas-auto-20260923-201004.csv"), contents);
        var source = Stage("vendas-auto-20260924-134006.csv", contents);

        var result = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());

        Assert.False(result.Succeeded);
        Assert.Equal(AutoRecoveryClassification.TRANSIENT_CSV_ORPHAN, result.Classification);
        Assert.True(File.Exists(source));
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void CSV_SAME_HASH_EXISTING_IN_RECOVERY_DIFFERENT_INCIDENT()
    {
        const string contents = "hash repetivel do CSV transitorio";
        File.WriteAllText(Path.Combine(_recovery, "vendas-auto-20260923-201004.csv"), contents);
        var source = Stage("vendas-auto-20260924-134006.csv", contents);
        AddIntent(source, Guid.NewGuid(), Guid.NewGuid());

        var result = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());

        Assert.True(result.Succeeded);
        Assert.True(File.Exists(Path.Combine(_recovery, Path.GetFileName(source))));
    }

    [Fact]
    public void XLS_SAME_HASH_DIFFERENT_RUN()
    {
        const string contents = "mesmo XLS final";
        var first = Stage("vendas-auto-20260923-120143.xls", contents);
        AddIntent(first, Guid.NewGuid(), Guid.NewGuid());
        Assert.True(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);

        File.Delete(Path.Combine(_exportados, Path.GetFileName(first)));
        var second = Stage("vendas-auto-20260924-120143.xls", contents);
        AddIntent(second, Guid.NewGuid(), Guid.NewGuid());
        var result = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());

        Assert.False(result.Succeeded);
        Assert.True(File.Exists(second));
        Assert.Equal(1, _mover.MoveCalls);
    }

    [Fact]
    public void CSV_WITH_FINAL_XLS_PRESENT_FailClosed()
    {
        var csv = Stage("vendas-auto-20260923-201004.csv", "transitorio");
        Stage("vendas-auto-20260923-201004.xls", "final");
        AddIntent(csv);
        Assert.False(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);
        Assert.True(File.Exists(csv));
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void MULTIPLE_STAGE_FILES_E_UNKNOWN_EXTENSION_FailClosed()
    {
        Stage("vendas-auto-20260923-120143.xls", "x");
        Stage("unexpected.tmp", "x");
        Assert.False(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void UNKNOWN_EXTENSION_Sozinha_FailClosed()
    {
        Stage("vendas-auto-20260923-120143.tmp", "x");
        var result = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());
        Assert.False(result.Succeeded);
        Assert.Equal(AutoRecoveryClassification.AMBIGUOUS, result.Classification);
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void AGE_BELOW_PT5M_FailClosed()
    {
        var source = Path.Combine(_stage, "vendas-auto-20260923-120143.xls");
        File.WriteAllText(source, "x");
        File.SetLastWriteTimeUtc(source, _clock.Now.ToUniversalTime() - TimeSpan.FromMinutes(4));
        AddIntent(source);
        Assert.False(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);
    }

    [Fact]
    public void MOVE_FAILURE_ZeroRetry()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "x");
        AddIntent(source);
        _mover.ThrowOnMove = new IOException("falha simulada");
        Assert.False(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);
        Assert.Equal(1, _mover.MoveCalls);
    }

    [Fact]
    public void FILE_STILL_GROWING_FailClosed()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "x");
        AddIntent(source);
        _watcher.WaitResult = ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable, "continua crescendo");
        Assert.False(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void HASH_CHANGE_BETWEEN_CHECK_AND_MOVE_FailClosed()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "aaaa");
        AddIntent(source);
        var calls = 0;
        _watcher.OnWait = () =>
        {
            calls++;
            if (calls == 2) File.WriteAllText(source, "bbbb");
        };
        Assert.False(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);
        Assert.True(File.Exists(source));
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void RECOVERY_ALREADY_RECORDED_FailClosed()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "x");
        AddIntent(source);
        var hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(source)));
        var ledger = new RecoveryLedger(LedgerPath);
        Assert.True(ledger.AppendIntentPending(Guid.NewGuid(), Guid.NewGuid(), Path.GetFileName(source), "FINAL_XLS_ORPHAN", hash, source, Path.Combine(_exportados, Path.GetFileName(source)), out _));
        Assert.False(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void JSONL_TRUNCATED_LAST_RECORD_FailClosed()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "x");
        AddIntent(source);
        File.AppendAllText(LedgerPath, "{\"recordType\":");
        Assert.False(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void LEDGER_INTENT_PENDING_AMBIGUOUS_FailClosed()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "x");
        AddIntent(source);
        var hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(source)));
        var ledger = new RecoveryLedger(LedgerPath);
        ledger.AppendIntentPending(Guid.NewGuid(), Guid.NewGuid(), Path.GetFileName(source), "FINAL_XLS_ORPHAN", hash, source, Path.Combine(_exportados, Path.GetFileName(source)), out _);
        ledger.AppendIntentPending(Guid.NewGuid(), Guid.NewGuid(), Path.GetFileName(source), "FINAL_XLS_ORPHAN", hash, source, Path.Combine(_exportados, Path.GetFileName(source)), out _);
        Assert.False(Service().TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);
    }

    [Fact]
    public void DURABLE_INTENT_FLUSH_FAILURE_NaoPersiste()
    {
        var store = new DurableExportIntentStore(Path.Combine(_logs, "flush-fail.jsonl"), _ => throw new IOException("flush"));
        var intent = new DurableExportIntent(Guid.NewGuid(), Guid.NewGuid(), "vendas-auto-20260923-120143", ".xls", _clock.Now, "ExpectedExport");
        Assert.False(store.RecordExpected(intent, out _));
    }

    [Fact]
    public void LEDGER_DURABLE_FLUSH_FAILURE_NaoMove()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "x");
        AddIntent(source);
        var ledger = new RecoveryLedger(LedgerPath, _ => throw new IOException("flush"));
        Assert.False(Service(ledger: ledger).TryRecover(Guid.NewGuid(), Guid.NewGuid()).Succeeded);
        Assert.True(File.Exists(source));
        Assert.Equal(0, _mover.MoveCalls);
    }

    [Fact]
    public void DURABLE_INTENT_PRESENT_EncontraOrigemSemJsonlDoLauncher()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "x");
        AddIntent(source);
        var lookup = new DurableExportIntentStore(IntentPath).FindPending(Path.GetFileNameWithoutExtension(source));
        Assert.True(lookup.Healthy);
        Assert.True(lookup.Found);
    }

    [Fact]
    public void XLS_ORPHAN_WITH_MISSING_NORMAL_LOG_BUT_VALID_DURABLE_INTENT_Recupera()
    {
        var source = Stage("vendas-auto-20260923-120143.xls", "incidente conceitual 23-09");
        AddIntent(source);
        var result = Service().TryRecover(Guid.NewGuid(), Guid.NewGuid());
        Assert.True(result.Succeeded);
        Assert.DoesNotContain(_logger.Events, e => e.Stage == nameof(AgentStage.FileSaveTriggered));
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private FileSystemAutoRecoveryService Service(RecoveryLedger? ledger = null, DurableExportIntentStore? intents = null) => new(
        _stage, _exportados, _recovery, _watcher, _validator,
        new FileMoveAtomicPublisher(_mover, _stage, _exportados),
        new FileMoveAtomicQuarantinePublisher(_mover, _stage, _recovery),
        intents ?? new DurableExportIntentStore(IntentPath), ledger ?? new RecoveryLedger(LedgerPath), _logger, _clock);

    private string Stage(string name, string contents)
    {
        var path = Path.Combine(_stage, name);
        File.WriteAllText(path, contents);
        File.SetLastWriteTimeUtc(path, _clock.Now.ToUniversalTime() - TimeSpan.FromMinutes(6));
        return path;
    }

    private DurableExportIntent AddIntent(string source, Guid? runId = null, Guid? correlationId = null)
    {
        var intent = new DurableExportIntent(
            runId ?? Guid.NewGuid(), correlationId ?? Guid.NewGuid(), Path.GetFileNameWithoutExtension(source), ".xls", _clock.Now.ToUniversalTime(), "ExpectedExport");
        var ok = new DurableExportIntentStore(IntentPath).RecordExpected(intent, out _);
        Assert.True(ok);
        return intent;
    }

    private string IntentPath => Path.Combine(_logs, "g13-export-intents.jsonl");
    private string LedgerPath => Path.Combine(_logs, "g13-auto-recovery-ledger.jsonl");
}

public sealed class AutoRecoveryPipelineTests
{
    [Fact]
    public void RECOVERY_SUCCESS_STOPS_CURRENT_RUN_AND_DOES_NOT_TOUCH_NEX_UI()
    {
        var fx = new OrchestratorFixture();
        var recovery = new FixedRecovery(AutoRecoveryResult.PublishedXls(@"C:\temp\recovered.xls"), fx.Spy);
        var result = fx.BuildOrchestrator(autoRecovery: recovery).Run();
        Assert.True(result.Success);
        Assert.True(result.RecoveryCompleted);
        Assert.Equal(0, fx.InputSender.SendExportShortcutCalls);
        Assert.Equal(0, fx.Spy.CountOf(nameof(FakeNexWindowInspector.LocateNexAdmin)));
        Assert.True(fx.Spy.Before(nameof(FakeSessionInspector.CheckSession), 1, "AutoRecovery", 1));
    }

    [Fact]
    public void SESSION_INVALID_AUTO_RECOVERY_NOT_EXECUTED()
    {
        var fx = new OrchestratorFixture();
        fx.SessionInspector.Result = SessionCheckResult.Fail(AgentErrorCode.SessionUnavailable, "sessao indisponivel");
        var recovery = new FixedRecovery(AutoRecoveryResult.Empty());
        fx.BuildOrchestrator(autoRecovery: recovery).Run();
        Assert.Equal(0, recovery.Calls);
    }

    [Fact]
    public void DURABLE_INTENT_PRESENT_BeforeFileSaveTriggered_AndResolvedAfterPublish()
    {
        var fx = new OrchestratorFixture();
        var intents = new RecordingIntentStore(fx.Spy);
        var result = fx.BuildOrchestrator(exportIntentStore: intents).Run();
        Assert.True(result.Success);
        Assert.Equal(1, intents.RecordCalls);
        Assert.Equal(1, intents.ResolveCalls);
        Assert.True(fx.Spy.Before("RecordExpected", 1, nameof(FakeConfirmedSaveDialogCommitter.CommitOnce), 1));
    }

    private sealed class FixedRecovery : IAutoRecoveryService
    {
        private readonly AutoRecoveryResult _result;
        private readonly CallSpy? _spy;
        public int Calls { get; private set; }
        public FixedRecovery(AutoRecoveryResult result, CallSpy? spy = null) { _result = result; _spy = spy; }
        public AutoRecoveryResult TryRecover(Guid runId, Guid correlationId) { Calls++; _spy?.Record("AutoRecovery"); return _result; }
    }

    private sealed class RecordingIntentStore : IExportIntentStore
    {
        private readonly CallSpy _spy;
        public int RecordCalls { get; private set; }
        public int ResolveCalls { get; private set; }
        public RecordingIntentStore(CallSpy spy) => _spy = spy;
        public bool RecordExpected(DurableExportIntent intent, out string reason) { RecordCalls++; _spy.Record("RecordExpected"); reason = string.Empty; return true; }
        public bool Resolve(DurableExportIntent intent, out string reason) { ResolveCalls++; _spy.Record("ResolveIntent"); reason = string.Empty; return true; }
        public DurableIntentLookup FindPending(string expectedBasename) => DurableIntentLookup.Missing();
    }
}
