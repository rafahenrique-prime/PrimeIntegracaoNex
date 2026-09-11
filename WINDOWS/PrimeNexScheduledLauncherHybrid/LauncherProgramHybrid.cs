// PRIME NEX SCHEDULED LAUNCHER HYBRID - entrypoint de producao para o
// Task Scheduler. A Task PrimeNexVendasExport aponta para este executavel
// (confirmado via Task Scheduler em 2026-09-10). Os launchers V1
// (PrimeNexScheduledLauncher) e V2 (PrimeNexScheduledLauncherBackgroundSafe)
// permanecem intocados e disponiveis standalone - V1 para rollback, V2
// como mecanismo standalone/diagnostico. OutputType=WinExe (ver .csproj)
// - este processo nunca aloca console/janela, mesmo motivo dos launchers
// V1/V2.
//
// Unico papel: iniciar PrimeNexExportAgent.exe
// --run-once-scheduled-hybrid exatamente uma vez (via
// RealChildProcessRunner do projeto V1, reutilizado via ProjectReference -
// sem cmd.exe/powershell/shell), preservar stdout+stderr no MESMO log
// JSONL diario que os launchers V1/V2 ja usam (LauncherCore.Run() define
// esse nome de arquivo - reutilizado sem alteracao, nunca duplicado
// aqui), e propagar o exit code real como o exit code deste processo.

using PrimeNexScheduledLauncher;

const string AgentExe = @"C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexExportAgent\bin\Debug\net10.0-windows\PrimeNexExportAgent.exe";
const string AgentWorkDir = @"C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexExportAgent";
const string LogDir = @"C:\Nex\PrimeIntegracaoNex\LOGS";
const string Argument = "--run-once-scheduled-hybrid";

var exitCode = LauncherCore.Run(new RealChildProcessRunner(), AgentExe, AgentWorkDir, LogDir, Argument, () => DateTime.Now);

Environment.Exit(exitCode);
