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

    /// <summary>Titulo/texto da janela (GetWindowText) - F6.14B2, usado
    /// para confirmar o titulo exato "Salvar como" do dialogo #32770.
    /// Retorna null se o HWND for invalido/a consulta falhar; string vazia
    /// e um resultado valido (janela sem titulo), nunca confundido com null.</summary>
    string? GetWindowTitle(nint hWnd);

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

    /// <summary>Scheduler V2 - GetDlgCtrlID(hWnd), somente leitura.
    /// Retorna 0 se o HWND for invalido/nao tiver ID atribuido.</summary>
    int GetControlId(nint hWnd);

    /// <summary>Scheduler V2 - IsWindowEnabled(hWnd), somente leitura.</summary>
    bool IsWindowCurrentlyEnabled(nint hWnd);

    /// <summary>Scheduler V2 - GetParent(hWnd) real, distinto de GetOwner
    /// (GW_OWNER) acima - usado para reencontrar o parent verdadeiro de um
    /// controle filho (ex.: botao de overflow), nunca o owner de uma
    /// janela top-level. Retorna 0 se o HWND for invalido/nao tiver
    /// parent.</summary>
    nint GetParentWindow(nint hWnd);

    /// <summary>Scheduler V2 - TODOS os descendentes (subarvore inteira,
    /// via EnumChildWindows) do HWND informado - somente leitura, mesma
    /// semantica ja homologada em Win32SaveDialogInterop/F6.14B2.3.</summary>
    IReadOnlyList<nint> GetAllDescendants(nint hWndParent);

    /// <summary>Scheduler V2 - filhos IMEDIATOS de `hWndParent`, na ordem Z
    /// real (GetWindow(GW_CHILD) + GW_HWNDNEXT), usada exclusivamente para
    /// computar o indice 0-based de um HWND especifico entre seus irmaos
    /// verdadeiros - nunca confundir com GetAllDescendants (subarvore
    /// inteira, sem nocao de irmandade imediata).</summary>
    IReadOnlyList<nint> GetImmediateChildrenInZOrder(nint hWndParent);

    /// <summary>Hybrid V3 - IsIconic(hWnd), somente leitura. True se a
    /// janela estiver minimizada (SW_SHOWMINIMIZED). Discriminador de
    /// NexRuntimeState.Minimized (ver Win32NexRuntimeStateProbe) -
    /// distinto de IsWindowCurrentlyVisible, que fica False tanto em
    /// Minimized quanto em Closed.</summary>
    bool IsWindowMinimized(nint hWnd);

    /// <summary>Hybrid V3 - TODAS as janelas top-level (EnumWindows) do PID
    /// informado, SEM filtrar por IsWindowVisible (distinto de
    /// GetVisibleTopLevelWindowsForProcess, que so' devolve visiveis) -
    /// necessario porque TFrmPri fica Visible=False quando minimizado,
    /// mas TApplication (Owner==0) permanece descobrivel aqui em qualquer
    /// estado (aberto, minimizado) para permitir a classificacao correta.</summary>
    IReadOnlyList<nint> GetAllTopLevelWindowsForProcess(int processId);
}
