namespace PrimeNexExportAgent.WindowsNative;

/// <summary>
/// Fronteira mockavel para as consultas Win32 de janela (user32.dll)
/// usadas por INexWindowInspector (F6.14A/F6.14A.1). Todas as operacoes
/// sao somente leitura - nada aqui pode alterar foco, conteudo ou estado
/// de nenhuma janela.
/// </summary>
public interface INativeWindowApi
{
    /// <summary>True se o HWND ainda e uma janela valida (IsWindow).</summary>
    bool IsWindowValid(nint hWnd);

    /// <summary>True se o HWND esta visivel agora (IsWindowVisible) -
    /// usado tanto na enumeracao quanto na revalidacao pontual de um
    /// target ja conhecido (F6.14A.1).</summary>
    bool IsWindowCurrentlyVisible(nint hWnd);

    /// <summary>PID dono do HWND informado, ou null se o HWND for invalido
    /// ou a consulta falhar.</summary>
    int? GetOwningProcessId(nint hWnd);

    /// <summary>ClassName real da janela (GetClassName), ou null se o HWND
    /// for invalido/a consulta falhar.</summary>
    string? GetClassName(nint hWnd);

    /// <summary>HWND dono (GW_OWNER) da janela informada, ou 0 se nao tiver
    /// dono/o HWND for invalido (F6.14A.2 - usado para classificar
    /// infraestrutura Delphi/Intercom, nunca para o filtro de "top-level").</summary>
    nint GetOwner(nint hWnd);

    /// <summary>Le a area (largura/altura) da janela via GetWindowRect.
    /// Retorna false se a consulta falhar - o chamador DEVE tratar false
    /// como "area desconhecida" (fail-closed, F6.14A.2), nunca como "area
    /// vazia assumida".</summary>
    bool TryGetWindowRect(nint hWnd, out int width, out int height);

    /// <summary>Todos os HWNDs top-level (EnumWindows) atualmente visiveis
    /// (IsWindowVisible) que pertencem ao PID informado - SEM filtrar por
    /// Owner (F6.14A.1: evidencia real do NEX provou que a janela de
    /// negocio real, TfrmPri, tem Owner != 0 - o Delphi/VCL a torna filha,
    /// em termos de GW_OWNER, da janela oculta TApplication. Filtrar por
    /// "sem dono" excluiria a propria janela alvo). Usado tanto para
    /// localizar a janela TfrmPri (LocateNexAdmin) quanto para o gate G3
    /// (exatamente 1 janela top-level visivel relevante).</summary>
    IReadOnlyList<nint> GetVisibleTopLevelWindowsForProcess(int processId);
}
