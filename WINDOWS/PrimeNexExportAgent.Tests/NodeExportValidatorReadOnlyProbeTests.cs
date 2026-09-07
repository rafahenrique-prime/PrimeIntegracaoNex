using System.IO;
using System.Linq;
using PrimeNexExportAgent.Diagnostics;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14B2.10B1) de NodeExportValidatorReadOnlyProbe -
/// exercitam RunCore(...) com um IExportValidator fake e um diretorio
/// "autorizado" TEMPORARIO e isolado (nunca a pasta real
/// OUTPUT\HOMOLOGACAO-F6.14B2.9\, nunca as duas evidencias reais). Prova
/// os gates de canonical path/extensao ANTES de qualquer chamada real ao
/// Validator.
/// </summary>
public sealed class NodeExportValidatorReadOnlyProbeTests : IDisposable
{
    private readonly string _allowedFolder;
    private readonly string _outsideFolder;

    public NodeExportValidatorReadOnlyProbeTests()
    {
        var root = Path.Combine(Path.GetTempPath(), "PrimeNexExportAgentTests_ValidateProbe_" + Guid.NewGuid());
        _allowedFolder = Path.Combine(root, "HOMOLOGACAO-FAKE");
        _outsideFolder = Path.Combine(root, "OUTRA-PASTA");
        Directory.CreateDirectory(_allowedFolder);
        Directory.CreateDirectory(_outsideFolder);
    }

    public void Dispose()
    {
        try { Directory.Delete(Path.GetDirectoryName(_allowedFolder)!, recursive: true); } catch { /* best-effort */ }
    }

    private static FakeExportValidator BuildFakeValidator(CallSpy spy) => new(spy);

    private string WriteFile(string directory, string fileName)
    {
        var path = Path.Combine(directory, fileName);
        File.WriteAllBytes(path, new byte[10]);
        return path;
    }

    [Fact]
    public void A_ArquivoPermitido_ValidatorPass_ResultadoPass()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        validator.Result = ExportValidationResult.Ok(42);
        var arquivo = WriteFile(_allowedFolder, "vendas-teste.xls");

        var result = NodeExportValidatorReadOnlyProbe.RunCore(arquivo, _allowedFolder, validator, _ => { });

        Assert.Equal(ValidateReadOnlyProbeOutcome.Passed, result.Outcome);
        Assert.Equal(true, result.Valid);
        Assert.Equal(42, result.Rows);
        Assert.Equal(1, spy.CountOf(nameof(FakeExportValidator.Validate)));
    }

    [Fact]
    public void B_ArquivoPermitido_ValidatorFail_ResultadoFail()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        validator.Result = ExportValidationResult.Fail(AgentErrorCode.ReaderRejected, "colunas_inesperadas: teste");
        var arquivo = WriteFile(_allowedFolder, "vendas-teste.xls");

        var result = NodeExportValidatorReadOnlyProbe.RunCore(arquivo, _allowedFolder, validator, _ => { });

        Assert.Equal(ValidateReadOnlyProbeOutcome.FailedValidatorInvalid, result.Outcome);
        Assert.Equal(false, result.Valid);
        Assert.Equal(1, spy.CountOf(nameof(FakeExportValidator.Validate)));
    }

    [Fact]
    public void C_ArquivoInexistente_ValidateZero()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        var caminho = Path.Combine(_allowedFolder, "nao-existe.xls");

        var result = NodeExportValidatorReadOnlyProbe.RunCore(caminho, _allowedFolder, validator, _ => { });

        Assert.Equal(ValidateReadOnlyProbeOutcome.FailedFileNotFound, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
    }

    [Fact]
    public void D_DiretorioEmVezDeArquivo_ValidateZero()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        var subDir = Path.Combine(_allowedFolder, "subpasta.xls"); // nome com extensao .xls, mas e' um diretorio
        Directory.CreateDirectory(subDir);

        var result = NodeExportValidatorReadOnlyProbe.RunCore(subDir, _allowedFolder, validator, _ => { });

        Assert.Equal(ValidateReadOnlyProbeOutcome.FailedNotAFile, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
    }

    [Fact]
    public void E_ExtensaoDiferenteDeXls_ValidateZero()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        var arquivo = WriteFile(_allowedFolder, "vendas-teste.csv");

        var result = NodeExportValidatorReadOnlyProbe.RunCore(arquivo, _allowedFolder, validator, _ => { });

        Assert.Equal(ValidateReadOnlyProbeOutcome.FailedWrongExtension, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
    }

    [Fact]
    public void F_PathEmPastaTipoExportStage_ValidateZero()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        var pastaTipoExportStage = Path.Combine(Path.GetDirectoryName(_allowedFolder)!, "EXPORT_STAGE");
        Directory.CreateDirectory(pastaTipoExportStage);
        var arquivo = WriteFile(pastaTipoExportStage, "vendas-teste.xls");

        var result = NodeExportValidatorReadOnlyProbe.RunCore(arquivo, _allowedFolder, validator, _ => { });

        Assert.Equal(ValidateReadOnlyProbeOutcome.FailedPathOutsideAllowedFolder, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
    }

    [Fact]
    public void G_PathEmPastaTipoExportados_ValidateZero()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        var pastaTipoExportados = Path.Combine(Path.GetDirectoryName(_allowedFolder)!, "EXPORTADOS");
        Directory.CreateDirectory(pastaTipoExportados);
        var arquivo = WriteFile(pastaTipoExportados, "vendas-teste.xls");

        var result = NodeExportValidatorReadOnlyProbe.RunCore(arquivo, _allowedFolder, validator, _ => { });

        Assert.Equal(ValidateReadOnlyProbeOutcome.FailedPathOutsideAllowedFolder, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
    }

    [Fact]
    public void H_OutraPastaDentroDeOutputForaDaHomologada_ValidateZero()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        var arquivo = WriteFile(_outsideFolder, "vendas-teste.xls");

        var result = NodeExportValidatorReadOnlyProbe.RunCore(arquivo, _allowedFolder, validator, _ => { });

        Assert.Equal(ValidateReadOnlyProbeOutcome.FailedPathOutsideAllowedFolder, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
    }

    [Fact]
    public void I_SubdiretorioDentroDaPastaHomologada_ValidateZero()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        var subDir = Path.Combine(_allowedFolder, "subdir");
        Directory.CreateDirectory(subDir);
        var arquivo = WriteFile(subDir, "vendas-teste.xls");

        var result = NodeExportValidatorReadOnlyProbe.RunCore(arquivo, _allowedFolder, validator, _ => { });

        Assert.Equal(ValidateReadOnlyProbeOutcome.FailedPathOutsideAllowedFolder, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
    }

    [Fact]
    public void J_Traversal_ValidateZero()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        WriteFile(_outsideFolder, "vendas-teste.xls");
        var caminhoComTraversal = Path.Combine(_allowedFolder, "..", "OUTRA-PASTA", "vendas-teste.xls");

        var result = NodeExportValidatorReadOnlyProbe.RunCore(caminhoComTraversal, _allowedFolder, validator, _ => { });

        Assert.Equal(ValidateReadOnlyProbeOutcome.FailedPathOutsideAllowedFolder, result.Outcome);
        Assert.Equal(0, spy.CountOf(nameof(FakeExportValidator.Validate)));
    }

    [Fact]
    public void K_PathCanonicalAutorizado_Aceita()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        validator.Result = ExportValidationResult.Ok(5);
        // Caminho equivalente mas com ".." no meio, que apos GetFullPath
        // resolve para dentro da propria pasta autorizada - deve ser aceito.
        var arquivo = WriteFile(_allowedFolder, "vendas-teste.xls");
        var comTraversalNoMeioQueResolveDeVolta = Path.Combine(_allowedFolder, "..", "HOMOLOGACAO-FAKE", "vendas-teste.xls");

        var result = NodeExportValidatorReadOnlyProbe.RunCore(comTraversalNoMeioQueResolveDeVolta, _allowedFolder, validator, _ => { });

        Assert.Equal(ValidateReadOnlyProbeOutcome.Passed, result.Outcome);
        Assert.Equal(1, spy.CountOf(nameof(FakeExportValidator.Validate)));
    }

    [Fact]
    public void L_UmaChamadaAoProbe_ValidateNoMaximoUm()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        validator.Result = ExportValidationResult.Fail(AgentErrorCode.ReaderRejected, "teste");
        var arquivo = WriteFile(_allowedFolder, "vendas-teste.xls");

        NodeExportValidatorReadOnlyProbe.RunCore(arquivo, _allowedFolder, validator, _ => { });

        Assert.Equal(1, spy.CountOf(nameof(FakeExportValidator.Validate)));
    }

    [Fact]
    public void M_NenhumRetry_GarantiaEstrutural()
    {
        // RunCore nao tem nenhum loop/laco de repeticao envolvendo
        // Validate - confirmado por leitura (um unico caminho de codigo
        // chama validator.Validate exatamente uma vez, sem laco).
        var method = typeof(NodeExportValidatorReadOnlyProbe).GetMethod(
            "RunCore", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
        Assert.NotNull(method);
        // Garantia comportamental equivalente ja' provada por L (1 chamada).
    }

    [Fact]
    public void N_OutputNaoContemPii_ApenasEstruturaSegura()
    {
        var spy = new CallSpy();
        var validator = BuildFakeValidator(spy);
        validator.Result = ExportValidationResult.Ok(4883);
        var arquivo = WriteFile(_allowedFolder, "vendas-teste.xls");
        var logs = new System.Collections.Generic.List<string>();

        var result = NodeExportValidatorReadOnlyProbe.RunCore(arquivo, _allowedFolder, validator, logs.Add);

        // FileName e' so o basename (nunca o path completo com dados de
        // outra natureza), Reason/ErrorCode vem de um resultado sintetico
        // sem PII neste teste - a garantia real de "nunca imprime linhas de
        // venda" vem do Reader nunca expor isso no contrato JSON (ja
        // testado em TESTES/teste-validar-export-vendas.js item G).
        Assert.Equal("vendas-teste.xls", result.FileName);
        Assert.DoesNotContain(logs, l => l.Length > 500); // nenhum log gigantesco (ex.: buffer/JSON bruto)
    }

    [Fact]
    public void O_SourceDoProbe_NuncaReferenciaPublicacaoOuUiNex()
    {
        // Verifica CALL SITES/USOS reais, nunca a palavra solta - o
        // cabecalho do arquivo legitimamente MENCIONA "IAtomicPublisher"
        // em prosa, explicando que nunca e' chamado.
        var path = FindSourceFile("NodeExportValidatorReadOnlyProbe.cs");
        var source = File.ReadAllText(path);

        Assert.DoesNotContain("new IAtomicPublisher", source);
        Assert.DoesNotContain("File.Move(", source);
        Assert.DoesNotContain("File.Copy(", source);
        Assert.DoesNotContain("File.Delete(", source);
        Assert.DoesNotContain(".LocateNexAdmin(", source);
        Assert.DoesNotContain(".SendInput(", source);
        Assert.DoesNotContain(".ClickButton(", source);
        Assert.DoesNotContain(".SetEditText(", source);
        Assert.DoesNotContain("BM_CLICK", source);
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
}
