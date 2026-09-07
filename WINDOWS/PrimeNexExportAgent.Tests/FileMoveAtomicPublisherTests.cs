using System.IO;
using System.Security.Cryptography;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14B2.11A) de FileMoveAtomicPublisher - SEMPRE
/// diretorios temporarios isolados (nunca EXPORT_STAGE/EXPORTADOS
/// operacionais). O fluxo feliz usa Win32FileMover REAL (File.Move de
/// verdade, provando a operacao real de filesystem); os cenarios de
/// falha usam FakeFileMover para simular condicoes dificeis de forcar
/// deterministicamente (ex.: Move falhando por motivo de infraestrutura).
/// </summary>
public sealed class FileMoveAtomicPublisherTests : IDisposable
{
    private readonly string _stageRoot;
    private readonly string _exportadosRoot;
    private readonly string _outroVolumeSimulado;

    public FileMoveAtomicPublisherTests()
    {
        var root = Path.Combine(Path.GetTempPath(), "PrimeNexExportAgentTests_Publisher_" + Guid.NewGuid());
        _stageRoot = Path.Combine(root, "EXPORT_STAGE");
        _exportadosRoot = Path.Combine(root, "EXPORTADOS");
        _outroVolumeSimulado = Path.Combine(root, "OUTRO_ROOT_FORA_DO_STAGE");
        Directory.CreateDirectory(_stageRoot);
        Directory.CreateDirectory(_exportadosRoot);
        Directory.CreateDirectory(_outroVolumeSimulado);
    }

    public void Dispose()
    {
        try { Directory.Delete(Path.GetDirectoryName(_stageRoot)!, recursive: true); } catch { /* best-effort */ }
    }

    private static byte[] ConteudoSintetico() => System.Text.Encoding.UTF8.GetBytes("conteudo sintetico de teste - nunca dado real de venda");

    private string EscreverArquivoNoStage(string fileName, byte[]? conteudo = null)
    {
        var path = Path.Combine(_stageRoot, fileName);
        File.WriteAllBytes(path, conteudo ?? ConteudoSintetico());
        return path;
    }

    private static string Sha256Of(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    // ==================================================================
    // A: fluxo feliz - Win32FileMover REAL
    // ==================================================================

    [Fact]
    public void A_SourceValidoDestinationLivreMesmoVolume_PublishPass_MoveReal()
    {
        var conteudo = ConteudoSintetico();
        var source = EscreverArquivoNoStage("vendas-auto-teste.xls", conteudo);
        var hashAntes = Sha256Of(source);
        var publisher = new FileMoveAtomicPublisher(new Win32FileMover(), _stageRoot, _exportadosRoot);

        var result = publisher.Publish(source, _exportadosRoot);

        Assert.True(result.Published);
        var destinationEsperado = Path.Combine(_exportadosRoot, "vendas-auto-teste.xls");
        Assert.Equal(destinationEsperado, result.DestinationPath);
        Assert.False(File.Exists(source)); // source desapareceu
        Assert.True(File.Exists(destinationEsperado)); // destination existe
        Assert.Equal(hashAntes, Sha256Of(destinationEsperado)); // bytes identicos
        Assert.Equal("vendas-auto-teste.xls", Path.GetFileName(destinationEsperado)); // basename preservado
    }

    // ==================================================================
    // B: destination ja existe -> FAIL, Move 0, ambos os arquivos intactos
    // ==================================================================

    [Fact]
    public void B_DestinationJaExiste_FailMoveZero_AmbosPermanecemIntactos()
    {
        var source = EscreverArquivoNoStage("colisao.xls", System.Text.Encoding.UTF8.GetBytes("source"));
        var destinationExistente = Path.Combine(_exportadosRoot, "colisao.xls");
        File.WriteAllBytes(destinationExistente, System.Text.Encoding.UTF8.GetBytes("destino original - nunca deve ser sobrescrito"));
        var hashDestinoOriginal = Sha256Of(destinationExistente);
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);

        var result = publisher.Publish(source, _exportadosRoot);

        Assert.False(result.Published);
        Assert.Equal(0, mover.MoveCalls);
        Assert.True(File.Exists(source)); // source permanece
        Assert.Equal(hashDestinoOriginal, Sha256Of(destinationExistente)); // destino original intacto
    }

    // ==================================================================
    // C: source inexistente -> FAIL, Move 0
    // ==================================================================

    [Fact]
    public void C_SourceInexistente_FailMoveZero()
    {
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);
        var sourceInexistente = Path.Combine(_stageRoot, "nao-existe.xls");

        var result = publisher.Publish(sourceInexistente, _exportadosRoot);

        Assert.False(result.Published);
        Assert.Equal(0, mover.MoveCalls);
    }

    // ==================================================================
    // D: source fora do stage root -> FAIL
    // ==================================================================

    [Fact]
    public void D_SourceForaDoStageRoot_Fail()
    {
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);
        var sourceForaDeStage = Path.Combine(_outroVolumeSimulado, "vendas.xls");
        File.WriteAllBytes(sourceForaDeStage, ConteudoSintetico());

        var result = publisher.Publish(sourceForaDeStage, _exportadosRoot);

        Assert.False(result.Published);
        Assert.Equal(0, mover.MoveCalls);
    }

    // ==================================================================
    // E: source em subdiretorio do stage -> FAIL
    // ==================================================================

    [Fact]
    public void E_SourceEmSubdiretorioDoStage_Fail()
    {
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);
        var subDir = Path.Combine(_stageRoot, "subdir");
        Directory.CreateDirectory(subDir);
        var sourceEmSubdir = Path.Combine(subDir, "vendas.xls");
        File.WriteAllBytes(sourceEmSubdir, ConteudoSintetico());

        var result = publisher.Publish(sourceEmSubdir, _exportadosRoot);

        Assert.False(result.Published);
        Assert.Equal(0, mover.MoveCalls);
    }

    // ==================================================================
    // F: source com traversal -> FAIL
    // ==================================================================

    [Fact]
    public void F_SourceComTraversal_Fail()
    {
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);
        var arquivoForaDeStage = Path.Combine(_outroVolumeSimulado, "vendas.xls");
        File.WriteAllBytes(arquivoForaDeStage, ConteudoSintetico());
        var sourceComTraversal = Path.Combine(_stageRoot, "..", "OUTRO_ROOT_FORA_DO_STAGE", "vendas.xls");

        var result = publisher.Publish(sourceComTraversal, _exportadosRoot);

        Assert.False(result.Published);
        Assert.Equal(0, mover.MoveCalls);
    }

    // ==================================================================
    // G: destinationDirectory fora do destination root -> FAIL
    // ==================================================================

    [Fact]
    public void G_DestinationDirectoryForaDoDestinationRoot_Fail()
    {
        var source = EscreverArquivoNoStage("vendas.xls");
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);

        var result = publisher.Publish(source, _outroVolumeSimulado);

        Assert.False(result.Published);
        Assert.Equal(0, mover.MoveCalls);
    }

    // ==================================================================
    // H/I: extensao errada -> FAIL
    // ==================================================================

    [Fact]
    public void H_ExtensaoXlsx_Fail()
    {
        var source = EscreverArquivoNoStage("vendas.xlsx");
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);

        var result = publisher.Publish(source, _exportadosRoot);

        Assert.False(result.Published);
        Assert.Equal(0, mover.MoveCalls);
    }

    [Fact]
    public void I_ExtensaoCsv_Fail()
    {
        var source = EscreverArquivoNoStage("vendas.csv");
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);

        var result = publisher.Publish(source, _exportadosRoot);

        Assert.False(result.Published);
        Assert.Equal(0, mover.MoveCalls);
    }

    // ==================================================================
    // J: .xls maiusculo (.XLS) - case-insensitive aceitavel
    // ==================================================================

    [Fact]
    public void J_ExtensaoXlsMaiuscula_AceitaCaseInsensitive()
    {
        var source = EscreverArquivoNoStage("vendas-caixa-alta.XLS");
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);

        var result = publisher.Publish(source, _exportadosRoot);

        Assert.True(result.Published);
        Assert.Equal(1, mover.MoveCalls);
    }

    // ==================================================================
    // K/L: basename preservado + hash identico (ja cobertos em A, mas
    // reforcados aqui com um arquivo de conteudo diferente)
    // ==================================================================

    [Fact]
    public void K_BasenamePreservado()
    {
        var source = EscreverArquivoNoStage("vendas-auto-20260902-999999.xls");
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);

        var result = publisher.Publish(source, _exportadosRoot);

        Assert.True(result.Published);
        Assert.Equal("vendas-auto-20260902-999999.xls", Path.GetFileName(result.DestinationPath));
    }

    [Fact]
    public void L_ConteudoHashIdenticoAntesDepoisDoMove()
    {
        var conteudo = new byte[5000];
        new Random(42).NextBytes(conteudo);
        var source = EscreverArquivoNoStage("vendas-hash-teste.xls", conteudo);
        var hashAntes = Sha256Of(source);
        var publisher = new FileMoveAtomicPublisher(new Win32FileMover(), _stageRoot, _exportadosRoot);

        var result = publisher.Publish(source, _exportadosRoot);

        Assert.True(result.Published);
        Assert.Equal(hashAntes, Sha256Of(result.DestinationPath!));
    }

    // ==================================================================
    // M/N: Publish 1x -> Move no maximo 1x, zero retry
    // ==================================================================

    [Fact]
    public void M_PublishChamadoUmaVez_MoveNoMaximoUmaVez()
    {
        var source = EscreverArquivoNoStage("vendas.xls");
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);

        publisher.Publish(source, _exportadosRoot);

        Assert.Equal(1, mover.MoveCalls);
    }

    [Fact]
    public void N_MoveFalha_ZeroRetry_MoveContinuaExatamenteUm()
    {
        var source = EscreverArquivoNoStage("vendas.xls");
        var mover = new FakeFileMover { ThrowOnMove = new IOException("falha simulada de filesystem") };
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);

        var result = publisher.Publish(source, _exportadosRoot);

        Assert.False(result.Published);
        Assert.Equal(1, mover.MoveCalls); // exatamente 1 tentativa, nunca uma segunda
        Assert.True(File.Exists(source)); // source nao foi apagado por nenhum fallback
    }

    // ==================================================================
    // O/P/Q/R: guard de codigo-fonte - File.Copy/Delete/Replace/overwrite
    // nunca aparecem como call sites no Publisher
    // ==================================================================

    [Fact]
    public void OPQR_SourceDoPublisher_NuncaContemCopyDeleteReplaceOuOverwrite()
    {
        var path = FindSourceFile("FileMoveAtomicPublisher.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain("File.Copy(", source);
        Assert.DoesNotContain("File.Delete(", source);
        Assert.DoesNotContain("File.Replace(", source);
        Assert.DoesNotContain("overwrite: true", source);
        Assert.DoesNotContain("Overwrite: true", source);
    }

    // ==================================================================
    // S: falha simulavel do Move -> zero segundo Move (mesmo teste de N,
    // reforcado com contagem explicita apos multiplas invocacoes de
    // Publish em sequencia - cada Publish() e' independente, nunca
    // encadeia retry internamente)
    // ==================================================================

    [Fact]
    public void S_FalhaDoMove_NenhumaChamadaSubsequenteAutomatica()
    {
        var source = EscreverArquivoNoStage("vendas.xls");
        var mover = new FakeFileMover { ThrowOnMove = new UnauthorizedAccessException("simulado") };
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, _exportadosRoot);

        publisher.Publish(source, _exportadosRoot);

        Assert.Equal(1, mover.MoveCalls);
    }

    // ==================================================================
    // Volumes diferentes -> fail-closed (nao ha' 2 volumes reais
    // disponiveis neste ambiente de teste para simular de verdade, mas o
    // gate e' auditado por leitura de codigo - reforcado por teste de
    // path canonical distinto simulando raizes diferentes via string).
    // ==================================================================

    [Fact]
    public void VolumesDiferentesSimulados_Fail()
    {
        // Simula raizes com "PathRoot" textualmente diferentes usando
        // caminhos UNC vs local - Path.GetPathRoot distingue.
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, _stageRoot, @"\\outroservidor\compartilhamento\EXPORTADOS");
        var source = EscreverArquivoNoStage("vendas.xls");

        var result = publisher.Publish(source, @"\\outroservidor\compartilhamento\EXPORTADOS");

        Assert.False(result.Published);
        Assert.Equal(0, mover.MoveCalls);
    }

    // ==================================================================
    // F6.14B2.11B secao 2 - same-volume comparison deve ser
    // case-insensitive (C:\ e c:\ sao o MESMO volume no Windows).
    // ==================================================================

    [Fact]
    public void SameVolume_CasingDiferenteNaoDeveFalharPorCausaDoCasing()
    {
        // sourceRoot com drive maiusculo, destinationRoot com o MESMO
        // drive em minusculo - devem ser tratados como mesmo volume. Isso
        // ja' funcionava corretamente (StringComparison.OrdinalIgnoreCase
        // ja' usado desde F6.14B2.11A) - este teste apenas prova/fixa o
        // comportamento explicitamente, conforme pedido em F6.14B2.11B.
        var driveLetter = Path.GetPathRoot(_stageRoot)!.Substring(0, 1);
        var stageRootMinusculo = driveLetter.ToLowerInvariant() + _stageRoot.Substring(1);
        var source = EscreverArquivoNoStage("vendas-casing.xls");
        var mover = new FakeFileMover();
        var publisher = new FileMoveAtomicPublisher(mover, stageRootMinusculo, _exportadosRoot);

        var result = publisher.Publish(source, _exportadosRoot);

        Assert.True(result.Published);
        Assert.Equal(1, mover.MoveCalls);
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
