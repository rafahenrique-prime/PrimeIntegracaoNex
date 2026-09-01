using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Tests.Fakes;

/// <summary>Fake de ISessionNativeApi (F6.14A) - permite simular qualquer
/// WtsConnectState ou falha de consulta (null), sem tocar WTS real.</summary>
public sealed class FakeSessionNativeApi : ISessionNativeApi
{
    public int CurrentSessionId { get; set; } = 1;
    public WtsConnectState? ConnectStateToReturn { get; set; } = WtsConnectState.Active;
    public Exception? ThrowOnGetCurrentProcessSessionId { get; set; }
    public Exception? ThrowOnQueryConnectState { get; set; }
    public int? LastSessionIdQueried { get; private set; }

    public int GetCurrentProcessSessionId()
    {
        if (ThrowOnGetCurrentProcessSessionId is not null) throw ThrowOnGetCurrentProcessSessionId;
        return CurrentSessionId;
    }

    public WtsConnectState? QueryConnectState(int sessionId)
    {
        LastSessionIdQueried = sessionId;
        if (ThrowOnQueryConnectState is not null) throw ThrowOnQueryConnectState;
        return ConnectStateToReturn;
    }
}

/// <summary>Fake de INativeWindowApi (F6.14A) - simula janelas por HWND
/// arbitrario (nint), sem nenhuma chamada Win32 real.</summary>
public sealed class FakeNativeWindowApi : INativeWindowApi
{
    public HashSet<nint> ValidWindows { get; } = new();
    public HashSet<nint> VisibleWindows { get; } = new();
    public Dictionary<nint, int> OwningProcessByWindow { get; } = new();
    public Dictionary<nint, string> ClassNameByWindow { get; } = new();

    /// <summary>Owner (GW_OWNER) por HWND - F6.14A.2, usado para
    /// classificar infraestrutura Delphi/Intercom. Ausente = sem dono (0).</summary>
    public Dictionary<nint, nint> OwnerByWindow { get; } = new();

    /// <summary>Rect (width,height) por HWND - F6.14A.2. Ausente = simula
    /// falha de GetWindowRect (fail-closed).</summary>
    public Dictionary<nint, (int Width, int Height)> RectByWindow { get; } = new();

    /// <summary>Janelas top-level VISIVEIS por PID - F6.14A.1: NUNCA
    /// filtradas por Owner aqui (o fake so devolve o que o teste registrou,
    /// o filtro de "sem dono" foi removido da implementacao real por
    /// evidencia de que exclui a propria TfrmPri).</summary>
    public Dictionary<int, IReadOnlyList<nint>> TopLevelWindowsByProcess { get; } = new();
    public Exception? ThrowOnEnumerate { get; set; }

    public bool IsWindowValid(nint hWnd) => ValidWindows.Contains(hWnd);

    public bool IsWindowCurrentlyVisible(nint hWnd) => VisibleWindows.Contains(hWnd);

    public int? GetOwningProcessId(nint hWnd) =>
        OwningProcessByWindow.TryGetValue(hWnd, out var pid) ? pid : null;

    public string? GetClassName(nint hWnd) =>
        ClassNameByWindow.TryGetValue(hWnd, out var name) ? name : null;

    public IReadOnlyList<nint> GetVisibleTopLevelWindowsForProcess(int processId)
    {
        if (ThrowOnEnumerate is not null) throw ThrowOnEnumerate;
        return TopLevelWindowsByProcess.TryGetValue(processId, out var list) ? list : Array.Empty<nint>();
    }

    public nint GetOwner(nint hWnd) => OwnerByWindow.TryGetValue(hWnd, out var owner) ? owner : 0;

    public bool TryGetWindowRect(nint hWnd, out int width, out int height)
    {
        if (RectByWindow.TryGetValue(hWnd, out var rect))
        {
            width = rect.Width;
            height = rect.Height;
            return true;
        }
        width = 0;
        height = 0;
        return false; // simula falha de GetWindowRect
    }
}

/// <summary>Fake de INexProcessScanner (F6.14A) - simula uma lista de
/// candidatos a NexAdmin.exe sem tocar nenhum processo real.</summary>
public sealed class FakeNexProcessScanner : INexProcessScanner
{
    public List<NexProcessCandidate> Candidates { get; } = new();
    public Exception? ThrowOnScan { get; set; }
    public string? LastProcessNameRequested { get; private set; }

    public IReadOnlyList<NexProcessCandidate> FindProcessesByName(string processName)
    {
        LastProcessNameRequested = processName;
        if (ThrowOnScan is not null) throw ThrowOnScan;
        return Candidates;
    }
}

/// <summary>Fake de INexUiAutomationReader (F6.14A) - simula presenca/
/// visibilidade de elementos nomeados, sem tocar UI Automation real.</summary>
public sealed class FakeNexUiAutomationReader : INexUiAutomationReader
{
    public HashSet<string> PresentElementNames { get; } = new();
    public HashSet<string> VisibleElementNames { get; } = new();
    public Dictionary<nint, string> OwnNameByWindow { get; } = new();
    public Exception? ThrowOnQuery { get; set; }

    public bool HasElementNamed(nint hWnd, string name)
    {
        if (ThrowOnQuery is not null) throw ThrowOnQuery;
        return PresentElementNames.Contains(name);
    }

    public bool HasVisibleElementNamed(nint hWnd, string name)
    {
        if (ThrowOnQuery is not null) throw ThrowOnQuery;
        return VisibleElementNames.Contains(name);
    }

    public string? GetOwnName(nint hWnd)
    {
        if (ThrowOnQuery is not null) throw ThrowOnQuery;
        return OwnNameByWindow.TryGetValue(hWnd, out var name) ? name : null;
    }
}
