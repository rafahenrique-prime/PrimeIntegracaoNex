using System.IO;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (F6.14B2.9A) de IExportStageWatcher - puramente
/// read-only em relacao ao sistema de arquivos (Directory.GetFiles/
/// FileInfo). NUNCA cria, apaga, move ou escreve nenhum arquivo. NUNCA
/// reenvia nenhuma acao (ClickButton/Shift+F5/etc.) - so observa o
/// resultado de uma acao ja executada exatamente 1 vez pelo chamador.
/// </summary>
public sealed class PollingExportStageWatcher : IExportStageWatcher
{
    /// <summary>Tempo maximo de espera bounded pos-acao - apos isso,
    /// fail-closed com o ultimo estado observado, nunca espera
    /// indefinidamente.</summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(15);

    /// <summary>Intervalo entre consultas read-only sucessivas.</summary>
    public static readonly TimeSpan DefaultPollInterval = TimeSpan.FromMilliseconds(300);

    /// <summary>Numero de observacoes consecutivas identicas de
    /// (tamanho, LastWriteTimeUtc) exigidas para considerar o arquivo
    /// estavel (mesmo criterio desenhado em F6.12 secao 11).</summary>
    private const int RequiredStableObservations = 3;

    private readonly IDelay _delay;
    private readonly IClock _clock;
    private readonly TimeSpan _pollInterval;

    public PollingExportStageWatcher(IDelay delay, IClock clock, TimeSpan? pollInterval = null)
    {
        _delay = delay;
        _clock = clock;
        _pollInterval = pollInterval ?? DefaultPollInterval;
    }

    public ExportStageWatchResult ConfirmEmptyBeforeAction(string directoryPath)
    {
        string[] entries;
        try
        {
            entries = Directory.GetFiles(directoryPath);
        }
        catch (Exception ex)
        {
            return ExportStageWatchResult.Fail(AgentErrorCode.UnsafeState, $"erro ao ler '{directoryPath}': {ex.Message}");
        }

        if (entries.Length > 0)
        {
            // Fail-closed - NUNCA apagado automaticamente para "tornar
            // vazio" (F6.14B2.9A secao 6).
            return ExportStageWatchResult.Fail(AgentErrorCode.UnsafeState,
                $"'{directoryPath}' nao esta vazia antes da acao ({entries.Length} arquivo(s) presente(s)) - fail-closed");
        }

        return ExportStageWatchResult.Pass();
    }

    public ExportStageWatchResult WaitForExpectedFileOnly(string directoryPath, string expectedFileName, TimeSpan timeout)
    {
        // F6.14B2.9F - unico transitorio TOLERADO (nao PASS, nao FAIL
        // imediato): o MESMO basename do esperado, com extensao ".csv"
        // (comparacao de extensao case-insensitive, conforme evidencia
        // real observada em F6.14B2.9E - o NEX passa por um arquivo
        // "<basename>.csv" durante a geracao antes do ".xls" final).
        // Derivado do proprio expectedFileName - nunca hardcoded, nunca
        // generalizado para qualquer outra extensao/basename/sufixo.
        var expectedBaseName = Path.GetFileNameWithoutExtension(expectedFileName);
        var allowedTransientName = expectedBaseName + ".csv";

        var deadline = _clock.Now + timeout;
        (long Length, DateTime LastWriteUtc)? lastObserved = null;
        var consecutiveStable = 0;
        var transientObservedThisRun = false;

        while (true)
        {
            string[] entries;
            try
            {
                entries = Directory.GetFiles(directoryPath);
            }
            catch (Exception ex)
            {
                return ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable, $"erro ao ler '{directoryPath}': {ex.Message}");
            }

            var expectedPathIndex = -1;
            var transientPathIndex = -1;
            for (var i = 0; i < entries.Length; i++)
            {
                var actualName = Path.GetFileName(entries[i]);
                if (string.Equals(actualName, expectedFileName, StringComparison.Ordinal))
                {
                    expectedPathIndex = i;
                }
                else if (string.Equals(actualName, allowedTransientName, StringComparison.OrdinalIgnoreCase))
                {
                    transientPathIndex = i;
                }
                else
                {
                    // Qualquer nome/basename/extensao fora das duas
                    // categorias explicitamente permitidas (esperado ou
                    // transitorio conhecido) e' INESPERADO REAL - fail-closed
                    // imediato, nunca "esperar para ver se desaparece"
                    // (F6.14B2.9F secao 1/2 - nunca generalizar tolerancia
                    // alem do fenomeno real observado).
                    return ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable,
                        $"arquivo inesperado '{actualName}' - esperado exatamente '{expectedFileName}' (unico transitorio tolerado: '{allowedTransientName}')");
                }
            }

            var hasExpected = expectedPathIndex >= 0;
            var hasTransient = transientPathIndex >= 0;

            if (hasTransient)
            {
                // Transitorio presente (sozinho ou junto do esperado) -
                // NUNCA PASS enquanto ele existir. Reinicia qualquer
                // contagem de estabilidade do XLS - so volta a contar
                // depois que o transitorio desaparecer e restar
                // exatamente o esperado (F6.14B2.9F secao 2).
                transientObservedThisRun = true;
                consecutiveStable = 0;
                lastObserved = null;
            }
            else if (hasExpected)
            {
                var info = new FileInfo(entries[expectedPathIndex]);

                if (info.Length > 0 && lastObserved is { } prev && prev.Length == info.Length && prev.LastWriteUtc == info.LastWriteTimeUtc)
                {
                    consecutiveStable++;
                }
                else
                {
                    // 0 bytes nunca conta como estavel, mesmo que
                    // "pare de mudar"; tamanho/mtime mudando reinicia a
                    // contagem (conservador - prefere falso negativo a
                    // falso positivo, F6.12 secao 11).
                    consecutiveStable = info.Length > 0 ? 1 : 0;
                }

                lastObserved = (info.Length, info.LastWriteTimeUtc);

                if (consecutiveStable >= RequiredStableObservations)
                {
                    return ExportStageWatchResult.Pass();
                }
            }
            else
            {
                // 0 arquivos - continua aguardando (pode ser que a
                // exportacao ainda nem tenha comecado a escrever nada).
                consecutiveStable = 0;
                lastObserved = null;
            }

            if (_clock.Now >= deadline)
            {
                var reason = (hasExpected, hasTransient, transientObservedThisRun) switch
                {
                    (false, false, false) => $"nenhum arquivo apareceu em '{directoryPath}' dentro do timeout",
                    (false, true, _) => $"apenas o transitorio '{allowedTransientName}' persistiu ate o timeout, sem o '{expectedFileName}' final",
                    (true, true, _) => $"transitorio '{allowedTransientName}' e esperado '{expectedFileName}' persistiram juntos ate o timeout",
                    (true, false, true) => $"'{expectedFileName}' apareceu apos transitorio mas nao estabilizou dentro do timeout",
                    _ => $"'{expectedFileName}' nao estabilizou dentro do timeout",
                };
                return ExportStageWatchResult.Fail(AgentErrorCode.FileUnstable, reason);
            }

            // POLL READ-ONLY - nunca reenvia ClickButton nem qualquer
            // outra acao. Timeout esgotado = FAIL, nunca uma segunda
            // tentativa da acao real. Nunca renomeia/apaga/interfere no
            // transitorio - so observa.
            _delay.Wait(_pollInterval);
        }
    }
}
