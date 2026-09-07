using System.Text.Json;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (F6.14B2.10A) de IExportValidator - chama
/// SCRIPTS/validar-export-vendas.js via IProcessRunner e interpreta o
/// contrato JSON+exit code. NUNCA reimplementa a regra de validacao do
/// Reader (SERVICO/leitor-export-vendas.js continua Source of Truth).
/// NUNCA publica, NUNCA chama IAtomicPublisher, NUNCA move/copia/apaga
/// arquivos - responsabilidade estritamente de interpretar o resultado
/// de uma unica chamada ao CLI.
///
/// VALIDACAO ESTRITA (F6.14B2.10A secao 7): qualquer contradicao entre
/// exit code e o campo `ok` do JSON, ou qualquer desvio do contrato
/// esperado (stdout vazio, JSON invalido, campo ausente/tipo errado),
/// e' fail-closed - nunca "o sinal mais provavel".
/// </summary>
public sealed class NodeExportValidator : IExportValidator
{
    /// <summary>Timeout conservador para um Reader local processando um
    /// .xls de ~1,7MB (tempo real observado em F6.14B2.9: escrita do
    /// proprio arquivo pelo NEX levou ~7s: 15s cobre o Reader com folga
    /// generosa sem esperar indefinidamente).</summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(10);

    private const int ExitOk = 0;
    private const int ExitReaderRejeitou = 1;

    private readonly IProcessRunner _processRunner;
    private readonly string _nodeExecutable;
    private readonly string _cliScriptPath;
    private readonly TimeSpan _timeout;

    public NodeExportValidator(IProcessRunner processRunner, string cliScriptPath, string nodeExecutable = "node", TimeSpan? timeout = null)
    {
        _processRunner = processRunner;
        _cliScriptPath = cliScriptPath;
        _nodeExecutable = nodeExecutable;
        _timeout = timeout ?? DefaultTimeout;
    }

    public ExportValidationResult Validate(string filePath)
    {
        // Exatamente 1 chamada ao subprocesso - zero retry, mesmo em
        // caso de excecao inesperada do proprio runner.
        ProcessRunResult result;
        try
        {
            result = _processRunner.Run(_nodeExecutable, new[] { _cliScriptPath, filePath }, _timeout);
        }
        catch (Exception ex)
        {
            return ExportValidationResult.Fail(AgentErrorCode.UnexpectedException, $"falha ao iniciar subprocesso Node: {ex.Message}");
        }

        if (!result.Started)
        {
            return ExportValidationResult.Fail(AgentErrorCode.UnexpectedException, "subprocesso Node nao iniciou (executavel ausente/sem permissao)");
        }

        if (result.TimedOut)
        {
            return ExportValidationResult.Fail(AgentErrorCode.UnexpectedException, $"subprocesso Node excedeu o timeout de {_timeout.TotalSeconds}s - nenhuma segunda tentativa");
        }

        if (result.ExitCode != ExitOk && result.ExitCode != ExitReaderRejeitou)
        {
            return ExportValidationResult.Fail(AgentErrorCode.UnexpectedException, $"exit code inesperado do CLI: {result.ExitCode} (esperado 0 ou 1)");
        }

        if (string.IsNullOrWhiteSpace(result.StdOut))
        {
            return ExportValidationResult.Fail(AgentErrorCode.UnexpectedException, "stdout vazio - contrato ausente");
        }

        var linhas = result.StdOut.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (linhas.Length != 1)
        {
            return ExportValidationResult.Fail(AgentErrorCode.UnexpectedException, $"stdout deveria conter exatamente 1 linha JSON, continha {linhas.Length}");
        }

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(linhas[0]);
        }
        catch (JsonException ex)
        {
            return ExportValidationResult.Fail(AgentErrorCode.UnexpectedException, $"stdout nao e' JSON valido: {ex.Message}");
        }

        using (doc)
        {
            var root = doc.RootElement;

            if (!root.TryGetProperty("ok", out var okProperty) ||
                (okProperty.ValueKind != JsonValueKind.True && okProperty.ValueKind != JsonValueKind.False))
            {
                return ExportValidationResult.Fail(AgentErrorCode.UnexpectedException, "JSON sem campo 'ok' booleano");
            }

            var ok = okProperty.GetBoolean();

            if (ok)
            {
                if (result.ExitCode != ExitOk)
                {
                    return ExportValidationResult.Fail(AgentErrorCode.UnexpectedException, $"contradicao: ok=true mas exitCode={result.ExitCode}");
                }

                if (!root.TryGetProperty("rows", out var rowsProperty) ||
                    rowsProperty.ValueKind != JsonValueKind.Number ||
                    !rowsProperty.TryGetInt32(out var rows) ||
                    rows < 0)
                {
                    return ExportValidationResult.Fail(AgentErrorCode.UnexpectedException, "campo 'rows' ausente, nao-inteiro ou negativo");
                }

                return ExportValidationResult.Ok(rows);
            }
            else
            {
                if (result.ExitCode != ExitReaderRejeitou)
                {
                    return ExportValidationResult.Fail(AgentErrorCode.UnexpectedException, $"contradicao: ok=false mas exitCode={result.ExitCode}");
                }

                if (!root.TryGetProperty("errorCode", out var errorCodeProperty) ||
                    errorCodeProperty.ValueKind != JsonValueKind.String ||
                    string.IsNullOrEmpty(errorCodeProperty.GetString()))
                {
                    return ExportValidationResult.Fail(AgentErrorCode.UnexpectedException, "campo 'errorCode' ausente/vazio no contrato de falha");
                }

                var errorCode = errorCodeProperty.GetString()!;
                var reason = root.TryGetProperty("reason", out var reasonProperty) && reasonProperty.ValueKind == JsonValueKind.String
                    ? reasonProperty.GetString() ?? string.Empty
                    : string.Empty;

                // Preserva o errorCode ORIGINAL do Reader na mensagem -
                // nunca mascarado por um codigo generico do Agent.
                return ExportValidationResult.Fail(AgentErrorCode.ReaderRejected, $"{errorCode}: {reason}");
            }
        }
    }
}
