namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Identidade do dialogo "Salvar como" ja identificado/validado (F6.14B2) -
/// equivalente, para o dialogo, ao papel que NexAdminWindowIdentity exerce
/// para a janela principal do NexAdmin. Flui de
/// ISaveDialogInspector.IdentifySaveDialog(target) ate
/// ISaveDialogController.Configure(dialog, ...)/ClickSave(dialog)/
/// CancelSaveDialog(dialog) - nunca recalculada/redescoberta no meio do
/// caminho (mesma disciplina de F6.13.4).
/// </summary>
public sealed class SaveDialogIdentity : IEquatable<SaveDialogIdentity>
{
    public nint DialogHandle { get; }

    public SaveDialogIdentity(nint dialogHandle) => DialogHandle = dialogHandle;

    public bool Equals(SaveDialogIdentity? other) => other is not null && DialogHandle == other.DialogHandle;

    public override bool Equals(object? obj) => Equals(obj as SaveDialogIdentity);

    public override int GetHashCode() => DialogHandle.GetHashCode();

    public override string ToString() => $"SaveDialogIdentity(HWND=0x{DialogHandle:X})";
}
