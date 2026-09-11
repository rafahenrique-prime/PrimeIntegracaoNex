using Xunit;

namespace PrimeNexScheduledLauncher.Tests;

/// <summary>
/// Teste de robustez de RealChildProcessRunner contra um processo REAL que
/// produz alto volume em stdout+stderr simultaneamente - unico jeito de
/// provar de verdade que a drenagem assincrona nao trava (deadlock classico
/// so se manifesta com volume suficiente para encher os buffers OS do
/// pipe). cmd.exe e' usado AQUI SOMENTE como gerador de volume descartavel
/// para este teste - nunca e' assim que RealChildProcessRunner e' usado em
/// producao (Program.cs sempre aponta FileName diretamente para
/// PrimeNexExportAgent.exe, nunca para cmd.exe - ver
/// PrimeNexScheduledLauncherProjectTests.N_RealChildProcessRunner_
/// NuncaUsaShellOuCmdOuPowershell). Nenhum NEX/Agent real e' tocado por
/// este teste.
/// </summary>
public sealed class RealChildProcessRunnerTests
{
    [Fact]
    public void AltoVolumeStdoutEStderrSimultaneo_NuncaTravaECapturaTudo()
    {
        const string cmdExe = @"C:\Windows\System32\cmd.exe";
        Assert.True(File.Exists(cmdExe), $"Pre-requisito de ambiente ausente: {cmdExe} (esperado em qualquer Windows real)");

        var result = RealChildProcessRunner.RunWithArguments(
            cmdExe,
            Path.GetTempPath(),
            "/c",
            "for /l %i in (1,1,3000) do @(echo OUT%i& echo ERR%i 1>&2)");

        Assert.Equal(0, result.ExitCode);
        Assert.Contains("OUT1", result.Stdout);
        Assert.Contains("OUT2999", result.Stdout);
        Assert.Contains("ERR1", result.Stderr);
        Assert.Contains("ERR2999", result.Stderr);
    }
}
