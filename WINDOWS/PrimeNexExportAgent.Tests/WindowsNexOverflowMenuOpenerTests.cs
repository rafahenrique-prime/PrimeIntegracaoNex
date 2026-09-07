using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>Testes offline (V1) de WindowsNexOverflowMenuOpener - matriz
/// K, L, M, AB do plano aprovado.</summary>
public sealed class WindowsNexOverflowMenuOpenerTests
{
    private const int Pid = 22240;
    private static readonly nint ClientWindow = 0x3000;
    private static readonly nint TargetPanel = 0x7000;
    private static readonly nint PopupHwnd = 0x8000;
    private static readonly nint PopupOwnerHwnd = 0x8001;

    private static readonly NexAdminWindowIdentity Target = new(Pid, 0x1000);
    private static readonly OpenedClientIdentity Client = new(ClientWindow, "292", "MATHEUS HENRIQUE DEPRE");

    private const int ExpectedLeft = 0, ExpectedTop = 0, ExpectedRight = 1536, ExpectedBottom = 864;
    private const int ScreenX = 1489, ScreenY = 146;

    private sealed class Fixture
    {
        public FakeOverflowHitTestNativeApi HitTest { get; } = new();
        public FakeMsaaAccessibilityApi Msaa { get; } = new();
        public FakeDelay Delay { get; } = new();
        public WindowsNexOverflowMenuOpener Opener { get; }

        public Fixture()
        {
            Opener = new WindowsNexOverflowMenuOpener(HitTest, Msaa, Delay);
            HitTest.WindowRect = (ExpectedLeft, ExpectedTop, ExpectedRight, ExpectedBottom);
            HitTest.HitTestResult = TargetPanel;
            HitTest.OwningProcessByHwnd[TargetPanel] = Pid;
            HitTest.OwningProcessByHwnd[ClientWindow] = Pid;
            HitTest.IsWindowValidResult = true;
            HitTest.ScreenToClientResult = (44, 15);
        }

        public void SetupValidPopupWithAllItems()
        {
            HitTest.TopLevelByClassResultsSequence.Enqueue(new List<nint>()); // antes: nenhum popup
            HitTest.TopLevelByClassResultsSequence.Enqueue(new List<nint> { PopupHwnd }); // depois: popup correto
            HitTest.ParentByHwnd[PopupHwnd] = PopupOwnerHwnd;
            HitTest.ClassNameByHwnd[PopupOwnerHwnd] = "TfbTranCli";
            HitTest.TitleByHwnd[PopupOwnerHwnd] = "Transações";
            HitTest.WindowRect = (ExpectedLeft, ExpectedTop, ExpectedRight, ExpectedBottom); // reaproveitado tb p/ popup pela sequencia de chamadas

            // O fake GetWindowRectPhysical retorna sempre o mesmo valor
            // configurado (WindowRect) independente do HWND - suficiente
            // para popular a varredura MSAA com pontos deterministicos.
            Msaa.NamesByPoint[(ExpectedLeft + 10, ExpectedTop + 5)] = "Agrupar por colunas";
            Msaa.NamesByPoint[(ExpectedLeft + 10, ExpectedTop + 20)] = "Imprimir lista de transações";
            Msaa.NamesByPoint[(ExpectedLeft + 10, ExpectedTop + 35)] = "Exportar lista de transações";
        }
    }

    [Fact]
    public void K_OverflowPopupCorreto_Pass()
    {
        var f = new Fixture();
        f.SetupValidPopupWithAllItems();

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.True(result.Passed);
        Assert.Equal("TfbTranCli", result.PopupOwnerClass);
        Assert.Equal("Transações", result.PopupOwnerTitle);
    }

    [Fact]
    public void L_OverflowSemPopup_NoEffectSemRetry()
    {
        var f = new Fixture();
        f.HitTest.TopLevelByClassResult = new List<nint>(); // nenhum popup apareceu

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.OverflowPopupNotFound, result.ErrorCode);
    }

    [Fact]
    public void M1_PopupOwnerErrado_Block()
    {
        var f = new Fixture();
        f.HitTest.TopLevelByClassResultsSequence.Enqueue(new List<nint>());
        f.HitTest.TopLevelByClassResultsSequence.Enqueue(new List<nint> { PopupHwnd });
        f.HitTest.ParentByHwnd[PopupHwnd] = PopupOwnerHwnd;
        f.HitTest.ClassNameByHwnd[PopupOwnerHwnd] = "OutraClasse";
        f.HitTest.TitleByHwnd[PopupOwnerHwnd] = "Transações";

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.OverflowWrongPopup, result.ErrorCode);
    }

    [Fact]
    public void M2_ItensMsaaIncompletos_Block()
    {
        var f = new Fixture();
        f.HitTest.TopLevelByClassResultsSequence.Enqueue(new List<nint>());
        f.HitTest.TopLevelByClassResultsSequence.Enqueue(new List<nint> { PopupHwnd });
        f.HitTest.ParentByHwnd[PopupHwnd] = PopupOwnerHwnd;
        f.HitTest.ClassNameByHwnd[PopupOwnerHwnd] = "TfbTranCli";
        f.HitTest.TitleByHwnd[PopupOwnerHwnd] = "Transações";
        // So 1 dos 3 itens esperados presente
        f.Msaa.NamesByPoint[(ExpectedLeft + 10, ExpectedTop + 5)] = "Agrupar por colunas";

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.OverflowWrongPopup, result.ErrorCode);
    }

    [Fact]
    public void AB_GeometriaDivergente_ZeroPostMessage()
    {
        var f = new Fixture();
        f.HitTest.WindowRect = (0, 0, 1920, 1080); // diverge da calibracao homologada

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.OverflowGeometryMismatch, result.ErrorCode);
    }

    [Fact]
    public void AB2_PopupJaAbertoAntes_BlockSemClicar()
    {
        var f = new Fixture();
        f.HitTest.TopLevelByClassResult = new List<nint> { PopupHwnd }; // popup ja presente ANTES de qualquer acao

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.OverflowPopupNotFound, result.ErrorCode);
    }

    private static readonly (int, int, int, int) WrongRect = (0, 0, 1920, 1080);
    private static readonly (int, int, int, int) CorrectRect = (ExpectedLeft, ExpectedTop, ExpectedRight, ExpectedBottom);

    // ======================================================
    // Geometry Stability Gate - matriz A-K (correcao pos-Probe 11B)
    // ======================================================

    [Fact]
    public void GeoA_ErradaCorretaCorreta_PassSomenteNaTerceiraELeituraZeroPostMessageAntes()
    {
        var f = new Fixture();
        f.SetupValidPopupWithAllItems();
        f.HitTest.WindowRectSequence.Enqueue(WrongRect);
        f.HitTest.WindowRectSequence.Enqueue(CorrectRect);
        f.HitTest.WindowRectSequence.Enqueue(CorrectRect);
        f.HitTest.WindowRect = CorrectRect; // usado pelo popupRect apos o gate

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.True(result.Passed);
        Assert.Equal(1, f.HitTest.MouseDownCalls); // clique so' apos a leitura estavel (3a amostra)
        Assert.Equal(1, f.HitTest.MouseUpCalls);
    }

    [Fact]
    public void GeoB_CorretaCorreta_Pass()
    {
        var f = new Fixture();
        f.SetupValidPopupWithAllItems();
        f.HitTest.WindowRectSequence.Enqueue(CorrectRect);
        f.HitTest.WindowRectSequence.Enqueue(CorrectRect);
        f.HitTest.WindowRect = CorrectRect;

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.True(result.Passed);
    }

    [Fact]
    public void GeoC_CorretaErradaCorretaCorreta_PassSomenteNasDuasUltimas()
    {
        var f = new Fixture();
        f.SetupValidPopupWithAllItems();
        f.HitTest.WindowRectSequence.Enqueue(CorrectRect);
        f.HitTest.WindowRectSequence.Enqueue(WrongRect);
        f.HitTest.WindowRectSequence.Enqueue(CorrectRect);
        f.HitTest.WindowRectSequence.Enqueue(CorrectRect);
        f.HitTest.WindowRect = CorrectRect;

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.True(result.Passed);
    }

    [Fact]
    public void GeoD_TodasErradasAteTimeout_MismatchZeroPostMessage()
    {
        var f = new Fixture();
        f.HitTest.WindowRect = WrongRect; // toda leitura (sem sequence) retorna WrongRect

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.OverflowGeometryMismatch, result.ErrorCode);
        Assert.Contains("GEOMETRY_SAMPLE_COUNT=15", result.Reason);
        Assert.Equal(0, f.HitTest.MouseDownCalls);
        Assert.Equal(0, f.HitTest.MouseUpCalls);
    }

    [Fact]
    public void GeoE_HwndInvalidoDuranteONPolling_FailClosed()
    {
        var f = new Fixture();
        f.HitTest.WindowRect = CorrectRect;
        f.HitTest.IsWindowValidSequence.Enqueue(true);
        f.HitTest.IsWindowValidSequence.Enqueue(false); // fica invalido na 2a amostra

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.OverflowHandleInvalidated, result.ErrorCode);
        Assert.Equal(0, f.HitTest.MouseDownCalls);
    }

    [Fact]
    public void GeoF_PidDivergeDuranteOPolling_FailClosed()
    {
        var f = new Fixture();
        f.HitTest.WindowRect = CorrectRect;
        f.HitTest.OwningProcessIdSequence.Enqueue(Pid); // handle gate 1a amostra ok
        f.HitTest.OwningProcessIdSequence.Enqueue(99999); // pid divergente na 2a amostra

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.OverflowHandleInvalidated, result.ErrorCode);
        Assert.Equal(0, f.HitTest.MouseDownCalls);
    }

    [Fact]
    public void GeoG_PostMessageDoOverflowSomenteApos2MatchesConsecutivos()
    {
        var f = new Fixture();
        f.SetupValidPopupWithAllItems();
        f.HitTest.WindowRectSequence.Enqueue(WrongRect);
        f.HitTest.WindowRectSequence.Enqueue(CorrectRect);
        f.HitTest.WindowRectSequence.Enqueue(CorrectRect);
        f.HitTest.WindowRect = CorrectRect;

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.True(result.Passed);
        Assert.Equal(1, f.HitTest.MouseDownCalls);
        Assert.Equal(1, f.HitTest.MouseUpCalls);
    }

    [Fact]
    public void GeoH_PollingNaoIncrementaNenhumActionRetryCounter()
    {
        var f = new Fixture();
        f.SetupValidPopupWithAllItems();
        f.HitTest.WindowRectSequence.Enqueue(WrongRect);
        f.HitTest.WindowRectSequence.Enqueue(WrongRect);
        f.HitTest.WindowRectSequence.Enqueue(CorrectRect);
        f.HitTest.WindowRectSequence.Enqueue(CorrectRect);
        f.HitTest.WindowRect = CorrectRect;

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.True(result.Passed);
        // Independente de quantas leituras de geometria (retries de LEITURA,
        // nunca de ACAO) ocorreram, o clique so acontece exatamente 1 vez.
        Assert.Equal(1, f.HitTest.MouseDownCalls);
        Assert.Equal(1, f.HitTest.MouseUpCalls);
    }

    [Fact]
    public void GeoI_ReasonDaFalhaContemCamposDeDiagnostico()
    {
        var f = new Fixture();
        f.HitTest.WindowRect = WrongRect;

        var result = f.Opener.OpenOverflowMenu(Target, Client);

        Assert.False(result.Passed);
        Assert.Contains("EXPECTED_CADCLI_RECT=(0,0,1536,864)", result.Reason);
        Assert.Contains("ACTUAL_CADCLI_RECT=(0,0,1920,1080)", result.Reason);
        Assert.Contains("GEOMETRY_SAMPLE_COUNT=", result.Reason);
        Assert.Contains("GEOMETRY_WAIT_ELAPSED_MS=", result.Reason);
        Assert.Contains($"CADCLI_HWND={ClientWindow}", result.Reason);
        Assert.Contains($"TARGET_NEX_PID={Pid}", result.Reason);
    }

    [Fact]
    public void GeoJ_ProfilePermanece0_0_1536_864E1489_146()
    {
        Assert.Equal(0, PrimeNexExportAgent.WindowsNative.NexOverflowButtonProfile.ExpectedCadCliWindowRect.Left);
        Assert.Equal(0, PrimeNexExportAgent.WindowsNative.NexOverflowButtonProfile.ExpectedCadCliWindowRect.Top);
        Assert.Equal(1536, PrimeNexExportAgent.WindowsNative.NexOverflowButtonProfile.ExpectedCadCliWindowRect.Right);
        Assert.Equal(864, PrimeNexExportAgent.WindowsNative.NexOverflowButtonProfile.ExpectedCadCliWindowRect.Bottom);
        Assert.Equal(1489, PrimeNexExportAgent.WindowsNative.NexOverflowButtonProfile.ValidatedOverflowScreenX);
        Assert.Equal(146, PrimeNexExportAgent.WindowsNative.NexOverflowButtonProfile.ValidatedOverflowScreenY);
    }
}
