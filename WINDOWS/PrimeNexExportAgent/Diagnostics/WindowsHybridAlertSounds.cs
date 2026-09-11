namespace PrimeNexExportAgent.Diagnostics;

/// <summary>
/// Implementacao REAL de IHybridAlertSounds - Console.Beep nativo do
/// .NET/Windows (PC speaker/beep sintetico via API do SO), zero MP3/WAV,
/// zero dependencia nova. Frequencias/duracoes escolhidas para nunca
/// serem confundiveis ao ouvido: MINIMIZED usa 2 tons curtos e agudos;
/// TECHNICAL_FAILURE usa 3 tons mais longos e mais graves.
/// </summary>
public sealed class WindowsHybridAlertSounds : IHybridAlertSounds
{
    private const int MinimizedFrequencyHz = 1200;
    private const int MinimizedDurationMs = 150;
    private const int MinimizedBeepCount = 2;
    private const int MinimizedGapMs = 100;

    private const int TechnicalFailureFrequencyHz = 600;
    private const int TechnicalFailureDurationMs = 400;
    private const int TechnicalFailureBeepCount = 3;
    private const int TechnicalFailureGapMs = 150;

    public void PlayMinimizedWarning()
    {
        for (var i = 0; i < MinimizedBeepCount; i++)
        {
            Console.Beep(MinimizedFrequencyHz, MinimizedDurationMs);
            if (i < MinimizedBeepCount - 1) Thread.Sleep(MinimizedGapMs);
        }
    }

    public void PlayTechnicalFailureAfterAction()
    {
        for (var i = 0; i < TechnicalFailureBeepCount; i++)
        {
            Console.Beep(TechnicalFailureFrequencyHz, TechnicalFailureDurationMs);
            if (i < TechnicalFailureBeepCount - 1) Thread.Sleep(TechnicalFailureGapMs);
        }
    }
}
