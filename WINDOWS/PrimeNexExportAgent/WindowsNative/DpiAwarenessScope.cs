namespace PrimeNexExportAgent.WindowsNative;

/// <summary>
/// Escopo thread-local de contexto DPI (correcao pos-Probe 12A): entra em
/// DPI_AWARENESS_CONTEXT_UNAWARE, executa a operacao Win32 desejada, e
/// SEMPRE restaura o contexto original da thread - inclusive quando a
/// operacao lanca excecao. Nunca usa SetProcessDpiAwareness/
/// SetProcessDpiAwarenessContext (nunca altera o processo inteiro - so a
/// thread que chamou TryEnterUnaware, pelo tempo do `using`), entao nao
/// afeta WPF/UI Automation/outras partes do Agent.
///
/// Motivo (Probe 12A, comprovado em runtime real): GetWindowRect e'
/// virtualizado por DPI (documentacao oficial Microsoft). O profile de
/// overflow homologado (NexOverflowButtonProfile: 0,0,1536,864 /
/// 1489,146) foi calibrado inteiramente por ferramentas rodando sob
/// contexto DPI_AWARENESS_CONTEXT_UNAWARE (PowerShell). Para o C# do
/// Agent enxergar o MESMO espaco de coordenadas (em vez de pixels fisicos
/// 1920x1080, que fazem o profile divergir), toda operacao Win32 do fluxo
/// de overflow precisa rodar sob o MESMO contexto UNAWARE - exatamente o
/// mesmo principio ja usado por Win32MsaaAccessibilityApi.
///
/// `setContext` e' injetado (nao um DllImport direto aqui) para permitir
/// testar toda a logica de entrar/restaurar/fail-closed com um fake
/// determinístico, sem tocar user32.dll real.
/// </summary>
internal sealed class DpiAwarenessScope : IDisposable
{
    internal static readonly nint DpiAwarenessContextUnaware = new(-1);

    private readonly Func<nint, nint> _setContext;
    private readonly nint _oldContext;
    private bool _disposed;

    private DpiAwarenessScope(Func<nint, nint> setContext, nint oldContext)
    {
        _setContext = setContext;
        _oldContext = oldContext;
    }

    /// <summary>Entra em DPI_AWARENESS_CONTEXT_UNAWARE na thread atual.
    /// Retorna false (fail closed) se SetThreadDpiAwarenessContext
    /// retornar 0/NULL (contexto antigo indeterminavel) - nesse caso
    /// `scope` e' null e o chamador NAO deve executar a operacao Win32
    /// solicitada (zero GetWindowRect/hit-test/PostMessage).</summary>
    internal static bool TryEnterUnaware(Func<nint, nint> setContext, out DpiAwarenessScope? scope)
    {
        var oldContext = setContext(DpiAwarenessContextUnaware);
        if (oldContext == 0)
        {
            scope = null;
            return false;
        }

        scope = new DpiAwarenessScope(setContext, oldContext);
        return true;
    }

    /// <summary>Restaura EXATAMENTE o contexto original da thread - chamado
    /// sempre (inclusive apos excecao) via `using`/`try-finally` no
    /// chamador. Idempotente - uma segunda chamada nao restaura de novo.</summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _setContext(_oldContext);
    }
}
