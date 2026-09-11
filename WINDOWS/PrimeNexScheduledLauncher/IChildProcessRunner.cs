namespace PrimeNexScheduledLauncher;

/// <summary>Fronteira mockavel (unica) deste launcher - permite testar
/// LauncherCore inteiramente offline, sem nunca iniciar
/// PrimeNexExportAgent.exe real nem qualquer outro processo. `argument` e'
/// sempre exatamente 1 string (o contrato de producao real - o Agent so
/// aceita exatamente 1 argumento exato por vez, ex.
/// "--run-once-scheduled-safe").</summary>
public interface IChildProcessRunner
{
    ChildProcessResult Run(string fileName, string workingDirectory, string argument);
}
