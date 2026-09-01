using System.Diagnostics;

namespace PrimeNexExportAgent.WindowsNative;

/// <summary>Implementacao real (F6.14A) de INexProcessScanner - somente
/// leitura via System.Diagnostics.Process. Cada Process e descartado
/// (Dispose) apos a extracao do instantaneo somente-leitura.</summary>
public sealed class Win32NexProcessScanner : INexProcessScanner
{
    public IReadOnlyList<NexProcessCandidate> FindProcessesByName(string processName)
    {
        var processes = Process.GetProcessesByName(processName);
        var result = new List<NexProcessCandidate>(processes.Length);

        try
        {
            foreach (var process in processes)
            {
                try
                {
                    string? executablePath;
                    try
                    {
                        executablePath = process.MainModule?.FileName;
                    }
                    catch
                    {
                        // Acesso negado/processo indisponivel - registra
                        // este candidato com caminho null, nunca trata
                        // como match (a decisao de descartar fica em
                        // WindowsNexWindowInspector, que e testavel).
                        executablePath = null;
                    }

                    result.Add(new NexProcessCandidate(process.Id, executablePath, process.SessionId));
                }
                catch
                {
                    // Processo saiu entre GetProcessesByName e a leitura de
                    // suas propriedades - descarta esse candidato.
                }
            }
        }
        finally
        {
            foreach (var process in processes) process.Dispose();
        }

        return result;
    }
}
