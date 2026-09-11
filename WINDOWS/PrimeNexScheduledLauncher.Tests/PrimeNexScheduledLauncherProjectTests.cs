using Xunit;

namespace PrimeNexScheduledLauncher.Tests;

/// <summary>
/// Guardas estruturais (source + binario compilado) do launcher. Nenhum
/// teste aqui inicia PrimeNexExportAgent.exe real, toca NEX, ou toca Task
/// Scheduler - apenas le arquivos-fonte texto e o binario ja compilado em
/// disco.
/// </summary>
public sealed class PrimeNexScheduledLauncherProjectTests
{
    // ---- A: OutputType=WinExe no .csproj ----
    [Fact]
    public void A_CsprojDeclaraOutputTypeWinExe()
    {
        var csproj = File.ReadAllText(FindSourceFile("PrimeNexScheduledLauncher.csproj"));

        Assert.Contains("<OutputType>WinExe</OutputType>", csproj);
    }

    // ---- B: binario compilado tem subsystem GUI (2), nunca console (3) ----
    // Le o cabecalho PE diretamente (bytes crus), nao presume so pelo
    // source - prova real contra o artefato que o Task Scheduler de fato
    // executaria.
    [Fact]
    public void B_BinarioCompilado_SubsystemGui_NuncaConsole()
    {
        var exePath = FindCompiledExe();
        var bytes = File.ReadAllBytes(exePath);

        var peHeaderOffset = BitConverter.ToInt32(bytes, 0x3C);
        var peSignature = BitConverter.ToInt32(bytes, peHeaderOffset);
        Assert.Equal(0x00004550, peSignature); // "PE\0\0"

        var optionalHeaderStart = peHeaderOffset + 24;
        // Subsystem esta no offset 68 do Optional Header tanto em PE32
        // quanto PE32+ (o campo aparece na mesma posicao relativa nas duas
        // variantes).
        var subsystem = BitConverter.ToUInt16(bytes, optionalHeaderStart + 68);

        const ushort IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
        const ushort IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;
        Assert.Equal(IMAGE_SUBSYSTEM_WINDOWS_GUI, subsystem);
        Assert.NotEqual(IMAGE_SUBSYSTEM_WINDOWS_CUI, subsystem);
    }

    // ---- C: configuracao real de producao (LauncherProgram.cs) ----
    [Fact]
    public void C_ProgramCs_ConfiguracaoRealDeProducao()
    {
        var source = File.ReadAllText(FindSourceFile("LauncherProgram.cs"));

        Assert.Contains(@"C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexExportAgent\bin\Debug\net10.0-windows\PrimeNexExportAgent.exe", source);
        Assert.Contains(@"C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexExportAgent", source);
        Assert.Contains(@"C:\Nex\PrimeIntegracaoNex\LOGS", source);
        Assert.Contains("--run-once-scheduled-safe", source);
        Assert.Contains("new RealChildProcessRunner()", source);

        // Nenhum override por variavel de ambiente reintroduzido.
        Assert.DoesNotContain("GetEnvironmentVariable", source);
    }

    // ---- N (parcial): source guard - nunca cmd.exe/powershell/shell na producao ----
    [Fact]
    public void N_RealChildProcessRunner_NuncaUsaShellOuCmdOuPowershell()
    {
        var source = File.ReadAllText(FindSourceFile("RealChildProcessRunner.cs"));

        Assert.Contains("UseShellExecute = false", source);
        Assert.Contains("CreateNoWindow = true", source);
        // Verifica ausencia de USO real (string literal entre aspas), nao
        // de mera mencao em comentario/docblock explicando o porque de
        // NAO usar.
        Assert.DoesNotContain("\"cmd.exe\"", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("\"powershell", source, StringComparison.OrdinalIgnoreCase);
    }

    // ---- N (parcial): source guard - launcher nunca referencia UI/foreground/NEX/Task Scheduler ----
    [Fact]
    public void N_LauncherNuncaReferenciaUiForegroundOuTaskScheduler()
    {
        var root = FindSourceRoot();
        var launcherDir = Path.Combine(root, "PrimeNexScheduledLauncher");
        foreach (var file in Directory.GetFiles(launcherDir, "*.cs", SearchOption.TopDirectoryOnly))
        {
            var source = File.ReadAllText(file);
            Assert.DoesNotContain("SetForegroundWindow", source);
            Assert.DoesNotContain("ShowWindow", source);
            Assert.DoesNotContain("BringWindowToTop", source);
            Assert.DoesNotContain("SetFocus", source);
            Assert.DoesNotContain("SwitchToThisWindow", source);
            Assert.DoesNotContain("ScheduledTask", source);
            Assert.DoesNotContain("NexAdmin", source);
            Assert.DoesNotContain("System.Windows.Forms", source);
            Assert.DoesNotContain("System.Windows.Window", source); // WPF Window
        }
    }

    private static string FindCompiledExe()
    {
        var launcherDir = Path.Combine(FindSourceRoot(), "PrimeNexScheduledLauncher");
        var matches = Directory.GetFiles(launcherDir, "PrimeNexScheduledLauncher.exe", SearchOption.AllDirectories)
            .Where(f => f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
            .ToList();
        Assert.NotEmpty(matches);
        return matches[0];
    }

    /// <summary>Restrito ao diretorio do projeto PrimeNexScheduledLauncher
    /// (nunca WINDOWS/ inteiro) - evita colisao com arquivos de mesmo nome
    /// no projeto PrimeNexExportAgent (ex. Program.cs existe nos dois).</summary>
    private static string FindSourceFile(string fileName)
    {
        var launcherDir = Path.Combine(FindSourceRoot(), "PrimeNexScheduledLauncher");
        var matches = Directory.GetFiles(launcherDir, fileName, SearchOption.AllDirectories)
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
