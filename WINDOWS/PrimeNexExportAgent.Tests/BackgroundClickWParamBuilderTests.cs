using PrimeNexExportAgent.WindowsInput;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (Scheduler V2) de BackgroundClickWParamBuilder - prova a
/// aritmetica de MAKEWPARAM(LOWORD(controlId), notificationCode) usada
/// para o WM_COMMAND/BN_CLICKED homologado nas Fases B.1.3/B.2/B.3,
/// incluindo a truncagem documentada para o control ID real (133354) que
/// excede 16 bits.
/// </summary>
public sealed class BackgroundClickWParamBuilderTests
{
    private const int RealOpenerControlId = 133354; // 0x208AA - excede 0xFFFF de proposito

    [Fact]
    public void F1_BuildWmCommandWParam_ControlIdReal_TruncaParaOsBits16Baixos()
    {
        var result = BackgroundClickWParamBuilder.BuildWmCommandWParam(RealOpenerControlId, 0);

        // 133354 mod 65536 = 2282 (0x08AA) - exatamente LOWORD(133354).
        Assert.Equal(2282, (int)result);
    }

    [Fact]
    public void F2_BuildWmCommandWParam_ControlIdPequeno_NuncaTrunca()
    {
        var result = BackgroundClickWParamBuilder.BuildWmCommandWParam(5, 0);

        Assert.Equal(5, (int)result);
    }

    [Fact]
    public void F3_BuildWmCommandWParam_NotificationCodeVaiNoHighWord()
    {
        var result = BackgroundClickWParamBuilder.BuildWmCommandWParam(RealOpenerControlId, 7);

        var packed = unchecked((uint)(int)result);
        Assert.Equal(7u, packed >> 16);
        Assert.Equal(2282u, packed & 0xFFFFu);
    }

    [Fact]
    public void F4_BuildWmCommandWParam_BnClicked_EhZero_HighWordFicaZero()
    {
        var result = BackgroundClickWParamBuilder.BuildWmCommandWParam(RealOpenerControlId, 0);

        var packed = unchecked((uint)(int)result);
        Assert.Equal(0u, packed >> 16);
    }

    [Fact]
    public void F5_BuildWmCommandWParam_NuncaLancaException_ParaControlIdForaDeFaixa16Bits()
    {
        var exception = Record.Exception(() => BackgroundClickWParamBuilder.BuildWmCommandWParam(RealOpenerControlId, 0));

        Assert.Null(exception);
    }
}
