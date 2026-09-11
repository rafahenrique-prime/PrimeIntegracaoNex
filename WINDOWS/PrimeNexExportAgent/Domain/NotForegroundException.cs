namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Lancada exclusivamente por WindowsScheduledSafeInputSender (modo
/// --run-once-scheduled-safe) quando o NexAdmin nao esta em primeiro
/// plano no momento do input (T3 inicial ou T4 revalidacao imediatamente
/// antes do SendInput). NUNCA lancada pelo sender manual
/// (WindowsInputSender), que forca foreground em vez de desistir.
///
/// Tipo distinto (nao InvalidOperationException) para permitir que
/// ExportAgentOrchestrator a distinga, com um catch especifico, de
/// qualquer outra falha real (UnexpectedException) - o resultado e' um
/// SKIP esperado (SkippedNotForeground), nunca um Failed.
/// </summary>
public sealed class NotForegroundException : Exception
{
    public NotForegroundException(string message) : base(message)
    {
    }
}
