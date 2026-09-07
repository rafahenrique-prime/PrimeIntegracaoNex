using System.IO;
using System.Linq;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14B2.11B) de ValidatedExportPublicationCoordinator -
/// ZERO Node/filesystem real e tocado aqui (isso e' o teste E2E,
/// separado, em ValidatedExportPublicationCoordinatorIntegrationTests).
/// IExportValidator/IAtomicPublisher sao sempre fakes, compartilhando o
/// mesmo CallSpy para provar a ORDEM real das chamadas, nao so a
/// contagem.
/// </summary>
public sealed class ValidatedExportPublicationCoordinatorTests
{
    private const string SourcePath = @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE\vendas-auto-teste.xls";
    private const string DestinationDirectory = @"C:\Nex\PrimeIntegracaoNex\EXPORTADOS";

    private static (CallSpy Spy, FakeExportValidator Validator, FakeAtomicPublisher Publisher, ValidatedExportPublicationCoordinator Coordinator) BuildFixture()
    {
        var spy = new CallSpy();
        var validator = new FakeExportValidator(spy);
        var publisher = new FakeAtomicPublisher(spy);
        var coordinator = new ValidatedExportPublicationCoordinator(validator, publisher);
        return (spy, validator, publisher, coordinator);
    }

    [Fact]
    public void A_ValidatorPassPublisherPass_Success_UmaChamadaCada()
    {
        var (spy, validator, publisher, coordinator) = BuildFixture();
        validator.Result = PrimeNexExportAgent.Domain.ExportValidationResult.Ok(recordCount: 4883);
        publisher.Result = PrimeNexExportAgent.Domain.PublishResult.Ok(Path.Combine(DestinationDirectory, "vendas-auto-teste.xls"));

        var result = coordinator.Execute(SourcePath, DestinationDirectory);

        Assert.True(result.Success);
        Assert.Equal(1, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(1, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void B_ValidatorInvalid_ValidatorUm_PublisherZero_Fail()
    {
        var (spy, validator, publisher, coordinator) = BuildFixture();
        validator.Result = PrimeNexExportAgent.Domain.ExportValidationResult.Fail(PrimeNexExportAgent.Domain.AgentErrorCode.ReaderRejected, "colunas_inesperadas: teste");

        var result = coordinator.Execute(SourcePath, DestinationDirectory);

        Assert.False(result.Success);
        Assert.True(result.ValidationFailed);
        Assert.False(result.PublicationFailed);
        Assert.Null(result.Publication);
        Assert.Equal(1, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void C_ValidatorFail_PublisherZero()
    {
        // Mesmo cenario logico de B (Validate() retorna Valid=false) -
        // reforca que qualquer motivo de reprovacao (Reader rejeitou,
        // subprocesso falhou, timeout, JSON invalido) leva ao mesmo
        // comportamento: Publisher NUNCA e' chamado.
        var (spy, validator, publisher, coordinator) = BuildFixture();
        validator.Result = PrimeNexExportAgent.Domain.ExportValidationResult.Fail(PrimeNexExportAgent.Domain.AgentErrorCode.UnexpectedException, "timeout simulado");

        var result = coordinator.Execute(SourcePath, DestinationDirectory);

        Assert.False(result.Success);
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void D_PublisherFail_ValidatorUm_PublisherUm_FailZeroRetry()
    {
        var (spy, validator, publisher, coordinator) = BuildFixture();
        validator.Result = PrimeNexExportAgent.Domain.ExportValidationResult.Ok(recordCount: 10);
        publisher.Result = PrimeNexExportAgent.Domain.PublishResult.Fail(PrimeNexExportAgent.Domain.AgentErrorCode.PublishFailed, "destination ja existe (teste)");

        var result = coordinator.Execute(SourcePath, DestinationDirectory);

        Assert.False(result.Success);
        Assert.False(result.ValidationFailed);
        Assert.True(result.PublicationFailed);
        Assert.Equal(1, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(1, spy.CountOf(nameof(FakeAtomicPublisher.Publish))); // exatamente 1, nunca uma segunda tentativa
    }

    [Fact]
    public void E_UmaChamadaAoCoordinator_ValidatorEPublisherNoMaximoUm()
    {
        var (spy, validator, publisher, coordinator) = BuildFixture();
        validator.Result = PrimeNexExportAgent.Domain.ExportValidationResult.Ok(recordCount: 1);
        publisher.Result = PrimeNexExportAgent.Domain.PublishResult.Ok(DestinationDirectory);

        coordinator.Execute(SourcePath, DestinationDirectory);

        Assert.Equal(1, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(1, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void F_OrdemObjetiva_ValidatorOcorreAntesDoPublisher()
    {
        var (spy, validator, publisher, coordinator) = BuildFixture();
        validator.Result = PrimeNexExportAgent.Domain.ExportValidationResult.Ok(recordCount: 1);
        publisher.Result = PrimeNexExportAgent.Domain.PublishResult.Ok(DestinationDirectory);

        coordinator.Execute(SourcePath, DestinationDirectory);

        Assert.True(spy.Before(nameof(FakeExportValidator.Validate), 1, nameof(FakeAtomicPublisher.Publish), 1));
    }

    [Fact]
    public void G_NaoExisteCaminhoPublisherParaValidator_GarantiaEstrutural()
    {
        // FakeAtomicPublisher/IAtomicPublisher nao tem nenhum metodo capaz
        // de invocar Validate - estruturalmente impossivel o Coordinator
        // (ou qualquer implementacao real de IAtomicPublisher) chamar o
        // Validator a partir do Publisher.
        var publisherMethods = typeof(PrimeNexExportAgent.Contracts.IAtomicPublisher).GetMethods().Select(m => m.Name);
        Assert.DoesNotContain(publisherMethods, n => n.Contains("Validate", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void H_CoordinatorNaoReferenciaNodeFileMoveOuNexUi()
    {
        var path = FindSourceFile("ValidatedExportPublicationCoordinator.cs");
        var source = File.ReadAllText(path);

        // Verifica USOS reais (tipos/namespaces/call sites), nunca a
        // palavra solta - o cabecalho legitimamente MENCIONA "Node" em
        // prosa, explicando que o Coordinator nunca lida com isso.
        Assert.DoesNotContain("System.Diagnostics", source);
        Assert.DoesNotContain("new Process", source);
        Assert.DoesNotContain("File.Move(", source);
        Assert.DoesNotContain("File.Copy(", source);
        Assert.DoesNotContain("File.Delete(", source);
        Assert.DoesNotContain("node.exe", source, System.StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(".LocateNexAdmin(", source);
        Assert.DoesNotContain(".ClickButton(", source);
        Assert.DoesNotContain("DetectorExportsNex", source);
    }

    [Fact]
    public void I_ZeroLoopOuRetry_GarantiaEstrutural()
    {
        var path = FindSourceFile("ValidatedExportPublicationCoordinator.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain("while", source);
        Assert.DoesNotContain("for (", source);
        Assert.DoesNotContain("foreach", source);
    }

    private static string FindSourceFile(string fileName)
    {
        var root = FindSourceRoot();
        var matches = Directory.GetFiles(root, fileName, SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}") && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
            .ToList();
        Assert.Single(matches);
        return matches[0];
    }

    private static string FindSourceRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && dir.Name != "WINDOWS")
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        return dir!.FullName;
    }
}
