using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (Hybrid V3) de INexRuntimeStateProbe - somente
/// leitura. Reutiliza EXATAMENTE o mesmo padrao ja homologado de
/// INexProcessScanner.FindProcessesByName("NexAdmin") + filtro por
/// ExecutablePath (WindowsNexWindowInspector.LocateNexAdmin) - nunca uma
/// segunda logica de descoberta de processo, nunca "o primeiro" candidato.
/// </summary>
public sealed class Win32NexRuntimeStateProbe : INexRuntimeStateProbe
{
    private const string ExpectedProcessName = "NexAdmin";
    private const string ExpectedExecutablePath = @"C:\Nex\NexAdmin.exe";

    /// <summary>OrdinalIgnoreCase - mesma correcao do bug de casing ja
    /// homologada em WindowsNexWindowInspector (evidencia real: GetClassNameW
    /// retorna "TFrmPri", nao "TfrmPri").</summary>
    private const string TfrmPriClassName = "TfrmPri";

    private const string TApplicationClassName = "TApplication";

    private readonly INexProcessScanner _processScanner;
    private readonly INativeWindowApi _nativeWindows;

    public Win32NexRuntimeStateProbe(INexProcessScanner processScanner, INativeWindowApi nativeWindows)
    {
        _processScanner = processScanner;
        _nativeWindows = nativeWindows;
    }

    public NexRuntimeStateResult Classify()
    {
        IReadOnlyList<NexProcessCandidate> candidates;
        try
        {
            candidates = _processScanner.FindProcessesByName(ExpectedProcessName);
        }
        catch (Exception ex)
        {
            return new NexRuntimeStateResult(NexRuntimeState.BlockingUnknown, $"erro ao enumerar processos NexAdmin.exe: {ex.Message}");
        }

        List<NexProcessCandidate> pathValidCandidates;
        List<NexProcessCandidate> unreadablePathCandidates;
        try
        {
            pathValidCandidates = candidates
                .Where(c => c.ExecutablePath is not null && string.Equals(c.ExecutablePath, ExpectedExecutablePath, StringComparison.OrdinalIgnoreCase))
                .ToList();
            unreadablePathCandidates = candidates.Where(c => c.ExecutablePath is null).ToList();
        }
        catch (Exception ex)
        {
            return new NexRuntimeStateResult(NexRuntimeState.BlockingUnknown, $"erro ao filtrar ExecutablePath: {ex.Message}");
        }

        if (pathValidCandidates.Count == 0)
        {
            if (unreadablePathCandidates.Count > 0)
            {
                // Erro de OBSERVABILIDADE (ex.: AccessDenied ao ler
                // ExecutablePath) - NUNCA vira Closed, pois nao podemos
                // confirmar que aquele processo nao era o NexAdmin real.
                return new NexRuntimeStateResult(
                    NexRuntimeState.BlockingUnknown,
                    $"nao foi possivel ler ExecutablePath de {unreadablePathCandidates.Count} processo(s) 'NexAdmin' candidato(s) - impossivel confirmar ausencia");
            }

            return new NexRuntimeStateResult(NexRuntimeState.Closed, "zero processos NexAdmin.exe validos encontrados (leitura de processo e ExecutablePath bem-sucedidas)");
        }

        // Para cada candidato com path valido, procura TApplication
        // (Owner==0) e TfrmPri entre TODAS as top-level windows do PID -
        // SEM filtro de visibilidade (GetAllTopLevelWindowsForProcess),
        // porque TfrmPri fica Visible=False quando minimizado.
        var coherentCandidates = new List<(int ProcessId, nint TApplicationHwnd, bool Minimized, nint? TfrmPriHwnd, bool TfrmPriVisible)>();

        foreach (var candidate in pathValidCandidates)
        {
            IReadOnlyList<nint> allTopLevel;
            try
            {
                allTopLevel = _nativeWindows.GetAllTopLevelWindowsForProcess(candidate.ProcessId);
            }
            catch (Exception ex)
            {
                return new NexRuntimeStateResult(NexRuntimeState.BlockingUnknown, $"erro ao enumerar janelas do PID {candidate.ProcessId}: {ex.Message}");
            }

            var tApplicationMatches = new List<nint>();
            var tfrmPriMatches = new List<nint>();

            foreach (var hwnd in allTopLevel)
            {
                string? className;
                try
                {
                    className = _nativeWindows.GetClassName(hwnd);
                }
                catch (Exception ex)
                {
                    return new NexRuntimeStateResult(NexRuntimeState.BlockingUnknown, $"erro ao ler ClassName de 0x{hwnd:X}: {ex.Message}");
                }

                if (string.Equals(className, TApplicationClassName, StringComparison.Ordinal))
                {
                    nint owner;
                    try
                    {
                        owner = _nativeWindows.GetOwner(hwnd);
                    }
                    catch (Exception ex)
                    {
                        return new NexRuntimeStateResult(NexRuntimeState.BlockingUnknown, $"erro ao ler Owner de 0x{hwnd:X}: {ex.Message}");
                    }

                    if (owner == 0) tApplicationMatches.Add(hwnd);
                }
                else if (string.Equals(className, TfrmPriClassName, StringComparison.OrdinalIgnoreCase))
                {
                    tfrmPriMatches.Add(hwnd);
                }
            }

            // Estrutura incompleta/ambigua para este candidato (0 ou >1
            // TApplication) - nunca escolhida como coerente.
            if (tApplicationMatches.Count != 1) continue;

            var tAppHwnd = tApplicationMatches[0];
            bool minimized;
            try
            {
                minimized = _nativeWindows.IsWindowMinimized(tAppHwnd);
            }
            catch (Exception ex)
            {
                return new NexRuntimeStateResult(NexRuntimeState.BlockingUnknown, $"erro ao ler IsIconic do PID {candidate.ProcessId}: {ex.Message}");
            }

            nint? tfrmPriHwnd = tfrmPriMatches.Count == 1 ? tfrmPriMatches[0] : null;
            var tfrmPriVisible = false;
            if (tfrmPriHwnd is not null)
            {
                try
                {
                    tfrmPriVisible = _nativeWindows.IsWindowCurrentlyVisible(tfrmPriHwnd.Value);
                }
                catch (Exception ex)
                {
                    return new NexRuntimeStateResult(NexRuntimeState.BlockingUnknown, $"erro ao ler visibilidade de TfrmPri (PID {candidate.ProcessId}): {ex.Message}");
                }
            }

            coherentCandidates.Add((candidate.ProcessId, tAppHwnd, minimized, tfrmPriHwnd, tfrmPriVisible));
        }

        if (coherentCandidates.Count == 0)
        {
            return new NexRuntimeStateResult(
                NexRuntimeState.BlockingUnknown,
                "processo(s) NexAdmin.exe valido(s) existem, mas nenhum possui exatamente 1 TApplication estruturalmente coerente (Owner==0)");
        }

        if (coherentCandidates.Count > 1)
        {
            return new NexRuntimeStateResult(
                NexRuntimeState.BlockingUnknown,
                $"mais de uma instancia principal valida coerente ({coherentCandidates.Count}) - ambiguidade, fail-closed");
        }

        var only = coherentCandidates[0];

        if (only.Minimized)
        {
            return new NexRuntimeStateResult(NexRuntimeState.Minimized, $"TApplication (PID {only.ProcessId}) IsIconic=true");
        }

        if (only.TfrmPriHwnd is not null && only.TfrmPriVisible)
        {
            return new NexRuntimeStateResult(NexRuntimeState.Open, $"TApplication nao minimizada + TfrmPri visivel e inequivoco (PID {only.ProcessId})");
        }

        return new NexRuntimeStateResult(
            NexRuntimeState.BlockingUnknown,
            $"TApplication nao minimizada, mas TfrmPri nao identificado de forma inequivoca/visivel (PID {only.ProcessId})");
    }
}
