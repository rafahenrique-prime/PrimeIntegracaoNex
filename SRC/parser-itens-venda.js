'use strict';

/**
 * Parser da coluna de itens concatenados dos exports oficiais do NEX
 * (coluna "Itens" no export de Vendas, "Descrição" no extrato individual
 * de transacoes). Formato observado: uma linha por item, separadas por
 * CRLF, cada linha no padrao "{quantidade} X {produto}", ex.:
 *
 *   "1 X BRAND 018 HUGO BOSS"
 *   "2 X CAMISETAS VARIADAS  G2/G3"
 *   "1 X CAMISETAS SUEDINE PREMIUM\r\n1 X BERMUDAS JR IMPORTADAS COM FORRO"
 *
 * NAO extrai preco unitario - os exports auditados nao fornecem isso com
 * seguranca para vendas com mais de um item (so o subtotal da venda inteira).
 */

function parseItensVenda(str) {
  if (str == null) return [];
  const texto = String(str);
  if (!texto.trim()) return [];

  const linhas = texto
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');

  return linhas.map((linha) => {
    const m = linha.match(/^(\d+)\s*X\s*(.+)$/i);
    if (m) {
      return { quantidade: parseInt(m[1], 10), produto: m[2].trim() };
    }
    // Linha fora do padrao esperado - preserva o texto bruto em vez de
    // descartar silenciosamente, sem inventar uma quantidade.
    return { quantidade: null, produto: linha };
  });
}

module.exports = { parseItensVenda };
