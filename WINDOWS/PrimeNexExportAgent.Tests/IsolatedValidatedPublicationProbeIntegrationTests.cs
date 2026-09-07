using System.IO;
using System.Security.Cryptography;
using PrimeNexExportAgent.Diagnostics;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// F6.14B2.11D - teste E2E REAL do probe isolado: C# real -> node.exe
/// real -> SCRIPTS/validar-export-vendas.js real -> Reader real ->
/// FileMoveAtomicPublisher real -> File.Move real, EXCLUSIVAMENTE contra
/// diretorios TEMPORARIOS (TEMP\stage, TEMP\publicado) - NUNCA
/// OUTPUT\HOMOLOGACAO-PUBLICACAO real (essa area so e' criada em uma
/// futura ordem de BEFORE/execucao real). Fixture copiada via File.Copy
/// SOMENTE como setup de teste (permitido - a proibicao de File.Copy e'
/// sobre o codigo de PRODUCAO, nunca sobre o codigo de teste).
/// </summary>
public sealed class IsolatedValidatedPublicationProbeIntegrationTests : IDisposable
{
    private readonly string _tempStage;
    private readonly string _tempPublicado;

    public IsolatedValidatedPublicationProbeIntegrationTests()
    {
        var root = Path.Combine(Path.GetTempPath(), "PrimeNexExportAgentTests_IsolatedProbeE2E_" + Guid.NewGuid());
        _tempStage = Path.Combine(root, "stage");
        _tempPublicado = Path.Combine(root, "publicado");
        Directory.CreateDirectory(_tempStage);
        Directory.CreateDirectory(_tempPublicado);
    }

    public void Dispose()
    {
        try { Directory.Delete(Path.GetDirectoryName(_tempStage)!, recursive: true); } catch { /* best-effort */ }
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && dir.Name != "WINDOWS")
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        return dir!.Parent!.FullName;
    }

    private static string CliPath() => Path.Combine(RepoRoot(), "SCRIPTS", "validar-export-vendas.js");

    private static string FixtureValidaPath() => Path.Combine(AppContext.BaseDirectory, "Fixtures", "vendas-fixture-sintetica.xls");

    private static string Sha256Of(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    private ValidatedExportPublicationCoordinator BuildRealCoordinator()
    {
        var processRunner = new Win32ProcessRunner();
        var validator = new NodeExportValidator(processRunner, CliPath());
        var fileMover = new Win32FileMover();
        var publisher = new FileMoveAtomicPublisher(fileMover, _tempStage, _tempPublicado);
        return new ValidatedExportPublicationCoordinator(validator, publisher);
    }

    [Fact]
    public void E2E_FixtureValida_ReaderPassPublisherPass_SourceSomeDestinationApareceHashIgual()
    {
        var stageFile = Path.Combine(_tempStage, "vendas-isolado-e2e.xls");
        File.Copy(FixtureValidaPath(), stageFile); // setup de teste - permitido
        var hashAntes = Sha256Of(stageFile);
        var coordinator = BuildRealCoordinator();

        var result = IsolatedValidatedPublicationProbe.RunCore(stageFile, _tempStage, _tempPublicado, coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.Passed, result.Outcome);
        Assert.True(result.Valid);
        Assert.Equal(5, result.Rows); // fixture sintetica tem 5 linhas
        Assert.True(result.Published);
        Assert.Equal("vendas-isolado-e2e.xls", result.DestinationName);

        var destinationEsperado = Path.Combine(_tempPublicado, "vendas-isolado-e2e.xls");
        Assert.False(File.Exists(stageFile)); // source desapareceu
        Assert.True(File.Exists(destinationEsperado)); // destination existe
        Assert.Equal(hashAntes, Sha256Of(destinationEsperado)); // bytes identicos
    }

    [Fact]
    public void E2E_ArquivoInvalido_ReaderRejeita_PublisherNuncaExecuta()
    {
        var stageFile = Path.Combine(_tempStage, "vendas-invalido.xls");
        File.WriteAllBytes(stageFile, Array.Empty<byte>()); // setup de teste
        var coordinator = BuildRealCoordinator();

        var result = IsolatedValidatedPublicationProbe.RunCore(stageFile, _tempStage, _tempPublicado, coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedValidation, result.Outcome);
        Assert.False(result.Valid);
        Assert.False(result.Published);
        Assert.True(File.Exists(stageFile)); // source permanece
        Assert.Empty(Directory.GetFiles(_tempPublicado)); // publicado permanece vazio
    }

    [Fact]
    public void E2E_Collision_ReaderPassMasDestinationJaExiste_PublisherFail_ZeroOverwrite()
    {
        var stageFile = Path.Combine(_tempStage, "vendas-colisao.xls");
        File.Copy(FixtureValidaPath(), stageFile); // setup de teste
        var destinationPreexistente = Path.Combine(_tempPublicado, "vendas-colisao.xls");
        var conteudoOriginalDestino = System.Text.Encoding.UTF8.GetBytes("arquivo ja existente - nunca deve ser sobrescrito");
        File.WriteAllBytes(destinationPreexistente, conteudoOriginalDestino); // setup de teste
        var hashDestinoOriginal = Sha256Of(destinationPreexistente);
        var coordinator = BuildRealCoordinator();

        var result = IsolatedValidatedPublicationProbe.RunCore(stageFile, _tempStage, _tempPublicado, coordinator, _ => { });

        Assert.Equal(IsolatedPublicationProbeOutcome.FailedPublication, result.Outcome);
        Assert.True(result.Valid); // Reader aprovou normalmente
        Assert.False(result.Published); // Publisher reprovou por colisao

        Assert.True(File.Exists(stageFile)); // source permanece
        Assert.Equal(hashDestinoOriginal, Sha256Of(destinationPreexistente)); // destino original intacto, zero overwrite
    }
}
