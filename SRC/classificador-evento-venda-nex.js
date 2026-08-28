'use strict';

/**
 * Classificacao PURA de uma venda normalizada (Fase EXPORT-FIRST - Fase E)
 * em um dos EVENT TYPES aprovados, usando SOMENTE os fatos ja normalizados
 * pela Fase B (amountPaid/amountDebt). NAO conhece identidade, dedupe,
 * CustomerResolver, eventId, HTTP ou .nx1.
 *
 * O NEX e Source of Truth para o que aconteceu (venda, pagamento, valor
 * pago, valor debitado, itens, forma de pagamento, cancelamento). O PRIME
 * decidira depois vencimentos/parcelas/negociacao - nada disso e inventado
 * aqui.
 *
 * REGRA (independente de `cancelled` - cancelamento e tratado como uma
 * representacao ADICIONAL, nao como substituicao da classificacao
 * comercial de base - ver SERVICO/gerador-eventos-nex.js):
 *
 *   amountPaid > 0 E (amountDebt ausente/zero)      -> SALE_PAID
 *   amountDebt > 0 E (amountPaid ausente/zero)      -> DEBT_CREATED
 *   amountPaid > 0 E amountDebt > 0                 -> SALE_PARTIALLY_PAID
 *   nenhum dos dois > 0                             -> UNCLASSIFIED
 */

function ehValorPositivo(v) {
  return typeof v === 'number' && !Number.isNaN(v) && v > 0;
}

/**
 * @param {Object} vendaNormalizada - saida de normalizarVendaNex
 * @returns {{status:'CLASSIFIED', eventType:'SALE_PAID'|'DEBT_CREATED'|'SALE_PARTIALLY_PAID'} | {status:'UNCLASSIFIED', motivo:string}}
 */
function classificarVenda(vendaNormalizada) {
  const v = vendaNormalizada || {};
  const pago = ehValorPositivo(v.amountPaid);
  const devido = ehValorPositivo(v.amountDebt);

  if (pago && devido) return { status: 'CLASSIFIED', eventType: 'SALE_PARTIALLY_PAID' };
  if (pago && !devido) return { status: 'CLASSIFIED', eventType: 'SALE_PAID' };
  if (!pago && devido) return { status: 'CLASSIFIED', eventType: 'DEBT_CREATED' };

  return {
    status: 'UNCLASSIFIED',
    motivo: 'AMOUNT_PAID_AND_AMOUNT_DEBT_BOTH_ABSENT_OR_ZERO',
  };
}

module.exports = { classificarVenda, ehValorPositivo };
