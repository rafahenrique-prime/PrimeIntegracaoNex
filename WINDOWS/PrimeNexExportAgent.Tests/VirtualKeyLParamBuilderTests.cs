using PrimeNexExportAgent.WindowsInput;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (V1 individual statement) de VirtualKeyLParamBuilder -
/// reproduz exatamente os valores hex conferidos manualmente na sessao
/// real (Probe 9B/correcao), com o scan code real do F2 (0x3C), provando
/// que a aritmetica em C# nao sofre o overflow que ocorreu em PowerShell.
/// </summary>
public sealed class VirtualKeyLParamBuilderTests
{
    private const ushort F2ScanCode = 0x3C; // 60 - conferido via MapVirtualKeyW nesta sessao

    [Fact]
    public void F1_BuildKeyDown_F2ScanCode_BateComValorHexJaValidado()
    {
        var result = VirtualKeyLParamBuilder.BuildKeyDown(F2ScanCode);

        Assert.Equal(0x003C0001u, result);
    }

    [Fact]
    public void F2_BuildKeyUp_F2ScanCode_BateComValorHexJaValidado()
    {
        var result = VirtualKeyLParamBuilder.BuildKeyUp(F2ScanCode);

        Assert.Equal(0xC03C0001u, result);
    }

    [Fact]
    public void F3_BuildKeyUp_Bit31TransitionState_SempreSetado()
    {
        var result = VirtualKeyLParamBuilder.BuildKeyUp(F2ScanCode);

        Assert.NotEqual(0u, result & (1u << 31));
    }

    [Fact]
    public void F4_BuildKeyUp_Bit30PreviousKeyState_SempreSetado()
    {
        var result = VirtualKeyLParamBuilder.BuildKeyUp(F2ScanCode);

        Assert.NotEqual(0u, result & (1u << 30));
    }

    [Fact]
    public void F5_BuildKeyDown_Bits30E31_NuncaSetados()
    {
        var result = VirtualKeyLParamBuilder.BuildKeyDown(F2ScanCode);

        Assert.Equal(0u, result & (1u << 30));
        Assert.Equal(0u, result & (1u << 31));
    }

    [Fact]
    public void F6_ToLParam_NuncaLancaOverflowException_ParaValorComBits30E31()
    {
        var value = VirtualKeyLParamBuilder.BuildKeyUp(F2ScanCode);

        var exception = Record.Exception(() => VirtualKeyLParamBuilder.ToLParam(value));

        Assert.Null(exception);
    }

    [Fact]
    public void F7_ToLParam_PreservaOPadraoDeBits32_ViaSignExtension()
    {
        var value = VirtualKeyLParamBuilder.BuildKeyUp(F2ScanCode); // 0xC03C0001

        var lparam = VirtualKeyLParamBuilder.ToLParam(value);

        // unchecked((nint)(int)0xC03C0001u) = -1069481983 estendido com
        // sinal para 64 bits - os 32 bits baixos devem bater exatamente
        // com o valor uint original.
        Assert.Equal(unchecked((int)value), (int)lparam);
        Assert.Equal(value, unchecked((uint)(int)lparam));
    }

    [Theory]
    [InlineData((ushort)0x01)]
    [InlineData((ushort)0x3C)]
    [InlineData((ushort)0xFF)]
    public void F8_BuildKeyDownEBuildKeyUp_DiferemApenasNosBits30E31EMantemMesmoScanCode(ushort scanCode)
    {
        var down = VirtualKeyLParamBuilder.BuildKeyDown(scanCode);
        var up = VirtualKeyLParamBuilder.BuildKeyUp(scanCode);

        var downScanCode = (down >> 16) & 0xFF;
        var upScanCode = (up >> 16) & 0xFF;

        Assert.Equal(downScanCode, upScanCode);
        Assert.Equal(down | (1u << 30) | (1u << 31), up);
    }
}
