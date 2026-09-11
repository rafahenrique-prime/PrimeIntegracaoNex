namespace PrimeNexExportAgent.WindowsNative;

/// <summary>
/// Hybrid V3 - estado simples por execucao: se a PRIMEIRA acao mutavel
/// real (SendInput do V1 / WM_COMMAND do V2) chegou a ser tentada. Usado
/// EXCLUSIVAMENTE pela composicao do RunOnceScheduledHybridEntrypoint para
/// decidir entre silencio e os 3 beeps de falha tecnica - nunca consultado
/// por V1/V2 standalone, que nao tem nocao de alertas sonoros.
///
/// Por que nao basta o log de AgentStage.ExportTriggered: esse estagio so'
/// e' logado quando IInputSender.SendExportShortcut() RETORNA sem lancar
/// nenhuma excecao. Tanto WindowsScheduledSafeInputSender (gates T1/T2,
/// pre-mutacao) quanto uma falha de SendInput reportando contagem errada
/// (pos-mutacao) lancam o MESMO tipo (InvalidOperationException) - o log
/// de estagios sozinho nao distingue "gate falhou antes de qualquer input"
/// de "SendInput foi despachado mas voltou parcial". MutationWitness marca
/// o instante exato da chamada nativa real, nao depende do que acontece
/// depois dela.
/// </summary>
public sealed class MutationWitness
{
    public bool MutationAttempted { get; private set; }

    public void MarkAttempted() => MutationAttempted = true;
}
