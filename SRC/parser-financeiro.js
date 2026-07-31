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

module.exports = { parseValorBR, parseFinanceiro };
