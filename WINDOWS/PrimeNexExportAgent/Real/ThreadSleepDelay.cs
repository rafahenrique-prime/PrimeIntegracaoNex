using System.Threading;
using PrimeNexExportAgent.Contracts;

namespace PrimeNexExportAgent.Real;

/// <summary>Implementacao real (F6.14B2.4) de IDelay - Thread.Sleep puro,
/// somente leitura em relacao ao NEX (nunca envia nenhuma acao).</summary>
public sealed class ThreadSleepDelay : IDelay
{
    public void Wait(TimeSpan duration) => Thread.Sleep(duration);
}
