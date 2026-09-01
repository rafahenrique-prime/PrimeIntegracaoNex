namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Identidade explicita da janela principal do NexAdmin ja validada (F6.13.4).
/// Carrega exatamente o necessario para que uma acao de teclado (Shift+F5)
/// possa ser dirigida a UMA janela especifica, nunca "a janela que estiver
/// em foreground no momento" - a mesma instancia flui de LocateNexAdmin ate
/// IInputSender.SendExportShortcut(), nunca e recalculada no meio do caminho.
///
/// So dados de identidade (PID + HWND) - nunca coordenadas de tela, nunca
/// estado de foreground (isso e responsabilidade do PRE-INPUT TARGET GATE
/// da implementacao real de IInputSender, F6.14 - ver comentario no
/// contrato de IInputSender).
///
/// nint (em vez de um wrapper proprio) foi escolhido para MainWindowHandle
/// porque e exatamente o tipo que System.Diagnostics.Process.MainWindowHandle
/// e P/Invoke de user32.dll (HWND) usam nativamente em .NET moderno - criar
/// um wrapper proprio so adicionaria uma conversao extra sem nenhum ganho de
/// tipagem (um HWND nao tem operacoes de dominio alem de comparacao de
/// igualdade, que nint ja oferece).
/// </summary>
public sealed class NexAdminWindowIdentity : IEquatable<NexAdminWindowIdentity>
{
    public int ProcessId { get; }
    public nint MainWindowHandle { get; }

    public NexAdminWindowIdentity(int processId, nint mainWindowHandle)
    {
        ProcessId = processId;
        MainWindowHandle = mainWindowHandle;
    }

    public bool Equals(NexAdminWindowIdentity? other) =>
        other is not null && ProcessId == other.ProcessId && MainWindowHandle == other.MainWindowHandle;

    public override bool Equals(object? obj) => Equals(obj as NexAdminWindowIdentity);

    public override int GetHashCode() => HashCode.Combine(ProcessId, MainWindowHandle);

    public override string ToString() => $"NexAdminWindowIdentity(PID={ProcessId}, HWND=0x{MainWindowHandle:X})";
}
