using System.Runtime.InteropServices;
using System.Text;

namespace PrimeNexExportAgent.WindowsNative;

/// <summary>
/// UNICO ponto do projeto com DllImport (F6.14A secao 11 - "nao espalhar
/// P/Invoke pelo projeto"). Todas as funcoes aqui sao estritamente
/// SOMENTE LEITURA - nenhuma delas altera estado do Windows ou de
/// qualquer processo/janela. Nenhum codigo de dominio/orquestrador
/// referencia esta classe diretamente - sempre atraves de
/// Win32NativeWindowApi/Win32SessionNativeApi (interfaces mockaveis).
///
/// PROIBIDO acrescentar aqui (F6.14A): SendInput, keybd_event, mouse_event,
/// PostMessage, SendMessage de escrita, WM_COMMAND/BM_CLICK/WM_SETTEXT,
/// SetWindowText, SetForegroundWindow - essas pertencem exclusivamente a
/// F6.14B (IInputSender/ISaveDialogController reais), ainda nao implementada.
/// </summary>
internal static class Win32Interop
{
    // ---- user32.dll (somente leitura) ----

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool IsWindow(nint hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool IsWindowVisible(nint hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern uint GetWindowThreadProcessId(nint hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern int GetClassName(nint hWnd, StringBuilder lpClassName, int nMaxCount);

    /// <summary>F6.14B2 - somente leitura, usada para confirmar o titulo
    /// exato do dialogo #32770 ("Salvar como").</summary>
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern int GetWindowText(nint hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern int GetWindowTextLength(nint hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern nint GetWindow(nint hWnd, uint uCmd);

    /// <summary>F6.14A.2 - somente leitura, usada para classificar a
    /// janela oculta TApplication (area 0x0) sem depender de heuristica
    /// visual/coordenada.</summary>
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetWindowRect(nint hWnd, out RECT lpRect);

    internal delegate bool EnumWindowsProc(nint hWnd, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, nint lParam);

    /// <summary>Scheduler V2 - somente leitura, usada para relocalizar
    /// (nunca cachear) o botao de overflow por ClassName+ControlId dentro
    /// da subarvore inteira da janela alvo. EnumChildWindows ja enumera
    /// recursivamente filhos/netos/etc (mesma semantica documentada em
    /// F6.14B2.3 para Win32SaveDialogInterop) - reaproveita o mesmo
    /// delegate EnumWindowsProc acima (assinatura identica).</summary>
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool EnumChildWindows(nint hWndParent, EnumWindowsProc lpEnumFunc, nint lParam);

    /// <summary>GetDlgCtrlID(hWnd) - somente leitura, identifica o control
    /// ID atribuido pelo framework (Delphi/DevExpress) ao HWND informado.
    /// Retorna 0 se o HWND nao tiver ID atribuido/for invalido.</summary>
    [DllImport("user32.dll", SetLastError = true)]
    internal static extern int GetDlgCtrlID(nint hWnd);

    /// <summary>IsWindowEnabled(hWnd) - somente leitura.</summary>
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindowEnabled(nint hWnd);

    /// <summary>IsIconic(hWnd) - somente leitura, True se a janela estiver
    /// minimizada (SW_SHOWMINIMIZED). Hybrid V3 - discriminador de
    /// NexRuntimeState.Minimized, evidencia real: TApplication.IsIconic
    /// so' e' True quando o NexAdmin esta genuinamente minimizado (False
    /// tanto em foreground quanto em background-aberto).</summary>
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsIconic(nint hWnd);

    /// <summary>GetParent(hWnd) real (distinto de GetWindow(hWnd, GW_OWNER)
    /// acima) - usado para reencontrar o parent verdadeiro de um controle
    /// filho (ex.: o botao de overflow), nunca confundido com o owner de
    /// uma janela top-level.</summary>
    [DllImport("user32.dll", SetLastError = true)]
    internal static extern nint GetParent(nint hWnd);

    internal const uint GW_OWNER = 4;

    /// <summary>Scheduler V2 - usados com GetWindow() acima para caminhar a
    /// lista de filhos IMEDIATOS (Z-order) de um parent e computar a
    /// posicao (indice 0-based) de um HWND especifico entre eles - nunca
    /// confundir com EnumChildWindows (que enumera TODA a subarvore,
    /// recursiva, sem nocao de irmandade imediata).</summary>
    internal const uint GW_CHILD = 5;
    internal const uint GW_HWNDNEXT = 2;

    // ---- wtsapi32.dll (somente leitura) ----

    [DllImport("wtsapi32.dll", SetLastError = true)]
    internal static extern bool WTSQuerySessionInformation(
        nint hServer, uint sessionId, WtsInfoClass wtsInfoClass, out nint ppBuffer, out uint pBytesReturned);

    [DllImport("wtsapi32.dll")]
    internal static extern void WTSFreeMemory(nint pMemory);

    internal const nint WTS_CURRENT_SERVER_HANDLE = 0;

    internal enum WtsInfoClass
    {
        WTSConnectState = 8,
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
