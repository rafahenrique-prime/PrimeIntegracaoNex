// PRIME NEX SCHEDULED LAUNCHER - entrypoint de producao para o Task
// Scheduler (PrimeNexVendasExport). OutputType=WinExe (ver .csproj) - este
// processo nunca aloca console/janela. Configuracao FIXA, sem override por
// variavel de ambiente (a versao testavel/parametrizavel e' LauncherCore,
// exercitada offline em PrimeNexScheduledLauncher.Tests - este Program.cs
// nunca e' chamado por nenhum teste).
//
// Unico papel: iniciar PrimeNexExportAgent.exe --run-once-scheduled-safe
// exatamente uma vez (via RealChildProcessRunner, sem cmd.exe/powershell/
// shell), preservar stdout+stderr no mesmo log JSONL diario que o launcher
// .cmd anterior usava, e propagar o exit code real como o exit code deste
// processo.

using PrimeNexScheduledLauncher;

const string AgentExe = @"C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexExportAgent\bin\Debug\net10.0-windows\PrimeNexExportAgent.exe";
const string AgentWorkDir = @"C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexExportAgent";
const string LogDir = @"C:\Nex\PrimeIntegracaoNex\LOGS";
const string Argument = "--run-once-scheduled-safe";

var exitCode = LauncherCore.Run(new RealChildProcessRunner(), AgentExe, AgentWorkDir, LogDir, Argument, () => DateTime.Now);

Environment.Exit(exitCode);
