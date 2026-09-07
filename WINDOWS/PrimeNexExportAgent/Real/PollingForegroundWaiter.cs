using PrimeNexExportAgent.Contracts;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (F6.14B2.5) de IForegroundWaiter - corrige a race de
/// tempo entre SetForegroundWindow retornar sucesso e o Windows
/// efetivamente refletir essa troca de foreground (evidencia real: probe
/// B2.4 confirmou SetForegroundWindow=true seguido imediatamente de
/// GetForegroundWindow() != target). So faz leitura (GetForegroundWindow) -
/// nunca chama SetForegroundWindow/AttachThreadInput/BringWindowToTop/
/// SwitchToThisWindow/SetActiveWindow/SetFocus ou qualquer outro mecanismo
/// de forcar foreground.
///
/// Timeout/intervalo centralizados aqui, com defaults conservadores
/// (menores que os do SaveDialogWaiter, pois a troca de foreground e
/// tipicamente muito mais rapida que a criacao de uma janela de dialogo).
/// </summary>
public sealed class PollingForegroundWaiter : IForegroundWaiter
{
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(1);
    public static readonly TimeSpan DefaultPollInterval = TimeSpan.FromMilliseconds(50);

    private readonly IForegroundReader _foregroundReader;
    private readonly IDelay _delay;
    private readonly IClock _clock;
    private readonly TimeSpan _timeout;
    private readonly TimeSpan _pollInterval;

    public PollingForegroundWaiter(
        IForegroundReader foregroundReader,
        IDelay delay,
        IClock clock,
        TimeSpan? timeout = null,
        TimeSpan? pollInterval = null)
    {
        _foregroundReader = foregroundReader;
        _delay = delay;
        _clock = clock;
        _timeout = timeout ?? DefaultTimeout;
        _pollInterval = pollInterval ?? DefaultPollInterval;
    }

    public bool WaitForForeground(nint targetHwnd)
    {
        var deadline = _clock.Now + _timeout;

        while (true)
        {
            // POLL READ-ONLY (F6.14B2.5) - nunca uma acao, so observacao do
            // resultado da unica tentativa de SetForegroundWindow ja feita
            // pelo chamador antes de invocar este metodo.
            if (_foregroundReader.GetForegroundWindow() == targetHwnd)
            {
                return true;
            }

            if (_clock.Now >= deadline)
            {
                return false; // fail-closed - nunca espera indefinidamente, nunca forca foreground
            }

            _delay.Wait(_pollInterval);
        }
    }
}
