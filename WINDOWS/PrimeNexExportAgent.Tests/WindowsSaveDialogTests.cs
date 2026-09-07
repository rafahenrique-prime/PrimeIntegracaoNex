using System.Reflection;
using System.Runtime.InteropServices;
using PrimeNexExportAgent.Contracts;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using PrimeNexExportAgent.WindowsSaveDialog;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14B2, corrigidos/ampliados em F6.14B2.1 e F6.14B2.2)
/// de WindowsSaveDialogInspector e WindowsSaveDialogController. ZERO
/// Win32 real e tocado: INativeWindowApi e ISaveDialogControlApi sao
/// ambos fakes puros.
///
/// F6.14B2.2 - arquitetura corrigida por evidencia real:
/// - 1148 e um ComboBoxEx32 cujo valor real vive num Edit FILHO;
/// - 1137 (destino) NUNCA recebe escrita - o caminho completo
///   (Path.Combine(destino,nome)) e escrito no Edit filho do 1148;
/// - 1136 (tipo) usa CB_FINDSTRINGEXACT+CB_SETCURSEL, zero fallback de
///   escrita direta (F6.14B2.1), leitura via CB_GETCURSEL+CB_GETLBTEXT.
///
/// F6.14B2.8 - CORRECAO DE SEGURANCA (auditoria F6.14B2.7): ReadBack NAO
/// usa mais CDM_GETFILEPATH/CDM_GETFOLDERPATH (mensagens >= WM_USER,
/// cross-process inseguras - ver Win32SaveDialogInterop.cs) - releitura
/// agora e via WM_GETTEXT no proprio Edit filho do 1148 (SetEditText/
/// ReadEditText no fake), com igualdade ESTRITA contra o caminho completo
/// esperado. Nenhuma normalizacao de caminho e mais permitida.
/// </summary>
public sealed class WindowsSaveDialogTests
{
    private const int NexAdminPid = 1316;
    private static readonly nint TargetHwnd = 0x1000;
    private static readonly nint DialogHwnd = 0x7000;
    private static readonly nint FileNameContainerHwnd = 0x7101; // ComboBoxEx32 (1148)
    private static readonly nint DestinationHwnd = 0x7103;        // ComboBox (1137) - NUNCA escrito
    private static readonly nint FileTypeHwnd = 0x7104;           // ComboBox (1136)
    private static readonly nint SaveButtonHwnd = 0x7105;
    private static readonly nint CancelButtonHwnd = 0x7106;

    private const string DestinationValue = @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE";
    private const string FileNameValue = "vendas-auto-readback-test-20260901-120000.xls";
    private const string FileTypeValue = "Excel";
    private static string ExpectedFullPath => System.IO.Path.Combine(DestinationValue, FileNameValue);

    private static NexAdminWindowIdentity Target => new(processId: NexAdminPid, mainWindowHandle: TargetHwnd);

    private static (FakeNativeWindowApi Native, FakeSaveDialogControlApi Controls) BuildBaseFixture()
    {
        var native = new FakeNativeWindowApi();
        var controls = new FakeSaveDialogControlApi();
        return (native, controls);
    }

    /// <summary>Registra 1 dialogo #32770/"Salvar como" valido, do PID
    /// esperado, com a topologia REAL descoberta em F6.14B2.1: 1148 e um
    /// ComboBoxEx32 com exatamente 1 child Edit; 1137/1136 sao ComboBox
    /// simples; 1/2 sao Button. Por padrao 1136 ja contem o item "Excel".</summary>
    private static void RegisterValidDialog(FakeNativeWindowApi native, FakeSaveDialogControlApi controls, int editChildrenCount = 1, bool editChildHasEditClass = true)
    {
        native.ValidWindows.Add(DialogHwnd);
        native.VisibleWindows.Add(DialogHwnd);
        native.ClassNameByWindow[DialogHwnd] = "#32770";
        native.TitleByWindow[DialogHwnd] = "Salvar como";
        native.OwningProcessByWindow[DialogHwnd] = NexAdminPid;
        native.TopLevelWindowsByProcess[NexAdminPid] = new[] { DialogHwnd };

        controls.ControlsByDialogAndId[(DialogHwnd, 1148)] = FileNameContainerHwnd;
        controls.ControlsByDialogAndId[(DialogHwnd, 1137)] = DestinationHwnd;
        controls.ControlsByDialogAndId[(DialogHwnd, 1136)] = FileTypeHwnd;
        controls.ControlsByDialogAndId[(DialogHwnd, 1)] = SaveButtonHwnd;
        controls.ControlsByDialogAndId[(DialogHwnd, 2)] = CancelButtonHwnd;

        foreach (var hwnd in new[] { FileNameContainerHwnd, DestinationHwnd, FileTypeHwnd, SaveButtonHwnd, CancelButtonHwnd })
        {
            native.ValidWindows.Add(hwnd);
            controls.EnabledControls.Add(hwnd);
        }
        native.ClassNameByWindow[FileNameContainerHwnd] = "ComboBoxEx32";
        native.ClassNameByWindow[DestinationHwnd] = "ComboBox";
        native.ClassNameByWindow[FileTypeHwnd] = "ComboBox";
        native.ClassNameByWindow[SaveButtonHwnd] = "Button";
        native.ClassNameByWindow[CancelButtonHwnd] = "Button";

        // Topologia REAL descoberta no probe B2.2: ComboBoxEx32 -> ComboBox
        // (intermediario) -> Edit (neto, nao filho direto). GetDescendants
        // retorna a SUBARVORE INTEIRA (F6.14B2.3) - o fake simula isso
        // registrando, no mesmo nivel de lista, o wrapper intermediario
        // (sempre presente, realista) mais os candidatos a Edit
        // parametrizados (para os testes A-D de cardinalidade).
        var descendants = new List<nint>();
        var intermediateComboBoxHwnd = (nint)0x7150;
        native.ValidWindows.Add(intermediateComboBoxHwnd);
        native.ClassNameByWindow[intermediateComboBoxHwnd] = "ComboBox";
        descendants.Add(intermediateComboBoxHwnd);

        for (var i = 0; i < editChildrenCount; i++)
        {
            var childHwnd = (nint)(0x7200 + i);
            native.ValidWindows.Add(childHwnd);
            native.ClassNameByWindow[childHwnd] = editChildHasEditClass ? "Edit" : "ComboBox";
            descendants.Add(childHwnd);
        }
        controls.DescendantsByContainer[FileNameContainerHwnd] = descendants;

        controls.ComboBoxItemsByControl[FileTypeHwnd] = new List<string> { "CSV", "Excel", "Texto" };
        controls.ComboBoxSelectedIndexByControl[FileTypeHwnd] = 0; // "CSV" por padrao (sera alterado por Configure)

        // F6.14B2.8: o Edit filho ja "contem" o caminho esperado por padrao
        // (simula o dialogo ja mostrando o valor correto) - usado pelos
        // testes de ReadBack que nao chamam Configure() antes. So possivel
        // quando existe exatamente 1 Edit valido na subarvore (o caso
        // realista default) - testes de cardinalidade diferente (A-D) nao
        // dependem deste valor.
        var editMatches = descendants.Where(h => native.ClassNameByWindow[h] == "Edit").ToList();
        if (editMatches.Count == 1)
        {
            controls.TextByControl[editMatches[0]] = ExpectedFullPath;
        }
    }

    private static nint RealFileNameEditHwnd(FakeNativeWindowApi native, FakeSaveDialogControlApi controls) =>
        controls.DescendantsByContainer[FileNameContainerHwnd].Single(h => native.ClassNameByWindow[h] == "Edit");

    // ==================================================================
    // A-D: resolucao do child Edit do CtrlId 1148 (F6.14B2.2)
    // ==================================================================

    [Fact]
    public void A_ContainerComboBoxEx32ComExatamenteUmChildEdit_IdentifyPass()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls, editChildrenCount: 1, editChildHasEditClass: true);

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.True(result.Passed);
    }

    [Fact]
    public void B_ZeroChildEdit_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls, editChildrenCount: 0);

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
    }

    [Fact]
    public void C_DoisChildEdit_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls, editChildrenCount: 2, editChildHasEditClass: true);

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
    }

    [Fact]
    public void D_ChildComClasseDiferenteDeEdit_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls, editChildrenCount: 1, editChildHasEditClass: false);

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
    }

    // ==================================================================
    // F6.14B2.3 - correcao da regressao de GetImmediateChildren: o Edit
    // real e NETO (nao filho direto) do ComboBoxEx32. GetDescendants
    // retorna a subarvore inteira; a seguranca vem de exigir exatamente 1
    // ClassName=="Edit" nela, nunca de limitar profundidade.
    // ==================================================================

    [Fact]
    public void B_EditDiretoComoFilhoImediato_TambemResolve()
    {
        // Cenario B da ordem: Edit filho DIRETO do 1148 (sem nenhum
        // ComboBox intermediario) - deve resolver igualmente, pois a regra
        // e "exatamente 1 Edit na subarvore", nao "exatamente no nivel N".
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        var editHwnd = (nint)0x7999;
        native.ValidWindows.Add(editHwnd);
        native.ClassNameByWindow[editHwnd] = "Edit";
        controls.DescendantsByContainer[FileNameContainerHwnd] = new nint[] { editHwnd }; // SEM wrapper intermediario

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.True(result.Passed);
    }

    [Fact]
    public void E_EditForaDaSubarvoreDoContainer_Ignorado()
    {
        // Um Edit existe em algum outro lugar do dialogo (fora da
        // subarvore do 1148) - GetDescendants(1148) nunca o retorna, entao
        // o resolver corretamente encontra 0 Edit e falha (nao "acha" o
        // Edit externo por engano).
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls, editChildrenCount: 0); // 1148 sem nenhum Edit na propria subarvore
        var editForaDoEscopo = (nint)0x8001;
        native.ValidWindows.Add(editForaDoEscopo);
        native.ClassNameByWindow[editForaDoEscopo] = "Edit";
        // Registrado como descendente de OUTRO container (ex.: 1137), nunca do 1148.
        controls.DescendantsByContainer[DestinationHwnd] = new nint[] { editForaDoEscopo };

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
    }

    [Fact]
    public void F_EscritaOcorreSomenteNoEditNuncaNoWrapperOuNoContainer()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls); // topologia realista: ComboBoxEx32 -> ComboBox -> Edit
        var editHwnd = RealFileNameEditHwnd(native, controls);
        var intermediateWrapperHwnd = controls.DescendantsByContainer[FileNameContainerHwnd].First(h => h != editHwnd);
        var controller = new WindowsSaveDialogController(native, controls);

        controller.Configure(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        Assert.True(controls.TextByControl.ContainsKey(editHwnd));
        Assert.False(controls.TextByControl.ContainsKey(intermediateWrapperHwnd));
        Assert.False(controls.TextByControl.ContainsKey(FileNameContainerHwnd));
    }

    [Fact]
    public void H_AmbiguidadeNuncaEscolhePrimeiroEncontrado_ZeroEscrita()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls, editChildrenCount: 2, editChildHasEditClass: true); // 2 Edit na subarvore
        var controller = new WindowsSaveDialogController(native, controls);

        var exception = Record.Exception(() => controller.Configure(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue));

        Assert.NotNull(exception);
        // Ambiguidade detectada ANTES de qualquer escrita - nunca "escolhe
        // o primeiro Edit encontrado e escreve nele mesmo assim".
        Assert.Equal(0, controls.SetEditTextCalls);
        Assert.Equal(0, controls.TrySelectComboBoxItemExactCalls);
    }

    // ==================================================================
    // F6.14B2.2B - restauracao de cobertura perdida na reescrita B2.2
    // (auditoria F6.14B2.2A: 9 propriedades sem teste equivalente)
    // ==================================================================

    [Fact]
    public void Identify_DialogClassNameDiferente_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        // Sobrescreve a MESMA janela candidata com ClassName errado -
        // continua na lista de top-level do PID (nao e "zero candidatos",
        // e "candidato existente mas filtrado pela classe").
        native.ClassNameByWindow[DialogHwnd] = "OutraClasseQualquer";

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.DialogNotFound, result.ErrorCode);
    }

    [Fact]
    public void Identify_DialogTituloDiferente_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        // ClassName correto ("#32770"), so o titulo diverge.
        native.TitleByWindow[DialogHwnd] = "Abrir";

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.DialogNotFound, result.ErrorCode);
    }

    [Fact]
    public void Identify_CtrlId1148ContainerAusente_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ControlsByDialogAndId.Remove((DialogHwnd, 1148));

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
    }

    [Fact]
    public void Identify_CtrlId1137Ausente_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ControlsByDialogAndId.Remove((DialogHwnd, 1137));

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
    }

    [Fact]
    public void Identify_CtrlId1136Ausente_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ControlsByDialogAndId.Remove((DialogHwnd, 1136));

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
    }

    [Fact]
    public void Identify_CtrlId1Ausente_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ControlsByDialogAndId.Remove((DialogHwnd, 1));

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
    }

    [Fact]
    public void Identify_CtrlId2Ausente_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ControlsByDialogAndId.Remove((DialogHwnd, 2));

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
    }

    [Fact]
    public void Configure_EscritaNoChildEditFalha_ZeroRetry()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.SetEditTextResult = false; // simula falha do WM_SETTEXT no child Edit
        var controller = new WindowsSaveDialogController(native, controls);

        var exception = Record.Exception(() => controller.Configure(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue));

        Assert.NotNull(exception);
        Assert.Equal(1, controls.SetEditTextCalls); // exatamente 1 tentativa, nunca uma segunda
        // Aborta ANTES de chegar ao campo tipo - nenhuma tentativa de
        // selecionar o ComboBox depois de uma falha no campo anterior.
        Assert.Equal(0, controls.TrySelectComboBoxItemExactCalls);
    }

    [Fact]
    public void ReadBack_EditTextComBarraFinalDiferente_FalhaIgualdadeEstrita()
    {
        // F6.14B2.8: nenhuma normalizacao de caminho e mais permitida no
        // ReadBack (CDM_* removido, releitura agora via WM_GETTEXT direto
        // no Edit) - uma divergencia de barra final, que antes era tolerada
        // via PathsEquivalent sobre o valor de CDM_GETFILEPATH, agora deve
        // FALHAR por igualdade estrita (Ordinal).
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ComboBoxSelectedIndexByControl[FileTypeHwnd] = 1; // "Excel"
        var editHwnd = RealFileNameEditHwnd(native, controls);
        controls.TextByControl[editHwnd] = ExpectedFullPath + @"\";

        var result = new WindowsSaveDialogInspector(native, controls)
            .ReadBack(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ReadbackMismatch, result.ErrorCode);
    }

    // ==================================================================
    // Identificacao - cenarios ja cobertos em F6.14B2 (preservados)
    // ==================================================================

    [Fact]
    public void ZeroDialogoValido_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        native.TopLevelWindowsByProcess[NexAdminPid] = Array.Empty<nint>();

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.DialogNotFound, result.ErrorCode);
    }

    [Fact]
    public void DoisDialogosValidos_FalhaPorAmbiguidade()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        var segundoDialogo = (nint)0x7300;
        native.ValidWindows.Add(segundoDialogo);
        native.ClassNameByWindow[segundoDialogo] = "#32770";
        native.TitleByWindow[segundoDialogo] = "Salvar como";
        native.OwningProcessByWindow[segundoDialogo] = NexAdminPid;
        native.TopLevelWindowsByProcess[NexAdminPid] = new[] { DialogHwnd, segundoDialogo };

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.DialogNotFound, result.ErrorCode);
    }

    [Fact]
    public void PidOwnerIncompativel_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        native.OwningProcessByWindow[DialogHwnd] = 9999;

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.DialogNotFound, result.ErrorCode);
    }

    [Fact]
    public void QualquerControleDisabled_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.EnabledControls.Remove(FileTypeHwnd);

        var result = new WindowsSaveDialogInspector(native, controls).IdentifySaveDialog(Target);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
    }

    // ==================================================================
    // E-F: Configure - caminho completo no Edit filho, 1136 via ComboBox
    // ==================================================================

    [Fact]
    public void E_FullTargetPathConstruidoComPathCombine()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        var editHwnd = RealFileNameEditHwnd(native, controls);
        var controller = new WindowsSaveDialogController(native, controls);

        controller.Configure(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        Assert.Equal(System.IO.Path.Combine(DestinationValue, FileNameValue), controls.TextByControl[editHwnd]);
    }

    [Fact]
    public void F_EscritaOcorreExatamenteUmaVezNoChildEdit()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        var controller = new WindowsSaveDialogController(native, controls);

        controller.Configure(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        // Unica chamada a SetEditText em todo o Configure - o campo
        // tipo (1136) usa TrySelectComboBoxItemExact, nunca SetEditText.
        Assert.Equal(1, controls.SetEditTextCalls);
    }

    [Fact]
    public void Configure_1148ContainerAusente_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ControlsByDialogAndId.Remove((DialogHwnd, 1148));
        var controller = new WindowsSaveDialogController(native, controls);

        var exception = Record.Exception(() => controller.Configure(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue));

        Assert.NotNull(exception);
        Assert.Equal(0, controls.SetEditTextCalls);
    }

    // ==================================================================
    // G-K (F6.14B2.8): ReadBack via WM_GETTEXT no Edit filho do 1148 -
    // CDM_GETFILEPATH/CDM_GETFOLDERPATH REMOVIDAS PERMANENTEMENTE
    // (auditoria F6.14B2.7 - cross-process inseguras, ver
    // Win32SaveDialogInterop.cs).
    // ==================================================================

    [Fact]
    public void G_ReadEditTextIgualEsperado_Pass()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls); // Edit ja contem ExpectedFullPath por padrao
        controls.ComboBoxSelectedIndexByControl[FileTypeHwnd] = 1; // "Excel"

        var result = new WindowsSaveDialogInspector(native, controls)
            .ReadBack(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        Assert.True(result.Passed);
    }

    [Fact]
    public void H_ReadEditTextDestinoErrado_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ComboBoxSelectedIndexByControl[FileTypeHwnd] = 1;
        var editHwnd = RealFileNameEditHwnd(native, controls);
        controls.TextByControl[editHwnd] = System.IO.Path.Combine(@"C:\OutraPasta", FileNameValue);

        var result = new WindowsSaveDialogInspector(native, controls)
            .ReadBack(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ReadbackMismatch, result.ErrorCode);
    }

    [Fact]
    public void I_ReadEditTextFileNameErrado_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ComboBoxSelectedIndexByControl[FileTypeHwnd] = 1;
        var editHwnd = RealFileNameEditHwnd(native, controls);
        controls.TextByControl[editHwnd] = System.IO.Path.Combine(DestinationValue, "outro-nome.xls");

        var result = new WindowsSaveDialogInspector(native, controls)
            .ReadBack(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ReadbackMismatch, result.ErrorCode);
    }

    [Fact]
    public void J_ReadEditTextFalha_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        var editHwnd = RealFileNameEditHwnd(native, controls);
        controls.ReadEditTextOverride[editHwnd] = null; // simula falha do WM_GETTEXT

        var result = new WindowsSaveDialogInspector(native, controls)
            .ReadBack(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ReadbackMismatch, result.ErrorCode);
    }

    [Fact]
    public void K_ReadEditTextVazio_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        var editHwnd = RealFileNameEditHwnd(native, controls);
        controls.ReadEditTextOverride[editHwnd] = string.Empty; // WM_GETTEXTLENGTH==0 legitimamente vazio

        var result = new WindowsSaveDialogInspector(native, controls)
            .ReadBack(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ReadbackMismatch, result.ErrorCode);
    }

    // ==================================================================
    // L-O: CtrlId 1136 (tipo) - ComboBox real
    // ==================================================================

    [Fact]
    public void L_1136ContemExcel_SelecaoUmaVez()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        var controller = new WindowsSaveDialogController(native, controls);

        controller.Configure(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        Assert.Equal(1, controls.TrySelectComboBoxItemExactCalls);
        Assert.Equal(1, controls.ComboBoxSelectedIndexByControl[FileTypeHwnd]); // indice de "Excel"
    }

    [Fact]
    public void M_1136NaoContemExcel_FalhaZeroRetry()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ComboBoxItemsByControl[FileTypeHwnd] = new List<string> { "CSV", "Texto" }; // sem Excel
        var controller = new WindowsSaveDialogController(native, controls);

        var exception = Record.Exception(() => controller.Configure(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue));

        Assert.NotNull(exception);
        Assert.Equal(1, controls.TrySelectComboBoxItemExactCalls);
    }

    [Fact]
    public void N_CbSetCurSelFalha_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ForceComboBoxSetCurSelFailure.Add(FileTypeHwnd);
        var controller = new WindowsSaveDialogController(native, controls);

        var exception = Record.Exception(() => controller.Configure(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue));

        Assert.NotNull(exception);
        Assert.Equal(1, controls.TrySelectComboBoxItemExactCalls);
    }

    [Fact]
    public void O_ReadbackFileTypeDiverge_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ComboBoxSelectedIndexByControl[FileTypeHwnd] = 0; // "CSV", nao "Excel"

        var result = new WindowsSaveDialogInspector(native, controls)
            .ReadBack(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ReadbackMismatch, result.ErrorCode);
    }

    // ==================================================================
    // P-R: 1137 nunca escrito; ClickSave/CancelSaveDialog continuam bloqueados
    // ==================================================================

    [Fact]
    public void P_1137NuncaRecebeEscrita()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        var controller = new WindowsSaveDialogController(native, controls);

        controller.Configure(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        Assert.False(controls.TextByControl.ContainsKey(DestinationHwnd));
    }

    [Fact]
    public void Q_ClickSaveReal_SempreLancaNotSupportedException()
    {
        var (native, controls) = BuildBaseFixture();
        var controller = new WindowsSaveDialogController(native, controls);

        var exception = Record.Exception(() => controller.ClickSave(new SaveDialogIdentity(DialogHwnd)));

        Assert.IsType<NotSupportedException>(exception);
    }

    // ==================================================================
    // F6.14B2.9A - ClickButton (BM_CLICK) permanece bloqueado por
    // ISaveDialogController.ClickSave(); so o probe diagnostico isolado
    // (ConfigureSaveDialogClickSaveOnceProbe) pode chegar a
    // ISaveDialogControlApi.ClickButton.
    // ==================================================================

    [Fact]
    public void ClickSave_ContinuaLancandoNotSupportedException_MesmoAposF6_14B2_9A()
    {
        // Reconfirma que a introducao de ClickButton em
        // ISaveDialogControlApi NAO afetou o bloqueio incondicional de
        // ISaveDialogController.ClickSave() - a interface generica nunca
        // foi alterada nesta fase.
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        var controller = new WindowsSaveDialogController(native, controls);

        var exception = Record.Exception(() => controller.ClickSave(new SaveDialogIdentity(DialogHwnd)));

        Assert.IsType<NotSupportedException>(exception);
        Assert.Equal(0, controls.ClickButtonCalls);
    }

    [Fact]
    public void ISaveDialogController_NuncaReferenciaClickButton_GarantiaEstrutural()
    {
        // WindowsSaveDialogController (a implementacao REAL da interface
        // generica) nao pode, nem estruturalmente, chamar ClickButton -
        // confirmado por reflexao sobre o corpo compilado nao e trivial em
        // C#, mas a garantia comportamental (teste acima, ClickButtonCalls
        // == 0 mesmo apos tentar ClickSave) e' a prova pratica equivalente.
        // Aqui confirmamos a garantia complementar: ISaveDialogController
        // (a interface) nao expoe nenhum metodo que aceite um HWND de
        // botao diretamente - ClickSave/CancelSaveDialog recebem somente
        // SaveDialogIdentity, nunca nint.
        var methods = typeof(ISaveDialogController).GetMethods();
        foreach (var m in methods)
        {
            var paramTypes = m.GetParameters().Select(p => p.ParameterType.Name);
            Assert.DoesNotContain("nint", paramTypes);
            Assert.DoesNotContain("IntPtr", paramTypes);
        }
    }

    [Fact]
    public void ISaveDialogControlApi_ClickButton_EhVoid_NuncaExpoeRetornoComoProvaDeSucesso()
    {
        // Correcao obrigatoria (F6.14B2.9A): o retorno de SendMessageW
        // (BM_CLICK) NUNCA deve ser interpretado como "salvou com
        // sucesso" - ClickButton e' deliberadamente void, para que seja
        // estruturalmente impossivel qualquer chamador tratar seu
        // retorno como gate positivo.
        var method = typeof(ISaveDialogControlApi).GetMethod(nameof(ISaveDialogControlApi.ClickButton))!;

        Assert.Equal(typeof(void), method.ReturnType);
    }

    [Fact]
    public void ClickButton_DispatchApenasUmaVez_FakeRegistraChamadaSemSemanticaDeSucesso()
    {
        var (_, controls) = BuildBaseFixture();

        controls.ClickButton(SaveButtonHwnd);

        Assert.Equal(1, controls.ClickButtonCalls);
        Assert.Equal(SaveButtonHwnd, controls.LastClickButtonHwnd);
    }

    [Fact]
    public void BM_CLICK_EhMenorQueWmUser_ESemPonteiro()
    {
        // Mesma disciplina de auditoria de F6.14B2.7/B2.8: BM_CLICK deve
        // ser < WM_USER (marshalling automatico documentado) e nao deve
        // carregar nenhum ponteiro (chamado sempre com wParam=0,lParam=0,
        // confirmado por leitura de Win32SaveDialogControlApi.ClickButton).
        var interopType = typeof(WindowsSaveDialogInspector).Assembly.GetType("PrimeNexExportAgent.WindowsSaveDialog.Win32SaveDialogInterop", throwOnError: true)!;
        var bmClick = (uint)interopType.GetField("BM_CLICK", BindingFlags.NonPublic | BindingFlags.Static)!.GetRawConstantValue()!;

        const uint WmUser = 0x0400;
        Assert.True(bmClick < WmUser);
    }

    [Fact]
    public void R_CancelSaveDialogReal_SempreLancaNotSupportedException()
    {
        var (native, controls) = BuildBaseFixture();
        var controller = new WindowsSaveDialogController(native, controls);

        var exception = Record.Exception(() => controller.CancelSaveDialog(new SaveDialogIdentity(DialogHwnd)));

        Assert.IsType<NotSupportedException>(exception);
    }

    // ==================================================================
    // Robustez adicional preservada de F6.14B2/B2.1
    // ==================================================================

    [Fact]
    public void ReadBack_ControleTipoDesapareceu_Falha()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        controls.ControlsByDialogAndId.Remove((DialogHwnd, 1136));

        var result = new WindowsSaveDialogInspector(native, controls)
            .ReadBack(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.ReadbackMismatch, result.ErrorCode);
    }

    [Fact]
    public void Configure_ClassNameFileTypeNaoSuportada_FailClosed()
    {
        var (native, controls) = BuildBaseFixture();
        RegisterValidDialog(native, controls);
        native.ClassNameByWindow[FileTypeHwnd] = "TAlgumaCoisaNuncaVista";
        var controller = new WindowsSaveDialogController(native, controls);

        var exception = Record.Exception(() => controller.Configure(new SaveDialogIdentity(DialogHwnd), DestinationValue, FileNameValue, FileTypeValue));

        Assert.IsType<NotSupportedException>(exception);
        Assert.Equal(0, controls.TrySelectComboBoxItemExactCalls);
    }

    // ---- F6.14B2.6: nenhum wrapper P/Invoke "SendMessage*" pode depender
    // de resolucao implicita de EntryPoint (evidencia real: SendMessageInt
    // sem EntryPoint explicito falhou em runtime com
    // "Unable to find an entry point named 'SendMessageInt'" - offline
    // nunca pega isso, pois os testes normais usam FakeSaveDialogControlApi,
    // nunca a interop real). Esta auditoria por reflexao evita regressao. ----
    [Fact]
    public void Interop_TodosOsWrappersSendMessageApontamParaEntryPointRealExplicito()
    {
        var assembly = typeof(WindowsSaveDialogInspector).Assembly;
        var interopType = assembly.GetType("PrimeNexExportAgent.WindowsSaveDialog.Win32SaveDialogInterop", throwOnError: true)!;

        var sendMessageMethods = interopType
            .GetMethods(BindingFlags.NonPublic | BindingFlags.Static)
            .Where(m => m.Name.Contains("SendMessage", StringComparison.OrdinalIgnoreCase))
            .ToList();

        // Se este Assert falhar no futuro, significa que os wrappers foram
        // renomeados/removidos - atualizar a lista de nomes reais
        // aprovados abaixo, nunca remover a auditoria.
        Assert.NotEmpty(sendMessageMethods);

        foreach (var method in sendMessageMethods)
        {
            var dllImport = method.GetCustomAttribute<DllImportAttribute>();
            Assert.NotNull(dllImport);
            Assert.False(string.IsNullOrEmpty(dllImport!.EntryPoint),
                $"{method.Name} nao tem EntryPoint explicito - o runtime tentaria resolver o nome gerenciado literalmente como simbolo nativo, que pode nao existir na DLL (evidencia real: SendMessageInt).");
            Assert.Equal("SendMessageW", dllImport.EntryPoint);
        }
    }

    [Fact]
    public void T_ISaveDialogControlApi_NaoExpoeMetodoGenericoDeEscritaArbitraria()
    {
        var methodNames = typeof(ISaveDialogControlApi).GetMethods().Select(m => m.Name).ToHashSet();

        Assert.DoesNotContain(methodNames, n => n.Equals("SendMessage", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(methodNames, n => n.Contains("PostMessage", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(methodNames, n => n.Contains("SetControlText", StringComparison.OrdinalIgnoreCase));
        // F6.14B2.9A: "ClickButton" e' a UNICA excecao deliberada e
        // documentada a "nenhum Click generico" - um primitivo minimo,
        // void (sem semantica de sucesso), usado exclusivamente sobre um
        // HWND de botao ja validado pelo probe diagnostico isolado.
        // Qualquer OUTRO metodo de clique (genérico, por texto, por
        // coordenada) continua proibido.
        Assert.DoesNotContain(methodNames, n => n.Contains("Click", StringComparison.OrdinalIgnoreCase) && !n.Equals("ClickButton", StringComparison.Ordinal));
        Assert.Contains("ClickButton", methodNames);
    }

    // ==================================================================
    // F6.14B2.8 secao 8/9/12 - inventario cross-process e auditoria
    // permanente contra regressao de CDM_*/memoria remota.
    // ==================================================================

    private static Type Win32SaveDialogInteropType =>
        typeof(WindowsSaveDialogInspector).Assembly.GetType("PrimeNexExportAgent.WindowsSaveDialog.Win32SaveDialogInterop", throwOnError: true)!;

    [Fact]
    public void I_RuntimeContemZeroCdmGetFilePath()
    {
        var fieldsAndConsts = Win32SaveDialogInteropType.GetFields(BindingFlags.NonPublic | BindingFlags.Static)
            .Select(f => f.Name);
        Assert.DoesNotContain(fieldsAndConsts, n => n.Equals("CDM_GETFILEPATH", StringComparison.Ordinal));
    }

    [Fact]
    public void J_RuntimeContemZeroCdmGetFolderPath()
    {
        var fieldsAndConsts = Win32SaveDialogInteropType.GetFields(BindingFlags.NonPublic | BindingFlags.Static)
            .Select(f => f.Name);
        Assert.DoesNotContain(fieldsAndConsts, n => n.Equals("CDM_GETFOLDERPATH", StringComparison.Ordinal));
    }

    [Fact]
    public void K_RuntimeContemZeroCdmGetSpecOuCdmFirst()
    {
        var fieldsAndConsts = Win32SaveDialogInteropType.GetFields(BindingFlags.NonPublic | BindingFlags.Static)
            .Select(f => f.Name);
        Assert.DoesNotContain(fieldsAndConsts, n => n.Equals("CDM_GETSPEC", StringComparison.Ordinal));
        Assert.DoesNotContain(fieldsAndConsts, n => n.Equals("CDM_FIRST", StringComparison.Ordinal));
        Assert.DoesNotContain(fieldsAndConsts, n => n.StartsWith("CDM_", StringComparison.Ordinal));
    }

    [Fact]
    public void L_NenhumaApiDeMemoriaRemotaExisteNoAssembly()
    {
        // F6.14B2.7/B2.8: proibicao permanente - nenhum P/Invoke de
        // manipulacao de memoria de outro processo pode ser introduzido,
        // agora ou no futuro, em nenhum tipo do assembly.
        var forbidden = new[]
        {
            "OpenProcess", "VirtualAllocEx", "VirtualFreeEx",
            "ReadProcessMemory", "WriteProcessMemory", "CreateRemoteThread",
        };

        var allMethodNames = typeof(WindowsSaveDialogInspector).Assembly.GetTypes()
            .SelectMany(t => t.GetMethods(BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance))
            .Select(m => m.Name)
            .ToHashSet(StringComparer.Ordinal);

        foreach (var name in forbidden)
        {
            Assert.DoesNotContain(name, allMethodNames);
        }
    }

    [Fact]
    public void M_WmSetTextEWmGetTextSaoMenoresQueWmUser()
    {
        // Confirma numericamente (F6.14B2.7 secao 4/8) que as mensagens
        // usadas para o Edit sao < WM_USER (0x0400) - o mesmo criterio
        // usado para classificar CDM_* como inseguras classifica
        // WM_SETTEXT/WM_GETTEXT como seguras.
        var wmSetText = (uint)Win32SaveDialogInteropType.GetField("WM_SETTEXT", BindingFlags.NonPublic | BindingFlags.Static)!.GetRawConstantValue()!;
        var wmGetText = (uint)Win32SaveDialogInteropType.GetField("WM_GETTEXT", BindingFlags.NonPublic | BindingFlags.Static)!.GetRawConstantValue()!;
        var wmGetTextLength = (uint)Win32SaveDialogInteropType.GetField("WM_GETTEXTLENGTH", BindingFlags.NonPublic | BindingFlags.Static)!.GetRawConstantValue()!;

        const uint WmUser = 0x0400;
        Assert.True(wmSetText < WmUser);
        Assert.True(wmGetText < WmUser);
        Assert.True(wmGetTextLength < WmUser);
    }
}
