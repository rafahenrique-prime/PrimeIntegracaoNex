// PRIME NEX EXPORT AGENT - skeleton (F6.13) + wrappers read-only (F6.14A)
// + IInputSender real (F6.14B1, SOMENTE via probe explicito abaixo).
//
// F6.14A implementou ISessionInspector/INexWindowInspector reais (somente
// leitura). F6.14B1 implementou IInputSender real (WindowsInputSender),
// mas ISaveDialogController REAL ainda NAO existe - so o fake de teste.
// Program.cs deliberadamente NAO monta nenhum ExportAgentOrchestrator real
// aqui, e a execucao padrao (sem argumento) continua zero-input - isso
// evita que simplesmente rodar este executavel possa, por acidente,
// alcancar um envio de tecla.
//
// Dois modos diagnosticos, cada um atras de um argumento EXPLICITO:
//   --inspect-readonly                          -> zero input (F6.14A)
//   --diagnostic-send-export-shortcut-once       -> PODE enviar Shift+F5
//                                                    real (F6.14B1) - one
//                                                    shot, nunca clica
//                                                    Salvar/Cancelar.
// Sem NENHUM argumento (ou um argumento nao reconhecido), o executavel so
// imprime a mensagem de status abaixo e encerra - zero input em qualquer
// caso.

if (args.Length == 1 && args[0] == "--inspect-readonly")
{
    PrimeNexExportAgent.Diagnostics.ReadOnlyInspection.Run();
    return;
}

if (args.Length == 1 && args[0] == "--diagnostic-send-export-shortcut-once")
{
    PrimeNexExportAgent.Diagnostics.SendExportShortcutOnceProbe.Run();
    return;
}

Console.WriteLine("PRIME NEX EXPORT AGENT - F6.14B1. Sem argumento reconhecido, ZERO acao foi executada.");
Console.WriteLine("Use --inspect-readonly para uma inspecao somente-leitura.");
Console.WriteLine("Use --diagnostic-send-export-shortcut-once para o probe supervisionado de Shift+F5 (PODE enviar tecla real - so execute sob o ritual BEFORE/AFTER).");
