using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.Tests.Fakes;

/// <summary>Fakes offline (V1 - extrato individual por cliente) para os
/// componentes de alto nivel do novo fluxo, seguindo o mesmo padrao ja
/// usado no resto do projeto (spies configuraveis, nunca tocam Win32/NEX
/// real).</summary>
public sealed class FakeNexClientNavigator : INexClientNavigator
{
    public ClientOpenResult OpenResult { get; set; } = ClientOpenResult.Fail(AgentErrorCode.UnexpectedException, "nao configurado");
    public TransactionsTabResult TabResult { get; set; } = TransactionsTabResult.Fail(AgentErrorCode.UnexpectedException, "nao configurado");
    public int OpenClientByCodeCalls { get; private set; }
    public int OpenTransactionsTabCalls { get; private set; }
    public ClientNavigationTarget? LastNavigationTarget { get; private set; }
    public OpenedClientIdentity? LastClientReceived { get; private set; }

    public ClientOpenResult OpenClientByCode(NexAdminWindowIdentity target, ClientNavigationTarget navigationTarget)
    {
        OpenClientByCodeCalls++;
        LastNavigationTarget = navigationTarget;
        return OpenResult;
    }

    public TransactionsTabResult OpenTransactionsTab(NexAdminWindowIdentity target, OpenedClientIdentity client)
    {
        OpenTransactionsTabCalls++;
        LastClientReceived = client;
        return TabResult;
    }
}

public sealed class FakeNexOverflowMenuOpener : INexOverflowMenuOpener
{
    public OverflowMenuResult Result { get; set; } = OverflowMenuResult.Fail(AgentErrorCode.UnexpectedException, "nao configurado");
    public int OpenOverflowMenuCalls { get; private set; }

    public OverflowMenuResult OpenOverflowMenu(NexAdminWindowIdentity target, OpenedClientIdentity client)
    {
        OpenOverflowMenuCalls++;
        return Result;
    }
}

public sealed class FakeNexExportTrigger : INexExportTrigger
{
    public ExportTriggerResult Result { get; set; } = ExportTriggerResult.Fail(AgentErrorCode.UnexpectedException, "nao configurado");
    public int TriggerExportCalls { get; private set; }
    public OverflowMenuResult? LastOverflowReceived { get; private set; }

    public ExportTriggerResult TriggerExport(NexAdminWindowIdentity target, OverflowMenuResult overflow)
    {
        TriggerExportCalls++;
        LastOverflowReceived = overflow;
        return Result;
    }
}

/// <summary>Fake de INexClientNavigationNativeApi - permite programar
/// cenarios deterministicos (search readback correto/errado, F2
/// down/up sucesso/falha, exceptions entre DOWN e UP via callback) sem
/// tocar user32.dll real.</summary>
public sealed class FakeNexClientNavigationNativeApi : INexClientNavigationNativeApi
{
    public nint ForegroundWindow { get; set; }
    public Dictionary<nint, int> OwningProcessByHwnd { get; } = new();
    public Dictionary<nint, string> ClassNameByHwnd { get; } = new();
    public Dictionary<nint, List<nint>> ChildrenByParent { get; } = new();
    public Dictionary<nint, string> TextByHwnd { get; } = new();
    public Dictionary<nint, (int width, int height)> ClientSizeByHwnd { get; } = new();
    public HashSet<nint> ValidWindows { get; } = new();
    public HashSet<nint> VisibleWindows { get; } = new();
    public HashSet<nint> EnabledWindows { get; } = new();
    public nint FocusedWindowToReturn { get; set; }
    public ushort ScanCodeToReturn { get; set; } = 0x3C;
    public bool ShiftDown { get; set; }
    public bool CtrlDown { get; set; }
    public bool AltDown { get; set; }

    public (bool posted, int lastError) KeyDownResult { get; set; } = (true, 0);
    public (bool posted, int lastError) KeyUpResult { get; set; } = (true, 0);
    public (bool posted, int lastError) MouseDownResult { get; set; } = (true, 0);
    public (bool posted, int lastError) MouseUpResult { get; set; } = (true, 0);

    /// <summary>Se definido, e' lancado a partir de PostKeyUp na PRIMEIRA
    /// chamada (simula uma excecao entre DOWN e UP) - a SEGUNDA chamada
    /// (safety-release dentro do finally do navigator) usa KeyUpResult
    /// normalmente.</summary>
    public Exception? ThrowOnFirstPostKeyUp { get; set; }
    public int PostKeyDownCalls { get; private set; }
    public int PostKeyUpCalls { get; private set; }

    public nint GetForegroundWindow() => ForegroundWindow;

    public int GetOwningProcessId(nint hWnd) => OwningProcessByHwnd.TryGetValue(hWnd, out var pid) ? pid : 0;

    public string? GetClassName(nint hWnd) => ClassNameByHwnd.TryGetValue(hWnd, out var c) ? c : null;

    public IReadOnlyList<nint> EnumChildWindows(nint parentHwnd) =>
        ChildrenByParent.TryGetValue(parentHwnd, out var list) ? list : Array.Empty<nint>();

    /// <summary>Quando definido, ReadControlText SEMPRE retorna este valor
    /// (independente do que foi escrito) - usado para simular um readback
    /// divergente do que foi WM_SETTEXT'ado (cenario B da matriz).</summary>
    public string? ForceReadbackValue { get; set; }

    public string? ReadControlText(nint hWnd) =>
        ForceReadbackValue ?? (TextByHwnd.TryGetValue(hWnd, out var t) ? t : null);

    public bool WriteControlText(nint hWnd, string value)
    {
        TextByHwnd[hWnd] = value;
        return true;
    }

    public bool IsWindowValid(nint hWnd) => ValidWindows.Contains(hWnd);
    public bool IsWindowCurrentlyVisible(nint hWnd) => VisibleWindows.Contains(hWnd);
    public bool IsWindowCurrentlyEnabled(nint hWnd) => EnabledWindows.Contains(hWnd);

    public nint GetFocusedWindow(nint foregroundHwnd) => FocusedWindowToReturn;

    public ushort GetKeyScanCode(ushort virtualKey) => ScanCodeToReturn;

    public bool IsModifierKeyDown(int virtualKey) => virtualKey switch
    {
        0x10 => ShiftDown,
        0x11 => CtrlDown,
        0x12 => AltDown,
        _ => false,
    };

    public (bool posted, int lastError) PostKeyDown(nint hWnd, ushort virtualKey, nint lParam)
    {
        PostKeyDownCalls++;
        return KeyDownResult;
    }

    public (bool posted, int lastError) PostKeyUp(nint hWnd, ushort virtualKey, nint lParam)
    {
        PostKeyUpCalls++;
        if (PostKeyUpCalls == 1 && ThrowOnFirstPostKeyUp is not null)
        {
            throw ThrowOnFirstPostKeyUp;
        }
        return KeyUpResult;
    }

    public int PostMouseDownCalls { get; private set; }
    public int PostMouseUpCalls { get; private set; }
    public (nint hWnd, int x, int y)? LastMouseDownArgs { get; private set; }
    public (nint hWnd, int x, int y)? LastMouseUpArgs { get; private set; }

    public (bool posted, int lastError) PostMouseDown(nint hWnd, int clientX, int clientY)
    {
        PostMouseDownCalls++;
        LastMouseDownArgs = (hWnd, clientX, clientY);
        return MouseDownResult;
    }

    public (bool posted, int lastError) PostMouseUp(nint hWnd, int clientX, int clientY)
    {
        PostMouseUpCalls++;
        LastMouseUpArgs = (hWnd, clientX, clientY);
        return MouseUpResult;
    }

    public (int width, int height)? GetClientSize(nint hWnd) =>
        ClientSizeByHwnd.TryGetValue(hWnd, out var size) ? size : null;

    public Dictionary<nint, (int left, int top, int right, int bottom)> WindowRectByHwnd { get; } = new();

    public (int left, int top, int right, int bottom)? GetWindowRectangle(nint hWnd) =>
        WindowRectByHwnd.TryGetValue(hWnd, out var rect) ? rect : null;
}

public sealed class FakeOverflowHitTestNativeApi : IOverflowHitTestNativeApi
{
    public (int left, int top, int right, int bottom)? WindowRect { get; set; }
    public nint HitTestResult { get; set; }
    public Dictionary<nint, int> OwningProcessByHwnd { get; } = new();
    public Dictionary<nint, string> ClassNameByHwnd { get; } = new();
    public Dictionary<nint, string> TitleByHwnd { get; } = new();
    public Dictionary<nint, nint> ParentByHwnd { get; } = new();
    public (int clientX, int clientY)? ScreenToClientResult { get; set; } = (10, 10);
    public (bool posted, int lastError) MouseDownResult { get; set; } = (true, 0);
    public (bool posted, int lastError) MouseUpResult { get; set; } = (true, 0);
    public List<nint> TopLevelByClassResult { get; set; } = new();

    /// <summary>Quando nao-vazia, cada chamada a FindVisibleTopLevelByClass
    /// consome (dequeue) o proximo resultado desta fila em vez de
    /// TopLevelByClassResult - usado para simular "nenhum popup antes,
    /// popup correto depois do clique" (2 chamadas, 2 respostas
    /// diferentes) sem inventar estado temporal complexo no fake.</summary>
    public Queue<List<nint>> TopLevelByClassResultsSequence { get; } = new();
    public int FindVisibleTopLevelByClassCalls { get; private set; }

    /// <summary>Quando nao-vazia, cada chamada a GetWindowRectPhysical
    /// consome (dequeue) a proxima leitura desta fila em vez de
    /// WindowRect fixo - usado para simular o geometry stability gate
    /// (leituras erradas seguidas de leituras corretas).</summary>
    public Queue<(int left, int top, int right, int bottom)?> WindowRectSequence { get; } = new();
    public int GetWindowRectPhysicalCalls { get; private set; }

    /// <summary>Quando nao-vazia, cada chamada a IsWindowValid consome
    /// (dequeue) o proximo resultado desta fila em vez de
    /// IsWindowValidResult fixo - usado para simular o handle ficando
    /// invalido no meio do polling.</summary>
    public Queue<bool> IsWindowValidSequence { get; } = new();
    public bool IsWindowValidResult { get; set; } = true;
    public int IsWindowValidCalls { get; private set; }

    /// <summary>Quando nao-vazia, cada chamada a GetOwningProcessId (para
    /// o hWnd do handle gate) consome (dequeue) o proximo PID desta fila
    /// em vez do dicionario fixo - usado para simular o PID divergindo no
    /// meio do polling.</summary>
    public Queue<int> OwningProcessIdSequence { get; } = new();

    public (int left, int top, int right, int bottom)? GetWindowRectPhysical(nint hWnd)
    {
        GetWindowRectPhysicalCalls++;
        return WindowRectSequence.Count > 0 ? WindowRectSequence.Dequeue() : WindowRect;
    }

    public nint WindowFromPhysicalPoint(int screenX, int screenY) => HitTestResult;

    public bool IsWindowValid(nint hWnd)
    {
        IsWindowValidCalls++;
        return IsWindowValidSequence.Count > 0 ? IsWindowValidSequence.Dequeue() : IsWindowValidResult;
    }

    public int GetOwningProcessId(nint hWnd) =>
        OwningProcessIdSequence.Count > 0
            ? OwningProcessIdSequence.Dequeue()
            : OwningProcessByHwnd.TryGetValue(hWnd, out var pid) ? pid : 0;

    public string? GetClassName(nint hWnd) => ClassNameByHwnd.TryGetValue(hWnd, out var c) ? c : null;

    public (int clientX, int clientY)? ScreenToClient(nint hWnd, int screenX, int screenY) => ScreenToClientResult;

    public int MouseDownCalls { get; private set; }
    public int MouseUpCalls { get; private set; }

    public (bool posted, int lastError) PostMouseDown(nint hWnd, int clientX, int clientY)
    {
        MouseDownCalls++;
        return MouseDownResult;
    }

    public (bool posted, int lastError) PostMouseUp(nint hWnd, int clientX, int clientY)
    {
        MouseUpCalls++;
        return MouseUpResult;
    }

    public IReadOnlyList<nint> FindVisibleTopLevelByClass(int processId, string className)
    {
        FindVisibleTopLevelByClassCalls++;
        return TopLevelByClassResultsSequence.Count > 0 ? TopLevelByClassResultsSequence.Dequeue() : TopLevelByClassResult;
    }

    public nint GetParent(nint hWnd) => ParentByHwnd.TryGetValue(hWnd, out var p) ? p : 0;

    public string? GetWindowTitle(nint hWnd) => TitleByHwnd.TryGetValue(hWnd, out var t) ? t : null;
}

public sealed class FakeMsaaAccessibilityApi : IMsaaAccessibilityApi
{
    /// <summary>Mapa (screenX,screenY) -> nome do item MSAA "presente"
    /// naquele ponto exato - simula o hit-test sem nenhuma dependencia de
    /// oleacc.dll real.</summary>
    public Dictionary<(int x, int y), string> NamesByPoint { get; } = new();
    public Dictionary<string, int> RoleByName { get; } = new();
    public Dictionary<string, int> StateByName { get; } = new();
    public HashSet<string> DoDefaultActionShouldFailFor { get; } = new();
    public int DoDefaultActionCalls { get; private set; }
    public List<string?> DoDefaultActionCalledOnNames { get; } = new();

    /// <summary>Overrides por PONTO de scan (correcao pos-Probe 13A -
    /// deduplicacao MSAA) - usados quando o teste precisa que dois pontos
    /// com o MESMO nome tenham Role/State/Location/ChildId diferentes
    /// (elementos semanticamente distintos) ou EXPLICITAMENTE iguais
    /// (mesmo elemento, varios hits de scan). Quando ausentes, cai de
    /// volta em RoleByName/StateByName (compat com testes existentes) ou
    /// em valores default (location=null, childId="0").</summary>
    public Dictionary<(int x, int y), int> RoleByPoint { get; } = new();
    public Dictionary<(int x, int y), int> StateByPoint { get; } = new();
    public Dictionary<(int x, int y), (int left, int top, int width, int height)> LocationByPoint { get; } = new();
    public Dictionary<(int x, int y), string> ChildIdTextByPoint { get; } = new();

    public MsaaElementHandle? HitTest(int screenX, int screenY)
    {
        if (!NamesByPoint.TryGetValue((screenX, screenY), out var name)) return null;
        return new MsaaElementHandle(name, (screenX, screenY)); // ChildId carrega o ponto de scan (convencao SOMENTE deste fake)
    }

    /// <summary>Scheduler V2 - simula HitTestWithinWindow por
    /// (hWnd,x,y), independente do mapa global NamesByPoint acima (nunca
    /// compartilha estado com HitTest - evita que um teste do hit-test
    /// global "vaze" acidentalmente para um teste do hit-test escopado a
    /// janela, ou vice-versa).</summary>
    public Dictionary<(nint hWnd, int x, int y), string> NamesByWindowPoint { get; } = new();
    public HashSet<nint> AccessibleObjectFromWindowShouldFailFor { get; } = new();

    public MsaaElementHandle? HitTestWithinWindow(nint hWnd, int screenX, int screenY)
    {
        if (AccessibleObjectFromWindowShouldFailFor.Contains(hWnd)) return null;
        if (!NamesByWindowPoint.TryGetValue((hWnd, screenX, screenY), out var name)) return null;
        // ChildId permanece (x,y) - MESMO formato de HitTest() - para que
        // GetRole/GetState/GetLocation/DescribeChildId (que fazem
        // ((int x, int y))element.ChildId) funcionem identicamente para
        // handles vindos de qualquer um dos dois metodos de hit-test.
        // Desambiguar por janela (quando necessario) fica a cargo do
        // proprio teste, usando ranges de (x,y) que nao se sobrepoem
        // entre janelas diferentes num mesmo cenario.
        return new MsaaElementHandle(name, (screenX, screenY));
    }

    public string? GetName(MsaaElementHandle element) => (string)element.AccessibleObject;

    public int GetRole(MsaaElementHandle element)
    {
        var point = ((int x, int y))element.ChildId;
        if (RoleByPoint.TryGetValue(point, out var r)) return r;
        return RoleByName.TryGetValue((string)element.AccessibleObject, out var rn) ? rn : 0;
    }

    public int GetState(MsaaElementHandle element)
    {
        var point = ((int x, int y))element.ChildId;
        if (StateByPoint.TryGetValue(point, out var s)) return s;
        return StateByName.TryGetValue((string)element.AccessibleObject, out var sn) ? sn : 0;
    }

    public (int left, int top, int width, int height)? GetLocation(MsaaElementHandle element)
    {
        var point = ((int x, int y))element.ChildId;
        return LocationByPoint.TryGetValue(point, out var loc) ? loc : null;
    }

    public string DescribeChildId(MsaaElementHandle element)
    {
        var point = ((int x, int y))element.ChildId;
        return ChildIdTextByPoint.TryGetValue(point, out var t) ? t : "0";
    }

    public bool DoDefaultAction(MsaaElementHandle element)
    {
        DoDefaultActionCalls++;
        var name = (string)element.AccessibleObject;
        DoDefaultActionCalledOnNames.Add(name);
        return !DoDefaultActionShouldFailFor.Contains(name);
    }
}
