using System.IO;
using PrimeNexExportAgent.Real;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// F6.14B2.10A secao 12 - UNICO teste que toca node.exe REAL e o CLI REAL
/// (SCRIPTS/validar-export-vendas.js), provando C# -> Node -> Reader real
/// -> JSON -> C# fim-a-fim. Usa uma fixture XLS SINTETICA (dados
/// inventados, nunca PII real, nunca copiada de EXPORTADOS/OUTPUT
/// operacionais) versionada em Fixtures/. NUNCA toca EXPORT_STAGE/
/// EXPORTADOS reais, NUNCA publica, zero HTTP/Base44/banco.
/// </summary>
public sealed class NodeExportValidatorIntegrationTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && dir.Name != "WINDOWS")
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        return dir!.Parent!.FullName; // um nivel acima de WINDOWS = raiz do repo
    }

    [Fact]
    public void RealNodeRealCli_FixtureValida_RetornaOkComRowsCorreto()
    {
        var repoRoot = RepoRoot();
        var cliPath = Path.Combine(repoRoot, "SCRIPTS", "validar-export-vendas.js");
        var fixturePath = Path.Combine(AppContext.BaseDirectory, "Fixtures", "vendas-fixture-sintetica.xls");

        Assert.True(File.Exists(cliPath), $"CLI real nao encontrado em {cliPath}");
        Assert.True(File.Exists(fixturePath), $"Fixture nao encontrada em {fixturePath}");

        var runner = new Win32ProcessRunner();
        var validator = new NodeExportValidator(runner, cliPath);

        var result = validator.Validate(fixturePath);

        Assert.True(result.Valid, $"Reader real rejeitou a fixture: {result.Reason}");
        Assert.Equal(5, result.RecordCount);
    }

    [Fact]
    public void RealNodeRealCli_ArquivoInexistente_RetornaInvalidoFailClosed()
    {
        var repoRoot = RepoRoot();
        var cliPath = Path.Combine(repoRoot, "SCRIPTS", "validar-export-vendas.js");
        var caminhoInexistente = Path.Combine(Path.GetTempPath(), "nao-existe-" + Guid.NewGuid() + ".xls");

        var runner = new Win32ProcessRunner();
        var validator = new NodeExportValidator(runner, cliPath);

        var result = validator.Validate(caminhoInexistente);

        Assert.False(result.Valid);
    }
}
