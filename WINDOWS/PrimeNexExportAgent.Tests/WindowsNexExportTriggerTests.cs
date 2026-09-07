using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>Testes offline (V1) de WindowsNexExportTrigger - matriz N,
/// AG, AH, AI, AJ, AC do plano original, mais A-L da correcao pos-Probe
/// 13A (deduplicacao MSAA por fingerprint semantico).</summary>
public sealed class WindowsNexExportTriggerTests
{
    private const int Pid = 22240;
    private static readonly nint PopupHwnd = 0x8000;
    private static readonly nint PopupOwnerHwnd = 0x8001;
    private const int Left = 0, Top = 0, Right = 1536, Bottom = 864;
    private const string ExportName = "Exportar lista de transações";

    private static readonly NexAdminWindowIdentity Target = new(Pid, 0x1000);
    private static readonly OverflowMenuResult ValidOverflow = OverflowMenuResult.Pass("TfbTranCli", "Transações");

    private sealed class Fixture
    {
        public FakeOverflowHitTestNativeApi HitTest { get; } = new();
        public FakeMsaaAccessibilityApi Msaa { get; } = new();
        public WindowsNexExportTrigger Trigger { get; }

        public Fixture()
        {
            Trigger = new WindowsNexExportTrigger(HitTest, Msaa);
            HitTest.TopLevelByClassResult = new List<nint> { PopupHwnd };
            HitTest.ParentByHwnd[PopupHwnd] = PopupOwnerHwnd;
            HitTest.ClassNameByHwnd[PopupOwnerHwnd] = "TfbTranCli";
            HitTest.TitleByHwnd[PopupOwnerHwnd] = "Transações";
            HitTest.WindowRect = (Left, Top, Right, Bottom);
        }

        public void SetupExportItem(int role = 43, int state = 0)
        {
            Msaa.NamesByPoint[(Left + 10, Top + 35)] = ExportName;
            Msaa.RoleByName[ExportName] = role;
            Msaa.StateByName[ExportName] = state;
        }

        /// <summary>Configura N scan-points diferentes com o MESMO nome -
        /// por padrao (sem overrides por ponto) todos caem no mesmo
        /// fingerprint (role/state default de RoleByName/StateByName,
        /// location=null, childId="0" em todos), simulando o achado real
        /// do Probe 13A (mesmo botao alto o bastante para gerar varios
        /// hits de scan).</summary>
        public void SetupDuplicateHitsSameElement(params int[] scanYs)
        {
            foreach (var y in scanYs)
            {
                Msaa.NamesByPoint[(Left + 10, y)] = ExportName;
            }
            Msaa.RoleByName[ExportName] = 43;
            Msaa.StateByName[ExportName] = 0;
        }
    }

    [Fact]
    public void N_AccDoDefaultActionExatamenteUma_Pass()
    {
        var f = new Fixture();
        f.SetupExportItem();

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.True(result.Dispatched);
        Assert.Equal(1, f.Msaa.DoDefaultActionCalls);
    }

    [Fact]
    public void AG_ReacquireMsaaFresco_NuncaReaproveitaHandleAntigo()
    {
        var f = new Fixture();
        f.SetupExportItem();

        // Chama duas vezes seguidas (simulando 2 execucoes distintas do
        // orquestrador) - cada uma DEVE fazer seu proprio HitTest, nunca
        // reaproveitar o resultado da anterior. OverflowMenuResult nao
        // carrega nenhum handle - a unica forma de "reaproveitar" seria
        // um bug de cache interno, que este teste descarta indiretamente
        // ao provar que accDoDefaultAction e' chamado 1x POR chamada.
        f.Trigger.TriggerExport(Target, ValidOverflow);
        f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.Equal(2, f.Msaa.DoDefaultActionCalls);
    }

    [Fact]
    public void AH_ZeroExportItems_Fail()
    {
        var f = new Fixture();
        // Nenhum item MSAA configurado - HitTest nunca encontra "Exportar..."

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.False(result.Dispatched);
        Assert.Equal(AgentErrorCode.ExportItemNotFound, result.ErrorCode);
        Assert.Equal(0, f.Msaa.DoDefaultActionCalls);
    }

    [Fact]
    public void AJ_RoleOuStateInvalido_NotActionable()
    {
        var f = new Fixture();
        f.SetupExportItem(role: 43, state: 0x1); // STATE_SYSTEM_UNAVAILABLE

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.False(result.Dispatched);
        Assert.Equal(AgentErrorCode.ExportItemNotActionable, result.ErrorCode);
        Assert.Equal(0, f.Msaa.DoDefaultActionCalls);
    }

    [Fact]
    public void PopupFechadoOuTrocadoDesdeOpenOverflowMenu_Block()
    {
        var f = new Fixture();
        f.HitTest.ClassNameByHwnd[PopupOwnerHwnd] = "OutraClasse"; // owner nao bate mais

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.False(result.Dispatched);
        Assert.Equal(AgentErrorCode.OverflowWrongPopup, result.ErrorCode);
    }

    // ======================================================
    // Deduplicacao MSAA por fingerprint - matriz A-L (correcao pos-Probe 13A)
    // ======================================================

    [Fact]
    public void A_DoisHitsBrutosMesmoFingerprint_UniqueUm_PassIdentificacao()
    {
        var f = new Fixture();
        f.SetupDuplicateHitsSameElement(Top + 20, Top + 35); // reproduz exatamente o achado real (2 hits, mesmo botao)

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.True(result.Dispatched);
    }

    [Fact]
    public void B_TresHitsBrutosMesmoFingerprint_UniqueUm()
    {
        var f = new Fixture();
        f.SetupDuplicateHitsSameElement(Top + 20, Top + 35, Top + 50);

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.True(result.Dispatched);
        Assert.Equal(1, f.Msaa.DoDefaultActionCalls);
    }

    [Fact]
    public void C_MesmoNomeERole_LocationDiferente_UniqueDois_Ambiguous_ZeroAction()
    {
        var f = new Fixture();
        var p1 = (Left + 10, Top + 20);
        var p2 = (Left + 10, Top + 35);
        f.Msaa.NamesByPoint[p1] = ExportName;
        f.Msaa.NamesByPoint[p2] = ExportName;
        f.Msaa.RoleByName[ExportName] = 43;
        f.Msaa.LocationByPoint[p1] = (100, 100, 50, 20); // elemento A
        f.Msaa.LocationByPoint[p2] = (100, 300, 50, 20); // elemento B - posicao realmente diferente

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.False(result.Dispatched);
        Assert.Equal(AgentErrorCode.ExportItemAmbiguous, result.ErrorCode);
        Assert.Equal(0, f.Msaa.DoDefaultActionCalls);
        Assert.Contains("RAW_EXPORT_HIT_COUNT=2", result.Reason);
        Assert.Contains("UNIQUE_EXPORT_ELEMENT_COUNT=2", result.Reason);
    }

    [Fact]
    public void D_MesmaLocation_RoleDiferente_ElementosDistintos_FailClosed()
    {
        var f = new Fixture();
        var p1 = (Left + 10, Top + 20);
        var p2 = (Left + 10, Top + 35);
        f.Msaa.NamesByPoint[p1] = ExportName;
        f.Msaa.NamesByPoint[p2] = ExportName;
        f.Msaa.LocationByPoint[p1] = (100, 100, 50, 20);
        f.Msaa.LocationByPoint[p2] = (100, 100, 50, 20); // mesma location
        f.Msaa.RoleByPoint[p1] = 43; // PUSHBUTTON
        f.Msaa.RoleByPoint[p2] = 9;  // role diferente - elemento semanticamente distinto

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.False(result.Dispatched);
        Assert.Equal(AgentErrorCode.ExportItemAmbiguous, result.ErrorCode);
        Assert.Equal(0, f.Msaa.DoDefaultActionCalls);
    }

    [Fact]
    public void E_ZeroHits_ExportItemNotFound()
    {
        var f = new Fixture();

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.False(result.Dispatched);
        Assert.Equal(AgentErrorCode.ExportItemNotFound, result.ErrorCode);
        Assert.Equal(0, f.Msaa.DoDefaultActionCalls);
    }

    [Fact]
    public void F_UmElementoUnico_AccDoDefaultActionExatamenteUma()
    {
        var f = new Fixture();
        f.SetupExportItem();

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.True(result.Dispatched);
        Assert.Equal(1, f.Msaa.DoDefaultActionCalls);
    }

    [Fact]
    public void G_MultiplosHitsDuplicadosDoMesmoElemento_AccDoDefaultActionContinuaExatamenteUma()
    {
        var f = new Fixture();
        f.SetupDuplicateHitsSameElement(Top + 5, Top + 20, Top + 35, Top + 50, Top + 65);

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.True(result.Dispatched);
        Assert.Equal(1, f.Msaa.DoDefaultActionCalls);
    }

    [Fact]
    public void H_DoisElementosUnicos_AccDoDefaultActionCountZero()
    {
        var f = new Fixture();
        var p1 = (Left + 10, Top + 20);
        var p2 = (Left + 10, Top + 35);
        f.Msaa.NamesByPoint[p1] = ExportName;
        f.Msaa.NamesByPoint[p2] = ExportName;
        f.Msaa.RoleByName[ExportName] = 43;
        f.Msaa.LocationByPoint[p1] = (10, 10, 50, 20);
        f.Msaa.LocationByPoint[p2] = (10, 400, 50, 20);

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.False(result.Dispatched);
        Assert.Equal(0, f.Msaa.DoDefaultActionCalls);
    }

    [Fact]
    public void J_DiagnosticosRawEUniqueCoerentes()
    {
        var f = new Fixture();
        var p1 = (Left + 10, Top + 20);
        var p2 = (Left + 10, Top + 35);
        var p3 = (Left + 10, Top + 50);
        f.Msaa.NamesByPoint[p1] = ExportName;
        f.Msaa.NamesByPoint[p2] = ExportName;
        f.Msaa.NamesByPoint[p3] = ExportName;
        f.Msaa.RoleByName[ExportName] = 43;
        f.Msaa.LocationByPoint[p1] = (10, 10, 50, 20);
        f.Msaa.LocationByPoint[p2] = (10, 10, 50, 20); // duplicata de p1
        f.Msaa.LocationByPoint[p3] = (10, 400, 50, 20); // elemento distinto

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.False(result.Dispatched);
        Assert.Contains("RAW_EXPORT_HIT_COUNT=3", result.Reason);
        Assert.Contains("UNIQUE_EXPORT_ELEMENT_COUNT=2", result.Reason);
    }

    [Fact]
    public void K_NuncaReutilizaIAccessibleEntreOverflowMenuOpenerEExportTrigger()
    {
        // OverflowMenuResult (produzido por WindowsNexOverflowMenuOpener)
        // so' carrega PopupOwnerClass/PopupOwnerTitle (strings) - nunca um
        // MsaaElementHandle/IAccessible. Este teste prova que
        // TriggerExport funciona corretamente recebendo SOMENTE esses
        // dados imutaveis, sem nenhum campo que pudesse carregar um
        // objeto MSAA vivo entre os dois componentes.
        var f = new Fixture();
        f.SetupExportItem();

        Assert.Null(ValidOverflow.GetType().GetProperty("MsaaElement"));
        Assert.Null(ValidOverflow.GetType().GetProperty("AccessibleObject"));

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);
        Assert.True(result.Dispatched);
    }

    [Fact]
    public void AI_MultiploExportItems_LocationDiferente_FailNuncaEscolhePrimeiro()
    {
        // Substitui o antigo teste AI (que assumia contagem bruta = ambiguidade):
        // apos a correcao pos-Probe 13A, ambiguidade real exige localizacoes
        // (fingerprints) DIFERENTES - dois hits do MESMO botao (mesma
        // location) agora sao deduplicados e NAO geram mais este erro
        // (ver teste A).
        var f = new Fixture();
        var p1 = (Left + 10, Top + 20);
        var p2 = (Left + 10, Top + 35);
        f.Msaa.NamesByPoint[p1] = ExportName;
        f.Msaa.NamesByPoint[p2] = ExportName;
        f.Msaa.RoleByName[ExportName] = 43;
        f.Msaa.LocationByPoint[p1] = (10, 10, 50, 20);
        f.Msaa.LocationByPoint[p2] = (10, 400, 50, 20);

        var result = f.Trigger.TriggerExport(Target, ValidOverflow);

        Assert.False(result.Dispatched);
        Assert.Equal(AgentErrorCode.ExportItemAmbiguous, result.ErrorCode);
        Assert.Equal(0, f.Msaa.DoDefaultActionCalls);
    }
}
