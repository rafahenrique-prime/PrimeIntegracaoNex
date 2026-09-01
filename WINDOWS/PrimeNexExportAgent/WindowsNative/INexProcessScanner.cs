namespace PrimeNexExportAgent.WindowsNative;

/// <summary>Fronteira mockavel para enumeracao de processos por nome
/// (F6.14A). Somente leitura - nunca inicia, encerra ou sinaliza nenhum
/// processo.</summary>
public interface INexProcessScanner
{
    IReadOnlyList<NexProcessCandidate> FindProcessesByName(string processName);
}
