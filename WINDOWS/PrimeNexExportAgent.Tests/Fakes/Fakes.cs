using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Logging;

namespace PrimeNexExportAgent.Tests.Fakes;

public sealed class FakeClock : IClock
{
    public DateTime Now { get; set; } = new DateTime(2026, 9, 1, 14, 30, 0, DateTimeKind.Local);
}

public sealed class FakeExecutionLock : IExecutionLock
{
    private readonly CallSpy _spy;
    public bool AcquireSucceeds { get; set; } = true;
    public int TryAcquireCalls { get; private set; }
    public int ReleaseCalls { get; private set; }

    public FakeExecutionLock(CallSpy spy) => _spy = spy;

    public bool TryAcquire()
    {
        TryAcquireCalls++;
        _spy.Record(nameof(TryAcquire));
        return AcquireSucceeds;
    }

    public void Release()
    {
        ReleaseCalls++;
        _spy.Record(nameof(Release));
    }
}

public sealed class FakeSessionInspector : ISessionInspector
{
    private readonly CallSpy _spy;
    public SessionCheckResult Result { get; set; } = SessionCheckResult.Pass(agentSessionId: 1);

    public FakeSessionInspector(CallSpy spy) => _spy = spy;

    public SessionCheckResult CheckSession()
    {
        _spy.Record(nameof(CheckSession));
        return Result;
    }
}

public sealed class FakeNexWindowInspector : INexWindowInspector
{
    private readonly CallSpy _spy;

    /// <summary>Identidade padrao usada pelo happy path de todos os testes -
    /// PID e HWND arbitrarios, mas fixos, para permitir asserção de
    /// igualdade de referencia/valor (F6.13.4).</summary>
    public static readonly NexAdminWindowIdentity DefaultIdentity = new(processId: 1316, mainWindowHandle: 0xABC);

    public NexAdminLocateResult LocateResult { get; set; } = NexAdminLocateResult.Pass(DefaultIdentity);
    public NexWindowCheckResult SafeStateResult { get; set; } = NexWindowCheckResult.Pass();
    public int? LastExpectedSessionIdReceived { get; private set; }
    public NexAdminWindowIdentity? LastTargetReceived { get; private set; }

    public FakeNexWindowInspector(CallSpy spy) => _spy = spy;

    public NexAdminLocateResult LocateNexAdmin(int expectedSessionId)
    {
        LastExpectedSessionIdReceived = expectedSessionId;
        _spy.Record(nameof(LocateNexAdmin));
        return LocateResult;
    }

    public NexWindowCheckResult CheckSafeState(NexAdminWindowIdentity target)
    {
        LastTargetReceived = target;
        _spy.Record(nameof(CheckSafeState));
        return SafeStateResult;
    }
}

public sealed class FakeInputSender : IInputSender
{
    private readonly CallSpy _spy;
    public int SendExportShortcutCalls { get; private set; }
    public NexAdminWindowIdentity? LastTargetReceived { get; private set; }
    public Exception? ThrowOnSend { get; set; }

    public FakeInputSender(CallSpy spy) => _spy = spy;

    public void SendExportShortcut(NexAdminWindowIdentity target)
    {
        SendExportShortcutCalls++;
        LastTargetReceived = target;
        _spy.Record(nameof(SendExportShortcut));
        if (ThrowOnSend is not null) throw ThrowOnSend;
    }
}

public sealed class FakeSaveDialogInspector : ISaveDialogInspector
{
    private readonly CallSpy _spy;
    public SaveDialogIdentityResult IdentityResult { get; set; } = SaveDialogIdentityResult.Pass();
    public SaveDialogReadbackResult ReadbackResult { get; set; } = SaveDialogReadbackResult.Pass();
    public (string destination, string fileName, string fileType)? LastReadBackArgs { get; private set; }

    public FakeSaveDialogInspector(CallSpy spy) => _spy = spy;

    public SaveDialogIdentityResult IdentifySaveDialog()
    {
        _spy.Record(nameof(IdentifySaveDialog));
        return IdentityResult;
    }

    public SaveDialogReadbackResult ReadBack(string expectedDestination, string expectedFileName, string expectedFileType)
    {
        LastReadBackArgs = (expectedDestination, expectedFileName, expectedFileType);
        _spy.Record(nameof(ReadBack));
        return ReadbackResult;
    }
}

public sealed class FakeSaveDialogController : ISaveDialogController
{
    private readonly CallSpy _spy;
    public int ConfigureCalls { get; private set; }
    public int ClickSaveCalls { get; private set; }
    public int CancelSaveDialogCalls { get; private set; }
    public Exception? ThrowOnClickSave { get; set; }
    public (string destination, string fileName, string fileType)? LastConfigureArgs { get; private set; }

    public FakeSaveDialogController(CallSpy spy) => _spy = spy;

    public void Configure(string destination, string fileName, string fileType)
    {
        ConfigureCalls++;
        LastConfigureArgs = (destination, fileName, fileType);
        _spy.Record(nameof(Configure));
    }

    public void ClickSave()
    {
        ClickSaveCalls++;
        _spy.Record(nameof(ClickSave));
        if (ThrowOnClickSave is not null) throw ThrowOnClickSave;
    }

    public void CancelSaveDialog()
    {
        CancelSaveDialogCalls++;
        _spy.Record(nameof(CancelSaveDialog));
    }
}

public sealed class FakeFileStabilityChecker : IFileStabilityChecker
{
    private readonly CallSpy _spy;
    public FileStabilityResult Result { get; set; } = FileStabilityResult.Stabilized();

    public FakeFileStabilityChecker(CallSpy spy) => _spy = spy;

    public FileStabilityResult WaitForStable(string filePath, TimeSpan timeout)
    {
        _spy.Record(nameof(WaitForStable));
        return Result;
    }
}

public sealed class FakeExportValidator : IExportValidator
{
    private readonly CallSpy _spy;
    public ExportValidationResult Result { get; set; } = ExportValidationResult.Ok(recordCount: 42);

    public FakeExportValidator(CallSpy spy) => _spy = spy;

    public ExportValidationResult Validate(string filePath)
    {
        _spy.Record(nameof(Validate));
        return Result;
    }
}

public sealed class FakeAtomicPublisher : IAtomicPublisher
{
    private readonly CallSpy _spy;
    public PublishResult Result { get; set; } = PublishResult.Ok(@"C:\Nex\PrimeIntegracaoNex\EXPORTADOS\vendas-auto-fake.xls");

    public FakeAtomicPublisher(CallSpy spy) => _spy = spy;

    public PublishResult Publish(string sourcePath, string destinationDirectory)
    {
        _spy.Record(nameof(Publish));
        return Result;
    }
}

public sealed class FakeAgentLogger : IAgentLogger
{
    public List<AgentLogEvent> Events { get; } = new();

    /// <summary>Se definido, a PRIMEIRA chamada a Log() lanca esta excecao
    /// (simula um logger real falhando, ex.: disco cheio/permissao) e
    /// depois se comporta normalmente - usado para provar que Run() nunca
    /// deixa essa excecao escapar sem tratamento (F6.13.2 correcao).</summary>
    public Exception? ThrowOnFirstLog { get; set; }

    /// <summary>Se definido, TODAS as chamadas a Log() lancam esta excecao,
    /// sempre (nunca se autolimpa) - simula um logger permanentemente
    /// quebrado (F6.13.3), usado para provar que mesmo o Log(Failed,...)
    /// dentro do catch de Run() nunca deixa uma segunda excecao escapar.</summary>
    public Exception? ThrowOnEveryLog { get; set; }

    public void Log(AgentLogEvent evt)
    {
        if (ThrowOnEveryLog is not null) throw ThrowOnEveryLog;

        if (ThrowOnFirstLog is not null)
        {
            var ex = ThrowOnFirstLog;
            ThrowOnFirstLog = null;
            throw ex;
        }
        Events.Add(evt);
    }
}
