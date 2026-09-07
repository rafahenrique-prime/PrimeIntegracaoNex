using PrimeNexExportAgent.Contracts;

namespace PrimeNexExportAgent.Diagnostics;

/// <summary>IClock real compartilhado pelos probes diagnosticos
/// (F6.14B2.5) - evita duplicar a mesma classe privada em cada probe.</summary>
internal sealed class SystemClock : IClock
{
    public DateTime Now => DateTime.Now;
}
