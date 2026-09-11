namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Lancada EXCLUSIVAMENTE por WindowsBackgroundExportTrigger (modo
/// --run-once-scheduled-background-safe) quando um gate de ESTADO
/// OPERACIONAL SEGURO, verificado ANTES de qualquer acao mutante, nao
/// esta satisfeito: NEX em foreground, abridor/aba nao confirmados,
/// "Todas vendas" nao confirmado, ou qualquer outro pre-requisito
/// equivalente. Sinaliza "nao e a hora certa, tente no proximo ciclo" -
/// NUNCA uma quebra tecnica.
///
/// Distincao obrigatoria (decisao de design homologada): qualquer
/// divergencia detectada DEPOIS que o WM_COMMAND ja foi enviado (popup
/// nao abriu, Exportar nao localizado, fingerprint inconsistente, Save
/// Dialog nao surgiu) NUNCA lanca esta excecao - usa
/// InvalidOperationException (ou o tipo ja existente apropriado),
/// tratada pelo orquestrador como AgentStage.Failed, nunca como skip.
///
/// ExportAgentOrchestrator.Run() captura este tipo separadamente de
/// NotForegroundException (que continua exclusiva do modo
/// --run-once-scheduled-safe/WindowsScheduledSafeInputSender) e mapeia
/// para AgentStage.UnsafeState - reaproveitado, nunca um novo valor de
/// enum - com o motivo especifico preservado no campo Reason do log.
/// </summary>
public sealed class BackgroundSafeSkipException : Exception
{
    public BackgroundSafeSkipException(string message) : base(message) { }
}
