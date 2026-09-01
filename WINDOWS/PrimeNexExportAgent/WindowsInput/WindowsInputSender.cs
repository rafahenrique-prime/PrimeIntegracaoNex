using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// Implementacao REAL (F6.14B1) de IInputSender - a UNICA classe do
/// projeto autorizada a enviar Shift+F5 de verdade. Executa o PRE-INPUT
/// TARGET GATE (T1-T4, documentado no contrato IInputSender desde
/// F6.13.4) IMEDIATAMENTE antes do foreground e imediatamente antes do
/// input - nunca confia num estado observado segundos antes (ex.: o
/// resultado de CheckSafeState, que e anterior no tempo).
///
/// Qualquer falha em qualquer gate lanca excecao - o orquestrador
/// (ExportAgentOrchestrator) ja trata isso: captura, loga Failed, nunca
/// tenta uma segunda vez (nao ha aresta de retry na maquina de estados).
/// </summary>
public sealed class WindowsInputSender : IInputSender
{
    private const string ExpectedClassName = "TfrmPri";

    private readonly INativeWindowApi _nativeWindows;
    private readonly IInputNativeApi _inputNative;

    public WindowsInputSender(INativeWindowApi nativeWindows, IInputNativeApi inputNative)
    {
        _nativeWindows = nativeWindows;
        _inputNative = inputNative;
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
        if (!string.Equals(className, ExpectedClassName, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"PRE-INPUT TARGET GATE T2 falhou: ClassName mudou para '{className}'.");
        }

        if (!_nativeWindows.IsWindowCurrentlyVisible(target.MainWindowHandle))
        {
            throw new InvalidOperationException("PRE-INPUT TARGET GATE T2 falhou: target nao esta mais visivel.");
        }

        // ---- T3: foreground, EXATAMENTE 1 tentativa, nunca repetir ----
        if (!_inputNative.SetForegroundWindow(target.MainWindowHandle))
        {
            throw new InvalidOperationException("PRE-INPUT TARGET GATE T3 falhou: SetForegroundWindow retornou false.");
        }

        // ---- T4: confirmar foreground == target (1a leitura) ----
        if (_inputNative.GetForegroundWindow() != target.MainWindowHandle)
        {
            throw new InvalidOperationException("PRE-INPUT TARGET GATE T4 falhou: foreground nao e o target (1a confirmacao).");
        }

        // ---- T4 (repeticao imediatamente antes do input): o foco pode ter
        // mudado entre a 1a confirmacao e agora - nunca confiar numa
        // observacao de instantes atras. ----
        if (_inputNative.GetForegroundWindow() != target.MainWindowHandle)
        {
            throw new InvalidOperationException("PRE-INPUT TARGET GATE T4 falhou: foreground mudou imediatamente antes do input (2a confirmacao).");
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
