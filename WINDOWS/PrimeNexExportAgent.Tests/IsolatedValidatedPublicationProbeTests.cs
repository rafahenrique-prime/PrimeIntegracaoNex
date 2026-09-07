using System.IO;
using System.Linq;
using PrimeNexExportAgent.Diagnostics;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// F6.14B2.11D - testes offline (fakes) do probe isolado
/// Validator-&gt;Publisher. Prova os gates de path (source precisa ser
/// filho direto do STAGE isolado, extensao .xls, existencia) e que o
/// Coordinator NUNCA e' chamado quando qualquer gate reprova - nenhum
/// destes testes toca NEX/EXPORTADOS/EXPORT_STAGE operacional/Node real.
/// </summary>
public sealed class IsolatedValidatedPublicationProbeTests
{
    private const string SourceRoot = @"C:\Nex\PrimeIntegracaoNex\OUTPUT\HOMOLOGACAO-PUBLICACAO\STAGE";
    private const string DestinationRoot = @"C:\Nex\PrimeIntegracaoNex\OUTPUT\HOMOLOGACAO-PUBLICACAO\PUBLICADO";

    private static (CallSpy Spy, FakeExportValidator Validator, FakeAtomicPublisher Publisher, ValidatedExportPublicationCoordinator Coordinator) BuildFixture()
    {
        var spy = new CallSpy();
        var validator = new FakeExportValidator(spy);
        var publisher = new FakeAtomicPublisher(spy);
        var coordinator = new ValidatedExportPublicationCoordinator(validator, publisher);
        return (spy, validator, publisher, coordinator);
    }

    private static string TempFile(string root, string name)
    {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, name);
        File.WriteAllText(path, "conteudo de teste - nao e' um XLS real");
        return path;
    }

    [Fact]
    public void A_PathAutorizado_ValidatorPublisherPass_CoordinatorUmaVez()
    {
        var (spy, validator, publisher, coordinator) = BuildFixture();
        var testRoot = Path.Combine(Path.GetTempPath(), "IsolatedProbeTests_" + Guid.NewGuid());
        var stage = Path.Combine(testRoot, "stage");
        var source = TempFile(stage, "vendas-teste.xls");
        validator.Result = ExportValidationResult.Ok(recordCount: 5);
        publisher.Result = PublishResult.Ok(Path.Combine(testRoot, "publicado", "vendas-teste.xls"));

        var result = IsolatedValidatedPublicationProbe.RunCore(source, stage, Path.Combine(testRoot, "publicado"), coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.Passed, result.Outcome);
        Assert.True(result.Published);
        Assert.Equal(1, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(1, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void B_PathAutorizado_ValidatorFail_CoordinatorChamado_PublisherZero()
    {
        var (spy, validator, publisher, coordinator) = BuildFixture();
        var testRoot = Path.Combine(Path.GetTempPath(), "IsolatedProbeTests_" + Guid.NewGuid());
        var stage = Path.Combine(testRoot, "stage");
        var source = TempFile(stage, "vendas-invalido.xls");
        validator.Result = ExportValidationResult.Fail(AgentErrorCode.ReaderRejected, "colunas_inesperadas: teste");

        var result = IsolatedValidatedPublicationProbe.RunCore(source, stage, Path.Combine(testRoot, "publicado"), coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedValidation, result.Outcome);
        Assert.False(result.Published);
        Assert.Equal(1, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void C_SourceForaDoStageIsolado_CoordinatorZero()
    {
        var (spy, _, _, coordinator) = BuildFixture();
        var testRoot = Path.Combine(Path.GetTempPath(), "IsolatedProbeTests_" + Guid.NewGuid());
        var stage = Path.Combine(testRoot, "stage");
        var outroDir = Path.Combine(testRoot, "outro-lugar");
        var source = TempFile(outroDir, "vendas.xls");

        var result = IsolatedValidatedPublicationProbe.RunCore(source, stage, Path.Combine(testRoot, "publicado"), coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedPathOutsideAllowedFolder, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void D_ExportStageOperacional_CoordinatorZero()
    {
        var (spy, _, _, coordinator) = BuildFixture();
        var source = @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE\vendas-auto-teste.xls";

        var result = IsolatedValidatedPublicationProbe.RunCore(source, SourceRoot, DestinationRoot, coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedPathOutsideAllowedFolder, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void E_Exportados_CoordinatorZero()
    {
        var (spy, _, _, coordinator) = BuildFixture();
        var source = @"C:\Nex\PrimeIntegracaoNex\EXPORTADOS\Exportar-dia-31-08.xls";

        var result = IsolatedValidatedPublicationProbe.RunCore(source, SourceRoot, DestinationRoot, coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedPathOutsideAllowedFolder, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void F_EvidenciaF6_14B2_9_CoordinatorZero()
    {
        var (spy, _, _, coordinator) = BuildFixture();
        var source = @"C:\Nex\PrimeIntegracaoNex\OUTPUT\HOMOLOGACAO-F6.14B2.9\vendas-auto-clicksave-test-20260902-084015.xls";

        var result = IsolatedValidatedPublicationProbe.RunCore(source, SourceRoot, DestinationRoot, coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedPathOutsideAllowedFolder, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void G_OutroOutput_CoordinatorZero()
    {
        var (spy, _, _, coordinator) = BuildFixture();
        var source = @"C:\Nex\PrimeIntegracaoNex\OUTPUT\HOMOLOGACAO-F6.3\qualquer.xls";

        var result = IsolatedValidatedPublicationProbe.RunCore(source, SourceRoot, DestinationRoot, coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedPathOutsideAllowedFolder, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void H_Subdiretorio_CoordinatorZero()
    {
        var (spy, _, _, coordinator) = BuildFixture();
        var source = SourceRoot + @"\subpasta\vendas.xls";

        var result = IsolatedValidatedPublicationProbe.RunCore(source, SourceRoot, DestinationRoot, coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedPathOutsideAllowedFolder, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void I_Traversal_CoordinatorZero()
    {
        var (spy, _, _, coordinator) = BuildFixture();
        var source = SourceRoot + @"\..\EXPORTADOS\vendas.xls";

        var result = IsolatedValidatedPublicationProbe.RunCore(source, SourceRoot, DestinationRoot, coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedPathOutsideAllowedFolder, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void J_ExtensaoErrada_CoordinatorZero()
    {
        var (spy, _, _, coordinator) = BuildFixture();
        var source = SourceRoot + @"\vendas.xlsx";

        var result = IsolatedValidatedPublicationProbe.RunCore(source, SourceRoot, DestinationRoot, coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedWrongExtension, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void J2_ExtensaoCsv_CoordinatorZero()
    {
        var (spy, _, _, coordinator) = BuildFixture();
        var source = SourceRoot + @"\vendas.csv";

        var result = IsolatedValidatedPublicationProbe.RunCore(source, SourceRoot, DestinationRoot, coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedWrongExtension, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void K_ArquivoInexistente_CoordinatorZero()
    {
        var (spy, _, _, coordinator) = BuildFixture();
        var testRoot = Path.Combine(Path.GetTempPath(), "IsolatedProbeTests_" + Guid.NewGuid());
        var stage = Path.Combine(testRoot, "stage");
        Directory.CreateDirectory(stage);
        var source = Path.Combine(stage, "nao-existe.xls");

        var result = IsolatedValidatedPublicationProbe.RunCore(source, stage, Path.Combine(testRoot, "publicado"), coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedFileNotFound, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(0, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void L_UmaExecucao_CoordinatorNoMaximoUmaChamadaDeCadaSubcomponente()
    {
        var (spy, validator, publisher, coordinator) = BuildFixture();
        var testRoot = Path.Combine(Path.GetTempPath(), "IsolatedProbeTests_" + Guid.NewGuid());
        var stage = Path.Combine(testRoot, "stage");
        var source = TempFile(stage, "vendas.xls");
        validator.Result = ExportValidationResult.Ok(recordCount: 1);
        publisher.Result = PublishResult.Ok(Path.Combine(testRoot, "publicado", "vendas.xls"));

        IsolatedValidatedPublicationProbe.RunCore(source, stage, Path.Combine(testRoot, "publicado"), coordinator, _ => { });

        Assert.Equal(1, spy.CountOf(nameof(FakeExportValidator.Validate)));
        Assert.Equal(1, spy.CountOf(nameof(FakeAtomicPublisher.Publish)));
    }

    [Fact]
    public void M_ResultadoNuncaContemPII()
    {
        var (_, validator, publisher, coordinator) = BuildFixture();
        var testRoot = Path.Combine(Path.GetTempPath(), "IsolatedProbeTests_" + Guid.NewGuid());
        var stage = Path.Combine(testRoot, "stage");
        var source = TempFile(stage, "vendas.xls");
        validator.Result = ExportValidationResult.Ok(recordCount: 5);
        publisher.Result = PublishResult.Ok(Path.Combine(testRoot, "publicado", "vendas.xls"));

        var result = IsolatedValidatedPublicationProbe.RunCore(source, stage, Path.Combine(testRoot, "publicado"), coordinator, _ => { });

        // Estrutural: o tipo so tem campos de metadado, nunca payload de
        // negocio - confirmado por reflexao sobre as propriedades publicas.
        var properties = typeof(IsolatedPublicationProbeResult).GetProperties().Select(p => p.Name);
        Assert.DoesNotContain(properties, n => n.Contains("Cliente", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(properties, n => n.Contains("Telefone", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(properties, n => n.Contains("Cpf", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(properties, n => n.Contains("Email", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(properties, n => n.Contains("Venda", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(properties, n => n.Contains("Secret", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(properties, n => n.Contains("Json", StringComparison.OrdinalIgnoreCase));
        Assert.NotNull(result);
    }

    [Fact]
    public void N_FonteNaoReferenciaDownstreamOperacional()
    {
        var path = FindSourceFile("IsolatedValidatedPublicationProbe.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain(@"\EXPORTADOS\", source, StringComparison.Ordinal);
        Assert.DoesNotContain("detector-exports-nex", source);
        Assert.DoesNotContain("runner-integracao-nex", source);
        Assert.DoesNotContain("BootstrapIntegracaoNex", source);
        Assert.DoesNotContain("processador-outbox-nex", source);
        Assert.DoesNotContain("repositorio-eventos-http", source);
        Assert.DoesNotContain("NEX_PRIME_ENDPOINT", source);
        Assert.DoesNotContain("NEX_PRIME_INTEGRATION_SECRET", source);
        Assert.DoesNotContain("HttpClient", source);
        Assert.DoesNotContain("fetch(", source);
        Assert.DoesNotContain("new Outbox", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("File.Move(", source);
        Assert.DoesNotContain(".LocateNexAdmin(", source);
        Assert.DoesNotContain(".SendExportShortcut(", source);
        Assert.DoesNotContain(".ClickButton(", source);
        Assert.DoesNotContain(".ClickSave(", source);
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
