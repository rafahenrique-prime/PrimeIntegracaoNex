using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Diagnostics;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Tests.Fakes;
using PrimeNexExportAgent.WindowsNative;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (Hybrid V3) de RunOnceScheduledHybridEntrypoint.RunCore -
/// ZERO Win32/orchestrator real. Prova: Closed/Minimized/BlockingUnknown
/// NUNCA constroem nem executam o orchestrator (zero V1, zero V2, zero
/// input); os 3 beeps de falha tecnica so' disparam quando FinalStage==Failed
/// E MutationWitness.MutationAttempted==true (nunca antes disso); Success
/// permanece silencioso independente do witness; e o mapeamento de exit
/// code.
/// </summary>
public sealed class RunOnceScheduledHybridEntrypointTests
{
    private sealed class WitnessMarkingInputSender : IInputSender
    {
        private readonly MutationWitness _witness;
        private readonly bool _markBeforeSend;
        public Exception? ThrowOnSend { get; set; }
        public int SendExportShortcutCalls { get; private set; }

        public WitnessMarkingInputSender(MutationWitness witness, bool markBeforeSend)
        {
            _witness = witness;
            _markBeforeSend = markBeforeSend;
        }

        public void SendExportShortcut(NexAdminWindowIdentity target)
        {
            SendExportShortcutCalls++;
            if (_markBeforeSend) _witness.MarkAttempted();
            if (ThrowOnSend is not null) throw ThrowOnSend;
        }
    }

    private static ExportAgentOrchestrator BuildOrchestrator(IInputSender sender, CallSpy spy, FakeAgentLogger logger, FakeClock clock)
    {
        var lockFake = new FakeExecutionLock(spy);
        var sessionInspector = new FakeSessionInspector(spy);
        var nexWindowInspector = new FakeNexWindowInspector(spy);
        var saveDialogInspector = new FakeSaveDialogInspector(spy);
        var saveDialogWaiter = new FakeSaveDialogWaiter(saveDialogInspector);
        var saveDialogController = new FakeSaveDialogController(spy);
        var committer = new FakeConfirmedSaveDialogCommitter(spy);
        var watcher = new FakeExportStageWatcher(spy);
        var exportValidator = new FakeExportValidator(spy);
        var atomicPublisher = new FakeAtomicPublisher(spy);

        return new ExportAgentOrchestrator(
            lockFake, sessionInspector, nexWindowInspector, sender,
            saveDialogWaiter, saveDialogInspector, saveDialogController, committer,
            watcher, exportValidator, atomicPublisher, logger, clock,
            OrchestratorFixture.ExportStagePath, OrchestratorFixture.ExportadosPath);
    }

    // ---- A: Closed -> zero orchestrator construido, zero beep ----
    [Fact]
    public void A_Closed_ZeroOrchestratorConstruido_ZeroBeep()
    {
        var probe = new FakeNexRuntimeStateProbe { Result = new NexRuntimeStateResult(NexRuntimeState.Closed, "zero processos validos") };
        var sounds = new FakeHybridAlertSounds();
        var logger = new FakeAgentLogger();
        var clock = new FakeClock();
        var buildCalls = 0;

        var result = RunOnceScheduledHybridEntrypoint.RunCore(
            probe,
            witness => { buildCalls++; return BuildOrchestrator(new FakeInputSender(new CallSpy()), new CallSpy(), new FakeAgentLogger(), new FakeClock()); },
            sounds, logger, clock);

        Assert.Equal(NexRuntimeState.Closed, result.State);
        Assert.Null(result.AgentResult);
        Assert.Equal(0, buildCalls);
        Assert.Equal(0, sounds.MinimizedWarningCalls);
        Assert.Equal(0, sounds.TechnicalFailureAfterActionCalls);
        Assert.Contains(logger.Events, e => e.Stage == "NEX_CLOSED"
            && e.HybridRoute == "NONE"
            && e.NexPosition == "CLOSED"
            && e.RouteReason == "NEX_CLOSED");
    }

    // ---- B: Minimized -> zero orchestrator, exatamente 1 aviso de minimized (2 beeps curtos) ----
    [Fact]
    public void B_Minimized_ZeroOrchestrator_ExatamenteUmAvisoMinimized()
    {
        var probe = new FakeNexRuntimeStateProbe { Result = new NexRuntimeStateResult(NexRuntimeState.Minimized, "TApplication IsIconic=true") };
        var sounds = new FakeHybridAlertSounds();
        var logger = new FakeAgentLogger();
        var clock = new FakeClock();
        var buildCalls = 0;

        var result = RunOnceScheduledHybridEntrypoint.RunCore(
            probe,
            witness => { buildCalls++; return BuildOrchestrator(new FakeInputSender(new CallSpy()), new CallSpy(), new FakeAgentLogger(), new FakeClock()); },
            sounds, logger, clock);

        Assert.Equal(NexRuntimeState.Minimized, result.State);
        Assert.Equal(0, buildCalls);
        Assert.Equal(1, sounds.MinimizedWarningCalls);
        Assert.Equal(0, sounds.TechnicalFailureAfterActionCalls);
        Assert.Contains(logger.Events, e => e.Stage == "NEX_MINIMIZED"
            && e.HybridRoute == "NONE"
            && e.NexPosition == "MINIMIZED"
            && e.RouteReason == "NEX_MINIMIZED");
    }

    // ---- C: BlockingUnknown -> zero orchestrator, zero beep, fail-closed silencioso ----
    [Fact]
    public void C_BlockingUnknown_ZeroOrchestrator_ZeroBeep()
    {
        var probe = new FakeNexRuntimeStateProbe { Result = new NexRuntimeStateResult(NexRuntimeState.BlockingUnknown, "TApplication ambigua") };
        var sounds = new FakeHybridAlertSounds();
        var logger = new FakeAgentLogger();
        var clock = new FakeClock();
        var buildCalls = 0;

        var result = RunOnceScheduledHybridEntrypoint.RunCore(
            probe,
            witness => { buildCalls++; return BuildOrchestrator(new FakeInputSender(new CallSpy()), new CallSpy(), new FakeAgentLogger(), new FakeClock()); },
            sounds, logger, clock);

        Assert.Equal(NexRuntimeState.BlockingUnknown, result.State);
        Assert.Equal(0, buildCalls);
        Assert.Equal(0, sounds.MinimizedWarningCalls);
        Assert.Equal(0, sounds.TechnicalFailureAfterActionCalls);
        Assert.Contains(logger.Events, e => e.Stage == "NEX_BLOCKING_UNKNOWN"
            && e.Reason == "TApplication ambigua"
            && e.HybridRoute == "NONE"
            && e.NexPosition == "UNKNOWN"
            && e.RouteReason == "NEX_BLOCKING_UNKNOWN");
    }

    // ---- D: Open + Falha ANTES da mutacao (MutationAttempted=false) -> zero 3-beep ----
    [Fact]
    public void D_Open_FalhaAntesDaMutacao_ZeroTechnicalFailureBeep()
    {
        var probe = new FakeNexRuntimeStateProbe { Result = new NexRuntimeStateResult(NexRuntimeState.Open, "aberto") };
        var sounds = new FakeHybridAlertSounds();
        var logger = new FakeAgentLogger();
        var clock = new FakeClock();

        var result = RunOnceScheduledHybridEntrypoint.RunCore(
            probe,
            witness =>
            {
                var sender = new WitnessMarkingInputSender(witness, markBeforeSend: false) { ThrowOnSend = new InvalidOperationException("gate T1/T2 falhou - PRE-mutacao") };
                return BuildOrchestrator(sender, new CallSpy(), new FakeAgentLogger(), new FakeClock());
            },
            sounds, logger, clock);

        Assert.Equal(NexRuntimeState.Open, result.State);
        Assert.Equal(AgentStage.Failed, result.AgentResult!.FinalStage);
        Assert.Equal(0, sounds.TechnicalFailureAfterActionCalls);
    }

    // ---- E: Open + Falha A PARTIR da tentativa de mutacao (MutationAttempted=true) -> exatamente 3 beeps ----
    [Fact]
    public void E_Open_FalhaAposTentativaDeMutacao_ExatamenteUmTechnicalFailureBeep()
    {
        var probe = new FakeNexRuntimeStateProbe { Result = new NexRuntimeStateResult(NexRuntimeState.Open, "aberto") };
        var sounds = new FakeHybridAlertSounds();
        var logger = new FakeAgentLogger();
        var clock = new FakeClock();

        var result = RunOnceScheduledHybridEntrypoint.RunCore(
            probe,
            witness =>
            {
                var sender = new WitnessMarkingInputSender(witness, markBeforeSend: true) { ThrowOnSend = new InvalidOperationException("SendInput/WM_COMMAND ja tentado - POS-mutacao") };
                return BuildOrchestrator(sender, new CallSpy(), new FakeAgentLogger(), new FakeClock());
            },
            sounds, logger, clock);

        Assert.Equal(AgentStage.Failed, result.AgentResult!.FinalStage);
        Assert.Equal(1, sounds.TechnicalFailureAfterActionCalls);
    }

    // ---- F: Open + Success -> zero beep, independente do witness ----
    [Fact]
    public void F_Open_Success_ZeroBeep()
    {
        var probe = new FakeNexRuntimeStateProbe { Result = new NexRuntimeStateResult(NexRuntimeState.Open, "aberto") };
        var sounds = new FakeHybridAlertSounds();
        var logger = new FakeAgentLogger();
        var clock = new FakeClock();

        var result = RunOnceScheduledHybridEntrypoint.RunCore(
            probe,
            witness =>
            {
                var sender = new WitnessMarkingInputSender(witness, markBeforeSend: true); // mutacao ocorreu, mas SEM excecao
                return BuildOrchestrator(sender, new CallSpy(), new FakeAgentLogger(), new FakeClock());
            },
            sounds, logger, clock);

        Assert.Equal(AgentStage.Success, result.AgentResult!.FinalStage);
        Assert.Equal(0, sounds.TechnicalFailureAfterActionCalls);
        Assert.Equal(0, sounds.MinimizedWarningCalls);
    }

    // ---- G: mapeamento de exit code ----
    [Theory]
    [InlineData(NexRuntimeState.Closed, 0)]
    [InlineData(NexRuntimeState.Minimized, 0)]
    [InlineData(NexRuntimeState.BlockingUnknown, 0)]
    public void G_MapExitCode_EstadosPreOrchestrator(NexRuntimeState state, int expectedExitCode)
    {
        var result = new HybridRunResult(Guid.NewGuid(), state, null, "motivo");

        Assert.Equal(expectedExitCode, RunOnceScheduledHybridEntrypoint.MapExitCode(result));
    }

    [Fact]
    public void G2_MapExitCode_OpenSuccess_ZeroExitCode()
    {
        var agentResult = AgentRunResult.Ok(Guid.NewGuid(), @"C:\Nex\PrimeIntegracaoNex\EXPORTADOS\vendas-auto-teste.xls");
        var result = new HybridRunResult(Guid.NewGuid(), NexRuntimeState.Open, agentResult, "aberto");

        Assert.Equal(0, RunOnceScheduledHybridEntrypoint.MapExitCode(result));
    }

    [Fact]
    public void G2b_MapExitCode_OpenRecoveryCompleted_ZeroExitCode()
    {
        var agentResult = AgentRunResult.Recovered(Guid.NewGuid(), @"C:\temp\recovered.xls");
        var result = new HybridRunResult(Guid.NewGuid(), NexRuntimeState.Open, agentResult, "aberto");

        Assert.Equal(0, RunOnceScheduledHybridEntrypoint.MapExitCode(result));
    }

    [Fact]
    public void G3_MapExitCode_OpenFailed_ExitCodeUm()
    {
        var agentResult = AgentRunResult.Stop(Guid.NewGuid(), AgentStage.Failed, AgentErrorCode.UnexpectedException);
        var result = new HybridRunResult(Guid.NewGuid(), NexRuntimeState.Open, agentResult, "aberto");

        Assert.Equal(1, RunOnceScheduledHybridEntrypoint.MapExitCode(result));
    }
}
