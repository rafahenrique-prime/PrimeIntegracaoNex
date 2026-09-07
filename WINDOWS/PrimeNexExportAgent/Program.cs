// PRIME NEX EXPORT AGENT - skeleton (F6.13) + wrappers read-only (F6.14A)
// + IInputSender real (F6.14B1) + Save Dialog Identify/Configure/ReadBack
// real (F6.14B2) + ClickSave diagnostico isolado (F6.14B2.9A), SOMENTE via
// probes explicitos abaixo.
//
// F6.14A implementou ISessionInspector/INexWindowInspector reais (somente
// leitura). F6.14B1 implementou IInputSender real. F6.14B2 implementou
// ISaveDialogInspector real e a parte Configure() de ISaveDialogController -
// ClickSave()/CancelSaveDialog() DA INTERFACE GENERICA continuam SEMPRE
// lancando NotSupportedException (nunca homologados, nem apos F6.14B2.9A).
// O clique real (BM_CLICK) so existe dentro do probe diagnostico isolado
// abaixo, via ISaveDialogControlApi.ClickButton - nunca exposto pela
// interface generica ISaveDialogController. Program.cs deliberadamente NAO
// monta nenhum ExportAgentOrchestrator real aqui, e a execucao padrao (sem
// argumento) continua zero-acao - isso evita que simplesmente rodar este
// executavel possa, por acidente, alcancar um envio de tecla ou clique.
//
// Quatro modos diagnosticos, cada um atras de um argumento EXPLICITO:
//   --inspect-readonly                                  -> zero acao (F6.14A)
//   --diagnostic-send-export-shortcut-once               -> PODE enviar
//                                                            Shift+F5 real
//                                                            (F6.14B1) - one
//                                                            shot, nunca
//                                                            clica Salvar/
//                                                            Cancelar.
//   --diagnostic-configure-save-dialog-readback-once     -> PODE enviar
//                                                            Shift+F5 real
//                                                            E escrever nos
//                                                            campos do
//                                                            dialogo
//                                                            (F6.14B2) - one
//                                                            shot, encerra
//                                                            apos o
//                                                            ReadBack, NUNCA
//                                                            clica Salvar/
//                                                            Cancelar.
//   --diagnostic-configure-save-dialog-click-save-once   -> PODE fazer tudo
//                                                            o que o modo
//                                                            acima faz E
//                                                            TAMBEM clica
//                                                            Salvar
//                                                            (BM_CLICK)
//                                                            exatamente 1x
//                                                            (F6.14B2.9A) -
//                                                            one shot, prova
//                                                            o resultado via
//                                                            sistema de
//                                                            arquivos, nunca
//                                                            via retorno do
//                                                            clique.
// Sem NENHUM argumento (ou um argumento nao reconhecido), o executavel so
// imprime a mensagem de status abaixo e encerra - zero acao em qualquer
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

if (args.Length == 1 && args[0] == "--diagnostic-configure-save-dialog-readback-once")
{
    PrimeNexExportAgent.Diagnostics.ConfigureSaveDialogReadbackOnceProbe.Run();
    return;
}

if (args.Length == 1 && args[0] == "--diagnostic-configure-save-dialog-click-save-once")
{
    PrimeNexExportAgent.Diagnostics.ConfigureSaveDialogClickSaveOnceProbe.Run();
    return;
}

if (args.Length == 2 && args[0] == "--diagnostic-validate-export-readonly")
{
    PrimeNexExportAgent.Diagnostics.NodeExportValidatorReadOnlyProbe.Run(new[] { args[1] });
    return;
}

if (args.Length == 2 && args[0] == "--diagnostic-publish-isolated")
{
    PrimeNexExportAgent.Diagnostics.IsolatedValidatedPublicationProbe.Run(new[] { args[1] });
    return;
}

if (args.Length == 3 && args[0] == "--diagnostic-mutex-hold")
{
    PrimeNexExportAgent.Diagnostics.MutexHoldTestHost.Run(new[] { args[1], args[2] });
    return;
}

if (args.Length == 1 && args[0] == "--diagnostic-confirmed-save-committer-once")
{
    PrimeNexExportAgent.Diagnostics.ConfirmedSaveDialogCommitterOnceProbe.Run();
    return;
}

if (PrimeNexExportAgent.Diagnostics.RunOnceOperationalEntrypoint.IsOperationalFlag(args))
{
    PrimeNexExportAgent.Diagnostics.RunOnceOperationalEntrypoint.Run();
    return;
}

// V1 (extrato individual por cliente) - probe supervisionado one-shot,
// mesmo padrao dos demais --diagnostic-* acima. NUNCA alcancavel sem o
// argumento exato "--diagnostic-individual-statement-once" seguido do
// codigo do cliente (e opcionalmente o nome esperado) - nunca hardcoded
// em producao, nunca disparado pelo modo default deste executavel.
if (PrimeNexExportAgent.Diagnostics.IndividualStatementOnceProbe.IsProbeFlag(args))
{
    PrimeNexExportAgent.Diagnostics.IndividualStatementOnceProbe.Run(args);
    return;
}

Console.WriteLine("PRIME NEX EXPORT AGENT - F6.14B2.10B1. Sem argumento reconhecido, ZERO acao foi executada.");
Console.WriteLine("Use --inspect-readonly para uma inspecao somente-leitura.");
Console.WriteLine("Use --diagnostic-send-export-shortcut-once para o probe supervisionado de Shift+F5 (PODE enviar tecla real).");
Console.WriteLine("Use --diagnostic-configure-save-dialog-readback-once para o probe supervisionado de Configure+ReadBack do Save Dialog (PODE enviar tecla real e escrever campos - NUNCA clica Salvar/Cancelar). So execute sob o ritual BEFORE/AFTER.");
Console.WriteLine("Use --diagnostic-configure-save-dialog-click-save-once para o probe supervisionado que TAMBEM clica Salvar (BM_CLICK) exatamente 1 vez apos Configure+ReadBack. So execute sob o ritual BEFORE/AFTER, com autorizacao humana explicita para o primeiro ClickSave real.");
Console.WriteLine("Use --diagnostic-validate-export-readonly <caminho.xls> para validar (SOMENTE LEITURA, zero NEX/UI/publicacao) um arquivo ja existente dentro de OUTPUT\\HOMOLOGACAO-F6.14B2.9\\ via NodeExportValidator real.");
Console.WriteLine("Use --diagnostic-publish-isolated <caminho.xls dentro de OUTPUT\\HOMOLOGACAO-PUBLICACAO\\STAGE> para validar+publicar (Validator+Publisher REAIS, zero NEX/UI/HTTP) num destino ISOLADO (OUTPUT\\HOMOLOGACAO-PUBLICACAO\\PUBLICADO), NUNCA EXPORTADOS.");
Console.WriteLine("Use --diagnostic-mutex-hold <nomeDoMutex> <holdMs> para o helper de teste de concorrencia real entre processos do Win32ExecutionLock - zero NEX/UI/publicacao, so um Mutex nomeado.");
Console.WriteLine("Use --diagnostic-confirmed-save-committer-once para o probe supervisionado que homologa o WindowsConfirmedSaveDialogCommitter real (PODE enviar Shift+F5 real e clicar Salvar via Committer exatamente 1 vez) - para em EXPORT_STAGE, NUNCA avanca para Validator/Publisher/EXPORTADOS. So execute sob o ritual BEFORE/AFTER.");
Console.WriteLine("Use --run-once-operational para o ENTRYPOINT OPERACIONAL REAL (gates -> Shift+F5 -> SaveDialog -> CommitOnce -> Watcher -> Validate -> Publish -> EXPORTADOS), UMA execucao completa. AINDA NAO AUTORIZADO PARA GO-LIVE - requer ritual BEFORE/autorizacao explicita antes do primeiro uso real.");
Console.WriteLine("Use --diagnostic-individual-statement-once <codigoCliente> <nomeEsperado> (ambos obrigatorios) para o probe supervisionado one-shot da V1 (extrato individual por cliente): gates -> busca+F2 -> Transacoes -> '...' -> Exportar -> SaveDialog -> CommitOnce -> Watcher -> Validate -> Publish -> EXPORTADOS. PODE enviar F2 real, abrir a aba Transacoes, abrir o menu de overflow, acionar Exportar via MSAA, e escrever/clicar no dialogo Salvar Como. AINDA NAO AUTORIZADO PARA EXECUCAO REAL - requer ritual BEFORE/autorizacao explicita antes do primeiro uso.");
