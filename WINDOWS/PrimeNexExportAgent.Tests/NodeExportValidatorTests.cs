using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14B2.10A) de NodeExportValidator - ZERO node.exe
/// real e tocado aqui (isso e' o teste de integracao controlado, feito a
/// parte). IProcessRunner e' sempre um FakeProcessRunner, permitindo
/// provar objetivamente cada branch de fail-closed do contrato JSON+exit
/// code.
/// </summary>
public sealed class NodeExportValidatorTests
{
    private const string CliPath = @"C:\Nex\PrimeIntegracaoNex\SCRIPTS\validar-export-vendas.js";
    private const string XlsPath = @"C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE\vendas-auto-teste.xls";

    private static (FakeProcessRunner Runner, NodeExportValidator Validator) BuildFixture()
    {
        var runner = new FakeProcessRunner();
        var validator = new NodeExportValidator(runner, CliPath);
        return (runner, validator);
    }

    [Fact]
    public void A1_ExitZeroOkTrueRowsValido_Pass()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: false, exitCode: 0, stdOut: "{\"ok\":true,\"rows\":4883}\n", stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.True(result.Valid);
        Assert.Equal(4883, result.RecordCount);
    }

    [Fact]
    public void A2_ExitUmOkFalseComErrorCode_Invalid()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: false, exitCode: 1, stdOut: "{\"ok\":false,\"errorCode\":\"colunas_inesperadas\",\"reason\":\"faltando colunas\"}\n", stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
        Assert.Equal(AgentErrorCode.ReaderRejected, result.ErrorCode);
        Assert.Contains("colunas_inesperadas", result.Reason);
    }

    [Fact]
    public void A3_ProcessoNaoInicia_Fail()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = ProcessRunResult.FailedToStart();

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
        Assert.Equal(AgentErrorCode.UnexpectedException, result.ErrorCode);
    }

    [Fact]
    public void A4_Timeout_Fail()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: true, exitCode: null, stdOut: string.Empty, stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
        Assert.Equal(AgentErrorCode.UnexpectedException, result.ErrorCode);
    }

    [Fact]
    public void A5_StdOutVazio_Fail()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: false, exitCode: 0, stdOut: string.Empty, stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
    }

    [Fact]
    public void A6_JsonInvalido_Fail()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: false, exitCode: 0, stdOut: "isto nao e json\n", stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
    }

    [Fact]
    public void A7_JsonSemCampoOk_Fail()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: false, exitCode: 0, stdOut: "{\"rows\":10}\n", stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
    }

    [Fact]
    public void A8_ExitZeroOkFalse_ContradicaoFail()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: false, exitCode: 0, stdOut: "{\"ok\":false,\"errorCode\":\"x\"}\n", stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
        Assert.Equal(AgentErrorCode.UnexpectedException, result.ErrorCode); // nunca ReaderRejected numa contradicao
    }

    [Fact]
    public void A9_ExitUmOkTrue_ContradicaoFail()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: false, exitCode: 1, stdOut: "{\"ok\":true,\"rows\":5}\n", stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
        Assert.Equal(AgentErrorCode.UnexpectedException, result.ErrorCode);
    }

    [Fact]
    public void A10_ExitCodeInesperado_Fail()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: false, exitCode: 2, stdOut: "{\"ok\":true,\"rows\":5}\n", stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
    }

    [Fact]
    public void A11_RowsNegativo_Fail()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: false, exitCode: 0, stdOut: "{\"ok\":true,\"rows\":-1}\n", stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
    }

    [Fact]
    public void A12_RowsTipoInvalido_Fail()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: false, exitCode: 0, stdOut: "{\"ok\":true,\"rows\":\"muitas\"}\n", stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
    }

    [Fact]
    public void A13_StdErrDiagnosticoNaoInfluenciaDecisao_PassMesmoComStdErrPreenchido()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: false, exitCode: 0, stdOut: "{\"ok\":true,\"rows\":3}\n", stdErr: "aviso diagnostico irrelevante");

        var result = validator.Validate(XlsPath);

        Assert.True(result.Valid); // decisao vem exclusivamente do contrato stdout+exitCode
        Assert.Equal(3, result.RecordCount);
    }

    [Fact]
    public void A14_NuncaReferenciaPublicacao_GarantiaEstrutural()
    {
        var ctorParams = typeof(NodeExportValidator)
            .GetConstructors()[0]
            .GetParameters()
            .Select(p => p.ParameterType.Name)
            .ToList();

        Assert.DoesNotContain("IAtomicPublisher", ctorParams);

        var fieldsAndMethods = typeof(NodeExportValidator)
            .GetFields(System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)
            .Select(f => f.FieldType.Name)
            .Concat(typeof(NodeExportValidator).GetMethods().Select(m => m.Name));
        Assert.DoesNotContain(fieldsAndMethods, n => n.Contains("Publish", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(fieldsAndMethods, n => n.Contains("Move", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(fieldsAndMethods, n => n.Contains("Copy", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void A15_UmaChamadaValidate_NoMaximoUmSubprocesso_ZeroRetry()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: true, exitCode: null, stdOut: string.Empty, stdErr: string.Empty); // pior caso: timeout

        validator.Validate(XlsPath);

        Assert.Equal(1, runner.RunCalls);
    }

    [Fact]
    public void A16_ArgumentosPassadosCorretamente_CliEArquivoLiteral()
    {
        var (runner, validator) = BuildFixture();

        validator.Validate(XlsPath);

        Assert.Equal("node", runner.LastFileName);
        Assert.NotNull(runner.LastArguments);
        Assert.Equal(2, runner.LastArguments!.Count);
        Assert.Equal(CliPath, runner.LastArguments[0]);
        Assert.Equal(XlsPath, runner.LastArguments[1]);
    }

    [Fact]
    public void A17_ExcecaoAoIniciarSubprocesso_FailNuncaPropaga()
    {
        var (runner, validator) = BuildFixture();
        runner.ThrowOnRun = new InvalidOperationException("simulado");

        ExportValidationResult? result = null;
        var exception = Record.Exception(() => result = validator.Validate(XlsPath));

        Assert.Null(exception);
        Assert.NotNull(result);
        Assert.False(result!.Valid);
        Assert.Equal(AgentErrorCode.UnexpectedException, result.ErrorCode);
    }

    [Fact]
    public void A18_TimeoutPadraoDoValidator_EhVinteSegundos()
    {
        var (runner, validator) = BuildFixture();

        validator.Validate(XlsPath);

        Assert.Equal(TimeSpan.FromSeconds(20), NodeExportValidator.DefaultTimeout);
        Assert.Equal(TimeSpan.FromSeconds(20), runner.LastTimeout);
    }

    [Fact]
    public void A19_SucessoAntesDoTimeout_PassComTimeoutDeVinteSegundos()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: false, exitCode: 0, stdOut: "{\"ok\":true,\"rows\":4918}\n", stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.True(result.Valid);
        Assert.Equal(4918, result.RecordCount);
        Assert.Equal(TimeSpan.FromSeconds(20), runner.LastTimeout);
        Assert.Equal(1, runner.RunCalls);
    }

    [Fact]
    public void A20_TimeoutDeVinteSegundos_ContinuaFailClosed()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: true, exitCode: null, stdOut: string.Empty, stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
        Assert.Equal(AgentErrorCode.UnexpectedException, result.ErrorCode);
        Assert.Contains("timeout de 20s", result.Reason);
        Assert.Equal(TimeSpan.FromSeconds(20), runner.LastTimeout);
    }

    [Fact]
    public void A21_TimeoutDeVinteSegundos_NaoFazRetryAutomatico()
    {
        var (runner, validator) = BuildFixture();
        runner.Result = new ProcessRunResult(started: true, timedOut: true, exitCode: null, stdOut: string.Empty, stdErr: string.Empty);

        var result = validator.Validate(XlsPath);

        Assert.False(result.Valid);
        Assert.Equal(1, runner.RunCalls);
        Assert.Contains("nenhuma segunda tentativa", result.Reason);
    }
}
