// PRIME NEX EXPORT AGENT - skeleton (F6.13) + wrappers read-only (F6.14A).
//
// F6.14A implementou ISessionInspector/INexWindowInspector reais (somente
// leitura). IInputSender/ISaveDialogController REAIS ainda NAO existem -
// so os fakes de teste. Program.cs deliberadamente NAO monta nenhum
// ExportAgentOrchestrator real aqui - isso evitaria que simplesmente rodar
// este executavel pudesse, por acidente, alcancar um envio de tecla no
// futuro (quando IInputSender real existir). Enquanto isso nao for
// explicitamente autorizado (F6.14B+), este executavel permanece um
// placeholder que nao interage com o NEX de forma alguma.
//
// Inspecao real read-only (F6.14A) fica atras de um argumento EXPLICITO
// (--inspect-readonly) - sem argumento nenhum, o executavel so imprime a
// mensagem de status abaixo e encerra. O harness invocado
// (Diagnostics/ReadOnlyInspection.cs) nao referencia IInputSender/
// ISaveDialogController em nenhum momento - essas interfaces de ACAO nem
// tem implementacao real ainda, entao nao existe caminho de codigo
// (acidental ou nao) daqui ate um Shift+F5.

if (args.Length == 1 && args[0] == "--inspect-readonly")
{
    PrimeNexExportAgent.Diagnostics.ReadOnlyInspection.Run();
    return;
}

Console.WriteLine("PRIME NEX EXPORT AGENT - wrappers read-only F6.14A. IInputSender/ISaveDialogController reais ainda NAO existem (ver F6.14B+). Este executavel nao envia nenhuma tecla/clique. Use --inspect-readonly para uma inspecao somente-leitura.");
