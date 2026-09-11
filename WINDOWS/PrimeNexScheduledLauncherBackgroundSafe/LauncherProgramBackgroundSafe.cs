// PRIME NEX SCHEDULED LAUNCHER BACKGROUND SAFE - entrypoint de producao
// para o Task Scheduler do Scheduler V2 (PARALELO a PrimeNexVendasExport/
// V1, nunca o substitui enquanto nao autorizado). OutputType=WinExe (ver
// .csproj) - este processo nunca aloca console/janela, mesmo motivo do
// launcher V1.
//
// Unico papel: iniciar PrimeNexExportAgent.exe
// --run-once-scheduled-background-safe exatamente uma vez (via
// RealChildProcessRunner do projeto V1, reutilizado via ProjectReference -
// sem cmd.exe/powershell/shell), preservar stdout+stderr no MESMO log
// JSONL diario que o launcher V1 ja usa (LauncherCore.Run() define esse
// nome de arquivo - reutilizado sem alteracao, nunca duplicado aqui), e
// propagar o exit code real como o exit code deste processo.

using PrimeNexScheduledLauncher;

const string AgentExe = @"C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexExportAgent\bin\Debug\net10.0-windows\PrimeNexExportAgent.exe";
const string AgentWorkDir = @"C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexExportAgent";
const string LogDir = @"C:\Nex\PrimeIntegracaoNex\LOGS";
const string Argument = "--run-once-scheduled-background-safe";

var exitCode = LauncherCore.Run(new RealChildProcessRunner(), AgentExe, AgentWorkDir, LogDir, Argument, () => DateTime.Now);

Environment.Exit(exitCode);
