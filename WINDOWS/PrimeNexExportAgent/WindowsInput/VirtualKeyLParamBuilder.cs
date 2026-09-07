namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// Construcao segura (sem overflow) do LPARAM de WM_KEYDOWN/WM_KEYUP -
/// corrige em codigo de producao o bug real observado no Probe 9B desta
/// investigacao, onde a aritmetica equivalente em PowerShell (tentando
/// caber os bits 30/31 setados em um Int32 comum) lancou overflow e
/// deixou o WM_KEYUP correspondente sem ser despachado.
///
/// Ambos os metodos retornam SEMPRE uint (nunca int) - o padrao de bits
/// de 32 bits e' exatamente o exigido pela documentacao Win32 para o
/// LPARAM dessas mensagens (bits 0-15 repeat count, 16-23 scan code, 24
/// extended-key flag, 29 context code, 30 previous key state, 31
/// transition state). A conversao para IntPtr/nint (parametro real de
/// PostMessage, LPARAM de 64 bits em x64) deve ser feita explicitamente
/// via ToLParam() - NUNCA um cast implicito/direto de uint para
/// int/IntPtr, que e' precisamente o que causou o overflow original.
/// </summary>
internal static class VirtualKeyLParamBuilder
{
    private const uint RepeatCount = 1u;
    private const int ScanCodeShift = 16;
    private const uint PreviousKeyStateBit = 1u << 30;
    private const uint TransitionStateBit = 1u << 31;

    /// <summary>LPARAM de WM_KEYDOWN: repeat count=1, scan code nos bits
    /// 16-23, extended/context/previous/transition todos 0 (tecla nao
    /// estendida, primeira vez pressionada).</summary>
    internal static uint BuildKeyDown(ushort scanCode) =>
        RepeatCount | ((uint)scanCode << ScanCodeShift);

    /// <summary>LPARAM de WM_KEYUP: repeat count=1, mesmo scan code,
    /// previous key state (bit 30) e transition state (bit 31) ambos 1 -
    /// exatamente o padrao documentado pela Microsoft para liberacao de
    /// tecla. Retorna uint sem qualquer cast intermediario para tipo com
    /// sinal, eliminando a classe inteira do bug do Probe 9B.</summary>
    internal static uint BuildKeyUp(ushort scanCode) =>
        RepeatCount | ((uint)scanCode << ScanCodeShift) | PreviousKeyStateBit | TransitionStateBit;

    /// <summary>Conversao explicita e documentada de um LPARAM de 32 bits
    /// (uint) para o tipo real esperado por PostMessage (nint/IntPtr, 64
    /// bits em x64). O padrao de bits de 32 bits e' reinterpretado como
    /// int com sinal (unchecked - nunca lanca OverflowException) e entao
    /// estendido com sinal para 64 bits, que e' o que a API Win32 espera
    /// receber como LPARAM de uma mensagem de teclado. Esta e' a unica
    /// conversao permitida no projeto para este proposito - nunca
    /// reimplementar a aritmetica inline em outro lugar.</summary>
    internal static nint ToLParam(uint value) => unchecked((nint)(int)value);
}
