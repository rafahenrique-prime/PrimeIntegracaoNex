using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// Implementacao REAL (F6.14B1, corrigida em F6.14B2.5) de IInputSender -
/// a UNICA classe do projeto autorizada a enviar Shift+F5 de verdade.
/// Executa o PRE-INPUT TARGET GATE (T1-T4, documentado desde F6.13.4)
/// IMEDIATAMENTE antes do foreground e imediatamente antes do input -
/// nunca confia num estado observado segundos antes.
///
/// F6.14B2.5 - CORRECAO POR EVIDENCIA REAL: um probe real mostrou
/// SetForegroundWindow retornando sucesso (T3) seguido IMEDIATAMENTE por
/// GetForegroundWindow() != target - ou seja, a troca de foreground do
/// Windows nao e sincrona em relacao ao retorno de SetForegroundWindow.
/// T4 passou a ter duas partes: T4a (o proprio SetForegroundWindow, unico)
/// + T4b (IForegroundWaiter.WaitForForeground - polling READ-ONLY bounded
/// do resultado dessa unica tentativa, NUNCA uma segunda chamada a
/// SetForegroundWindow). Depois do waiter confirmar, uma ULTIMA leitura
/// direta de GetForegroundWindow e feita imediatamente antes do SendInput,
/// pois o foco ainda pode mudar entre o waiter confirmar e o input
/// acontecer.
///
/// Qualquer falha em qualquer gate lanca excecao - o orquestrador
/// (ExportAgentOrchestrator) ja trata isso: captura, loga Failed, nunca
/// tenta uma segunda vez (nao ha aresta de retry na maquina de estados).
/// </summary>
public sealed class WindowsInputSender : IInputSender
{
    /// <summary>OrdinalIgnoreCase - evidencia real (GetClassNameW ao vivo)
    /// mostrou a janela registrada como "TFrmPri", nao "TfrmPri"; Ordinal
    /// causava falso T2 mesmo com o target correto.</summary>
    private const string ExpectedClassName = "TfrmPri";

    private readonly INativeWindowApi _nativeWindows;
    private readonly IInputNativeApi _inputNative;
    private readonly IForegroundWaiter _foregroundWaiter;

    public WindowsInputSender(INativeWindowApi nativeWindows, IInputNativeApi inputNative, IForegroundWaiter foregroundWaiter)
    {
        _nativeWindows = nativeWindows;
        _inputNative = inputNative;
        _foregroundWaiter = foregroundWaiter;
    }

    public void SendExportShortcut(NexAdminWindowIdentity target)
    {
        // ---- T1: HWND existe ----
        if (!_nativeWindows.IsWindowValid(target.MainWindowHandle))
        {
            throw new InvalidOperationException("PRE-INPUT TARGET GATE T1 falhou: HWND do target nao existe mais.");
        }

        // ---- T2: HWND pertence ao PID esperado, ClassName ainda TfrmPri, ainda visivel ----
        var owningPid = _nativeWindows.GetOwningProcessId(target.MainWindowHandle);
        if (owningPid != target.ProcessId)
        {
            throw new InvalidOperationException("PRE-INPUT TARGET GATE T2 falhou: HWND ja nao pertence ao PID esperado.");
        }

        var className = _nativeWindows.GetClassName(target.MainWindowHandle);
        if (!string.Equals(className, ExpectedClassName, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"PRE-INPUT TARGET GATE T2 falhou: ClassName mudou para '{className}'.");
        }

        if (!_nativeWindows.IsWindowCurrentlyVisible(target.MainWindowHandle))
        {
            throw new InvalidOperationException("PRE-INPUT TARGET GATE T2 falhou: target nao esta mais visivel.");
        }

        // ---- T4a: foreground, EXATAMENTE 1 tentativa, nunca repetir ----
        if (!_inputNative.SetForegroundWindow(target.MainWindowHandle))
        {
            throw new InvalidOperationException("PRE-INPUT TARGET GATE T4a falhou: SetForegroundWindow retornou false.");
        }

        // ---- T4b (F6.14B2.5): espera bounded, read-only, pela troca de
        // foreground refletir de fato - NUNCA uma segunda chamada a
        // SetForegroundWindow (o waiter nao tem essa capacidade). ----
        if (!_foregroundWaiter.WaitForForeground(target.MainWindowHandle))
        {
            throw new InvalidOperationException("PRE-INPUT TARGET GATE T4b falhou: foreground nao confirmou o target dentro do timeout.");
        }

        // ---- Confirmacao FINAL, imediatamente antes do input (F6.14B2.5) -
        // o foco pode ter mudado entre o waiter confirmar e agora. Nunca
        // tenta recuperar foco, nunca repete SetForegroundWindow. ----
        if (_inputNative.GetForegroundWindow() != target.MainWindowHandle)
        {
            throw new InvalidOperationException("PRE-INPUT TARGET GATE T4 falhou: foreground mudou imediatamente antes do input (confirmacao final).");
        }

        // ---- T1-T4 = PASS confirmado. Autorizado exatamente 1 SendInput
        // (Shift+F5). Nenhum retry - se o retorno divergir de 4 eventos
        // inseridos, e uma falha (possivel insercao parcial), nunca uma
        // segunda tentativa "para corrigir". ----
        var inserted = _inputNative.SendShiftF5();
        if (inserted != 4)
        {
            throw new InvalidOperationException($"SendInput inseriu {inserted} evento(s), esperado 4 - possivel falha parcial do Shift+F5.");
        }
    }
}
