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
    SaveDialogIdentityResult IdentifySaveDialog();

    SaveDialogReadbackResult ReadBack(string expectedDestination, string expectedFileName, string expectedFileType);
}

/// <summary>Observa tamanho/mtime de um arquivo ao longo do tempo, sem
/// tocar seu conteudo (F6.12 secao 11).</summary>
public interface IFileStabilityChecker
{
    FileStabilityResult WaitForStable(string filePath, TimeSpan timeout);
}

/// <summary>Fronteira para o Reader real (SERVICO/leitor-export-vendas.js,
/// via SCRIPTS/validar-export-vendas.js - F6.12 secao 12). Nunca
/// reimplementa a regra de negocio em C#.</summary>
public interface IExportValidator
{
    ExportValidationResult Validate(string filePath);
}

/// <summary>Move atomico staging -> EXPORTADOS (F6.12 secao 14).</summary>
public interface IAtomicPublisher
{
    PublishResult Publish(string sourcePath, string destinationDirectory);
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

/// <summary>Escreve os campos do dialogo "Salvar como" (destino/nome/tipo)
/// e, so depois do read-back (G10-G12) confirmar, clica Salvar. Tambem
/// permite Cancelar, mas somente com a identidade do dialogo reconfirmada
/// (F6.12 secao 16).</summary>
public interface ISaveDialogController
{
    void Configure(string destination, string fileName, string fileType);

    /// <summary>Unica chamada por execucao, somente apos G10-G12 = PASS.</summary>
    void ClickSave();

    /// <summary>Cleanup permitido somente com identidade do dialogo ja
    /// reconfirmada pelo chamador antes de invocar isto.</summary>
    void CancelSaveDialog();
}
