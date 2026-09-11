using System.Runtime.InteropServices;

namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// UNICO ponto do projeto com DllImport de ACAO para o modo
/// --run-once-scheduled-background-safe (Scheduler V2). Deliberadamente
/// separado de Win32InputInterop.cs (Shift+F5, V1) e de
/// Win32SaveDialogInterop.cs (dialogo "Salvar como") - nunca misturar
/// superficies de DllImport de componentes diferentes no mesmo arquivo.
///
/// Superficie MINIMA e final: SendMessageTimeout, usado EXCLUSIVAMENTE
/// para notificar BN_CLICKED ao parent de um botao via WM_COMMAND -
/// mecanismo homologado nas Fases B.1.3/B.2/B.3. Nenhuma outra API de
/// acao (WM_LBUTTONDOWN/UP, BM_CLICK, SetFocus, SetForegroundWindow,
/// SendInput, UIA Invoke) pertence a este arquivo.
/// </summary>
internal static class Win32BackgroundClickInterop
{
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern nint SendMessageTimeout(
        nint hWnd, uint msg, nint wParam, nint lParam, uint fuFlags, uint uTimeout, out nint lpdwResult);

    internal const uint WM_COMMAND = 0x0111;
    internal const uint BN_CLICKED = 0;
    internal const uint SMTO_ABORTIFHUNG = 0x0002;
}
