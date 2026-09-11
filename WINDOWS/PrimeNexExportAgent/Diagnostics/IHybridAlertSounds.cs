namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// Hybrid V3 - camada de alertas sonoros, DELIBERADAMENTE separada do
/// nucleo (RunOnceScheduledHybridEntrypoint so' chama isto DEPOIS de
/// decidir o resultado final - nunca antes, nunca condicionando exit
/// code/estagio/checkpoint/outbox/idempotencia a qualquer som). Implementacoes
/// usam APENAS som nativo do Windows (Console.Beep) - sem MP3/WAV externo,
/// sem dependencia nova.
/// </summary>
public interface IHybridAlertSounds
{
    /// <summary>NEX_MINIMIZED - exatamente 2 beeps curtos.</summary>
    void PlayMinimizedWarning();

    /// <summary>Falha tecnica APOS a primeira acao mutavel real ter sido
    /// tentada (MutationWitness.MutationAttempted==true) - exatamente 3
    /// beeps distintos/mais fortes que os de MINIMIZED (nunca confundiveis
    /// ao ouvido).</summary>
    void PlayTechnicalFailureAfterAction();
}
