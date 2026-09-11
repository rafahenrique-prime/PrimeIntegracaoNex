namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// Fronteira mockavel para a UNICA operacao de acao do Scheduler V2
/// (--run-once-scheduled-background-safe): notificar BN_CLICKED ao
/// parent de um botao via WM_COMMAND, sem qualquer input de mouse/
/// teclado real e sem jamais tentar foreground. Deliberadamente
/// minimalista - nenhum outro metodo de acao.
/// </summary>
public interface IBackgroundClickNativeApi
{
    /// <summary>SendMessageTimeout(parentHwnd, WM_COMMAND,
    /// MAKEWPARAM(LOWORD(controlId), BN_CLICKED), controlHwnd,
    /// SMTO_ABORTIFHUNG, timeoutMs, out result). UMA UNICA chamada
    /// nativa por invocacao - o chamador nunca deve invocar isto mais de
    /// uma vez por execucao (sem retry). `completed=false` cobre tanto
    /// timeout (SMTO_ABORTIFHUNG) quanto qualquer outra falha reportada
    /// por GetLastError - o chamador trata os dois como "mensagem nao
    /// confirmada", nunca como sucesso presumido.</summary>
    (bool completed, nint result, int lastError) SendBnClickedViaWmCommand(
        nint parentHwnd, nint controlHwnd, int controlId, uint timeoutMs);
}
