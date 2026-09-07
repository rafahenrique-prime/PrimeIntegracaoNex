using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Real;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// F6.14B2.10B1 - resultado interno do probe (sem efeito operacional, so
/// para clareza fail-closed e testabilidade).
/// </summary>
internal enum ValidateReadOnlyProbeOutcome
{
    Passed,
    FailedWrongExtension,
    FailedPathOutsideAllowedFolder,
    FailedFileNotFound,
    FailedNotAFile,
    FailedValidatorInvalid,
}

/// <summary>
/// F6.14B2.10B1 - resultado estruturado, seguro para log (nunca contem
/// conteudo de linhas/PII - so metadados do resultado da validacao).
/// </summary>
internal sealed class ValidateReadOnlyProbeResult
{
    public ValidateReadOnlyProbeOutcome Outcome { get; }
    public string? FileName { get; }
    public bool? Valid { get; }
    public int? Rows { get; }
    public string? ErrorCode { get; }
    public string? Reason { get; }

    public ValidateReadOnlyProbeResult(ValidateReadOnlyProbeOutcome outcome, string? fileName, bool? valid, int? rows, string? errorCode, string? reason)
    {
        Outcome = outcome;
        FileName = fileName;
        Valid = valid;
        Rows = rows;
        ErrorCode = errorCode;
        Reason = reason;
    }
}

/// <summary>
/// Probe diagnostico one-shot READ-ONLY (F6.14B2.10B1) - UNICO ponto do
/// projeto que pode chegar a NodeExportValidator.Validate() a partir de
/// um executavel real. Restrito a arquivos localizados EXATAMENTE dentro
/// de OUTPUT\HOMOLOGACAO-F6.14B2.9\ (nunca subdiretorios, nunca outro
/// caminho) - essa restricao e' propositalmente especifica deste probe
/// diagnostico, nao uma regra do futuro Validator operacional.
///
/// ZERO NEX, ZERO UI, ZERO publicacao, ZERO mutacao de filesystem - a
/// UNICA leitura de arquivo ocorre indiretamente via
/// NodeExportValidator -> CLI Node -> fs.readFileSync -> Reader real.
/// Nunca chama IAtomicPublisher, File.Move, File.Copy, File.Delete,
/// LocateNexAdmin, SendInput, ClickButton, ou qualquer outra acao real.
///
/// So alcancavel via o argumento explicito
/// --diagnostic-validate-export-readonly &lt;caminho&gt; (ver Program.cs).
/// </summary>
internal static class NodeExportValidatorReadOnlyProbe
{
    /// <summary>Unica pasta autorizada para este probe diagnostico -
    /// NUNCA EXPORT_STAGE, NUNCA EXPORTADOS, NUNCA outro subdiretorio de
    /// OUTPUT.</summary>
    internal const string AllowedFolder = @"C:\Nex\PrimeIntegracaoNex\OUTPUT\HOMOLOGACAO-F6.14B2.9";

    public static void Run(string[] args)
    {
        Console.WriteLine("=== PRIME NEX EXPORT AGENT - PROBE DIAGNOSTICO READ-ONLY NodeExportValidator (F6.14B2.10B1) ===");
        Console.WriteLine("ATENCAO: le SOMENTE o arquivo informado (se dentro da pasta de homologacao autorizada). ZERO publicacao, ZERO NEX, ZERO UI.");
        Console.WriteLine();

        if (args.Length != 1)
        {
            Console.WriteLine("Uso: --diagnostic-validate-export-readonly <caminho-do-xls-na-pasta-de-homologacao>");
            Environment.ExitCode = 2;
            return;
        }

        var processRunner = new Win32ProcessRunner();
        var cliScriptPath = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "SCRIPTS", "validar-export-vendas.js");
        // Caminho do CLI resolvido relativo ao repositorio - em producao o
        // Agent e' publicado dentro do proprio repositorio (WINDOWS/...),
        // entao a estrutura relativa e' estavel. Nao usado nesta fase
        // real (probe nao e' executado nesta tarefa).
        var validator = new NodeExportValidator(processRunner, Path.GetFullPath(cliScriptPath));

        var result = RunCore(args[0], AllowedFolder, validator, Console.WriteLine);

        Console.WriteLine();
        Console.WriteLine("DIAGNOSTIC_VALIDATE_EXPORT_READONLY");
        Console.WriteLine($"FILE_NAME: {result.FileName ?? "(n/a)"}");
        Console.WriteLine($"VALID: {result.Valid?.ToString() ?? "(n/a)"}");
        Console.WriteLine($"ROWS: {result.Rows?.ToString() ?? "(n/a)"}");
        Console.WriteLine($"ERROR_CODE: {result.ErrorCode ?? "(nenhum)"}");
        Console.WriteLine($"REASON: {result.Reason ?? "(nenhum)"}");

        Environment.ExitCode = result.Outcome == ValidateReadOnlyProbeOutcome.Passed && result.Valid == true ? 0 : 1;
    }

    /// <summary>
    /// F6.14B2.10B1 - core testavel. Recebe o IExportValidator por
    /// parametro (Run() usa o real; testes injetam fake) - nenhuma
    /// instancia real e' criada aqui dentro. EXATAMENTE 1 chamada a
    /// Validate(), independente do resultado.
    /// </summary>
    internal static ValidateReadOnlyProbeResult RunCore(string rawPath, string allowedFolder, IExportValidator validator, Action<string> log)
    {
        // ---- Gate 1: extensao exatamente .xls (case-insensitive) -
        // barato, checado antes de qualquer I/O. ----
        var extension = Path.GetExtension(rawPath);
        if (!string.Equals(extension, ".xls", StringComparison.OrdinalIgnoreCase))
        {
            log($"Extensao '{extension}' nao permitida - esperado exatamente '.xls'. Validate() = ZERO.");
            return new ValidateReadOnlyProbeResult(ValidateReadOnlyProbeOutcome.FailedWrongExtension, null, null, null, null, null);
        }

        // ---- Gate 2: canonical path - o PARENT do arquivo precisa ser
        // EXATAMENTE a pasta autorizada (nunca subdiretorio, nunca
        // traversal, nunca EXPORT_STAGE/EXPORTADOS/outro OUTPUT). ----
        string canonicalFullPath;
        string canonicalParent;
        string canonicalAllowedFolder;
        try
        {
            canonicalFullPath = Path.GetFullPath(rawPath);
            canonicalParent = Path.GetFullPath(Path.GetDirectoryName(canonicalFullPath) ?? string.Empty);
            canonicalAllowedFolder = Path.GetFullPath(allowedFolder);
        }
        catch (Exception ex)
        {
            log($"Path invalido: {ex.Message}. Validate() = ZERO.");
            return new ValidateReadOnlyProbeResult(ValidateReadOnlyProbeOutcome.FailedPathOutsideAllowedFolder, null, null, null, null, null);
        }

        if (!string.Equals(canonicalParent, canonicalAllowedFolder, StringComparison.OrdinalIgnoreCase))
        {
            log("Arquivo fora da pasta de homologacao autorizada (nao e' filho direto de HOMOLOGACAO-F6.14B2.9). Validate() = ZERO.");
            return new ValidateReadOnlyProbeResult(ValidateReadOnlyProbeOutcome.FailedPathOutsideAllowedFolder, null, null, null, null, null);
        }

        // ---- Gate 3: existencia e' arquivo (nunca diretorio). ----
        if (!File.Exists(canonicalFullPath))
        {
            if (Directory.Exists(canonicalFullPath))
            {
                log("Caminho informado e' um diretorio, nao um arquivo. Validate() = ZERO.");
                return new ValidateReadOnlyProbeResult(ValidateReadOnlyProbeOutcome.FailedNotAFile, null, null, null, null, null);
            }

            log("Arquivo nao encontrado. Validate() = ZERO.");
            return new ValidateReadOnlyProbeResult(ValidateReadOnlyProbeOutcome.FailedFileNotFound, null, null, null, null, null);
        }

        var fileName = Path.GetFileName(canonicalFullPath);
        log($"Gates de path OK - chamando NodeExportValidator.Validate() EXATAMENTE 1x para '{fileName}'...");

        // ---- Acao unica: exatamente 1 chamada a Validate(), sem retry,
        // sem fallback, independente do resultado. ----
        var validation = validator.Validate(canonicalFullPath);

        if (!validation.Valid)
        {
            return new ValidateReadOnlyProbeResult(ValidateReadOnlyProbeOutcome.FailedValidatorInvalid, fileName, false, null, validation.ErrorCode.ToString(), validation.Reason);
        }

        return new ValidateReadOnlyProbeResult(ValidateReadOnlyProbeOutcome.Passed, fileName, true, validation.RecordCount, null, null);
    }
}
