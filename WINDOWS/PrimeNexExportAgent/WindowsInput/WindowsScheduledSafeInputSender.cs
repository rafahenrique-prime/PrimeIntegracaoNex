using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// Implementacao REAL (modo --run-once-scheduled-safe) de IInputSender,
/// destinada a execucao recorrente via Task Scheduler. Compartilha T1/T2
/// (validacao do target) e o SendShiftF5 final com WindowsInputSender, mas
/// SUBSTITUI inteiramente T4a/T4b (forcar foreground) por uma checagem
/// somente-leitura: se o NexAdmin nao estiver JA em primeiro plano por
/// conta propria, desiste (NotForegroundException) - NUNCA chama
/// SetForegroundWindow/BringWindowToTop/SwitchToThisWindow/SetActiveWindow/
/// SetFocus ou qualquer outro mecanismo de forcar foco. Isso e' o que torna
/// este sender seguro para rodar sem supervisao enquanto o usuario pode
/// estar usando o computador para qualquer outra coisa.
///
/// Duas leituras de GetForegroundWindow() (T3 inicial + T4 imediatamente
/// antes do SendInput) - nunca uma so - pelo mesmo motivo documentado em
/// WindowsInputSender (F6.14B2.5): o foco pode mudar entre a primeira
/// checagem e o momento real do input.
/// </summary>
public sealed class WindowsScheduledSafeInputSender : IInputSender
{
    /// <summary>OrdinalIgnoreCase - evidencia real (GetClassNameW ao vivo)
    /// mostrou a janela registrada como "TFrmPri", nao "TfrmPri"; Ordinal
    /// causava falso NotForeground/T2 mesmo com o target correto.</summary>
    private const string ExpectedClassName = "TfrmPri";

    private readonly INativeWindowApi _nativeWindows;
    private readonly IInputNativeApi _inputNative;
    private readonly IForegroundReader _foregroundReader;

    public WindowsScheduledSafeInputSender(INativeWindowApi nativeWindows, IInputNativeApi inputNative, IForegroundReader foregroundReader)
    {
        _nativeWindows = nativeWindows;
        _inputNative = inputNative;
        _foregroundReader = foregroundReader;
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

        // ---- T3: foreground somente-leitura - NUNCA SetForegroundWindow.
        // Se o NexAdmin nao estiver ja em primeiro plano, desiste. ----
        if (_foregroundReader.GetForegroundWindow() != target.MainWindowHandle)
        {
            throw new NotForegroundException("SCHEDULED-SAFE GATE T3 falhou: NexAdmin nao esta em primeiro plano - nenhuma tentativa de forcar foco.");
        }

        // ---- T4: revalidacao IMEDIATAMENTE antes do input - o foco pode
        // ter mudado entre T3 e agora. Nunca tenta recuperar foco. ----
        if (_foregroundReader.GetForegroundWindow() != target.MainWindowHandle)
        {
            throw new NotForegroundException("SCHEDULED-SAFE GATE T4 falhou: foreground mudou entre a checagem inicial e o input (confirmacao final).");
        }

        // ---- T1-T4 = PASS confirmado. Autorizado exatamente 1 SendInput
        // (Shift+F5). Nenhum retry. ----
        var inserted = _inputNative.SendShiftF5();
        if (inserted != 4)
        {
            throw new InvalidOperationException($"SendInput inseriu {inserted} evento(s), esperado 4 - possivel falha parcial do Shift+F5.");
        }
    }
}
