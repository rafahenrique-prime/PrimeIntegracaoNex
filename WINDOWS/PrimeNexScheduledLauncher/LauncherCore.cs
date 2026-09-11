namespace PrimeNexScheduledLauncher;

/// <summary>
/// Logica testavel do launcher - EXATAMENTE 1 chamada a IChildProcessRunner
/// por invocacao, nunca retry, nunca loop. Program.cs monta a configuracao
/// FIXA de producao (nenhum override por variavel de ambiente) e chama
/// Run() uma unica vez; os testes injetam um IChildProcessRunner fake e
/// paths de log em diretorio temporario descartavel - nunca alcancam o
/// Agent real nem o NEX.
/// </summary>
public static class LauncherCore
{
    /// <summary>
    /// Executa o Agent exatamente uma vez via `runner`, anexa stdout+stderr
    /// (sem reserializar) ao log JSONL diario de `logDir`, e retorna o
    /// exit code REAL do Agent. Uma falha do PROPRIO launcher antes de
    /// sequer iniciar o filho (log dir inacessivel, Agent EXE ausente)
    /// retorna 1 sem chamar `runner` - nunca mascarada como sucesso.
    /// </summary>
    public static int Run(IChildProcessRunner runner, string agentExe, string agentWorkDir, string logDir, string argument, Func<DateTime> now)
    {
        try
        {
            Directory.CreateDirectory(logDir);
        }
        catch
        {
            // Falha do launcher antes de iniciar o filho - nunca chama o
            // Agent sem log dir garantido, nunca retry.
            return 1;
        }

        if (!File.Exists(agentExe))
        {
            // Mesma categoria: falha do launcher, zero tentativa de
            // iniciar o filho.
            return 1;
        }

        var logFile = Path.Combine(logDir, $"prime-nex-export-agent-scheduled-{now():yyyy-MM-dd}.jsonl");

        // ---- UNICA chamada por invocacao - nunca uma segunda, mesmo se
        // o resultado divergir do esperado. ----
        var result = runner.Run(agentExe, agentWorkDir, argument);

        try
        {
            // Conteudo original preservado linha a linha, sem
            // reserializar - mesma garantia que o .cmd anterior tinha via
            // `>> log 2>&1`. stdout primeiro, depois stderr (a
            // interleaving exata em tempo real entre os dois streams nao
            // e' preservada com captura assincrona separada - tradeoff
            // aceito, ambos os conteudos completos sao preservados).
            if (result.Stdout.Length > 0) File.AppendAllText(logFile, result.Stdout);
            if (result.Stderr.Length > 0) File.AppendAllText(logFile, result.Stderr);
        }
        catch
        {
            // Falha ao escrever o log NUNCA mascara o exit code real do
            // Agent - o resultado do processo filho e' o que importa.
        }

        return result.ExitCode;
    }
}
