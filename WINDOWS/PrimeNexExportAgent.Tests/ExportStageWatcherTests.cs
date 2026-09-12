using System.Collections.Generic;
using System.IO;
using PrimeNexExportAgent.Domain;
using PrimeNexExportAgent.Real;
using PrimeNexExportAgent.Tests.Fakes;
using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes offline (F6.14B2.9A) de PollingExportStageWatcher - prova de
/// filesystem para o futuro Save real supervisionado. Usa uma pasta REAL
/// e temporária e isolada (nunca EXPORT_STAGE/EXPORTADOS reais, nunca o
/// NEX) para exercitar Directory.GetFiles/FileInfo de verdade - mesma
/// disciplina já usada no projeto para testes de staging/estabilidade
/// (F6.12 seção 10/14: "sistema de arquivos real em pasta de teste").
/// Tempo é sempre controlado via FakeDelay+FakeClock - nenhum teste
/// dorme de verdade.
/// </summary>
public sealed class ExportStageWatcherTests : IDisposable
{
    private readonly string _tempDir;

    public ExportStageWatcherTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "PrimeNexExportAgentTests_" + Guid.NewGuid());
        Directory.CreateDirectory(_tempDir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_tempDir, recursive: true); } catch { /* best-effort cleanup de teste */ }
    }

    private static (FakeDelay Delay, FakeClock Clock, PollingExportStageWatcher Watcher) BuildFixture(TimeSpan? pollInterval = null)
    {
        var clock = new FakeClock();
        var delay = new FakeDelay();
        delay.OnWait = d => clock.Now = clock.Now.Add(d);
        var watcher = new PollingExportStageWatcher(delay, clock, pollInterval);
        return (delay, clock, watcher);
    }

    /// <summary>F6.14B2.9F: fixture com uma sequencia de transicoes de
    /// filesystem executadas uma por Wait() sucessivo (ou seja, entre um
    /// poll e o proximo) - permite roteirizar sequencias temporais
    /// deterministicas (ex.: "csv, depois csv+xls, depois so xls") sem
    /// nenhuma espera real.</summary>
    private (FakeDelay Delay, FakeClock Clock, PollingExportStageWatcher Watcher) BuildScriptedFixture(IReadOnlyList<Action> transitionsAfterEachPoll)
    {
        var clock = new FakeClock();
        var delay = new FakeDelay();
        var stepIndex = 0;
        delay.OnWait = d =>
        {
            clock.Now = clock.Now.Add(d);
            if (stepIndex < transitionsAfterEachPoll.Count)
            {
                transitionsAfterEachPoll[stepIndex]();
                stepIndex++;
            }
        };
        var watcher = new PollingExportStageWatcher(delay, clock, TimeSpan.FromMilliseconds(300));
        return (delay, clock, watcher);
    }

    private void WriteOrOverwrite(string fileName, int sizeBytes, DateTime lastWriteUtc) => WriteFile(fileName, sizeBytes, lastWriteUtc);

    private void DeleteIfExists(string fileName)
    {
        var path = Path.Combine(_tempDir, fileName);
        if (File.Exists(path)) File.Delete(path);
    }

    private void WriteFile(string fileName, int sizeBytes, DateTime lastWriteUtc)
    {
        var path = Path.Combine(_tempDir, fileName);
        File.WriteAllBytes(path, new byte[sizeBytes]);
        File.SetLastWriteTimeUtc(path, lastWriteUtc);
    }

    // ==================================================================
    // ConfirmEmptyBeforeAction (G13)
    // ==================================================================

    [Fact]
    public void A_DiretorioVazio_Pass()
    {
        var (_, _, watcher) = BuildFixture();

        var result = watcher.ConfirmEmptyBeforeAction(_tempDir);

        Assert.True(result.Passed);
    }

    [Fact]
    public void B_DiretorioComArquivo_FailClosed_NuncaApagaAutomaticamente()
    {
        WriteFile("qualquer.xls", 10, DateTime.UtcNow);
        var (_, _, watcher) = BuildFixture();

        var result = watcher.ConfirmEmptyBeforeAction(_tempDir);

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.UnsafeState, result.ErrorCode);
        Assert.True(File.Exists(Path.Combine(_tempDir, "qualquer.xls")), "o arquivo nao deveria ter sido apagado");
    }

    // ==================================================================
    // WaitForExpectedFileOnly (prova pos-clique)
    // ==================================================================

    [Fact]
    public void C_ZeroArquivosAteTimeout_Falha()
    {
        var (delay, _, watcher) = BuildFixture(pollInterval: TimeSpan.FromMilliseconds(300));

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "esperado.xls", TimeSpan.FromSeconds(1));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.FileUnstable, result.ErrorCode);
        Assert.True(delay.WaitCalls > 0);
    }

    [Fact]
    public void D_ArquivoComNomeDiferente_FalhaImediataSemEsperarEstabilizar()
    {
        WriteFile("outro-nome.xls", 100, DateTime.UtcNow);
        var (delay, _, watcher) = BuildFixture();

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "esperado.xls", TimeSpan.FromSeconds(5));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.FileUnstable, result.ErrorCode);
        Assert.Equal(0, delay.WaitCalls); // falha na primeira observacao, nunca espera
    }

    [Fact]
    public void E_MultiplosArquivos_FalhaImediataMesmoComUmDelesCorreto()
    {
        var now = DateTime.UtcNow;
        WriteFile("esperado.xls", 100, now);
        WriteFile("arquivo-inesperado.tmp", 5, now);
        var (delay, _, watcher) = BuildFixture();

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "esperado.xls", TimeSpan.FromSeconds(5));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.FileUnstable, result.ErrorCode);
        Assert.Equal(0, delay.WaitCalls); // ambiguidade nunca se resolve esperando
    }

    [Fact]
    public void F_ArquivoEsperadoJaEstavel_PassAposTresObservacoesIdenticas()
    {
        // Arquivo ja escrito por completo e nunca tocado de novo durante o
        // polling - 3 observacoes consecutivas naturalmente identicas.
        WriteFile("esperado.xls", 1000, new DateTime(2026, 9, 2, 10, 0, 0, DateTimeKind.Utc));
        var (delay, _, watcher) = BuildFixture(pollInterval: TimeSpan.FromMilliseconds(300));

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "esperado.xls", TimeSpan.FromSeconds(15));

        Assert.True(result.Passed);
        Assert.Equal(2, delay.WaitCalls); // observacao 1, espera, 2, espera, 3 (Pass) - 2 esperas entre 3 observacoes
    }

    [Fact]
    public void G_ArquivoZeroBytes_NuncaEstabiliza_FalhaNoTimeout()
    {
        WriteFile("esperado.xls", 0, DateTime.UtcNow);
        var (_, _, watcher) = BuildFixture(pollInterval: TimeSpan.FromMilliseconds(300));

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "esperado.xls", TimeSpan.FromSeconds(1));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.FileUnstable, result.ErrorCode);
    }

    [Fact]
    public void H_ArquivoCrescendo_ReiniciaContagemDeEstabilidade_SoPassaDepoisDeParar()
    {
        var path = Path.Combine(_tempDir, "esperado.xls");
        File.WriteAllBytes(path, new byte[10]);
        File.SetLastWriteTimeUtc(path, new DateTime(2026, 9, 2, 10, 0, 0, DateTimeKind.Utc));

        var pollCount = 0;
        var clock = new FakeClock();
        var delay = new FakeDelay();
        delay.OnWait = d =>
        {
            clock.Now = clock.Now.Add(d);
            pollCount++;
            if (pollCount == 1)
            {
                // Cresce uma unica vez, logo apos a 1a observacao - deve
                // reiniciar a contagem de estabilidade (F6.12 secao 11).
                File.WriteAllBytes(path, new byte[20]);
                File.SetLastWriteTimeUtc(path, new DateTime(2026, 9, 2, 10, 0, 1, DateTimeKind.Utc));
            }
        };
        var watcher = new PollingExportStageWatcher(delay, clock, TimeSpan.FromMilliseconds(300));

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "esperado.xls", TimeSpan.FromSeconds(15));

        Assert.True(result.Passed);
        // obs1(10b)=stable1 -> wait(cresce p/20b) -> obs2(20b, diferente)=reinicia p/1
        // -> wait -> obs3(20b,igual)=2 -> wait -> obs4(20b,igual)=3 -> Pass
        Assert.Equal(3, delay.WaitCalls);
    }

    [Fact]
    public void I_TimeoutNuncaRepeteNenhumaAcaoReal_GarantiaEstrutural()
    {
        // PollingExportStageWatcher so depende de IDelay/IClock - nao tem
        // nenhuma referencia a ISaveDialogControlApi/IInputSender, portanto
        // e estruturalmente impossivel repetir ClickButton/Shift+F5 a
        // partir daqui.
        var ctorParams = typeof(PollingExportStageWatcher)
            .GetConstructors()[0]
            .GetParameters()
            .Select(p => p.ParameterType.Name)
            .ToList();

        Assert.DoesNotContain("ISaveDialogControlApi", ctorParams);
        Assert.DoesNotContain("IInputSender", ctorParams);
    }

    [Fact]
    public void J_FakeDelayNuncaDormeDeVerdade()
    {
        var (delay, _, watcher) = BuildFixture(pollInterval: TimeSpan.FromMilliseconds(300));

        var startedAt = DateTime.UtcNow;
        watcher.WaitForExpectedFileOnly(_tempDir, "nunca-aparece.xls", TimeSpan.FromSeconds(15));
        var elapsedRealTime = DateTime.UtcNow - startedAt;

        Assert.True(elapsedRealTime < TimeSpan.FromSeconds(1), $"Teste levou {elapsedRealTime.TotalMilliseconds}ms - FakeDelay parece ter dormido de verdade.");
        Assert.True(delay.WaitCalls > 0);
    }

    // ==================================================================
    // F6.14B2.9F - transitorio conhecido "<basename>.csv" (evidencia real
    // F6.14B2.9E: NEX passa por esse nome durante a geracao antes do .xls
    // final). NUNCA PASS/FAIL imediato so por causa dele - so reinicia a
    // estabilidade do XLS enquanto ele existir.
    // ==================================================================

    [Fact]
    public void A_CsvTransitorioDepoisXlsEstavel_Pass()
    {
        // Polls: 1.csv 2.csv 3.xls(crescendo) 4.xls(A) 5.xls(A) 6.xls(A) -> PASS
        WriteFile("foo.csv", 5, new DateTime(2026, 9, 2, 2, 47, 11, DateTimeKind.Utc));
        var (delay, _, watcher) = BuildScriptedFixture(new List<Action>
        {
            () => { }, // apos poll1(csv): nada muda -> poll2 ve csv de novo
            () => { DeleteIfExists("foo.csv"); WriteOrOverwrite("foo.xls", 10, new DateTime(2026, 9, 2, 2, 47, 15, DateTimeKind.Utc)); }, // apos poll2(csv): csv vira xls(10, crescendo)
            () => WriteOrOverwrite("foo.xls", 20, new DateTime(2026, 9, 2, 2, 47, 18, DateTimeKind.Utc)), // apos poll3(xls=10): cresce p/20 (estado A)
            () => { }, // apos poll4(xls=20,A): nada muda
            () => { }, // apos poll5(xls=20,A): nada muda
        });

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(15));

        Assert.True(result.Passed);
    }

    [Fact]
    public void B_CsvEXlsJuntosDepoisSomenteXls_PassSomenteNoFinal()
    {
        // Polls: 1.csv 2.csv+xls 3.csv+xls 4.xls(A) 5.xls(A) 6.xls(A) -> PASS so no final
        WriteFile("foo.csv", 5, new DateTime(2026, 9, 2, 2, 47, 11, DateTimeKind.Utc));
        var (delay, _, watcher) = BuildScriptedFixture(new List<Action>
        {
            () => WriteOrOverwrite("foo.xls", 20, new DateTime(2026, 9, 2, 2, 47, 15, DateTimeKind.Utc)), // apos poll1(csv): xls aparece junto (csv ainda la)
            () => { }, // apos poll2(csv+xls): nada muda - continua os dois
            () => DeleteIfExists("foo.csv"), // apos poll3(csv+xls): csv finalmente some, so xls resta
            () => { }, // apos poll4(xls=20,A): nada muda
            () => { }, // apos poll5(xls=20,A): nada muda
        });

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(15));

        Assert.True(result.Passed);
    }

    [Fact]
    public void C_CsvPersisteAteTimeout_Falha()
    {
        WriteFile("foo.csv", 5, DateTime.UtcNow);
        var (_, _, watcher) = BuildFixture(pollInterval: TimeSpan.FromMilliseconds(300));

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(1));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.FileUnstable, result.ErrorCode);
    }

    [Fact]
    public void D_CsvEXlsPersistemJuntosAteTimeout_Falha()
    {
        WriteFile("foo.csv", 5, DateTime.UtcNow);
        WriteFile("foo.xls", 20, DateTime.UtcNow);
        var (_, _, watcher) = BuildFixture(pollInterval: TimeSpan.FromMilliseconds(300));

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(1));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.FileUnstable, result.ErrorCode);
    }

    [Fact]
    public void E_OutroBasenameCsv_FalhaImediata()
    {
        WriteFile("bar.csv", 5, DateTime.UtcNow);
        var (delay, _, watcher) = BuildFixture();

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(15));

        Assert.False(result.Passed);
        Assert.Equal(0, delay.WaitCalls); // falha na primeira observacao, nunca espera "ver se some"
    }

    [Fact]
    public void F_ExtensaoInesperadaTmp_FalhaImediata()
    {
        WriteFile("foo.tmp", 5, DateTime.UtcNow);
        var (delay, _, watcher) = BuildFixture();

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(15));

        Assert.False(result.Passed);
        Assert.Equal(0, delay.WaitCalls);
    }

    [Fact]
    public void G_CsvComSufixoNaoEhTransitorio_Falha()
    {
        WriteFile("foo (1).csv", 5, DateTime.UtcNow);
        var (delay, _, watcher) = BuildFixture();

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(15));

        Assert.False(result.Passed);
        Assert.Equal(0, delay.WaitCalls);
    }

    [Fact]
    public void H_MultiplosInesperados_FalhaImediata()
    {
        WriteFile("foo.csv", 5, DateTime.UtcNow);
        WriteFile("bar.txt", 5, DateTime.UtcNow);
        var (delay, _, watcher) = BuildFixture();

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(15));

        Assert.False(result.Passed);
        Assert.Equal(0, delay.WaitCalls);
    }

    [Fact]
    public void I2_XlsDiretoEstavel_ContinuaPassando_Regressao()
    {
        WriteFile("foo.xls", 1000, new DateTime(2026, 9, 2, 10, 0, 0, DateTimeKind.Utc));
        var (_, _, watcher) = BuildFixture(pollInterval: TimeSpan.FromMilliseconds(300));

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(15));

        Assert.True(result.Passed);
    }

    [Fact]
    public void J2_XlsCrescendoContinuaNaoPassandoCedo()
    {
        var path = Path.Combine(_tempDir, "foo.xls");
        File.WriteAllBytes(path, new byte[10]);
        File.SetLastWriteTimeUtc(path, new DateTime(2026, 9, 2, 10, 0, 0, DateTimeKind.Utc));
        var (delay, clock, watcher) = BuildFixture(pollInterval: TimeSpan.FromMilliseconds(300));
        var grew = false;
        delay.OnWait = d =>
        {
            clock.Now = clock.Now.Add(d);
            if (!grew)
            {
                grew = true;
                File.WriteAllBytes(path, new byte[20]);
                File.SetLastWriteTimeUtc(path, new DateTime(2026, 9, 2, 10, 0, 1, DateTimeKind.Utc));
            }
        };

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(15));

        Assert.True(result.Passed); // eventualmente estabiliza, mas nao no 1o/2o poll
        Assert.True(delay.WaitCalls >= 3); // nao passou cedo demais
    }

    [Fact]
    public void K_XlsZeroBytesContinuaNaoEstavel()
    {
        WriteFile("foo.xls", 0, DateTime.UtcNow);
        var (_, _, watcher) = BuildFixture(pollInterval: TimeSpan.FromMilliseconds(300));

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(1));

        Assert.False(result.Passed);
    }

    [Fact]
    public void L_NenhumArquivoAteTimeout_Falha()
    {
        var (_, _, watcher) = BuildFixture(pollInterval: TimeSpan.FromMilliseconds(300));

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(1));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.FileUnstable, result.ErrorCode);
    }

    [Fact]
    public void M_ExtensaoCsvMaiuscula_AindaReconhecidaComoTransitorio()
    {
        // Comparacao de EXTENSAO e' case-insensitive (Windows nao
        // diferencia maiusculas/minusculas em extensoes) - basename
        // continua exigido identico.
        WriteFile("foo.CSV", 5, new DateTime(2026, 9, 2, 2, 47, 11, DateTimeKind.Utc));
        var (delay, _, watcher) = BuildScriptedFixture(new List<Action>
        {
            () => { DeleteIfExists("foo.CSV"); WriteOrOverwrite("foo.xls", 20, new DateTime(2026, 9, 2, 2, 47, 18, DateTimeKind.Utc)); },
            () => { },
            () => { },
        });

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(15));

        Assert.True(result.Passed);
    }

    [Fact]
    public void N_ZeroRetryContinuaAposCorrecaoTemporal_GarantiaEstrutural()
    {
        var ctorParams = typeof(PollingExportStageWatcher)
            .GetConstructors()[0]
            .GetParameters()
            .Select(p => p.ParameterType.Name)
            .ToList();

        Assert.DoesNotContain("ISaveDialogControlApi", ctorParams);
        Assert.DoesNotContain("IInputSender", ctorParams);
        Assert.DoesNotContain("INexWindowInspector", ctorParams);
    }

    [Fact]
    public void O_XlsSurgeAposVinteETresSegundos_ComTimeoutDeTrinta_PassAposTresObservacoes()
    {
        var clock = new FakeClock();
        var delay = new FakeDelay();
        var startedAt = clock.Now;
        var fileCreated = false;

        delay.OnWait = d =>
        {
            clock.Now = clock.Now.Add(d);
            if (!fileCreated && clock.Now - startedAt >= TimeSpan.FromSeconds(23))
            {
                WriteFile("foo.xls", 1761280, new DateTime(2026, 9, 12, 5, 35, 29, DateTimeKind.Utc));
                fileCreated = true;
            }
        };

        var watcher = new PollingExportStageWatcher(delay, clock, TimeSpan.FromMilliseconds(300));

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(30));

        Assert.True(fileCreated);
        Assert.True(result.Passed);
        Assert.Equal(79, delay.WaitCalls);
        Assert.Equal(TimeSpan.FromMilliseconds(23700), clock.Now - startedAt);
    }

    [Fact]
    public void P_NenhumArquivoAteTimeoutDeTrinta_FalhaFileUnstable()
    {
        var (delay, clock, watcher) = BuildFixture(pollInterval: TimeSpan.FromMilliseconds(300));
        var startedAt = clock.Now;

        var result = watcher.WaitForExpectedFileOnly(_tempDir, "foo.xls", TimeSpan.FromSeconds(30));

        Assert.False(result.Passed);
        Assert.Equal(AgentErrorCode.FileUnstable, result.ErrorCode);
        Assert.Contains("nenhum arquivo apareceu", result.Reason);
        Assert.Equal(100, delay.WaitCalls);
        Assert.Equal(TimeSpan.FromSeconds(30), clock.Now - startedAt);
    }
}
