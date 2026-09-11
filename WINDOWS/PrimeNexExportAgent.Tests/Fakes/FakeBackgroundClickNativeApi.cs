using PrimeNexExportAgent.WindowsInput;

namespace PrimeNexExportAgent.Tests.Fakes;

/// <summary>Fake de IBackgroundClickNativeApi (Scheduler V2) - simula
/// SendBnClickedViaWmCommand sem tocar user32.dll real.</summary>
public sealed class FakeBackgroundClickNativeApi : IBackgroundClickNativeApi
{
    public int SendBnClickedViaWmCommandCalls { get; private set; }
    public nint? LastParentHwndReceived { get; private set; }
    public nint? LastControlHwndReceived { get; private set; }
    public int? LastControlIdReceived { get; private set; }

    public bool CompletedResult { get; set; } = true;
    public nint ResultValue { get; set; } = 0;
    public int LastErrorValue { get; set; } = 0;

    public (bool completed, nint result, int lastError) SendBnClickedViaWmCommand(
        nint parentHwnd, nint controlHwnd, int controlId, uint timeoutMs)
    {
        SendBnClickedViaWmCommandCalls++;
        LastParentHwndReceived = parentHwnd;
        LastControlHwndReceived = controlHwnd;
        LastControlIdReceived = controlId;
        return (CompletedResult, ResultValue, LastErrorValue);
    }
}
