using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Tests.Fakes;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Monta um ExportAgentOrchestrator com todos os 11 fakes conectados ao
/// mesmo CallSpy/FakeAgentLogger, todos configurados por padrao para o
/// caminho feliz (happy path) - cada teste so precisa sobrescrever o(s)
/// fake(s) relevante(s) ao cenario que quer provar.
/// </summary>
public sealed class OrchestratorFixture
{
    public CallSpy Spy { get; } = new();
    public FakeClock Clock { get; } = new();
    public FakeExecutionLock Lock { get; }
    public FakeSessionInspector SessionInspector { get; }
    public FakeNexWindowInspector NexWindowInspector { get; }
    public FakeInputSender InputSender { get; }
    public FakeSaveDialogWaiter SaveDialogWaiter { get; }
    public FakeSaveDialogInspector SaveDialogInspector { get; }
    public FakeSaveDialogController SaveDialogController { get; }
    public FakeConfirmedSaveDialogCommitter Committer { get; }
    public FakeExportStageWatcher Watcher { get; }
    public FakeExportValidator ExportValidator { get; }
    public FakeAtomicPublisher AtomicPublisher { get; }
    public FakeAgentLogger Logger { get; } = new();

    public const string ExportStagePath = @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE";
    public const string ExportadosPath = @"C:\Nex\PrimeIntegracaoNex\EXPORTADOS";

    public OrchestratorFixture()
    {
        Lock = new FakeExecutionLock(Spy);
        SessionInspector = new FakeSessionInspector(Spy);
        NexWindowInspector = new FakeNexWindowInspector(Spy);
        InputSender = new FakeInputSender(Spy);
        SaveDialogInspector = new FakeSaveDialogInspector(Spy);
        SaveDialogWaiter = new FakeSaveDialogWaiter(SaveDialogInspector);
        SaveDialogController = new FakeSaveDialogController(Spy);
        Committer = new FakeConfirmedSaveDialogCommitter(Spy);
        Watcher = new FakeExportStageWatcher(Spy);
        ExportValidator = new FakeExportValidator(Spy);
        AtomicPublisher = new FakeAtomicPublisher(Spy);
    }

    public ExportAgentOrchestrator BuildOrchestrator() => new(
        Lock,
        SessionInspector,
        NexWindowInspector,
        InputSender,
        SaveDialogWaiter,
        SaveDialogInspector,
        SaveDialogController,
        Committer,
        Watcher,
        ExportValidator,
        AtomicPublisher,
        Logger,
        Clock,
        ExportStagePath,
        ExportadosPath);
}
