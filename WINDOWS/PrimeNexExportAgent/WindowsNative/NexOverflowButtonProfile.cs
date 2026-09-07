namespace PrimeNexExportAgent.WindowsNative;

/// <summary>
/// Calibracao final e homologada (sessao de investigacao real) do botao
/// de overflow ("...") da aba Transacoes. NAO e' um offset a ser
/// recalculado (versoes anteriores da calibracao usaram offsets
/// FromRight/FromTop a partir de fontes de bounds que se provaram
/// inconsistentes nesta maquina - DESCARTADAS) - e' o PONTO DE TELA FINAL
/// ja homologado por dois mecanismos independentes:
///   1. Clique HUMANO, sem qualquer movimento de cursor, neste exato
///      ponto, abriu o menu corretamente.
///   2. PostMessage real (WM_LBUTTONDOWN/UP) neste mesmo ponto abriu o
///      menu e permitiu uma exportacao real completa, validada
///      semanticamente e publicada.
///
/// So e' valido enquanto a geometria da TFrmCadCli bater EXATAMENTE com
/// ExpectedCadCliWindowRect (GetWindowRect fisico). Qualquer divergencia
/// e' fail-closed (OverflowGeometryMismatch) - nunca escalar, nunca
/// recalcular, nunca aplicar heuristica de DPI. Mudanca de
/// resolucao/posicao da janela do NEX exige nova calibracao manual.
/// </summary>
internal static class NexOverflowButtonProfile
{
    internal static readonly Win32Interop.RECT ExpectedCadCliWindowRect = new()
    {
        Left = 0,
        Top = 0,
        Right = 1536,
        Bottom = 864,
    };

    internal const int ValidatedOverflowScreenX = 1489;
    internal const int ValidatedOverflowScreenY = 146;

    // Geometry stability gate (correcao pos-4o OnceProbe/Probe 11B): uma
    // unica leitura imediatamente apos TransactionsTabActive nao basta -
    // a falha real teve ~6.8ms entre a aba ficar ativa e a leitura de
    // geometria, sem qualquer folga para repaint/resize residual. Exige
    // N leituras CONSECUTIVAS corretas antes de prosseguir para
    // hit-test/PostMessage; nenhuma acao mutante ocorre durante o gate.
    internal const int GeometryPollIntervalMs = 100;
    internal const int MaxGeometryWaitMs = 1500;
    internal const int RequiredConsecutiveGeometryMatches = 2;

    internal static bool MatchesExpectedGeometry(Win32Interop.RECT actual) =>
        actual.Left == ExpectedCadCliWindowRect.Left &&
        actual.Top == ExpectedCadCliWindowRect.Top &&
        actual.Right == ExpectedCadCliWindowRect.Right &&
        actual.Bottom == ExpectedCadCliWindowRect.Bottom;
}
