using System.Text.Json;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Logging;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// F6.14B2.12E - implementacao REAL MINIMA de IAgentLogger: escreve 1
/// linha JSON por evento em stdout (mesmo espirito JSONL ja usado pelo
/// restante do projeto - SERVICO/logger-estruturado.js). AgentLogEvent so
/// carrega Timestamp/RunId/Stage/ErrorCode/FileName - nunca payload de
/// negocio (cliente/valor/itens/secret) por construcao do proprio tipo,
/// entao esta implementacao nao precisa (nem pode) filtrar nada alem
/// disso. Nunca envia log a nenhum servico externo/Base44 - so stdout do
/// proprio processo do Agent.
/// </summary>
public sealed class ConsoleAgentLogger : IAgentLogger
{
    public void Log(AgentLogEvent evt)
    {
        Console.WriteLine(Serialize(evt));
    }

    internal static string Serialize(AgentLogEvent evt) => JsonSerializer.Serialize(new
        {
            timestamp = evt.Timestamp.ToString("O"),
            runId = evt.RunId,
            stage = evt.Stage,
            errorCode = evt.ErrorCode,
            fileName = evt.FileName,
            reason = evt.Reason,
            hybridRoute = evt.HybridRoute,
            nexPosition = evt.NexPosition,
            routeReason = evt.RouteReason,
        });
}
