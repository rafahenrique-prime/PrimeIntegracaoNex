using PrimeNexExportAgent.WindowsInput;

namespace PrimeNexExportAgent.Tests.Fakes;

/// <summary>Fake de IInputNativeApi (F6.14B1) - simula
/// SetForegroundWindow/GetForegroundWindow/SendShiftF5 sem tocar nenhuma
/// API Win32 real. GetForegroundWindow suporta uma FILA de retornos para
/// simular a 1a e a 2a confirmacao do PRE-INPUT TARGET GATE divergindo
/// entre si.</summary>
public sealed class FakeInputNativeApi : IInputNativeApi
{
    public int SetForegroundWindowCalls { get; private set; }
    public nint? LastSetForegroundWindowTarget { get; private set; }
    public bool SetForegroundWindowResult { get; set; } = true;

    public int GetForegroundWindowCalls { get; private set; }

    /// <summary>Valores retornados por GetForegroundWindow(), um por
    /// chamada, na ordem. Se a fila esvaziar, repete o ultimo valor.</summary>
    public Queue<nint> GetForegroundWindowSequence { get; } = new();
    private nint _lastForegroundValue;

    public int SendShiftF5Calls { get; private set; }
    public int SendShiftF5Result { get; set; } = 4;
    public Exception? ThrowOnSendShiftF5 { get; set; }

    public bool SetForegroundWindow(nint hWnd)
    {
        SetForegroundWindowCalls++;
        LastSetForegroundWindowTarget = hWnd;
        return SetForegroundWindowResult;
    }

    public nint GetForegroundWindow()
    {
        GetForegroundWindowCalls++;
        if (GetForegroundWindowSequence.Count > 0)
        {
            _lastForegroundValue = GetForegroundWindowSequence.Dequeue();
        }
        return _lastForegroundValue;
    }

    public int SendShiftF5()
    {
        SendShiftF5Calls++;
        if (ThrowOnSendShiftF5 is not null) throw ThrowOnSendShiftF5;
        return SendShiftF5Result;
    }
}
