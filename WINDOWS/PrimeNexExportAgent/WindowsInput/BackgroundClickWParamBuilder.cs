namespace PrimeNexExportAgent.WindowsInput;

/// <summary>
/// Construcao segura (sem overflow, sem cast implicito) do WPARAM de
/// WM_COMMAND/BN_CLICKED - MAKEWPARAM(LOWORD(controlId), notificationCode),
/// exatamente a macro documentada pela Microsoft para esta mensagem.
///
/// NOTA IMPORTANTE (fidelidade ao mecanismo homologado nas Fases
/// B.1.3/B.2/B.3): controlId pode ser maior que 0xFFFF (ex.: 133354, um
/// ID atribuido pelo Delphi/DevExpress, fora da faixa convencional de 16
/// bits de um dialog control ID nativo). A macro MAKEWPARAM real SEMPRE
/// trunca para os 16 bits baixos - isso NAO e um bug desta implementacao,
/// e o comportamento documentado da API, ja confirmado funcional em
/// runtime real (Fase B.1.3: 133354 truncado para 2282 abriu o popup
/// correto).
/// </summary>
internal static class BackgroundClickWParamBuilder
{
    private const int NotificationCodeShift = 16;

    internal static nint BuildWmCommandWParam(int controlId, ushort notificationCode)
    {
        var lowWord = unchecked((ushort)controlId);
        var packed = unchecked((uint)(notificationCode << NotificationCodeShift) | lowWord);
        return unchecked((nint)(int)packed);
    }
}
