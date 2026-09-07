using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// F6.14B2.11D - probe diagnostico one-shot de Validator-&gt;Publisher
/// REAL, restrito a uma area TOTALMENTE ISOLADA (OUTPUT\HOMOLOGACAO-
/// PUBLICACAO\), nunca EXPORT_STAGE/EXPORTADOS operacionais.
///
/// Motivo (F6.14B2.11C): o servico PrimeIntegracaoNex esta Running/
/// Automatic, bootstrap_state=APPROVED, ja existem envios reais SENT ao
/// Base44 - publicar qualquer XLS novo em EXPORTADOS agora poderia
/// disparar processamento/envio real. Este probe prova a cadeia real
/// Validator-&gt;Coordinator-&gt;Publisher-&gt;File.Move SEM tocar em nada
/// operacional, usando source/destination roots fixos e isolados.
///
/// ZERO EXPORTADOS, ZERO EXPORT_STAGE operacional, ZERO NEX/UI, ZERO
/// HTTP/Base44, ZERO detector/pipeline/outbox/checkpoint - o probe
/// termina apos o Move (ou falha) no diretorio isolado.
/// </summary>
internal static class IsolatedValidatedPublicationProbe
{
    /// <summary>Unico source root autorizado - NUNCA EXPORT_STAGE
    /// operacional, NUNCA subdiretorio.</summary>
    internal const string SourceRoot = @"C:\Nex\PrimeIntegracaoNex\OUTPUT\HOMOLOGACAO-PUBLICACAO\STAGE";

    /// <summary>Unico destination root autorizado - NUNCA EXPORTADOS,
    /// NUNCA fornecido/alteravel pelo usuario.</summary>
    internal const string DestinationRoot = @"C:\Nex\PrimeIntegracaoNex\OUTPUT\HOMOLOGACAO-PUBLICACAO\PUBLICADO";

    private const string ExpectedExtension = ".xls";

    public static void Run(string[] args)
    {
        Console.WriteLine("=== PRIME NEX EXPORT AGENT - PROBE DIAGNOSTICO ISOLADO Validator->Publisher (F6.14B2.11D) ===");
        Console.WriteLine("ATENCAO: source/destination FIXOS e isolados (OUTPUT\\HOMOLOGACAO-PUBLICACAO). ZERO EXPORTADOS, ZERO NEX, ZERO HTTP.");
        Console.WriteLine();

        if (args.Length != 1)
        {
            Console.WriteLine("Uso: --diagnostic-publish-isolated <caminho-do-xls-dentro-de-OUTPUT\\HOMOLOGACAO-PUBLICACAO\\STAGE>");
            Environment.ExitCode = 2;
            return;
        }

        var processRunner = new Win32ProcessRunner();
        var cliScriptPath = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "SCRIPTS", "validar-export-vendas.js"));
        var validator = new NodeExportValidator(processRunner, cliScriptPath);
        var fileMover = new Win32FileMover();
        var publisher = new FileMoveAtomicPublisher(fileMover, SourceRoot, DestinationRoot);
        var coordinator = new ValidatedExportPublicationCoordinator(validator, publisher);

        var result = RunCore(args[0], SourceRoot, DestinationRoot, coordinator, Console.WriteLine);

        Console.WriteLine();
        Console.WriteLine("DIAGNOSTIC_ISOLATED_PUBLICATION");
        Console.WriteLine($"FILE_NAME: {result.FileName ?? "(n/a)"}");
        Console.WriteLine($"VALID: {result.Valid?.ToString() ?? "(n/a)"}");
        Console.WriteLine($"ROWS: {result.Rows?.ToString() ?? "(n/a)"}");
        Console.WriteLine($"PUBLISHED: {result.Published?.ToString() ?? "(n/a)"}");
        Console.WriteLine($"DESTINATION_NAME: {result.DestinationName ?? "(n/a)"}");
        Console.WriteLine($"ERROR_CODE: {result.ErrorCode ?? "(nenhum)"}");
        Console.WriteLine($"REASON: {result.Reason ?? "(nenhum)"}");

        Environment.ExitCode = result.Outcome == IsolatedPublicationProbeOutcome.Passed && result.Published == true ? 0 : 1;
    }

    /// <summary>
    /// Core testavel - recebe o Coordinator ja construido (Run() usa o
    /// real, testes injetam um Coordinator construido com fakes). Gates
    /// de path SEMPRE avaliados ANTES de qualquer chamada ao Coordinator -
    /// nenhuma chamada a Validate()/Publish() ocorre se o path nao for
    /// exatamente o autorizado.
    /// </summary>
    internal static IsolatedPublicationProbeResult RunCore(
        string rawSourcePath,
        string sourceRoot,
        string destinationRoot,
        ValidatedExportPublicationCoordinator coordinator,
        Action<string> log)
    {
        // ---- Gate 1: extensao exatamente .xls (case-insensitive). ----
        var extension = Path.GetExtension(rawSourcePath);
        if (!string.Equals(extension, ExpectedExtension, StringComparison.OrdinalIgnoreCase))
        {
            log($"Extensao '{extension}' nao permitida - esperado exatamente '{ExpectedExtension}'. Coordinator = ZERO.");
            return IsolatedPublicationProbeResult.Fail(IsolatedPublicationProbeOutcome.FailedWrongExtension, null, "extensao nao permitida");
        }

        // ---- Gate 2: canonical path - parent EXATAMENTE o STAGE
        // isolado (nunca subdiretorio, nunca traversal, nunca
        // EXPORT_STAGE/EXPORTADOS/outro OUTPUT). ----
        string sourceFull;
        string sourceParent;
        string sourceRootFull;
        try
        {
            sourceFull = Path.GetFullPath(rawSourcePath);
            sourceParent = Path.GetFullPath(Path.GetDirectoryName(sourceFull) ?? string.Empty);
            sourceRootFull = Path.GetFullPath(sourceRoot);
        }
        catch (Exception ex)
        {
            log($"Path invalido: {ex.Message}. Coordinator = ZERO.");
            return IsolatedPublicationProbeResult.Fail(IsolatedPublicationProbeOutcome.FailedPathOutsideAllowedFolder, null, "path invalido");
        }

        if (!string.Equals(sourceParent, sourceRootFull, StringComparison.OrdinalIgnoreCase))
        {
            log("Arquivo fora do STAGE isolado autorizado (nao e' filho direto de OUTPUT\\HOMOLOGACAO-PUBLICACAO\\STAGE). Coordinator = ZERO.");
            return IsolatedPublicationProbeResult.Fail(IsolatedPublicationProbeOutcome.FailedPathOutsideAllowedFolder, null, "fora do STAGE isolado");
        }

        // ---- Gate 3: existencia como arquivo. ----
        if (!File.Exists(sourceFull))
        {
            log("Arquivo nao encontrado/nao e' um arquivo. Coordinator = ZERO.");
            return IsolatedPublicationProbeResult.Fail(IsolatedPublicationProbeOutcome.FailedFileNotFound, null, "arquivo inexistente");
        }

        var fileName = Path.GetFileName(sourceFull);
        var destinationRootFull = Path.GetFullPath(destinationRoot);

        log($"Gates de path OK - chamando Coordinator.Execute() EXATAMENTE 1x para '{fileName}' (destino fixo isolado)...");

        // ---- Acao unica: exatamente 1 chamada a Coordinator.Execute(),
        // que por sua vez chama Validate() no maximo 1x e Publish() no
        // maximo 1x - zero retry em qualquer nivel. ----
        var result = coordinator.Execute(sourceFull, destinationRootFull);

        if (result.ValidationFailed)
        {
            return IsolatedPublicationProbeResult.FromCoordinator(
                IsolatedPublicationProbeOutcome.FailedValidation,
                fileName,
                valid: false,
                rows: null,
                published: false,
                destinationName: null,
                errorCode: result.Validation.ErrorCode.ToString(),
                reason: result.Validation.Reason);
        }

        if (result.PublicationFailed)
        {
            return IsolatedPublicationProbeResult.FromCoordinator(
                IsolatedPublicationProbeOutcome.FailedPublication,
                fileName,
                valid: true,
                rows: result.Validation.RecordCount,
                published: false,
                destinationName: null,
                errorCode: result.Publication?.ErrorCode.ToString(),
                reason: result.Publication?.Reason);
        }

        var destinationName = result.Publication?.DestinationPath is string destPath ? Path.GetFileName(destPath) : null;
        return IsolatedPublicationProbeResult.FromCoordinator(
            IsolatedPublicationProbeOutcome.Passed,
            fileName,
            valid: true,
            rows: result.Validation.RecordCount,
            published: true,
            destinationName: destinationName,
            errorCode: null,
            reason: null);
    }
}

internal enum IsolatedPublicationProbeOutcome
{
    Passed,
    FailedWrongExtension,
    FailedPathOutsideAllowedFolder,
    FailedFileNotFound,
    FailedValidation,
    FailedPublication,
}

/// <summary>Resultado estruturado, seguro para log (nunca linhas/
/// clientes/telefone/CPF/CNPJ/email/vendas/secret/JSON bruto).</summary>
internal sealed class IsolatedPublicationProbeResult
{
    public IsolatedPublicationProbeOutcome Outcome { get; }
    public string? FileName { get; }
    public bool? Valid { get; }
    public int? Rows { get; }
    public bool? Published { get; }
    public string? DestinationName { get; }
    public string? ErrorCode { get; }
    public string? Reason { get; }

    private IsolatedPublicationProbeResult(IsolatedPublicationProbeOutcome outcome, string? fileName, bool? valid, int? rows, bool? published, string? destinationName, string? errorCode, string? reason)
    {
        Outcome = outcome;
        FileName = fileName;
        Valid = valid;
        Rows = rows;
        Published = published;
        DestinationName = destinationName;
        ErrorCode = errorCode;
        Reason = reason;
    }

    public static IsolatedPublicationProbeResult Fail(IsolatedPublicationProbeOutcome outcome, string? fileName, string reason) =>
        new(outcome, fileName, null, null, false, null, null, reason);

    public static IsolatedPublicationProbeResult FromCoordinator(IsolatedPublicationProbeOutcome outcome, string fileName, bool valid, int? rows, bool published, string? destinationName, string? errorCode, string? reason) =>
        new(outcome, fileName, valid, rows, published, destinationName, errorCode, reason);
}
