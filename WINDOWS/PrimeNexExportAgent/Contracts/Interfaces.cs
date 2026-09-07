using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Logging;

namespace PrimeNexExportAgent.Contracts;

// =====================================================================
// As 11 interfaces aprovadas em F6.12/F6.12.1. Nesta fase (F6.13) SOMENTE
// os contratos existem - nenhuma implementacao Win32/UI Automation real.
//
// Separacao obrigatoria (F6.12 secao 2 / F6.12.1): interfaces de
// INSPECAO (somente leitura, sempre seguras de chamar em qualquer teste)
// versus interfaces de ACAO (unicas com poder de efeito real na UI do
// NEX). So IInputSender e ISaveDialogController sao de ACAO.
// =====================================================================

/// <summary>Relogio injetavel - mesma disciplina ja usada no restante do
/// projeto (ex.: `nowImpl` em SERVICO/processador-outbox-nex.js).</summary>
public interface IClock
{
    DateTime Now { get; }
}

/// <summary>Espera injetavel (F6.14B2.4) - abstrai Thread.Sleep para que
/// testes de componentes com espera bounded (ex.: PollingSaveDialogWaiter)
/// nunca precisem dormir de verdade. UNICO proposito: aguardar um
/// intervalo de tempo, somente leitura em relacao ao NEX - nunca envia
/// nenhuma acao.</summary>
public interface IDelay
{
    void Wait(TimeSpan duration);
}

/// <summary>Lock exclusivo de execucao (G7) - Named Mutex do Windows na
/// implementacao real (F6.14). Nesta fase, so o contrato.</summary>
public interface IExecutionLock
{
    /// <summary>Tenta adquirir o lock. Retorna false imediatamente se ja
    /// estiver ocupado - nunca espera.</summary>
    bool TryAcquire();

    /// <summary>Libera o lock. Deve ser chamado sempre, mesmo em caminho
    /// de excecao (bloco finally do orquestrador).</summary>
    void Release();
}

// ---------------------- INSPECAO (somente leitura) ---------------------

/// <summary>G2 (parte de sessao) - SOMENTE a sessao Windows do proprio
/// Agent (WTSActive). Nunca localiza, identifica ou conhece o NexAdmin -
/// isso e responsabilidade exclusiva de INexWindowInspector (F6.13.2
/// correcao da mistura de responsabilidade identificada em F6.13.1).</summary>
public interface ISessionInspector
{
    SessionCheckResult CheckSession();
}

/// <summary>G1 (identidade/processo/janela do NexAdmin, incluindo a
/// comparacao de sessao com o valor ja validado por ISessionInspector) +
/// G3 (janela unica top-level) + G4 (aba Vendas) + G5 (aba Historico
/// visivel) + G6 (nenhum modal financeiro).</summary>
public interface INexWindowInspector
{
    /// <summary>Localiza o processo NexAdmin, confirma ClassName TfrmPri
    /// e confirma que seu SessionId bate com `expectedSessionId` (o
    /// SessionId do proprio Agent, ja validado por ISessionInspector).
    /// So retorna Passed=true com a NexAdminWindowIdentity (PID+HWND,
    /// F6.13.4) quando tudo isso for verdadeiro - essa mesma identidade
    /// deve fluir, sem ser recalculada, ate CheckSafeState() e ate
    /// IInputSender.SendExportShortcut().</summary>
    NexAdminLocateResult LocateNexAdmin(int expectedSessionId);

    /// <summary>Recebe a MESMA identidade ja retornada por LocateNexAdmin -
    /// nunca localiza "algum NexAdmin" de novo por conta propria (F6.13.4).</summary>
    NexWindowCheckResult CheckSafeState(NexAdminWindowIdentity target);
}

/// <summary>G8+G9 (identidade do dialogo "Salvar como" e presenca dos 5
/// controles esperados) e G10-G12 (releitura pos-configuracao).</summary>
public interface ISaveDialogInspector
{
    /// <summary>Recebe a MESMA NexAdminWindowIdentity ja validada (F6.14B2) -
    /// usada para confirmar que o dialogo encontrado pertence ao NexAdmin
    /// esperado (owner/processo coerente), nunca aceito por coincidencia.</summary>
    SaveDialogIdentityResult IdentifySaveDialog(NexAdminWindowIdentity target);

    /// <summary>Recebe a MESMA SaveDialogIdentity ja retornada por
    /// IdentifySaveDialog - nunca redescobre o dialogo por conta propria.</summary>
    SaveDialogReadbackResult ReadBack(SaveDialogIdentity dialog, string expectedDestination, string expectedFileName, string expectedFileType);
}

/// <summary>
/// F6.14B2.4 - resolve a race de tempo assincrona entre SendExportShortcut
/// (Shift+F5) e o Windows efetivamente criar/exibir a janela "Salvar como"
/// (evidencia real: o probe checou 0 candidatos no instante seguinte ao
/// Shift+F5, mas o dialogo comprovadamente existia poucos instantes
/// depois). Faz POLLING READ-ONLY, bounded por timeout, de
/// ISaveDialogInspector.IdentifySaveDialog - NUNCA envia nenhuma acao
/// (SendInput/SendExportShortcut) internamente, e NUNCA re-tenta a acao ja
/// executada. "Poll" aqui significa "reconsultar um estado que pode mudar
/// de forma assincrona", nao deve ser confundido com "retry de acao" -
/// SendExportShortcut/SendInput continuam limitados a exatamente 1 chamada
/// por execucao do Agent, em outro componente inteiramente (IInputSender).
/// </summary>
public interface ISaveDialogWaiter
{
    /// <summary>Consulta IdentifySaveDialog repetidamente (mesma target,
    /// nunca redescoberta) ate: (a) encontrar exatamente 1 dialogo valido
    /// -> retorna Pass imediatamente; (b) detectar ambiguidade (mais de 1
    /// candidato) -> retorna Fail imediatamente, nunca espera "resolver
    /// sozinha"; (c) esgotar o timeout bounded -> retorna o ultimo Fail
    /// (fail-closed, nunca espera indefinidamente).</summary>
    SaveDialogIdentityResult WaitForSaveDialog(NexAdminWindowIdentity target);
}

/// <summary>Observa tamanho/mtime de um arquivo ao longo do tempo, sem
/// tocar seu conteudo (F6.12 secao 11).</summary>
public interface IFileStabilityChecker
{
    FileStabilityResult WaitForStable(string filePath, TimeSpan timeout);
}

/// <summary>
/// F6.14B2.9A - vigia um DIRETORIO inteiro (nao um caminho ja conhecido
/// como IFileStabilityChecker) em torno de uma unica acao real de save,
/// para: (a) exigir o diretorio vazio ANTES da acao (fail-closed se nao
/// estiver); (b) depois da acao, fazer polling somente-leitura ate o
/// ÚNICO arquivo esperado (nome exato) aparecer e estabilizar - qualquer
/// arquivo com nome inesperado, ou mais de um arquivo, e fail-closed
/// imediato, nunca "escolhe o mais provavel". NUNCA repete a acao que
/// causou a escrita (isso e responsabilidade exclusiva do chamador, que
/// so pode ter enviado essa acao exatamente 1 vez) - este componente e
/// puramente de observacao.
/// </summary>
public interface IExportStageWatcher
{
    /// <summary>Confirma que `directoryPath` esta completamente vazio -
    /// chamado ANTES de qualquer acao real. Nunca apaga nada
    /// automaticamente para "tornar vazio".</summary>
    ExportStageWatchResult ConfirmEmptyBeforeAction(string directoryPath);

    /// <summary>Polling somente-leitura, bounded por timeout, ate o
    /// arquivo `expectedFileName` (nome exato, sem variacao) aparecer em
    /// `directoryPath` e estabilizar (mesmo tamanho e mesma
    /// LastWriteTimeUtc em observacoes consecutivas, tamanho sempre
    /// maior que zero). Fail-closed para: 0 arquivos ate o timeout;
    /// qualquer arquivo com nome diferente do esperado; mais de 1
    /// arquivo presente (mesmo que um deles seja o esperado). Nunca
    /// reinicia nenhuma acao - so observa.</summary>
    ExportStageWatchResult WaitForExpectedFileOnly(string directoryPath, string expectedFileName, TimeSpan timeout);
}

/// <summary>Fronteira para o Reader real (SERVICO/leitor-export-vendas.js,
/// via SCRIPTS/validar-export-vendas.js - F6.12 secao 12, implementado em
/// F6.14B2.10A). Nunca reimplementa a regra de negocio em C#.</summary>
public interface IExportValidator
{
    ExportValidationResult Validate(string filePath);
}

/// <summary>
/// F6.14B2.10A - abstracao MINIMA de execucao de subprocesso, so o
/// necessario para NodeExportValidator chamar o CLI Node de forma
/// testavel (fake deterministico nos testes, Process.Start real em
/// producao). Deliberadamente NAO e' um framework generico de processos -
/// so retorna o que o chamador precisa para decidir fail-closed
/// (iniciou? timeout? exit code? stdout/stderr?).
/// </summary>
public interface IProcessRunner
{
    ProcessRunResult Run(string fileName, IReadOnlyList<string> arguments, TimeSpan timeout);
}

/// <summary>Move atomico staging -> EXPORTADOS (F6.12 secao 14,
/// implementado em F6.14B2.11A). Assinatura preservada sem alteracao.</summary>
public interface IAtomicPublisher
{
    PublishResult Publish(string sourcePath, string destinationDirectory);
}

/// <summary>
/// F6.14B2.11A - abstracao MINIMA para tornar FileMoveAtomicPublisher
/// testavel sem tocar o filesystem real do runner de testes de forma
/// nao-simulavel (ex.: forcar uma falha de Move). Producao: File.Move.
/// Testes: fake deterministico.
/// </summary>
public interface IFileMover
{
    void Move(string sourcePath, string destinationPath);
}

/// <summary>Log estruturado (F6.12 secao 17) - nunca payload de negocio.</summary>
public interface IAgentLogger
{
    void Log(AgentLogEvent evt);
}

// ------------------------------ ACAO ------------------------------

/// <summary>UNICA responsabilidade: enviar o atalho Shift+F5 para a janela
/// NexAdmin ja validada (G1-G7 -> EXPORT_TRIGGERED). Nunca mais de uma
/// chamada por execucao - a maquina de estados nao tem nenhuma aresta de
/// retorno a este estagio. Permanece minimalista de proposito - nao existe
/// SendKey/SendKeys/SendShortcut/ActivateWindow/Click genericos, so "enviar
/// o atalho oficial de Exportar para esta janela NexAdmin previamente
/// validada" (F6.13.4).
///
/// <para>
/// CONTRATO PARA A IMPLEMENTACAO REAL (F6.14, NAO implementada aqui) -
/// SendInput vai para a janela em foreground, entao "NEX esta na tela
/// correta" NAO implica "NEX vai receber o teclado" (evidencia real: F6.9,
/// NexAdmin estava em Vendas/Historico mas o Chrome estava em foreground).
/// A implementacao real DEVE, nesta ordem, imediatamente antes de enviar a
/// tecla (o "PRE-INPUT TARGET GATE"):
/// </para>
/// <list type="number">
/// <item>T1. Confirmar que <c>target.MainWindowHandle</c> ainda existe (ex.: IsWindow).</item>
/// <item>T2. Confirmar que esse HWND ainda pertence a <c>target.ProcessId</c>.</item>
/// <item>T3. Trazer SOMENTE esse HWND ao foreground (SetForegroundWindow) -
///   se falhar, ABORTAR, zero tecla enviada.</item>
/// <item>T4. Confirmar via GetForegroundWindow() que o foreground agora e
///   EXATAMENTE esse HWND - se nao for, ABORTAR, zero tecla enviada.</item>
/// </list>
/// <para>
/// Somente com T1-T4 = PASS: enviar Shift+F5 exatamente 1 vez. Nunca
/// enviar a tecla "esperando que o foco esteja certo" - o gate e
/// verificado nesse exato instante, nunca confiado a partir de uma
/// observacao de segundos atras (ex.: o resultado de CheckSafeState, que
/// e anterior no tempo e pode ja estar desatualizado).
/// </para></summary>
public interface IInputSender
{
    void SendExportShortcut(NexAdminWindowIdentity target);
}

/// <summary>F6.14B2.5 - fronteira somente-leitura para consultar qual HWND
/// esta atualmente em foreground. Deliberadamente MINIMA - nunca inclui
/// SetForegroundWindow (isso pertence exclusivamente a IInputNativeApi,
/// chamado no maximo 1 vez por execucao) nem qualquer outro metodo de
/// acao.</summary>
public interface IForegroundReader
{
    nint GetForegroundWindow();
}

/// <summary>
/// F6.14B2.5 - corrige a race de tempo assincrona entre SetForegroundWindow
/// retornar sucesso e o foreground do Windows efetivamente refletir essa
/// troca (evidencia real: SetForegroundWindow foi chamado 1x, mas a
/// confirmacao imediata seguinte via GetForegroundWindow ainda mostrava
/// outra janela). Faz POLLING READ-ONLY, bounded por timeout, de
/// GetForegroundWindow - NUNCA chama SetForegroundWindow (isso permanece
/// limitado a exatamente 1 chamada, em IInputNativeApi/WindowsInputSender)
/// e NUNCA chama SendInput. "Poll" aqui e observacao bounded do resultado
/// de uma acao ja executada - nunca retry dessa acao.
/// </summary>
public interface IForegroundWaiter
{
    /// <summary>Aguarda GetForegroundWindow() == targetHwnd, bounded por
    /// timeout. Retorna true assim que confirmado, false se o timeout for
    /// atingido antes - nunca lanca excecao, nunca chama nenhuma acao.</summary>
    bool WaitForForeground(nint targetHwnd);
}

/// <summary>
/// F6.14B2.12C1 - COMMITTER OPERACIONAL ESTREITO: unica interface (alem de
/// ISaveDialogControlApi.ClickButton, ja existente e restrita ao probe
/// diagnostico) capaz de disparar BM_CLICK no botao Salvar em um fluxo
/// que pode chegar a ser usado pelo Orchestrator real. Existe
/// exclusivamente para nao precisar desbloquear
/// ISaveDialogController.ClickSave() genericamente - CommitOnce() sempre
/// reidentifica o dialogo do zero (nunca reaproveita uma identificacao
/// antiga) e exige o MESMO HWND que `expectedDialog`, antes de resolver e
/// clicar CtrlId 1 exatamente 1 vez. Dispatched=true significa SOMENTE
/// "BM_CLICK foi despachado" - NUNCA "arquivo salvo/dialogo fechado/XLS
/// valido/publicacao concluida". A prova real de sucesso do Save continua
/// vindo exclusivamente de IFileStabilityChecker/IExportStageWatcher,
/// depois, nunca do retorno desta chamada.
/// </summary>
public interface IConfirmedSaveDialogCommitter
{
    SaveDialogCommitResult CommitOnce(NexAdminWindowIdentity target, SaveDialogIdentity expectedDialog);
}

/// <summary>Escreve os campos do dialogo "Salvar como" (destino/nome/tipo)
/// e, so depois do read-back (G10-G12) confirmar, clica Salvar. Tambem
/// permite Cancelar, mas somente com a identidade do dialogo reconfirmada
/// (F6.12 secao 16).</summary>
public interface ISaveDialogController
{
    /// <summary>Recebe a MESMA SaveDialogIdentity ja retornada por
    /// ISaveDialogInspector.IdentifySaveDialog (F6.14B2) - nunca escreve
    /// num dialogo redescoberto por conta propria.</summary>
    void Configure(SaveDialogIdentity dialog, string destination, string fileName, string fileType);

    /// <summary>Unica chamada por execucao, somente apos G10-G12 = PASS.
    /// F6.14B2: NAO homologado ainda - a implementacao real desta fase
    /// (WindowsSaveDialogController) lanca NotSupportedException sempre,
    /// nunca clica de fato.</summary>
    void ClickSave(SaveDialogIdentity dialog);

    /// <summary>Cleanup permitido somente com identidade do dialogo ja
    /// reconfirmada pelo chamador antes de invocar isto. F6.14B2: NAO
    /// homologado ainda - a implementacao real desta fase lanca
    /// NotSupportedException sempre.</summary>
    void CancelSaveDialog(SaveDialogIdentity dialog);
}
