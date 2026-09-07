namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Identidade imutavel de um cliente ja aberto (TFrmCadCli), validada
/// pos-F2. Codigo e SEMPRE confirmado contra o ClientNavigationTarget
/// (gate obrigatorio, sem excecao). Nome e' confirmado quando
/// ClientNavigationTarget.ExpectedClientName foi fornecido, ou capturado
/// (lido, nunca adivinhado) quando nao foi - de qualquer forma, esta
/// mesma identidade flui, sem ser recalculada, para OpenTransactionsTab e
/// para toda reconfirmacao posterior (nunca um "nome esperado" externo
/// diferente deste em nenhuma etapa seguinte).
/// </summary>
public sealed class OpenedClientIdentity
{
    public nint ClientWindowHandle { get; }
    public string ClientCode { get; }
    public string ClientName { get; }

    public OpenedClientIdentity(nint clientWindowHandle, string clientCode, string clientName)
    {
        ClientWindowHandle = clientWindowHandle;
        ClientCode = clientCode;
        ClientName = clientName;
    }
}
