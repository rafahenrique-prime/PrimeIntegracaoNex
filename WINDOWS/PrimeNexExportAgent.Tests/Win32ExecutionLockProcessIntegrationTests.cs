using System.Diagnostics;
using System.IO;
using PrimeNexExportAgent.Real;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// F6.14B2.12B secao 8 - prova concorrencia REAL entre PROCESSOS (nao so
/// dois objetos no mesmo processo). Spawna o proprio executavel
/// PrimeNexExportAgent.exe (ja compilado, mesma build usada pelos outros
/// probes) com o argumento --diagnostic-mutex-hold, que so faz uma coisa:
/// tentar adquirir um Mutex nomeado, segura-lo por um curto periodo
/// controlado, e reportar por stdout/exit code. ZERO NEX, ZERO Agent
/// operacional, ZERO UI - so o Mutex real, entre processos reais.
/// </summary>
public sealed class Win32ExecutionLockProcessIntegrationTests
{
    private static string AgentExePath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && dir.Name != "WINDOWS")
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        var exePath = Path.Combine(dir!.FullName, "PrimeNexExportAgent", "bin", "Debug", "net10.0-windows", "PrimeNexExportAgent.exe");
        Assert.True(File.Exists(exePath), $"Executavel do Agent nao encontrado em '{exePath}' - rode 'dotnet build' do PrimeNexExportAgent.csproj antes deste teste.");
        return exePath;
    }

    private static Process StartHold(string mutexName, int holdMs)
    {
        var psi = new ProcessStartInfo
        {
            FileName = AgentExePath(),
            ArgumentList = { "--diagnostic-mutex-hold", mutexName, holdMs.ToString() },
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        var process = Process.Start(psi)!;
        return process;
    }

    [Fact]
    public void ProcessoA_SeguraMutex_ProcessoB_FalhaImediatamente_DepoisAConsegue()
    {
        var mutexName = "PrimeNexExportAgentTests_Process_" + Guid.NewGuid();

        // Processo A adquire e segura por 3s.
        var processA = StartHold(mutexName, holdMs: 3000);

        // Espera A reportar ACQUIRED antes de iniciar B - evita race entre
        // "A ainda nao adquiriu" e "B tenta antes".
        var firstLineA = processA.StandardOutput.ReadLine();
        Assert.Equal("ACQUIRED", firstLineA);

        // Processo B tenta o MESMO nome enquanto A ainda segura - deve
        // falhar IMEDIATAMENTE (BUSY, exit code 1), nunca esperar A liberar.
        var processB = StartHold(mutexName, holdMs: 0);
        var sw = Stopwatch.StartNew();
        var outputB = processB.StandardOutput.ReadToEnd();
        processB.WaitForExit(5000);
        sw.Stop();

        Assert.Equal("BUSY", outputB.Trim());
        Assert.Equal(1, processB.ExitCode);
        Assert.True(sw.ElapsedMilliseconds < 4000, $"Processo B demorou {sw.ElapsedMilliseconds}ms para reportar BUSY - esperado quase imediato (nao deveria esperar A liberar).");

        // A ainda esta segurando e vai liberar sozinho (holdMs=3000).
        var secondLineA = processA.StandardOutput.ReadLine();
        Assert.Equal("RELEASED", secondLineA);
        processA.WaitForExit(5000);
        Assert.Equal(0, processA.ExitCode);

        // Depois que A liberou, um NOVO processo C com o mesmo nome deve
        // conseguir adquirir normalmente.
        var processC = StartHold(mutexName, holdMs: 0);
        var outputC = processC.StandardOutput.ReadToEnd();
        processC.WaitForExit(5000);

        Assert.Contains("ACQUIRED", outputC);
        Assert.Contains("RELEASED", outputC);
        Assert.Equal(0, processC.ExitCode);
    }
}
