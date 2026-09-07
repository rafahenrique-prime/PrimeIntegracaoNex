using Xunit;

namespace PrimeNexExportAgent.Tests;

/// <summary>
/// Testes de inspecao de codigo-fonte (mesmo padrao ja usado por
/// IndividualStatementSharedExecutionLockTests para o shared mutex) -
/// Win32OverflowHitTestNativeApi.cs faz DllImport real para user32.dll,
/// entao suas operacoes de geometria/hit-test/clique nao sao
/// unit-testaveis sem um desktop Windows real. Em vez disso, provamos
/// estruturalmente (E-H da matriz da correcao pos-Probe 12A) que cada
/// operacao relevante passa por DpiAwarenessScope.TryEnterUnaware antes
/// de chamar a API Win32 correspondente - a logica de
/// entrar/restaurar/fail-closed em si e' coberta com fakes deterministicos
/// em DpiAwarenessScopeTests.
/// </summary>
public sealed class Win32OverflowHitTestNativeApiSourceTests
{
    private static string ReadSource()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..",
            "PrimeNexExportAgent", "Real", "Win32OverflowHitTestNativeApi.cs");
        path = Path.GetFullPath(path);
        Assert.True(File.Exists(path), $"arquivo nao encontrado: {path}");
        return File.ReadAllText(path);
    }

    [Fact]
    public void E_GetWindowRectPhysical_OcorreSobTryEnterUnaware()
    {
        var src = ReadSource();
        var methodBody = ExtractMethodBody(src, "GetWindowRectPhysical");
        Assert.Contains("TryEnterUnaware", methodBody);
        Assert.Contains("Win32OverflowHitTestInterop.GetWindowRect", methodBody);
        AssertGetWindowRectCallIsInsideUsingScope(methodBody);
    }

    [Fact]
    public void F_WindowFromPhysicalPoint_OcorreSobTryEnterUnaware()
    {
        var src = ReadSource();
        var methodBody = ExtractMethodBody(src, "WindowFromPhysicalPoint");
        Assert.Contains("TryEnterUnaware", methodBody);
        Assert.Contains("Win32OverflowHitTestInterop.WindowFromPhysicalPoint", methodBody);
    }

    [Fact]
    public void G_ScreenToClient_OcorreSobTryEnterUnaware()
    {
        var src = ReadSource();
        var methodBody = ExtractMethodBody(src, "ScreenToClient");
        Assert.Contains("TryEnterUnaware", methodBody);
        Assert.Contains("Win32OverflowHitTestInterop.ScreenToClient", methodBody);
    }

    [Fact]
    public void H_PostMouseDownEUp_OcorremSobTryEnterUnaware()
    {
        var src = ReadSource();
        var down = ExtractMethodBody(src, "PostMouseDown");
        var up = ExtractMethodBody(src, "PostMouseUp");
        Assert.Contains("TryEnterUnaware", down);
        Assert.Contains("Post(hWnd, Win32OverflowHitTestInterop.WM_LBUTTONDOWN", down);
        Assert.Contains("TryEnterUnaware", up);
        Assert.Contains("Post(hWnd, Win32OverflowHitTestInterop.WM_LBUTTONUP", up);
    }

    [Fact]
    public void NuncaUsaSetProcessDpiAwareness()
    {
        var src = ReadSource();
        // Verifica ausencia de CHAMADA real (sufixo "(") - nao basta checar
        // a substring, pois a doc do arquivo MENCIONA esses nomes em texto
        // (explicando o que NAO e' usado) sem invoca-los como metodo.
        Assert.DoesNotContain("SetProcessDpiAwareness(", src);
        Assert.DoesNotContain("SetProcessDpiAwarenessContext(", src);
    }

    private static void AssertGetWindowRectCallIsInsideUsingScope(string methodBody)
    {
        var usingIndex = methodBody.IndexOf("using (scope)", StringComparison.Ordinal);
        var callIndex = methodBody.IndexOf("Win32OverflowHitTestInterop.GetWindowRect", StringComparison.Ordinal);
        Assert.True(usingIndex >= 0 && callIndex > usingIndex, "GetWindowRect deve ocorrer dentro do using(scope)");
    }

    private static string ExtractMethodBody(string src, string methodName)
    {
        var searchFrom = 0;
        while (true)
        {
            var idx = src.IndexOf(methodName + "(", searchFrom, StringComparison.Ordinal);
            Assert.True(idx >= 0, $"metodo '{methodName}' nao encontrado no arquivo");

            // Garante que e' uma DECLARACAO de metodo (precedida por
            // "public"/"private" na mesma linha), nao uma chamada a outro
            // metodo com o mesmo prefixo.
            var lineStart = src.LastIndexOf('\n', idx) + 1;
            var linePrefix = src.Substring(lineStart, idx - lineStart);
            if (!linePrefix.Contains("public") && !linePrefix.Contains("private"))
            {
                searchFrom = idx + methodName.Length;
                continue;
            }

            var openBrace = src.IndexOf('{', idx);
            var depth = 0;
            var i = openBrace;
            for (; i < src.Length; i++)
            {
                if (src[i] == '{') depth++;
                else if (src[i] == '}')
                {
                    depth--;
                    if (depth == 0) break;
                }
            }
            return src.Substring(openBrace, i - openBrace + 1);
        }
    }
}
