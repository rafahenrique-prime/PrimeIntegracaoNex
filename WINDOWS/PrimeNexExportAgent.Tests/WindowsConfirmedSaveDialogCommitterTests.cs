using System.IO;
using System.Linq;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// F6.14B2.12C1 - testes offline (fakes) do WindowsConfirmedSaveDialogCommitter.
/// ZERO Win32 real, ZERO NEX, ZERO BM_CLICK real - tudo via
/// FakeSaveDialogInspector/FakeSaveDialogControlApi/FakeNativeWindowApi.
/// </summary>
public sealed class WindowsConfirmedSaveDialogCommitterTests
{
    private static readonly NexAdminWindowIdentity Target = new(processId: 1234, mainWindowHandle: 0x1000);
    private static readonly SaveDialogIdentity ExpectedDialog = new(dialogHandle: 0x7000);
    private const int CtrlIdSave = 1;
    private const nint SaveButtonHwnd = 0x7100;

    private static (CallSpy Spy, FakeSaveDialogInspector Inspector, FakeSaveDialogControlApi ControlApi, FakeNativeWindowApi NativeWindows, WindowsConfirmedSaveDialogCommitter Committer) BuildHappyPathFixture()
    {
        var spy = new CallSpy();
        var inspector = new FakeSaveDialogInspector(spy) { IdentityResult = SaveDialogIdentityResult.Pass(ExpectedDialog) };
        var controlApi = new FakeSaveDialogControlApi();
        controlApi.ControlsByDialogAndId[(ExpectedDialog.DialogHandle, CtrlIdSave)] = SaveButtonHwnd;
        controlApi.EnabledControls.Add(SaveButtonHwnd);
        var nativeWindows = new FakeNativeWindowApi();
        nativeWindows.ValidWindows.Add(SaveButtonHwnd);
        var committer = new WindowsConfirmedSaveDialogCommitter(inspector, controlApi, nativeWindows);
        return (spy, inspector, controlApi, nativeWindows, committer);
    }

    [Fact]
    public void A_SameDialog_ButtonEnabled_ClickButtonUmaVez_DispatchedTrue()
    {
        var (_, _, controlApi, _, committer) = BuildHappyPathFixture();

        var result = committer.CommitOnce(Target, ExpectedDialog);

        Assert.True(result.Dispatched);
        Assert.Equal(1, controlApi.ClickButtonCalls);
        Assert.Equal(SaveButtonHwnd, controlApi.LastClickButtonHwnd);
    }

    [Fact]
    public void B_IdentifySaveDialogFalha_ClickButtonZero()
    {
        var (_, inspector, controlApi, _, committer) = BuildHappyPathFixture();
        inspector.IdentityResult = SaveDialogIdentityResult.Fail(AgentErrorCode.DialogNotFound, "#32770 nao apareceu");

        var result = committer.CommitOnce(Target, ExpectedDialog);

        Assert.False(result.Dispatched);
        Assert.Equal(0, controlApi.ClickButtonCalls);
    }

    [Fact]
    public void C_RevalidacaoFalhaPorAmbiguidade_ClickButtonZero()
    {
        var (_, inspector, controlApi, _, committer) = BuildHappyPathFixture();
        inspector.IdentityResult = SaveDialogIdentityResult.Fail(AgentErrorCode.DialogIdentityMismatch, "mais de 1 candidato #32770");

        var result = committer.CommitOnce(Target, ExpectedDialog);

        Assert.False(result.Dispatched);
        Assert.Equal(0, controlApi.ClickButtonCalls);
    }

    [Fact]
    public void D_HwndDiferente_ClickButtonZero()
    {
        var (_, inspector, controlApi, _, committer) = BuildHappyPathFixture();
        var dialogoDiferente = new SaveDialogIdentity(dialogHandle: 0x9999);
        inspector.IdentityResult = SaveDialogIdentityResult.Pass(dialogoDiferente);

        var result = committer.CommitOnce(Target, ExpectedDialog);

        Assert.False(result.Dispatched);
        Assert.Equal(AgentErrorCode.DialogIdentityMismatch, result.ErrorCode);
        Assert.Equal(0, controlApi.ClickButtonCalls);
    }

    [Fact]
    public void E_CtrlId1Ausente_ClickButtonZero()
    {
        var (_, _, controlApi, _, committer) = BuildHappyPathFixture();
        controlApi.ControlsByDialogAndId.Remove((ExpectedDialog.DialogHandle, CtrlIdSave));

        var result = committer.CommitOnce(Target, ExpectedDialog);

        Assert.False(result.Dispatched);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
        Assert.Equal(0, controlApi.ClickButtonCalls);
    }

    [Fact]
    public void F_CtrlId1Invalido_ClickButtonZero()
    {
        var (_, _, controlApi, nativeWindows, committer) = BuildHappyPathFixture();
        nativeWindows.ValidWindows.Remove(SaveButtonHwnd);

        var result = committer.CommitOnce(Target, ExpectedDialog);

        Assert.False(result.Dispatched);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
        Assert.Equal(0, controlApi.ClickButtonCalls);
    }

    [Fact]
    public void G_CtrlId1Disabled_ClickButtonZero()
    {
        var (_, _, controlApi, _, committer) = BuildHappyPathFixture();
        controlApi.EnabledControls.Remove(SaveButtonHwnd);

        var result = committer.CommitOnce(Target, ExpectedDialog);

        Assert.False(result.Dispatched);
        Assert.Equal(AgentErrorCode.ControlMissing, result.ErrorCode);
        Assert.Equal(0, controlApi.ClickButtonCalls);
    }

    [Fact]
    public void H_ClickButtonLanca_FailZeroRetry()
    {
        var innerControlApi = new FakeSaveDialogControlApi();
        innerControlApi.ControlsByDialogAndId[(ExpectedDialog.DialogHandle, CtrlIdSave)] = SaveButtonHwnd;
        innerControlApi.EnabledControls.Add(SaveButtonHwnd);
        var throwingControlApi = new ThrowingClickButtonControlApi(innerControlApi);
        var nativeWindows = new FakeNativeWindowApi();
        nativeWindows.ValidWindows.Add(SaveButtonHwnd);
        var inspector = new FakeSaveDialogInspector(new CallSpy()) { IdentityResult = SaveDialogIdentityResult.Pass(ExpectedDialog) };
        var committer = new WindowsConfirmedSaveDialogCommitter(inspector, throwingControlApi, nativeWindows);

        var result = committer.CommitOnce(Target, ExpectedDialog);

        Assert.False(result.Dispatched);
        Assert.Equal(AgentErrorCode.UnexpectedException, result.ErrorCode);
        Assert.Equal(1, throwingControlApi.ClickButtonAttempts); // exatamente 1 tentativa, zero retry
    }

    [Fact]
    public void I_CommitOnceChamado1x_ClickButtonNoMaximo1()
    {
        var (_, _, controlApi, _, committer) = BuildHappyPathFixture();

        committer.CommitOnce(Target, ExpectedDialog);

        Assert.Equal(1, controlApi.ClickButtonCalls);
    }

    [Fact]
    public void J_ResultDispatchedNaoAfirmaSaveConcluido()
    {
        // Estrutural: SaveDialogCommitResult so tem Dispatched/ErrorCode/Reason -
        // nenhum campo que sugira "Saved"/"FileCreated"/"Success" alem do
        // proprio nome generico do estagio.
        var properties = typeof(SaveDialogCommitResult).GetProperties().Select(p => p.Name);
        Assert.Contains("Dispatched", properties);
        Assert.DoesNotContain(properties, n => n.Contains("Saved", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(properties, n => n.Contains("FileCreated", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void K_CtrlId1137NuncaConsultadoOuEscrito()
    {
        var (_, _, controlApi, _, committer) = BuildHappyPathFixture();
        const int ctrlIdDestination = 1137;
        controlApi.ControlsByDialogAndId[(ExpectedDialog.DialogHandle, ctrlIdDestination)] = 0x7200;

        committer.CommitOnce(Target, ExpectedDialog);

        Assert.Equal(0, controlApi.SetEditTextCalls);
    }

    [Fact]
    public void L_CtrlId1148NaoEAlterado()
    {
        var (_, _, controlApi, _, committer) = BuildHappyPathFixture();

        committer.CommitOnce(Target, ExpectedDialog);

        // Nenhuma escrita de texto ocorre dentro do Committer - SetEditText
        // e' usado exclusivamente por Configure() (WindowsSaveDialogController),
        // nunca pelo Committer.
        Assert.Equal(0, controlApi.SetEditTextCalls);
    }

    [Fact]
    public void M_CtrlId1136NaoEAlterado()
    {
        var (_, _, controlApi, _, committer) = BuildHappyPathFixture();

        committer.CommitOnce(Target, ExpectedDialog);

        Assert.Equal(0, controlApi.TrySelectComboBoxItemExactCalls);
    }

    [Fact]
    public void N_SomenteCtrlId1EResolvidoDiretamenteParaAcao()
    {
        var path = FindSourceFile("WindowsConfirmedSaveDialogCommitter.cs");
        var source = File.ReadAllText(path);

        Assert.Contains("CtrlIdSave", source);
        Assert.DoesNotContain("CtrlIdFileName", source);
        Assert.DoesNotContain("CtrlIdDestination", source);
        Assert.DoesNotContain("CtrlIdFileType", source);
    }

    [Fact]
    public void O_SourceGuard_NaoDuplicaBmClickNemPInvoke()
    {
        var path = FindSourceFile("WindowsConfirmedSaveDialogCommitter.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain("[DllImport", source);
        Assert.DoesNotContain("0x00F5", source);
        Assert.DoesNotContain("SendMessage(", source);
        Assert.DoesNotContain("SendMessageInt(", source);
        Assert.Contains(".ClickButton(", source);
    }

    private static string FindSourceFile(string fileName)
    {
        var root = FindSourceRoot();
        var matches = Directory.GetFiles(root, fileName, SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}") && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
            .ToList();
        Assert.Single(matches);
        return matches[0];
    }

    private static string FindSourceRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && dir.Name != "WINDOWS")
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    /// <summary>Decorator minimo sobre FakeSaveDialogControlApi que forca
    /// ClickButton a lancar - usado exclusivamente para provar zero retry
    /// em H.</summary>
    private sealed class ThrowingClickButtonControlApi : PrimeNexExportAgent.WindowsSaveDialog.ISaveDialogControlApi
    {
        private readonly FakeSaveDialogControlApi _inner;
        public int ClickButtonAttempts { get; private set; }
        public Dictionary<(nint Dialog, int CtrlId), nint> ControlsByDialogAndId => _inner.ControlsByDialogAndId;
        public HashSet<nint> EnabledControls => _inner.EnabledControls;

        public ThrowingClickButtonControlApi(FakeSaveDialogControlApi inner) => _inner = inner;

        public nint GetControl(nint dialogHwnd, int ctrlId) => _inner.GetControl(dialogHwnd, ctrlId);
        public IReadOnlyList<nint> GetDescendants(nint containerHwnd) => _inner.GetDescendants(containerHwnd);
        public bool IsControlEnabled(nint controlHwnd) => _inner.IsControlEnabled(controlHwnd);
        public bool SetEditText(nint editHwnd, string value) => _inner.SetEditText(editHwnd, value);
        public string? ReadEditText(nint editHwnd) => _inner.ReadEditText(editHwnd);
        public int GetComboItemCount(nint comboHwnd) => _inner.GetComboItemCount(comboHwnd);
        public string? GetComboItemText(nint comboHwnd, int index) => _inner.GetComboItemText(comboHwnd, index);
        public string? GetSelectedComboItemText(nint comboHwnd) => _inner.GetSelectedComboItemText(comboHwnd);
        public bool TrySelectComboBoxItemExact(nint controlHwnd, string value) => _inner.TrySelectComboBoxItemExact(controlHwnd, value);

        public void ClickButton(nint buttonHwnd)
        {
            ClickButtonAttempts++;
            throw new InvalidOperationException("ClickButton falhou (simulado)");
        }
    }
}
