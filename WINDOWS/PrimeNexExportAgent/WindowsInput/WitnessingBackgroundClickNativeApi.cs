using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// Hybrid V3 - decorator usado EXCLUSIVAMENTE pela composicao de
/// RunOnceScheduledHybridEntrypoint, nunca por V2 standalone
/// (RunOnceScheduledBackgroundSafeEntrypoint continua usando
/// Win32BackgroundClickNativeApi cru, sem witness, sem nenhuma mudanca).
/// Marca MutationWitness.MarkAttempted() IMEDIATAMENTE ANTES de delegar a
/// UNICA chamada real (WM_COMMAND/BN_CLICKED) - nunca depois do retorno,
/// para que uma falha reportada pela propria chamada (completed=false, ou
/// uma excecao) nao impeca o witness de refletir que a mutacao real ja
/// havia sido tentada.
/// </summary>
public sealed class WitnessingBackgroundClickNativeApi : IBackgroundClickNativeApi
{
    private readonly IBackgroundClickNativeApi _inner;
    private readonly MutationWitness _witness;

    public WitnessingBackgroundClickNativeApi(IBackgroundClickNativeApi inner, MutationWitness witness)
    {
        _inner = inner;
        _witness = witness;
    }

    public (bool completed, nint result, int lastError) SendBnClickedViaWmCommand(nint parentHwnd, nint controlHwnd, int controlId, uint timeoutMs)
    {
        _witness.MarkAttempted();
        return _inner.SendBnClickedViaWmCommand(parentHwnd, controlHwnd, controlId, timeoutMs);
    }
}
