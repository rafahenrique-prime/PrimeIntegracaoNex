using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (F6.14B2.11A) de IAtomicPublisher - move
/// EXATAMENTE 1 arquivo, ja aprovado pelo Reader, de `sourceRoot`
/// (produção: EXPORT_STAGE) para `destinationRoot` (produção:
/// EXPORTADOS), via IFileMover (File.Move real, sem overwrite).
///
/// NAO valida XLS (isso e' responsabilidade exclusiva de
/// NodeExportValidator, chamado ANTES disto pelo orquestrador - nunca
/// duplicado aqui). NAO chama Node, NAO chama Reader, NAO toca UI/NEX,
/// NAO inicia detector/pipeline. Responsabilidade estritamente de mover
/// um arquivo ja aprovado, com governanca de path fail-closed.
///
/// PROIBIDO PERMANENTEMENTE: File.Copy, File.Delete, File.Replace,
/// overwrite, rename alternativo (sufixo "(1)", timestamp), retry de
/// Move - qualquer divergencia em qualquer gate resulta em
/// PublishResult.Fail SEM tentar outra estrategia.
/// </summary>
public sealed class FileMoveAtomicPublisher : IAtomicPublisher
{
    private const string ExpectedExtension = ".xls";

    private readonly IFileMover _fileMover;
    private readonly string _sourceRoot;
    private readonly string _destinationRoot;

    public FileMoveAtomicPublisher(IFileMover fileMover, string sourceRoot, string destinationRoot)
    {
        _fileMover = fileMover;
        _sourceRoot = sourceRoot;
        _destinationRoot = destinationRoot;
    }

    public PublishResult Publish(string sourcePath, string destinationDirectory)
    {
        string sourceFull;
        string sourceParent;
        string sourceRootFull;
        string destDirFull;
        string destRootFull;
        try
        {
            sourceFull = Path.GetFullPath(sourcePath);
            sourceParent = Path.GetFullPath(Path.GetDirectoryName(sourceFull) ?? string.Empty);
            sourceRootFull = Path.GetFullPath(_sourceRoot);
            destDirFull = Path.GetFullPath(destinationDirectory);
            destRootFull = Path.GetFullPath(_destinationRoot);
        }
        catch (Exception ex)
        {
            return PublishResult.Fail(AgentErrorCode.PublishFailed, $"path invalido: {ex.Message}");
        }

        // ---- Gate 1: source precisa ser filho DIRETO de sourceRoot
        // (nunca subdiretorio, nunca traversal, nunca fora de
        // EXPORT_STAGE). ----
        if (!string.Equals(sourceParent, sourceRootFull, StringComparison.OrdinalIgnoreCase))
        {
            return PublishResult.Fail(AgentErrorCode.PublishFailed, "source nao esta diretamente dentro do sourceRoot autorizado (EXPORT_STAGE) - fail-closed");
        }

        // ---- Gate 2: extensao exatamente .xls (case-insensitive). ----
        if (!string.Equals(Path.GetExtension(sourceFull), ExpectedExtension, StringComparison.OrdinalIgnoreCase))
        {
            return PublishResult.Fail(AgentErrorCode.PublishFailed, $"extensao do source nao permitida - esperado exatamente '{ExpectedExtension}'");
        }

        // ---- Gate 3: source precisa existir como arquivo. ----
        if (!File.Exists(sourceFull))
        {
            return PublishResult.Fail(AgentErrorCode.PublishFailed, "source nao existe/nao e' um arquivo");
        }

        // ---- Gate 4: destinationDirectory precisa ser EXATAMENTE o
        // destinationRoot autorizado (nunca subdiretorio, nunca outro
        // caminho). ----
        if (!string.Equals(destDirFull, destRootFull, StringComparison.OrdinalIgnoreCase))
        {
            return PublishResult.Fail(AgentErrorCode.PublishFailed, "destinationDirectory nao e' exatamente o destinationRoot autorizado (EXPORTADOS) - fail-closed");
        }

        // ---- Gate 5: mesmo volume - propriedade necessaria para que o
        // Move subsequente seja uma operacao de metadado atomica, nunca
        // uma copia progressiva de bytes. Nao declaramos atomicidade alem
        // do que o SO garante para um Move no mesmo volume. ----
        var sourceVolume = Path.GetPathRoot(sourceRootFull);
        var destVolume = Path.GetPathRoot(destRootFull);
        if (!string.Equals(sourceVolume, destVolume, StringComparison.OrdinalIgnoreCase))
        {
            return PublishResult.Fail(AgentErrorCode.PublishFailed, $"sourceRoot e destinationRoot estao em volumes diferentes ('{sourceVolume}' vs '{destVolume}') - fail-closed, Move nunca substituido por copy+delete");
        }

        var fileName = Path.GetFileName(sourceFull);
        var destinationFull = Path.Combine(destDirFull, fileName);

        // ---- Gate 6 (defesa em profundidade - a garantia FINAL de nao-
        // overwrite vem do proprio File.Move, que lanca se o destino ja
        // existir; este check previo so evita chamar Move numa colisao
        // ja conhecida, mas nao substitui a garantia do SO contra a
        // janela TOCTOU). ----
        if (File.Exists(destinationFull))
        {
            return PublishResult.Fail(AgentErrorCode.PublishFailed, $"destination ja existe ('{fileName}') - fail-closed, nunca overwrite");
        }

        // ---- Acao unica: exatamente 1 Move, sem retry, sem fallback. ----
        try
        {
            _fileMover.Move(sourceFull, destinationFull);
        }
        catch (Exception ex)
        {
            // Zero retry, zero Copy+Delete como fallback, zero tentativa
            // de "corrigir" o nome (sufixo, timestamp). O estado real do
            // source apos a excecao e' o que o SO deixou - nao presumido.
            return PublishResult.Fail(AgentErrorCode.PublishFailed, $"File.Move falhou: {ex.Message}");
        }

        return PublishResult.Ok(destinationFull);
    }
}
