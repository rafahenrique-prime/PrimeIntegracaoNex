using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.WindowsNative;

namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// Hybrid V3 - decorator usado EXCLUSIVAMENTE pela composicao de
/// RunOnceScheduledHybridEntrypoint, nunca por V1 standalone
/// (RunOnceScheduledSafeEntrypoint continua usando Win32InputNativeApi
/// cru, sem witness, sem nenhuma mudanca). Encaminha toda chamada ao
/// Win32InputNativeApi real injetado, exceto SendShiftF5(): marca
/// MutationWitness.MarkAttempted() IMEDIATAMENTE ANTES de delegar - nunca
/// depois do retorno, para que uma excecao lancada pela chamada real (ex.:
/// SendInput reportando contagem parcial) nao impeca o witness de refletir
/// que a mutacao real ja havia sido tentada.
///
/// Implementa tanto IInputNativeApi quanto IForegroundReader porque
/// Win32InputNativeApi (real) implementa as duas (WindowsScheduledSafeInputSender
/// recebe a MESMA instancia para os dois parametros do construtor - ver
/// RunOnceScheduledSafeEntrypoint.BuildOrchestrator()).
/// </summary>
public sealed class WitnessingInputNativeApi : IInputNativeApi, IForegroundReader
{
    private readonly IInputNativeApi _innerInput;
    private readonly IForegroundReader _innerForeground;
    private readonly MutationWitness _witness;

    public WitnessingInputNativeApi(IInputNativeApi innerInput, IForegroundReader innerForeground, MutationWitness witness)
    {
        _innerInput = innerInput;
        _innerForeground = innerForeground;
        _witness = witness;
    }

    public bool SetForegroundWindow(nint hWnd) => _innerInput.SetForegroundWindow(hWnd);

    /// <summary>Satisfaz IInputNativeApi.GetForegroundWindow() E
    /// IForegroundReader.GetForegroundWindow() (assinatura identica) -
    /// delega ao _innerForeground, que e' a MESMA instancia real repassada
    /// para ambos os papeis pela composicao do Hybrid.</summary>
    public nint GetForegroundWindow() => _innerForeground.GetForegroundWindow();

    public int SendShiftF5()
    {
        _witness.MarkAttempted();
        return _innerInput.SendShiftF5();
    }
}
