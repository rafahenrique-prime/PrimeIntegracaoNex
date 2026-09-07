namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Entrada de INexClientNavigator.OpenClientByCode.
///
/// CORRECAO (pos-primeiro OnceProbe real): ExpectedClientName agora e'
/// OBRIGATORIO, nao mais opcional. O primeiro OnceProbe real revelou que
/// nao existe forma homologada de descobrir genericamente qual controle
/// TcxDBTextEdit e' "o Nome" apenas por estar nao-vazio - o cadastro real
/// de um cliente pode ter varios TcxDBTextEdit nao-vazios simultaneamente
/// (telefone, codigo de area, etc.), tornando "capturar o nome real
/// quando ausente" uma operacao ambigua e insegura por design. Exigir o
/// nome esperado de antemao permite localizar exatamente o controle certo
/// por correspondencia exata de conteudo, em vez de por cardinalidade.
/// </summary>
public sealed class ClientNavigationTarget
{
    public string ClientCode { get; }
    public string ExpectedClientName { get; }

    public ClientNavigationTarget(string clientCode, string expectedClientName)
    {
        if (string.IsNullOrWhiteSpace(clientCode))
        {
            throw new ArgumentException("ClientCode e' obrigatorio.", nameof(clientCode));
        }

        if (string.IsNullOrWhiteSpace(expectedClientName))
        {
            throw new ArgumentException("ExpectedClientName e' obrigatorio nesta versao (V1) - nao ha forma segura de capturar o nome automaticamente.", nameof(expectedClientName));
        }

        ClientCode = clientCode;
        ExpectedClientName = expectedClientName;
    }
}
