using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Diagnostics;
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

    public NexWindowCheckResult SafeStateForClientNavigationResult { get; set; } = NexWindowCheckResult.Pass();
    public NexAdminWindowIdentity? LastClientNavigationTargetReceived { get; private set; }

    public NexWindowCheckResult CheckSafeStateForClientNavigation(NexAdminWindowIdentity target)
    {
        LastClientNavigationTargetReceived = target;
        _spy.Record(nameof(CheckSafeStateForClientNavigation));
        return SafeStateForClientNavigationResult;
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
    public static readonly SaveDialogIdentity DefaultDialog = new(dialogHandle: 0x7000);

    public SaveDialogIdentityResult IdentityResult { get; set; } = SaveDialogIdentityResult.Pass(DefaultDialog);
    public SaveDialogReadbackResult ReadbackResult { get; set; } = SaveDialogReadbackResult.Pass();
    public NexAdminWindowIdentity? LastTargetReceived { get; private set; }
    public SaveDialogIdentity? LastDialogReceivedInReadBack { get; private set; }
    public (string destination, string fileName, string fileType)? LastReadBackArgs { get; private set; }
    public int IdentifySaveDialogCalls { get; private set; }

    /// <summary>F6.14B2.4 - fila opcional de resultados sucessivos, um por
    /// chamada, para simular a race de tempo (0 candidatos no primeiro
    /// poll, 1 depois) sem tocar Win32 real. Se vazia, sempre retorna
    /// IdentityResult (comportamento anterior, usado pelos 78 testes do
    /// orquestrador que nao envolvem polling).</summary>
    public Queue<SaveDialogIdentityResult> IdentityResultSequence { get; } = new();

    public FakeSaveDialogInspector(CallSpy spy) => _spy = spy;

    public SaveDialogIdentityResult IdentifySaveDialog(NexAdminWindowIdentity target)
    {
        LastTargetReceived = target;
        IdentifySaveDialogCalls++;
        _spy.Record(nameof(IdentifySaveDialog));
        return IdentityResultSequence.Count > 0 ? IdentityResultSequence.Dequeue() : IdentityResult;
    }

    public SaveDialogReadbackResult ReadBack(SaveDialogIdentity dialog, string expectedDestination, string expectedFileName, string expectedFileType)
    {
        LastDialogReceivedInReadBack = dialog;
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
    public Exception? ThrowOnConfigure { get; set; }
    public SaveDialogIdentity? LastDialogReceivedInConfigure { get; private set; }
    public (string destination, string fileName, string fileType)? LastConfigureArgs { get; private set; }

    public FakeSaveDialogController(CallSpy spy) => _spy = spy;

    public void Configure(SaveDialogIdentity dialog, string destination, string fileName, string fileType)
    {
        ConfigureCalls++;
        LastDialogReceivedInConfigure = dialog;
        LastConfigureArgs = (destination, fileName, fileType);
        _spy.Record(nameof(Configure));
        if (ThrowOnConfigure is not null) throw ThrowOnConfigure;
    }

    public void ClickSave(SaveDialogIdentity dialog)
    {
        ClickSaveCalls++;
        _spy.Record(nameof(ClickSave));
        if (ThrowOnClickSave is not null) throw ThrowOnClickSave;
    }

    public void CancelSaveDialog(SaveDialogIdentity dialog)
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

public sealed class FakeConfirmedSaveDialogCommitter : IConfirmedSaveDialogCommitter
{
    private readonly CallSpy _spy;
    public SaveDialogCommitResult Result { get; set; } = SaveDialogCommitResult.Pass();
    public int CommitOnceCalls { get; private set; }
    public NexAdminWindowIdentity? LastTargetReceived { get; private set; }
    public SaveDialogIdentity? LastExpectedDialogReceived { get; private set; }

    public FakeConfirmedSaveDialogCommitter(CallSpy spy) => _spy = spy;

    public SaveDialogCommitResult CommitOnce(NexAdminWindowIdentity target, SaveDialogIdentity expectedDialog)
    {
        CommitOnceCalls++;
        LastTargetReceived = target;
        LastExpectedDialogReceived = expectedDialog;
        _spy.Record(nameof(CommitOnce));
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

/// <summary>Fake de ISaveDialogWaiter (F6.14B2.4) - usado pelos testes do
/// ORQUESTRADOR (nao pelos testes dedicados do waiter real). Delega
/// diretamente a FakeSaveDialogInspector.IdentifySaveDialog UMA vez (sem
/// polling nenhum) - preserva o comportamento e as asserções de spy
/// ("IdentifySaveDialog" chamado 1x, na ordem certa) ja existentes nos 78
/// testes do orquestrador, que nao precisam simular a race de tempo.</summary>
public sealed class FakeSaveDialogWaiter : ISaveDialogWaiter
{
    private readonly ISaveDialogInspector _inspector;
    public int WaitForSaveDialogCalls { get; private set; }

    public FakeSaveDialogWaiter(ISaveDialogInspector inspector) => _inspector = inspector;

    public SaveDialogIdentityResult WaitForSaveDialog(NexAdminWindowIdentity target)
    {
        WaitForSaveDialogCalls++;
        return _inspector.IdentifySaveDialog(target);
    }
}

/// <summary>Fake de IDelay (F6.14B2.4) - NUNCA dorme de verdade. Registra
/// chamadas e, opcionalmente, avanca um FakeClock compartilhado (via
/// OnWait) para simular passagem de tempo de forma deterministica em
/// testes de componentes com timeout bounded (ex.: PollingSaveDialogWaiter).</summary>
/// <summary>Fake de IExportStageWatcher (F6.14B2.9C) - permite aos testes
/// da orquestracao do probe de ClickSave controlar diretamente o
/// resultado dos 2 gates de filesystem, sem tocar disco nenhum.</summary>
public sealed class FakeExportStageWatcher : IExportStageWatcher
{
    private readonly CallSpy? _spy;
    public ExportStageWatchResult ConfirmEmptyResult { get; set; } = ExportStageWatchResult.Pass();
    public ExportStageWatchResult WaitResult { get; set; } = ExportStageWatchResult.Pass();
    public int ConfirmEmptyBeforeActionCalls { get; private set; }
    public int WaitForExpectedFileOnlyCalls { get; private set; }
    public string? LastExpectedFileNameReceived { get; private set; }
    public TimeSpan? LastTimeoutReceived { get; private set; }

    /// <summary>F6.14B2.9C: executado no exato momento de
    /// WaitForExpectedFileOnly - usado por testes para simular um agente
    /// EXTERNO alterando EXPORTADOS durante a janela de espera (o novo
    /// codigo do probe nunca escreve em EXPORTADOS por si mesmo).</summary>
    public Action? OnWait { get; set; }

    public FakeExportStageWatcher() { }

    /// <summary>F6.14B2.12E: variante com CallSpy compartilhado, usada pelo
    /// OrchestratorFixture para provar ORDEM entre ConfirmEmptyBeforeAction/
    /// WaitForExpectedFileOnly e as demais interfaces do Orchestrator.</summary>
    public FakeExportStageWatcher(CallSpy spy) => _spy = spy;

    public ExportStageWatchResult ConfirmEmptyBeforeAction(string directoryPath)
    {
        ConfirmEmptyBeforeActionCalls++;
        _spy?.Record(nameof(ConfirmEmptyBeforeAction));
        return ConfirmEmptyResult;
    }

    public ExportStageWatchResult WaitForExpectedFileOnly(string directoryPath, string expectedFileName, TimeSpan timeout)
    {
        WaitForExpectedFileOnlyCalls++;
        LastExpectedFileNameReceived = expectedFileName;
        LastTimeoutReceived = timeout;
        _spy?.Record(nameof(WaitForExpectedFileOnly));
        OnWait?.Invoke();
        return WaitResult;
    }
}

/// <summary>Fake de IProcessRunner (F6.14B2.10A) - permite aos testes de
/// NodeExportValidator controlar exatamente o resultado do subprocesso
/// (Started/TimedOut/ExitCode/StdOut/StdErr) sem nunca chamar node.exe de
/// verdade. Registra os argumentos recebidos para provar que o CLI/
/// caminho corretos foram passados.</summary>
public sealed class FakeProcessRunner : IProcessRunner
{
    public int RunCalls { get; private set; }
    public string? LastFileName { get; private set; }
    public IReadOnlyList<string>? LastArguments { get; private set; }
    public TimeSpan? LastTimeout { get; private set; }
    public ProcessRunResult Result { get; set; } = new(started: true, timedOut: false, exitCode: 0, stdOut: "{\"ok\":true,\"rows\":0}\n", stdErr: string.Empty);
    public Exception? ThrowOnRun { get; set; }

    public ProcessRunResult Run(string fileName, IReadOnlyList<string> arguments, TimeSpan timeout)
    {
        RunCalls++;
        LastFileName = fileName;
        LastArguments = arguments;
        LastTimeout = timeout;
        if (ThrowOnRun is not null) throw ThrowOnRun;
        return Result;
    }
}

/// <summary>Fake de IFileMover (F6.14B2.11A) - permite simular falha de
/// Move (para provar zero-retry/zero-fallback) sem depender de
/// condicoes reais de filesystem dificeis de forcar (ex.: arquivo
/// bloqueado). Por padrao delega para File.Move real, entao os testes
/// de fluxo feliz continuam exercitando o filesystem de verdade em
/// diretorios temporarios.</summary>
public sealed class FakeFileMover : IFileMover
{
    public int MoveCalls { get; private set; }
    public string? LastSource { get; private set; }
    public string? LastDestination { get; private set; }
    public Exception? ThrowOnMove { get; set; }
    public bool DelegateToRealMove { get; set; } = true;

    public void Move(string sourcePath, string destinationPath)
    {
        MoveCalls++;
        LastSource = sourcePath;
        LastDestination = destinationPath;
        if (ThrowOnMove is not null) throw ThrowOnMove;
        if (DelegateToRealMove) File.Move(sourcePath, destinationPath);
    }
}

public sealed class FakeDelay : IDelay
{
    public int WaitCalls { get; private set; }
    public List<TimeSpan> Durations { get; } = new();
    public Action<TimeSpan>? OnWait { get; set; }

    public void Wait(TimeSpan duration)
    {
        WaitCalls++;
        Durations.Add(duration);
        OnWait?.Invoke(duration);
    }
}

/// <summary>Hybrid V3 - fake de INexRuntimeStateProbe. `Result` e' o que
/// Classify() devolve; padrao Open com Reason vazio.</summary>
public sealed class FakeNexRuntimeStateProbe : INexRuntimeStateProbe
{
    public NexRuntimeStateResult Result { get; set; } = new(NexRuntimeState.Open, string.Empty);
    public int ClassifyCalls { get; private set; }

    public NexRuntimeStateResult Classify()
    {
        ClassifyCalls++;
        return Result;
    }
}

/// <summary>Hybrid V3 - fake de IHybridAlertSounds - conta chamadas, nunca
/// emite som real em testes offline.</summary>
public sealed class FakeHybridAlertSounds : IHybridAlertSounds
{
    public int MinimizedWarningCalls { get; private set; }
    public int TechnicalFailureAfterActionCalls { get; private set; }

    public void PlayMinimizedWarning() => MinimizedWarningCalls++;

    public void PlayTechnicalFailureAfterAction() => TechnicalFailureAfterActionCalls++;
}
