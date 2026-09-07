using PrimeNexExportAgent.Domain;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>Testes offline (V1) de IndividualStatementExportOrchestrator -
/// matriz T, V, W, AK, AL do plano aprovado.</summary>
public sealed class IndividualStatementExportOrchestratorTests
{
    [Fact]
    public void I_ExportTriggerReason_EPersistidoPeloOrquestrador()
    {
        // Correcao pos-Probe 13A: antes, o Reason de ExportTriggerResult
        // era descartado pelo orquestrador no estagio Failed (mesma
        // lacuna ja corrigida para overflow.Reason em rodada anterior).
        var fixture = new IndividualStatementOrchestratorFixture();
        fixture.ExportTrigger.Result = ExportTriggerResult.Fail(AgentErrorCode.ExportItemAmbiguous, "RAW_EXPORT_HIT_COUNT=2 UNIQUE_EXPORT_ELEMENT_COUNT=2");
        var orchestrator = fixture.BuildOrchestrator();

        orchestrator.Run(new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        var failedEvent = fixture.Logger.Events.Last();
        Assert.Equal(nameof(AgentStage.Failed), failedEvent.Stage);
        Assert.Equal(nameof(AgentErrorCode.ExportItemAmbiguous), failedEvent.ErrorCode);
        Assert.Equal("RAW_EXPORT_HIT_COUNT=2 UNIQUE_EXPORT_ELEMENT_COUNT=2", failedEvent.Reason);
    }

    [Fact]
    public void W_FluxoE2ESimuladoCompleto_Success()
    {
        var fixture = new IndividualStatementOrchestratorFixture();
        var orchestrator = fixture.BuildOrchestrator();

        var result = orchestrator.Run(new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.True(result.Success);
        Assert.Equal(nameof(AgentStage.Success), fixture.Logger.Events.Last().Stage);
        Assert.NotNull(result.PublishedFilePath);
    }

    [Fact]
    public void T_XlsValido_PublishChamado()
    {
        var fixture = new IndividualStatementOrchestratorFixture();
        fixture.ExportValidator.Result = ExportValidationResult.Ok(recordCount: 17);
        var orchestrator = fixture.BuildOrchestrator();

        orchestrator.Run(new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.Contains("Publish", fixture.Spy.Calls);
    }

    [Fact]
    public void AK_RecordCountZero_NaoPublica()
    {
        var fixture = new IndividualStatementOrchestratorFixture();
        fixture.ExportValidator.Result = ExportValidationResult.Ok(recordCount: 0);
        var orchestrator = fixture.BuildOrchestrator();

        var result = orchestrator.Run(new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Success);
        Assert.Equal(AgentErrorCode.ZeroRecords, result.ErrorCode);
        Assert.DoesNotContain("Publish", fixture.Spy.Calls);
    }

    [Fact]
    public void AL_RecordCountPositivo_PodePublicar()
    {
        var fixture = new IndividualStatementOrchestratorFixture();
        fixture.ExportValidator.Result = ExportValidationResult.Ok(recordCount: 1);
        var orchestrator = fixture.BuildOrchestrator();

        var result = orchestrator.Run(new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.True(result.Success);
    }

    [Fact]
    public void ClientOpenFalha_NuncaChamaOverflowNemSaveDialog()
    {
        var fixture = new IndividualStatementOrchestratorFixture();
        fixture.ClientNavigator.OpenResult = ClientOpenResult.Fail(AgentErrorCode.ClientWindowNotFound, "F2 sem efeito");
        var orchestrator = fixture.BuildOrchestrator();

        var result = orchestrator.Run(new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Success);
        Assert.Equal(AgentErrorCode.ClientWindowNotFound, result.ErrorCode);
        Assert.Equal(0, fixture.OverflowMenuOpener.OpenOverflowMenuCalls);
        Assert.DoesNotContain("Configure", fixture.Spy.Calls);
    }

    [Fact]
    public void TransactionsTabFalha_NuncaAbreOverflow()
    {
        var fixture = new IndividualStatementOrchestratorFixture();
        fixture.ClientNavigator.TabResult = TransactionsTabResult.Fail(AgentErrorCode.TransactionsTabNoEffect, "sem efeito");
        var orchestrator = fixture.BuildOrchestrator();

        var result = orchestrator.Run(new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Success);
        Assert.Equal(0, fixture.OverflowMenuOpener.OpenOverflowMenuCalls);
    }

    [Fact]
    public void OverflowFalha_NuncaAcionaExport()
    {
        var fixture = new IndividualStatementOrchestratorFixture();
        fixture.OverflowMenuOpener.Result = Domain.OverflowMenuResult.Fail(AgentErrorCode.OverflowPopupNotFound, "sem popup");
        var orchestrator = fixture.BuildOrchestrator();

        var result = orchestrator.Run(new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Success);
        Assert.Equal(0, fixture.ExportTrigger.TriggerExportCalls);
    }

    [Fact]
    public void ExportTriggerFalha_NuncaAguardaSaveDialog()
    {
        var fixture = new IndividualStatementOrchestratorFixture();
        fixture.ExportTrigger.Result = ExportTriggerResult.Fail(AgentErrorCode.ExportItemNotFound, "item ausente");
        var orchestrator = fixture.BuildOrchestrator();

        var result = orchestrator.Run(new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.False(result.Success);
        Assert.DoesNotContain("IdentifySaveDialog", fixture.Spy.Calls);
    }

    [Fact]
    public void V_NenhumaDependenciaBase44SupabaseFinanceira_NoConstrutor()
    {
        var ctorParams = typeof(IndividualStatementExportOrchestrator)
            .GetConstructors()[0]
            .GetParameters()
            .Select(p => p.ParameterType.FullName ?? p.ParameterType.Name)
            .ToList();

        Assert.DoesNotContain(ctorParams, n => n.Contains("Base44", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(ctorParams, n => n.Contains("Supabase", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(ctorParams, n => n.Contains("Payment", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(ctorParams, n => n.Contains("Financ", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void NavigationTargetFluiIntacto_ParaOClientNavigator()
    {
        var fixture = new IndividualStatementOrchestratorFixture();
        var orchestrator = fixture.BuildOrchestrator();
        var target = new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE");

        orchestrator.Run(target);

        Assert.Same(target, fixture.ClientNavigator.LastNavigationTarget);
    }

    [Fact]
    public void FileNameUsaGerarNomeArquivoExtratoIndividual_ComClientCode()
    {
        var fixture = new IndividualStatementOrchestratorFixture();
        var orchestrator = fixture.BuildOrchestrator();

        orchestrator.Run(new ClientNavigationTarget("292", "MATHEUS HENRIQUE DEPRE"));

        Assert.NotNull(fixture.SaveDialogController.LastConfigureArgs);
        Assert.StartsWith("extrato-cliente-292-", fixture.SaveDialogController.LastConfigureArgs!.Value.fileName);
    }
}
