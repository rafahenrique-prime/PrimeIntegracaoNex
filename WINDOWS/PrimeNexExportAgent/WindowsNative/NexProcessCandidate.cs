namespace PrimeNexExportAgent.WindowsNative;

/// <summary>Instantaneo somente-leitura de um processo candidato a
/// NexAdmin.exe (F6.14A). Ja extraido de System.Diagnostics.Process para
/// que a logica de decisao de LocateNexAdmin seja testavel com fakes puros,
/// sem precisar de um processo real do Windows em cada teste.
///
/// F6.14A.1: NAO carrega mais MainWindowHandle - evidencia real (inspecao
/// ao vivo, F6.14A) provou que Process.MainWindowHandle do NexAdmin.exe
/// aponta para a janela oculta TApplication do Delphi/VCL, nunca para a
/// janela de negocio real (TfrmPri). Manter esse campo aqui seria manter
/// um dado enganoso "so porque o Process oferece" - a janela alvo agora e
/// SEMPRE resolvida por enumeracao explicita (INativeWindowApi), nunca por
/// este campo. ExecutablePath null significa "nao foi possivel ler" (ex.:
/// acesso negado), nunca deve ser tratado como match.</summary>
public sealed record NexProcessCandidate(int ProcessId, string? ExecutablePath, int SessionId);
