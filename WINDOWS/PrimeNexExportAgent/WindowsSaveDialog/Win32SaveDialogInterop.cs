using System.Runtime.InteropServices;
using System.Text;

namespace PrimeNexExportAgent.WindowsSaveDialog;

/// <summary>
/// UNICO ponto do projeto com DllImport especifico do dialogo "Salvar
/// como" (F6.14B2, corrigido em F6.14B2.2). Separado tanto de
/// WindowsNative/Win32Interop.cs (generico, read-only, homologado em
/// F6.14A+) quanto de WindowsInput/Win32InputInterop.cs (Shift+F5,
/// homologado em F6.14B1).
///
/// Contem operacoes de LEITURA (GetDlgItem, EnumChildWindows,
/// IsWindowEnabled, CB_GETCOUNT/CB_GETCURSEL/CB_GETLBTEXT,
/// WM_GETTEXTLENGTH/WM_GETTEXT) e de ESCRITA restrita (WM_SETTEXT -
/// SOMENTE usado no Edit filho do 1148 pelo dominio; CB_SETCURSEL -
/// SOMENTE usado no 1136). NUNCA expoe SendMessage generico para o
/// dominio - so os metodos semanticos de Win32SaveDialogControlApi usam
/// isto internamente.
///
/// F6.14B2.7/F6.14B2.8 - CORRECAO DE SEGURANCA CROSS-PROCESS: as
/// mensagens CDM_GETFILEPATH/CDM_GETFOLDERPATH/CDM_GETSPEC (todas
/// derivadas de CDM_FIRST = WM_USER + 100, portanto >= WM_USER) foram
/// REMOVIDAS PERMANENTEMENTE daqui. Mensagens >= WM_USER sao espaco
/// privado/definido pela aplicacao - o Windows NAO realiza nenhuma
/// marshalling automatica de ponteiro para elas. O buffer passado como
/// StringBuilder era marshalado pelo CLR como ponteiro valido somente no
/// espaco de enderecamento do processo Agent, mas SendMessage entregava
/// esse ponteiro cru a uma janela pertencente a OUTRO processo
/// (NexAdmin) - a WndProc do dialogo, ao tentar escrever nesse endereco
/// invalido no seu proprio espaco, e um cenario classico de Access
/// Violation no processo RECEPTOR. Substituido por WM_SETTEXT/WM_GETTEXT
/// (ambos < WM_USER), que fazem parte do pequeno conjunto de mensagens
/// "conhecidas" do Windows com marshalling automatico documentado para
/// comunicacao cross-process de texto - o mesmo mecanismo usado ha
/// decadas por qualquer ferramenta legitima de automacao de UI. NUNCA
/// reintroduzir CDM_* neste arquivo.
///
/// PROIBIDO PERMANENTEMENTE: qualquer mecanismo de manipulacao de
/// memoria de outro processo (OpenProcess para manipulacao remota,
/// VirtualAllocEx, VirtualFreeEx, ReadProcessMemory, WriteProcessMemory,
/// CreateRemoteThread, injecao de DLL, hooks) - nao sao necessarios e
/// nunca serao implementados neste projeto.
///
/// PROIBIDO nos fluxos genericos/producao (ISaveDialogController.ClickSave()/
/// CancelSaveDialog(), que continuam lancando NotSupportedException
/// incondicionalmente): WM_COMMAND (para acionar botoes), qualquer forma
/// generica de "clicar" Salvar/Cancelar.
///
/// F6.14B2.9A/9C/9F - CORRECAO DE COMENTARIO DESATUALIZADO: BM_CLICK
/// deixou de estar "proibido nesta fase" - foi implementado e homologado
/// (com save real supervisionado, F6.14B2.9E) exclusivamente dentro do
/// probe diagnostico one-shot isolado
/// (Diagnostics/ConfigureSaveDialogClickSaveOnceProbe.cs), via
/// ISaveDialogControlApi.ClickButton - nunca exposto pela interface
/// generica ISaveDialogController.
/// </summary>
internal static class Win32SaveDialogInterop
{
    [DllImport("user32.dll", SetLastError = true)]
    internal static extern nint GetDlgItem(nint hDlg, int nIDDlgItem);

    /// <summary>Enumera TODOS os descendentes (subarvore inteira, nao so
    /// filhos imediatos) de uma janela (F6.14B2.2, semantica corrigida em
    /// F6.14B2.3 - o Edit real do CtrlId 1148 e neto do ComboBoxEx32, nao
    /// filho direto). Read-only.</summary>
    internal delegate bool EnumChildProc(nint hWnd, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool EnumChildWindows(nint hWndParent, EnumChildProc lpEnumFunc, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindowEnabled(nint hWnd);

    /// <summary>F6.14B2.6 - CORRECAO: nao existe funcao nativa
    /// "SendMessageInt" em user32.dll - sem EntryPoint explicito, o
    /// runtime tentava resolver literalmente esse nome e falhava em
    /// runtime (MissingMethodException/EntryPointNotFoundException) na
    /// primeira chamada real (CB_SETCURSEL/CB_GETCURSEL/CB_GETCOUNT).
    /// EntryPoint mapeado explicitamente para SendMessageW - o nome
    /// gerenciado (especifico, "Int" = variante com wParam/lParam
    /// inteiros) pode continuar diferente do nome nativo, mas o mapeamento
    /// NUNCA pode ser implicito.</summary>
    [DllImport("user32.dll", EntryPoint = "SendMessageW", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern nint SendMessageInt(nint hWnd, uint msg, nint wParam, nint lParam);

    [DllImport("user32.dll", EntryPoint = "SendMessageW", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern nint SendMessageFindString(nint hWnd, uint msg, nint wParam, string lParam);

    /// <summary>Variante com StringBuilder de saida - usada para
    /// CB_GETLBTEXT (item de ComboBox) e para WM_GETTEXT (F6.14B2.8 -
    /// releitura segura do Edit filho do 1148, ambas mensagens < WM_USER
    /// com marshalling automatico documentado pelo Windows).</summary>
    [DllImport("user32.dll", EntryPoint = "SendMessageW", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern nint SendMessageGetBuffer(nint hWnd, uint msg, nint wParam, StringBuilder lParamBuffer);

    internal const uint CB_GETCURSEL = 0x0147;
    internal const uint CB_GETLBTEXT = 0x0148;
    internal const uint CB_GETLBTEXTLEN = 0x0149;
    internal const uint CB_GETCOUNT = 0x0146;
    internal const uint CB_SETCURSEL = 0x014E;
    internal const uint CB_FINDSTRINGEXACT = 0x0158;
    internal const nint CB_ERR = -1;

    // ---- F6.14B2.8: WM_SETTEXT/WM_GETTEXT/WM_GETTEXTLENGTH - mensagens
    // de sistema documentadas (< WM_USER = 0x0400) com marshalling
    // automatico do Windows para comunicacao cross-process de texto.
    // Usadas EXCLUSIVAMENTE no Edit filho real do CtrlId 1148 (escrita em
    // Configure, releitura em ReadBack) - substituem CDM_GETFILEPATH/
    // CDM_GETFOLDERPATH (removidas por serem >= WM_USER, sem marshalling,
    // ver cabecalho deste arquivo). SendMessageFindString e
    // SendMessageGetBuffer (acima) ja tem a assinatura correta para
    // enviar/receber essas mensagens - nenhum novo P/Invoke necessario. ----
    internal const uint WM_SETTEXT = 0x000C;
    internal const uint WM_GETTEXT = 0x000D;
    internal const uint WM_GETTEXTLENGTH = 0x000E;

    /// <summary>F6.14B2.9A - simula um clique de usuario num controle
    /// Button (documentado pela Microsoft especificamente para isso): o
    /// proprio botao, dentro do processo dono (NexAdmin), recebe
    /// WM_LBUTTONDOWN/WM_LBUTTONUP internamente e notifica seu pai via
    /// WM_COMMAND/BN_CLICKED - tudo isso inteiramente dentro do processo
    /// NexAdmin. BM_CLICK = 0x00F5 e' &lt; WM_USER e NAO carrega nenhum
    /// ponteiro (wParam=0, lParam=0, ambos nao utilizados) - trivialmente
    /// seguro cross-process, mesma classe de seguranca que CB_SETCURSEL.
    /// Usado EXCLUSIVAMENTE pelo probe diagnostico isolado de
    /// F6.14B2.9A sobre o CtrlId 1 (Salvar) ja validado - NUNCA exposto
    /// por ISaveDialogController.ClickSave() (que continua bloqueado
    /// incondicionalmente).</summary>
    internal const uint BM_CLICK = 0x00F5;
}
