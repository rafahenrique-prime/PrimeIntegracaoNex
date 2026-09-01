using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (F6.14A, corrigida em F6.14A.1) de INexWindowInspector
/// - somente leitura. Cobre G1 (identidade do NexAdmin + comparacao de
/// sessao) e G3-G6 (topologia segura). Nunca envia tecla/clique/foco a
/// nenhuma janela - so consulta processos/Win32/UI Automation.
///
/// F6.14A.1 - CORRECAO POR EVIDENCIA REAL: a inspecao ao vivo contra o NEX
/// real (F6.14A) provou que Process.MainWindowHandle do NexAdmin.exe
/// retorna a janela OCULTA "TApplication" (BoundingRectangle vazio, nao e
/// a janela de negocio), nao a janela real "TfrmPri" (visivel, mas com
/// Owner != 0 - filha, em termos de GW_OWNER, da TApplication). Por isso:
/// - LocateNexAdmin NUNCA usa mais MainWindowHandle - a janela TfrmPri e
///   localizada explicitamente por enumeracao (EnumWindows) + ClassName;
/// - G3 NUNCA mais filtra por "Owner == 0" (isso excluiria a propria
///   TfrmPri) - a regra agora e "exatamente 1 janela top-level VISIVEL
///   pertencente ao PID, e essa e a propria target".
/// </summary>
public sealed class WindowsNexWindowInspector : INexWindowInspector
{
    /// <summary>Nome exato do elemento de UI Automation da aba Historico,
    /// confirmado ao vivo em F6.5-F6.6 (com acento - deve bater
    /// EXATAMENTE com o texto real da tela, nao e um comentario/label
    /// interno).</summary>
    private const string HistoricoTabName = "Hist\u00f3rico";

    private const string VendasTabName = "Vendas";
    private const string ExpectedClassName = "TfrmPri";
    private const string ExpectedProcessName = "NexAdmin";
    private const string ExpectedExecutablePath = @"C:\Nex\NexAdmin.exe";

    /// <summary>Assinaturas estritas de infraestrutura conhecida (F6.14A.2)
    /// - qualquer janela que nao bata EXATAMENTE com uma destas cai em
    /// BLOCKING_UNKNOWN (fail-closed). Nunca adicionar uma terceira
    /// assinatura sem evidencia real equivalente a F6.14A/F6.14A.1.</summary>
    private const string TApplicationClassName = "TApplication";

    private const string IntercomClassName = "TfrmIntercom";
    private const string IntercomExpectedName = "Atendimento";

    private enum WindowClassification { Target, InfraTApplication, InfraIntercom, BlockingUnknown }

    private readonly INexProcessScanner _processScanner;
    private readonly INativeWindowApi _nativeWindows;
    private readonly INexUiAutomationReader _uiAutomation;

    public WindowsNexWindowInspector(INexProcessScanner processScanner, INativeWindowApi nativeWindows, INexUiAutomationReader uiAutomation)
    {
        _processScanner = processScanner;
        _nativeWindows = nativeWindows;
        _uiAutomation = uiAutomation;
    }

    public NexAdminLocateResult LocateNexAdmin(int expectedSessionId)
    {
        IReadOnlyList<NexProcessCandidate> candidates;
        try
        {
            candidates = _processScanner.FindProcessesByName(ExpectedProcessName);
        }
        catch (Exception ex)
        {
            return NexAdminLocateResult.Fail(AgentErrorCode.NexNotFound, $"erro ao enumerar processos: {ex.Message}");
        }

        var pathValidCandidates = candidates.Where(c =>
            string.Equals(c.ExecutablePath, ExpectedExecutablePath, StringComparison.OrdinalIgnoreCase));

        // F6.14A.1: a janela alvo (TfrmPri) e localizada por enumeracao
        // explicita das janelas top-level VISIVEIS de cada PID candidato -
        // NUNCA por Process.MainWindowHandle (evidencia real: aponta para
        // a TApplication oculta, nao para a janela de negocio).
        var tfrmPriMatches = new List<(int ProcessId, nint Hwnd, int SessionId)>();

        foreach (var candidate in pathValidCandidates)
        {
            IReadOnlyList<nint> topLevelWindows;
            try
            {
                topLevelWindows = _nativeWindows.GetVisibleTopLevelWindowsForProcess(candidate.ProcessId);
            }
            catch (Exception ex)
            {
                return NexAdminLocateResult.Fail(AgentErrorCode.NexNotFound, $"erro ao enumerar janelas do PID {candidate.ProcessId}: {ex.Message}");
            }

            foreach (var hwnd in topLevelWindows)
            {
                var className = _nativeWindows.GetClassName(hwnd);
                if (string.Equals(className, ExpectedClassName, StringComparison.Ordinal))
                {
                    tfrmPriMatches.Add((candidate.ProcessId, hwnd, candidate.SessionId));
                }
            }
        }

        if (tfrmPriMatches.Count == 0)
        {
            return NexAdminLocateResult.Fail(AgentErrorCode.NexNotFound, "nenhuma janela TfrmPri visivel encontrada em nenhum processo NexAdmin.exe valido");
        }

        if (tfrmPriMatches.Count > 1)
        {
            // Ambiguidade (mesmo PID com 2 TfrmPri, ou 2 PIDs diferentes
            // cada um com sua propria TfrmPri) - nunca escolher "a
            // primeira"/"a mais recente" (F6.14A.1 secao 2/7 teste D).
            return NexAdminLocateResult.Fail(AgentErrorCode.NexNotFound, $"mais de uma janela TfrmPri visivel encontrada ({tfrmPriMatches.Count}) - ambiguidade, abortando");
        }

        var onlyMatch = tfrmPriMatches[0];
        if (onlyMatch.SessionId != expectedSessionId)
        {
            return NexAdminLocateResult.Fail(AgentErrorCode.SessionUnavailable, $"NexAdmin encontrado na sessao {onlyMatch.SessionId}, Agent esta na sessao {expectedSessionId}");
        }

        return NexAdminLocateResult.Pass(new NexAdminWindowIdentity(onlyMatch.ProcessId, onlyMatch.Hwnd));
    }

    public NexWindowCheckResult CheckSafeState(NexAdminWindowIdentity target)
    {
        // Revalidacao imediata (F6.14A secao 7) - nunca confia no resultado
        // de LocateNexAdmin como permanente; o HWND pode ter sido fechado
        // ou mudado de estado entre uma chamada e outra.
        if (!_nativeWindows.IsWindowValid(target.MainWindowHandle))
        {
            return NexWindowCheckResult.Fail(AgentErrorCode.NexNotFound, "HWND da janela alvo nao e mais valido (revalidacao)");
        }

        if (!_nativeWindows.IsWindowCurrentlyVisible(target.MainWindowHandle))
        {
            return NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, "HWND da janela alvo nao esta mais visivel (revalidacao)");
        }

        var owningPid = _nativeWindows.GetOwningProcessId(target.MainWindowHandle);
        if (owningPid != target.ProcessId)
        {
            return NexWindowCheckResult.Fail(AgentErrorCode.NexNotFound, "HWND ja nao pertence ao PID esperado (revalidacao)");
        }

        var className = _nativeWindows.GetClassName(target.MainWindowHandle);
        if (!string.Equals(className, ExpectedClassName, StringComparison.Ordinal))
        {
            return NexWindowCheckResult.Fail(AgentErrorCode.NexNotFound, $"ClassName da janela alvo mudou (revalidacao): '{className}'");
        }

        // ---- G3 (+ G6, combinados por design - F6.12.1/F6.13.1), corrigido
        // em F6.14A.2: evidencia real (F6.14A.1) provou que "exatamente 1
        // top-level visivel" e estruturalmente incorreto - TApplication
        // (area 0x0) e o widget "Atendimento" (TfrmIntercom) sao SEMPRE
        // visiveis e legitimos. Em vez de contar, cada janela top-level
        // visivel e CLASSIFICADA contra assinaturas estritas e fechadas;
        // qualquer janela que nao bata EXATAMENTE com uma assinatura
        // conhecida (incluindo duplicatas de uma assinatura conhecida) e
        // BLOCKING_UNKNOWN e causa UnsafeState. Infraestrutura conhecida
        // NAO precisa estar presente para o gate passar (F6.14A.2 secao
        // 10 teste L) - so e validada estritamente QUANDO existir. ----
        IReadOnlyList<nint> visibleTopLevelWindows;
        try
        {
            visibleTopLevelWindows = _nativeWindows.GetVisibleTopLevelWindowsForProcess(target.ProcessId);
        }
        catch (Exception ex)
        {
            return NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, $"erro ao enumerar janelas top-level: {ex.Message}");
        }

        var tApplicationCount = 0;
        var intercomCount = 0;

        foreach (var hwnd in visibleTopLevelWindows)
        {
            WindowClassification classification;
            try
            {
                classification = ClassifyWindow(hwnd, target);
            }
            catch (Exception ex)
            {
                return NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, $"erro ao classificar janela 0x{hwnd:X}: {ex.Message}");
            }

            switch (classification)
            {
                case WindowClassification.Target:
                    break;
                case WindowClassification.InfraTApplication:
                    tApplicationCount++;
                    break;
                case WindowClassification.InfraIntercom:
                    intercomCount++;
                    break;
                case WindowClassification.BlockingUnknown:
                default:
                    return NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, $"janela top-level visivel nao reconhecida (0x{hwnd:X}) - fail-closed");
            }
        }

        // Cardinalidade conservadora (F6.14A.2 secao 5): no maximo 1 de
        // cada infraestrutura reconhecida - duplicidade inesperada nunca e
        // resolvida arbitrariamente, e tratada como estado inseguro.
        if (tApplicationCount > 1)
        {
            return NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, $"mais de 1 TApplication reconhecida ({tApplicationCount}) - ambiguidade");
        }
        if (intercomCount > 1)
        {
            return NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, $"mais de 1 TfrmIntercom/Atendimento reconhecido ({intercomCount}) - ambiguidade");
        }

        // ---- G4: aba "Vendas" presente (leitura, nunca Invoke/Select) ----
        bool vendasPresente;
        try
        {
            vendasPresente = _uiAutomation.HasElementNamed(target.MainWindowHandle, VendasTabName);
        }
        catch (Exception ex)
        {
            return NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, $"erro ao consultar UI Automation (Vendas): {ex.Message}");
        }

        if (!vendasPresente)
        {
            return NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, "aba 'Vendas' nao encontrada na arvore de UI Automation");
        }

        // ---- G5: aba "Historico" presente E visivel (IsOffscreen=False) ----
        bool historicoVisivel;
        try
        {
            historicoVisivel = _uiAutomation.HasVisibleElementNamed(target.MainWindowHandle, HistoricoTabName);
        }
        catch (Exception ex)
        {
            return NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, $"erro ao consultar UI Automation (Historico): {ex.Message}");
        }

        if (!historicoVisivel)
        {
            return NexWindowCheckResult.Fail(AgentErrorCode.UnsafeState, "aba 'Historico' ausente ou offscreen");
        }

        return NexWindowCheckResult.Pass();
    }

    /// <summary>Classificacao fechada e conservadora de uma janela
    /// top-level visivel do PID validado (F6.14A.2). Qualquer janela que
    /// nao bata EXATAMENTE com a assinatura de TARGET/TApplication/
    /// Intercom cai em BlockingUnknown - nunca uma heuristica otimista
    /// (tamanho pequeno, nome parecido, Owner conhecido sozinho, etc.).</summary>
    private WindowClassification ClassifyWindow(nint hwnd, NexAdminWindowIdentity target)
    {
        if (hwnd == target.MainWindowHandle)
        {
            return WindowClassification.Target;
        }

        var owner = _nativeWindows.GetOwner(hwnd);
        var className = _nativeWindows.GetClassName(hwnd);

        // ---- Assinatura estrita: TApplication oculta do Delphi/VCL ----
        if (string.Equals(className, TApplicationClassName, StringComparison.Ordinal) && owner == 0)
        {
            if (!_nativeWindows.TryGetWindowRect(hwnd, out var width, out var height))
            {
                // GetWindowRect falhou - NUNCA ignorar a janela por omissao
                // (F6.14A.2 secao 3: "Se GetWindowRect falhar: NAO ignorar
                // a janela. BLOCKING_UNKNOWN / FAIL CLOSED").
                return WindowClassification.BlockingUnknown;
            }

            if (width <= 0 || height <= 0)
            {
                return WindowClassification.InfraTApplication;
            }

            // TApplication com area realmente utilizavel - NUNCA ignorar
            // so pelo nome da classe (F6.14A.2 secao 3).
            return WindowClassification.BlockingUnknown;
        }

        // ---- Assinatura estrita: widget "Atendimento" (TfrmIntercom) ----
        if (string.Equals(className, IntercomClassName, StringComparison.Ordinal) && owner == target.MainWindowHandle)
        {
            var name = _uiAutomation.GetOwnName(hwnd);
            if (string.Equals(name, IntercomExpectedName, StringComparison.Ordinal))
            {
                return WindowClassification.InfraIntercom;
            }

            // Name nao pode ser lido ou diverge do esperado - fail-closed
            // (F6.14A.2 secao 4: nunca ignorar so pelo ClassName+Owner).
            return WindowClassification.BlockingUnknown;
        }

        return WindowClassification.BlockingUnknown;
    }
}
