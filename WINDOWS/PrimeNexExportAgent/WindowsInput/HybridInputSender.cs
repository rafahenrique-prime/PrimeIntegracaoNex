using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// Hybrid V3 - COMPOE (nunca redesenha) os dois mecanismos homologados:
/// WindowsScheduledSafeInputSender (V1, foreground) e
/// WindowsBackgroundExportTrigger (V2, background). NENHUMA logica
/// funcional de V1/V2 vive aqui - este sender so' decide QUAL dos dois
/// chamar, exatamente 1 vez por execucao, no UNICO ponto em que
/// ExportAgentOrchestrator chama IInputSender.SendExportShortcut()
/// (ExportAgentOrchestrator.cs, apos G1-G7+G13=PASS).
///
/// Decisao de rota (uma unica vez, nunca reconsultada depois): mesmo
/// criterio ja homologado em WindowsBackgroundExportTrigger.IsNexForeground
/// - HWND de foreground exato OU MESMO PID do NexAdmin (cobre casos como
/// TfrmIntercom/"Atendimento", HWND distinto mas OWNER=TfrmPri, mesmo PID -
/// achado real de runtime). Uma vez escolhido V1 ou V2, o restante da
/// execucao delega inteiramente para o sender escolhido - qualquer
/// mudanca de foreground DEPOIS deste ponto e' tratada pelas proprias
/// revalidacoes internas de V1 (T3/T4) ou V2 (IsNexForeground antes do
/// WM_COMMAND), nunca por uma segunda decisao de rota aqui.
/// </summary>
public sealed class HybridInputSender : IInputSender, IHybridRouteDecisionContext
{
    private readonly INativeWindowApi _nativeWindows;
    private readonly IForegroundReader _foregroundReader;
    private readonly IInputSender _foregroundSender;
    private readonly IInputSender _backgroundSender;

    public HybridRouteDecision? CurrentDecision { get; private set; }

    public HybridInputSender(
        INativeWindowApi nativeWindows,
        IForegroundReader foregroundReader,
        IInputSender foregroundSender,
        IInputSender backgroundSender)
    {
        _nativeWindows = nativeWindows;
        _foregroundReader = foregroundReader;
        _foregroundSender = foregroundSender;
        _backgroundSender = backgroundSender;
    }

    public void SendExportShortcut(NexAdminWindowIdentity target)
    {
        var foregroundHwnd = _foregroundReader.GetForegroundWindow();
        var foregroundPid = _nativeWindows.GetOwningProcessId(foregroundHwnd);
        var isNexForeground = foregroundHwnd == target.MainWindowHandle || foregroundPid == target.ProcessId;

        // ---- ROTA decidida AQUI, UMA UNICA VEZ - nenhum codigo abaixo
        // deste ponto reconsulta foreground para trocar de sender. ----
        if (isNexForeground)
        {
            CurrentDecision = HybridRouteDecision.V1Foreground;
            _foregroundSender.SendExportShortcut(target);
        }
        else
        {
            CurrentDecision = HybridRouteDecision.V2Background;
            _backgroundSender.SendExportShortcut(target);
        }
    }
}
