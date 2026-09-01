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
    public FakeSaveDialogInspector SaveDialogInspector { get; }
    public FakeSaveDialogController SaveDialogController { get; }
    public FakeFileStabilityChecker FileStabilityChecker { get; }
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
        SaveDialogController = new FakeSaveDialogController(Spy);
        FileStabilityChecker = new FakeFileStabilityChecker(Spy);
        ExportValidator = new FakeExportValidator(Spy);
        AtomicPublisher = new FakeAtomicPublisher(Spy);
    }

    public ExportAgentOrchestrator BuildOrchestrator() => new(
        Lock,
        SessionInspector,
        NexWindowInspector,
        InputSender,
        SaveDialogInspector,
        SaveDialogController,
        FileStabilityChecker,
        ExportValidator,
        AtomicPublisher,
        Logger,
        Clock,
        ExportStagePath,
        ExportadosPath);
}
