using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Tests.Fakes;

namespace PrimeNexExportAgent.Tests;

/// <summary>Monta um IndividualStatementExportOrchestrator com todos os
/// fakes conectados ao mesmo CallSpy/FakeAgentLogger, configurados por
/// padrao para o caminho feliz - mesmo padrao de OrchestratorFixture
/// (Vendas), reaproveitando os fakes ja existentes para os componentes
/// genericos e adicionando apenas os 3 fakes novos (client navigator,
/// overflow opener, export trigger).</summary>
public sealed class IndividualStatementOrchestratorFixture
{
    public CallSpy Spy { get; } = new();
    public FakeClock Clock { get; } = new();
    public FakeExecutionLock Lock { get; }
    public FakeSessionInspector SessionInspector { get; }
    public FakeNexWindowInspector NexWindowInspector { get; }
    public FakeNexClientNavigator ClientNavigator { get; } = new();
    public FakeNexOverflowMenuOpener OverflowMenuOpener { get; } = new();
    public FakeNexExportTrigger ExportTrigger { get; } = new();
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

    private static readonly OpenedClientIdentity DefaultOpenedClient = new(0x3000, "292", "MATHEUS HENRIQUE DEPRE");

    public IndividualStatementOrchestratorFixture()
    {
        Lock = new FakeExecutionLock(Spy);
        SessionInspector = new FakeSessionInspector(Spy);
        NexWindowInspector = new FakeNexWindowInspector(Spy);
        SaveDialogInspector = new FakeSaveDialogInspector(Spy);
        SaveDialogWaiter = new FakeSaveDialogWaiter(SaveDialogInspector);
        SaveDialogController = new FakeSaveDialogController(Spy);
        Committer = new FakeConfirmedSaveDialogCommitter(Spy);
        Watcher = new FakeExportStageWatcher(Spy);
        ExportValidator = new FakeExportValidator(Spy);
        AtomicPublisher = new FakeAtomicPublisher(Spy);

        ClientNavigator.OpenResult = ClientOpenResult.Pass(DefaultOpenedClient);
        ClientNavigator.TabResult = TransactionsTabResult.Pass();
        OverflowMenuOpener.Result = OverflowMenuResult.Pass("TfbTranCli", "Transações");
        ExportTrigger.Result = ExportTriggerResult.Pass();
    }

    public IndividualStatementExportOrchestrator BuildOrchestrator() => new(
        Lock,
        SessionInspector,
        NexWindowInspector,
        ClientNavigator,
        OverflowMenuOpener,
        ExportTrigger,
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
