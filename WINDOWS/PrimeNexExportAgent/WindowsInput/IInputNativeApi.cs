namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// Fronteira mockavel para as UNICAS 3 operacoes de acao aprovadas para
/// esta fase (F6.14B1): trazer uma janela especifica ao foreground,
/// confirmar qual janela esta em foreground, e enviar exatamente o atalho
/// Shift+F5. Deliberadamente MINIMALISTA - nunca "SendKey"/"SendKeys"/
/// "SendShortcut"/"Click" genericos. O comando de teclado aprovado
/// (Shift+F5) e o UNICO que este contrato expoe.
/// </summary>
public interface IInputNativeApi
{
    /// <summary>SetForegroundWindow(hWnd). Retorna o resultado bruto da
    /// API (false = falhou) - o chamador (WindowsInputSender) decide o que
    /// fazer com isso, esta interface nunca decide sozinha.</summary>
    bool SetForegroundWindow(nint hWnd);

    /// <summary>GetForegroundWindow() - leitura pura.</summary>
    nint GetForegroundWindow();

    /// <summary>Envia, em uma UNICA chamada nativa a SendInput, exatamente
    /// a sequencia SHIFT DOWN, F5 DOWN, F5 UP, SHIFT UP (4 eventos).
    /// Retorna a quantidade de eventos que o Windows reportou terem sido
    /// efetivamente inseridos - o chamador DEVE comparar contra 4 e tratar
    /// qualquer valor diferente como falha (possivel insercao parcial),
    /// nunca assumir sucesso pelo retorno nao lancar excecao.</summary>
    int SendShiftF5();
}
