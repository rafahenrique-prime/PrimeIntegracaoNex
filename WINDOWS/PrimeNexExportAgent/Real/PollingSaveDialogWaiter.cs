using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (F6.14B2.4) de ISaveDialogWaiter - corrige a race de
/// tempo assincrona entre SendExportShortcut e o Windows criar a janela
/// "Salvar como" (evidencia real: probe B2.3 checou 0 candidatos no
/// instante seguinte ao Shift+F5; o dialogo comprovadamente existia pouco
/// depois). Faz polling READ-ONLY bounded de IdentifySaveDialog - NUNCA
/// chama IInputSender/SendExportShortcut, NUNCA reenvia a acao ja
/// executada em outro componente.
///
/// Timeout e intervalo de poll sao centralizados aqui (nao espalhados como
/// magic numbers pelo orquestrador), com defaults documentados e
/// configuraveis via construtor.
/// </summary>
public sealed class PollingSaveDialogWaiter : ISaveDialogWaiter
{
    /// <summary>Tempo maximo de espera bounded (F6.14B2.4 secao 3) - apos
    /// isso, fail-closed com o ultimo resultado observado, nunca espera
    /// indefinidamente.</summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(3);

    /// <summary>Intervalo entre consultas read-only sucessivas.</summary>
    public static readonly TimeSpan DefaultPollInterval = TimeSpan.FromMilliseconds(100);

    private readonly ISaveDialogInspector _inspector;
    private readonly IDelay _delay;
    private readonly IClock _clock;
    private readonly TimeSpan _timeout;
    private readonly TimeSpan _pollInterval;

    public PollingSaveDialogWaiter(
        ISaveDialogInspector inspector,
        IDelay delay,
        IClock clock,
        TimeSpan? timeout = null,
        TimeSpan? pollInterval = null)
    {
        _inspector = inspector;
        _delay = delay;
        _clock = clock;
        _timeout = timeout ?? DefaultTimeout;
        _pollInterval = pollInterval ?? DefaultPollInterval;
    }

    public SaveDialogIdentityResult WaitForSaveDialog(NexAdminWindowIdentity target)
    {
        var deadline = _clock.Now + _timeout;

        while (true)
        {
            // POLL READ-ONLY (F6.14B2.4) - reconsulta um estado que pode
            // mudar de forma assincrona. Isto NAO e retry de acao: nenhuma
            // tecla/clique e enviado aqui, em nenhuma iteracao. O retry de
            // acao (Shift+F5/SendInput) continua estritamente ZERO, em
            // outro componente (IInputSender), chamado exatamente 1 vez
            // antes deste metodo sequer comecar.
            var result = _inspector.IdentifySaveDialog(target);

            if (result.Passed)
            {
                return result;
            }

            if (IsAmbiguous(result))
            {
                // Ambiguidade nunca se resolve "esperando mais" - mais de 1
                // candidato valido e um estado definitivamente inseguro,
                // fail-closed imediato (F6.14B2.4 secao 6).
                return result;
            }

            if (_clock.Now >= deadline)
            {
                // Timeout - fail-closed com o ultimo resultado observado.
                // Nenhuma nova tecla, nenhum retry de acao.
                return result;
            }

            _delay.Wait(_pollInterval);
        }
    }

    private static bool IsAmbiguous(SaveDialogIdentityResult result) =>
        result.Reason.Contains("ambiguidade", StringComparison.OrdinalIgnoreCase);
}
