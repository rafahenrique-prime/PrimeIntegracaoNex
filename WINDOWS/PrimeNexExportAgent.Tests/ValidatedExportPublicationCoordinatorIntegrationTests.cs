using System.IO;
using System.Security.Cryptography;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// F6.14B2.11B secao 8-10 - teste E2E REAL controlado: C# real -> node.exe
/// real -> SCRIPTS/validar-export-vendas.js real -> Reader real ->
/// FileMoveAtomicPublisher real -> File.Move real, EXCLUSIVAMENTE contra
/// diretorios TEMPORARIOS isolados (TEMP\stage, TEMP\exportados) - NUNCA
/// EXPORT_STAGE/EXPORTADOS operacionais. Preparo de fixture usa
/// File.Copy/File.WriteAllBytes SOMENTE como setup de teste (permitido
/// explicitamente pela ordem - a proibicao de File.Copy/Delete/Write e'
/// sobre o CODIGO DE PRODUCAO, nunca sobre o codigo de teste).
/// </summary>
public sealed class ValidatedExportPublicationCoordinatorIntegrationTests : IDisposable
{
    private readonly string _tempStage;
    private readonly string _tempExportados;

    public ValidatedExportPublicationCoordinatorIntegrationTests()
    {
        var root = Path.Combine(Path.GetTempPath(), "PrimeNexExportAgentTests_CoordinatorE2E_" + Guid.NewGuid());
        _tempStage = Path.Combine(root, "stage");
        _tempExportados = Path.Combine(root, "exportados");
        Directory.CreateDirectory(_tempStage);
        Directory.CreateDirectory(_tempExportados);
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
        var publisher = new FileMoveAtomicPublisher(fileMover, _tempStage, _tempExportados);
        return new ValidatedExportPublicationCoordinator(validator, publisher);
    }

    [Fact]
    public void E2E_FixtureValida_ReaderPassPublisherPass_SourceSomeDestinationApareceHashIgual()
    {
        var stageFile = Path.Combine(_tempStage, "vendas-auto-e2e-teste.xls");
        File.Copy(FixtureValidaPath(), stageFile); // setup de teste - permitido
        var hashAntes = Sha256Of(stageFile);
        var coordinator = BuildRealCoordinator();

        var result = coordinator.Execute(stageFile, _tempExportados);

        Assert.True(result.Success);
        Assert.True(result.Validation.Valid);
        Assert.Equal(5, result.Validation.RecordCount); // fixture sintetica tem 5 linhas (confirmado em F6.14B2.10A)
        Assert.NotNull(result.Publication);
        Assert.True(result.Publication!.Published);

        var destinationEsperado = Path.Combine(_tempExportados, "vendas-auto-e2e-teste.xls");
        Assert.False(File.Exists(stageFile)); // source desapareceu
        Assert.True(File.Exists(destinationEsperado)); // destination existe
        Assert.Equal(hashAntes, Sha256Of(destinationEsperado)); // bytes identicos
    }

    [Fact]
    public void E2E_ArquivoInvalido_ReaderRejeita_PublisherNuncaExecuta_SourcePermaneceExportadosVazio()
    {
        // Arquivo vazio (0 bytes) -> Reader real rejeita com
        // 'arquivo_vazio' (contrato ja confirmado em F6.14B2.10A/9E).
        var stageFile = Path.Combine(_tempStage, "vendas-invalido.xls");
        File.WriteAllBytes(stageFile, Array.Empty<byte>()); // setup de teste
        var coordinator = BuildRealCoordinator();

        var result = coordinator.Execute(stageFile, _tempExportados);

        Assert.False(result.Success);
        Assert.True(result.ValidationFailed);
        Assert.False(result.Validation.Valid);
        Assert.Null(result.Publication); // Publisher NUNCA foi chamado

        Assert.True(File.Exists(stageFile)); // source permanece no stage
        Assert.Empty(Directory.GetFiles(_tempExportados)); // exportados permanece vazio
    }

    [Fact]
    public void E2E_Collision_ReaderPassMasDestinationJaExiste_PublisherFail_ZeroOverwrite()
    {
        var stageFile = Path.Combine(_tempStage, "vendas-colisao.xls");
        File.Copy(FixtureValidaPath(), stageFile); // setup de teste
        var destinationPreexistente = Path.Combine(_tempExportados, "vendas-colisao.xls");
        var conteudoOriginalDestino = System.Text.Encoding.UTF8.GetBytes("arquivo ja existente - nunca deve ser sobrescrito");
        File.WriteAllBytes(destinationPreexistente, conteudoOriginalDestino); // setup de teste
        var hashDestinoOriginal = Sha256Of(destinationPreexistente);
        var coordinator = BuildRealCoordinator();

        var result = coordinator.Execute(stageFile, _tempExportados);

        Assert.False(result.Success);
        Assert.False(result.ValidationFailed); // Reader aprovou normalmente
        Assert.True(result.Validation.Valid);
        Assert.True(result.PublicationFailed); // Publisher que reprovou, por colisao

        Assert.True(File.Exists(stageFile)); // source permanece no stage
        Assert.Equal(hashDestinoOriginal, Sha256Of(destinationPreexistente)); // destino original intacto, zero overwrite
    }
}
