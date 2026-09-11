namespace PrimeNexExportAgent.Contracts;

/// <summary>
/// Hybrid V3 - classificacao do estado runtime do NexAdmin ANTES do
/// ExportAgentOrchestrator ser construido/executado. Necessario porque
/// INexWindowInspector.LocateNexAdmin ja colapsa Minimized e Closed no
/// mesmo AgentErrorCode.NexNotFound (TfrmPri fica Visible=False nos dois
/// casos) - este probe e' o UNICO lugar que distingue os dois, sem alterar
/// LocateNexAdmin/CheckSafeState (que continuam servindo V1/V2 standalone
/// sem nenhuma mudanca).
/// </summary>
public enum NexRuntimeState
{
    /// <summary>NexAdmin aberto, TApplication nao minimizada, TfrmPri
    /// identificado de forma inequivoca (visivel). O orchestrator normal
    /// (com HybridInputSender) deve ser construido e executado.</summary>
    Open,

    /// <summary>Exatamente 1 TApplication valida (Owner==0) com
    /// IsWindowMinimized==true. Zero V1, zero V2, zero input - so' os 2
    /// beeps curtos de aviso.</summary>
    Minimized,

    /// <summary>Zero processos NexAdmin.exe validos encontrados, com
    /// leitura de processo e de ExecutablePath bem-sucedidas para TODOS os
    /// candidatos brutos (nenhuma ambiguidade de observabilidade). Zero
    /// input, silencioso.</summary>
    Closed,

    /// <summary>Qualquer coisa que nao seja inequivocamente Open/Minimized/
    /// Closed: erro ao consultar processos/ExecutablePath/janelas, TApplication
    /// ausente/ambigua, TfrmPri ambiguo/nao identificavel, >1 instancia
    /// principal valida. Fail-closed: zero V1, zero V2, zero input, zero
    /// beep - nunca uma tentativa otimista de continuar.</summary>
    BlockingUnknown,
}

/// <summary>Resultado da classificacao - `Reason` sempre preenchido
/// (inclusive para Open/Minimized/Closed, nao so' para BlockingUnknown),
/// para que o motivo apareca no log/relatorio em qualquer caso.</summary>
public sealed record NexRuntimeStateResult(NexRuntimeState State, string Reason);

/// <summary>Fronteira mockavel do probe de estado runtime (Hybrid V3).
/// Somente leitura - nenhuma implementacao pode enviar input/foco/clique.</summary>
public interface INexRuntimeStateProbe
{
    NexRuntimeStateResult Classify();
}
