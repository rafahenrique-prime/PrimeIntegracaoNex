namespace PrimeNexExportAgent.WindowsNative;

/// <summary>
/// Calibracao homologada (Probes 10A-10D) da abertura DIRETA do cliente
/// filtrado na tela Clientes, via clique tecnico no TcxGridSite -
/// substitui a dependencia de F2, que se provou nao confiavel: F2
/// abriu repetidamente o registro 743 (selecao interna antiga do grid),
/// mesmo com o campo de busca corretamente filtrado para "292" (Probe
/// 10A comprovou visualmente Clientes(1)/MATHEUS HENRIQUE DEPRE/Codigo
/// 292 apos WM_SETTEXT). O Probe 10D comprovou, com o NEX real, que um
/// unico PostMessage WM_LBUTTONDOWN/WM_LBUTTONUP no ponto client-local
/// abaixo, dirigido diretamente ao HWND do grid, abre corretamente o
/// registro filtrado (Codigo=292, Nome=MATHEUS HENRIQUE DEPRE
/// confirmados pos-abertura).
///
/// So valido enquanto a geometria (TFrmPri, janela do grid, area
/// cliente do grid) bater EXATAMENTE com os valores abaixo - qualquer
/// divergencia e' fail-closed (ClientGridGeometryMismatch), nunca
/// escalada/recalculada/adaptada por DPI. Mudanca de resolucao/layout da
/// janela do NEX exige nova calibracao manual.
/// </summary>
internal static class NexClientsGridOpenProfile
{
    internal static readonly Win32Interop.RECT ExpectedTFrmPriRect = new()
    {
        Left = -10,
        Top = -10,
        Right = 1930,
        Bottom = 1030,
    };

    internal static readonly Win32Interop.RECT ExpectedGridWindowRect = new()
    {
        Left = 245,
        Top = 204,
        Right = 1920,
        Bottom = 1020,
    };

    /// <summary>Area cliente do grid (sempre Left=0,Top=0 por definicao de
    /// GetClientRect) - representada aqui como largura/altura para bater
    /// com a assinatura de INexClientNavigationNativeApi.GetClientSize.</summary>
    internal const int ExpectedGridClientWidth = 1675;
    internal const int ExpectedGridClientHeight = 816;

    /// <summary>Ponto client-local homologado do botao/linha "Editar -
    /// F2" do unico registro filtrado, dentro do HWND do proprio grid -
    /// NAO e' um offset, e' o ponto final ja comprovado por clique
    /// real (Probe 10D).</summary>
    internal const int EditClientPointX = 83;
    internal const int EditClientPointY = 88;

    internal static bool MatchesExpectedGeometry(
        Win32Interop.RECT actualTFrmPriRect,
        Win32Interop.RECT actualGridWindowRect,
        int actualGridClientWidth,
        int actualGridClientHeight) =>
        RectEquals(actualTFrmPriRect, ExpectedTFrmPriRect) &&
        RectEquals(actualGridWindowRect, ExpectedGridWindowRect) &&
        actualGridClientWidth == ExpectedGridClientWidth &&
        actualGridClientHeight == ExpectedGridClientHeight;

    private static bool RectEquals(Win32Interop.RECT a, Win32Interop.RECT b) =>
        a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom;
}
