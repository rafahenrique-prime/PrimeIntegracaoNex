using PrimeNexExportAgent.Contracts;

namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Nomenclatura de arquivo (F6.12 secao 9) - funcao pura, nunca toca o
/// sistema de arquivos, nunca depende do conteudo do dialogo "Salvar
/// como" (mesmo nome pre-preenchido, "Exportar-dia-31-08", que ja provou
/// ser um risco real de sobrescrita em F6.9). Sempre gera um nome novo e
/// unico por timestamp.
/// </summary>
public static class FileNaming
{
    public static string GerarNomeArquivoVendas(IClock clock)
    {
        var now = clock.Now;
        return $"vendas-auto-{now:yyyyMMdd-HHmmss}.xls";
    }
}
