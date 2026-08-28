'use strict';

/**
 * Parser financeiro da coluna "Debito / Credito" do NEX.
 * Extraido e validado na Fase 1 (analisar-clientes.js) contra o total real
 * exibido na interface do NEX (R$ 25.414,58) - nenhuma logica foi alterada
 * aqui alem da extracao para modulo reutilizavel.
 *
 * Nao usa o sinal numerico como fonte de classificacao. Le os rotulos
 * "Debito" e "Credito" separadamente (aceita ":" ou "-" como separador);
 * ambos podem coexistir na mesma celula.
 */

function parseValorBR(str) {
  if (str == null) return NaN;
  let s = String(str).trim();
  if (!s) return NaN;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma && !hasDot) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isNaN(n) ? NaN : n;
}

function parseFinanceiro(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { tipo: 'vazio', raw: text, debito: null, credito: null };

  const reDebito = /d[ée]bito\s*[:\-]?\s*r?\$?\s*([\d.,]+)/i;
  const reCredito = /cr[ée]dito\s*[:\-]?\s*r?\$?\s*([\d.,]+)/i;
  const mD = text.match(reDebito);
  const mC = text.match(reCredito);

  let debito = mD ? parseValorBR(mD[1]) : null;
  let credito = mC ? parseValorBR(mC[1]) : null;
  if (debito != null && Number.isNaN(debito)) debito = null;
  if (credito != null && Number.isNaN(credito)) credito = null;

  if (debito != null || credito != null) {
    return { tipo: 'reconhecido', raw: text, debito: debito || 0, credito: credito || 0 };
  }

  const soNumero = text.match(/^r?\$?\s*([\d.,]+)$/i);
  if (soNumero) {
    const v = parseValorBR(soNumero[1]);
    if (!Number.isNaN(v) && v === 0) {
      return { tipo: 'zero', raw: text, debito: 0, credito: 0 };
    }
  }

  return { tipo: 'formato_nao_reconhecido', raw: text, debito: null, credito: null };
}

/**
 * Parser de valor monetario "solto" (sem rotulo Debito/Credito), no formato
 * como aparece nas colunas de moeda dos exports oficiais de Vendas/Transacoes
 * do NEX (Fase EXPORT-FIRST), ex.: "R$ 87.00 ", "R$ 1.135,00", "87.00".
 *
 * Reutiliza parseValorBR para a normalizacao de separador decimal/milhar -
 * a unica diferenca e que aqui removemos o prefixo "R$" antes, e vazio/null
 * vira `null` (nao encontrado) em vez de NaN (erro de formato), para o
 * chamador poder distinguir "campo nao preenchido" de "valor corrompido".
 *
 * Formatos observados nos exports auditados e cobertos:
 *   "R$ 87.00 "     -> 87    (ponto como separador DECIMAL - sem virgula)
 *   "R$ 1.135,00"   -> 1135  (padrao BR: ponto = milhar, virgula = decimal)
 *   "87.00"         -> 87    (mesmo sem "R$")
 *   ""              -> null
 *   null/undefined  -> null
 *
 * ATENCAO - ambiguidade conhecida e NAO resolvida por este parser: um valor
 * com ponto e SEM virgula e SEM casas decimais aparentes (ex.: "1.135") e
 * ambiguo entre "mil, cento e trinta e cinco" (BR, ponto=milhar) e "um virgula
 * cento e trinta e cinco" (ponto=decimal). Este parser herda o comportamento
 * de parseValorBR para esse caso (trata o ponto como decimal, pois nao ha
 * virgula), que e o mesmo comportamento ja usado em producao por essa funcao.
 * Nenhum export auditado ate agora produziu essa forma ambigua sem casas
 * decimais - se isso aparecer no futuro, este parser deve ser revisado antes
 * de confiar cegamente no resultado.
 */
function parseValorSolto(str) {
  if (str == null) return null;
  let s = String(str).trim();
  if (!s) return null;
  s = s.replace(/^r\$\s*/i, '').trim();
  if (!s) return null;
  const valor = parseValorBR(s);
  return Number.isNaN(valor) ? null : valor;
}

module.exports = { parseValorBR, parseFinanceiro, parseValorSolto };
