using System.IO;
using PrimeNexExportAgent.Real;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// V1 (extrato individual por cliente) - UNICO teste que toca node.exe
/// REAL e o CLI REAL (SCRIPTS/validar-export-transacoes-cliente.js),
/// provando C# -> Node -> SERVICO/leitor-export-transacoes-cliente.js
/// real -> JSON -> C# fim-a-fim, reaproveitando a MESMA classe
/// NodeExportValidator ja usada por Vendas (nenhuma classe C# nova foi
/// necessaria - o validator e' 100% generico, so troca o caminho do CLI).
/// NUNCA toca EXPORT_STAGE/EXPORTADOS reais, NUNCA publica, zero
/// HTTP/Base44/banco, zero PII real (usa apenas um arquivo deliberadamente
/// invalido para exercitar o caminho de rejeicao, sem precisar sintetizar
/// um .xls binario valido nesta rodada).
/// </summary>
public sealed class NodeExportTransacoesClienteValidatorIntegrationTests
{
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

    [Fact]
    public void RealNodeRealCli_CliScriptExiste()
    {
        var repoRoot = RepoRoot();
        var cliPath = Path.Combine(repoRoot, "SCRIPTS", "validar-export-transacoes-cliente.js");

        Assert.True(File.Exists(cliPath), $"CLI real nao encontrado em {cliPath}");
    }

    [Fact]
    public void RealNodeRealCli_ArquivoInvalido_RejeitadoPeloReaderReal_ExitCode1()
    {
        var repoRoot = RepoRoot();
        var cliPath = Path.Combine(repoRoot, "SCRIPTS", "validar-export-transacoes-cliente.js");
        var tempPath = Path.Combine(Path.GetTempPath(), $"nao-e-um-xls-{Guid.NewGuid()}.xls");
        File.WriteAllText(tempPath, "isto nao e um arquivo XLS valido");

        try
        {
            var runner = new Win32ProcessRunner();
            var validator = new NodeExportValidator(runner, cliPath);

            var result = validator.Validate(tempPath);

            // O Reader real deve rejeitar (erro_leitura/colunas_inesperadas),
            // NUNCA aceitar silenciosamente um arquivo invalido.
            Assert.False(result.Valid);
            Assert.Equal(Domain.AgentErrorCode.ReaderRejected, result.ErrorCode);
        }
        finally
        {
            File.Delete(tempPath);
        }
    }

    [Fact]
    public void RealNodeRealCli_ArquivoInexistente_RetornaInvalidoFailClosed()
    {
        var repoRoot = RepoRoot();
        var cliPath = Path.Combine(repoRoot, "SCRIPTS", "validar-export-transacoes-cliente.js");
        var caminhoInexistente = Path.Combine(Path.GetTempPath(), "nao-existe-" + Guid.NewGuid() + ".xls");

        var runner = new Win32ProcessRunner();
        var validator = new NodeExportValidator(runner, cliPath);

        var result = validator.Validate(caminhoInexistente);

        Assert.False(result.Valid);
    }
}
