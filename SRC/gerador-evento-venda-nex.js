'use strict';

/**
 * Construtor PURO de eventos de venda (Fase EXPORT-FIRST - Fase E). Nao
 * calcula identidade nem resolve cliente - recebe esses resultados ja
 * prontos e so monta o(s) objeto(s) de evento no shape previsivel.
 *
 * DECISAO DE DESIGN (cancelamento, documentada conforme exigido):
 * cancelamento e tratado como uma representacao ADICIONAL, nao como
 * substituicao da classificacao comercial de base. Uma venda com
 * `cancelled=true` gera:
 *   1. o evento de base (SALE_PAID/DEBT_CREATED/SALE_PARTIALLY_PAID, ou a
 *      entrada UNCLASSIFIED se nao houver amountPaid/amountDebt) -
 *      SEMPRE gerado, refletindo o fato comercial da venda, independente
 *      de cancelamento;
 *   2. um evento SALE_CANCELLED ADICIONAL, SOMENTE quando cancelled=true.
 * Isso preserva o principio "MESMO eventId + payload atualizado para
 * mudancas que NAO representam um novo tipo de acontecimento" (o evento de
 * base continua com o MESMO eventId antes/depois do cancelamento) e ao
 * mesmo tempo satisfaz "representacao explicita de cancelamento" (o
 * SALE_CANCELLED e um evento de tipo proprio, com seu proprio eventId
 * estavel, adicionado sem reescrever a identidade nem duplicar o evento
 * de base).
 *
 * VALOR PRINCIPAL POR EVENTO (`amount`):
 *   SALE_PAID            -> amount = amountPaid
 *   DEBT_CREATED         -> amount = amountDebt
 *   SALE_PARTIALLY_PAID  -> amount = null (nao ha um unico valor - ver
 *                           amountPaid/amountDebt, ambos preservados)
 *   SALE_CANCELLED       -> amount = null (nao inventa um valor comercial
 *                           para o ato de cancelar; preserva so o
 *                           necessario para identificar a venda cancelada)
 */

function baseEvento(vendaNormalizada, identityKey, resolucaoCliente) {
  const v = vendaNormalizada || {};
  const resolvido = resolucaoCliente && resolucaoCliente.status === 'RESOLVED';
  return {
    identityKey,
    nexTransactionId: v.nexTransactionId,
    occurredAt: v.occurredAt,
    nexCustomerCode: resolvido ? resolucaoCliente.nexCustomerCode : null,
    customerName: v.customerName,
    customerResolutionStatus: resolucaoCliente ? resolucaoCliente.status : null,
    paymentMethod: v.paymentMethod || null,
    items: v.items || null,
    cancelled: v.cancelled === true,
    cancelledAt: v.cancelledAt || null,
    source: v.source || null,
  };
}

/**
 * @param {Object} vendaNormalizada - saida de normalizarVendaNex
 * @param {string} identityKey - saida de gerarChaveIdentidadeTransacaoNex(...).identityKey
 * @param {Object} resolucaoCliente - saida de resolverCliente(...)
 * @param {{status:'CLASSIFIED', eventType:string} | {status:'UNCLASSIFIED', motivo:string}} classificacao - saida de classificarVenda(...)
 * @returns {Array<Object>} 1 ou 2 entradas (2 quando cancelled=true: base + SALE_CANCELLED)
 */
function gerarEventosVenda(vendaNormalizada, identityKey, resolucaoCliente, classificacao) {
  const v = vendaNormalizada || {};
  const eventos = [];

  if (classificacao.status === 'UNCLASSIFIED') {
    eventos.push({
      status: 'UNCLASSIFIED',
      motivo: classificacao.motivo,
      nexTransactionId: v.nexTransactionId,
      identityKey,
    });
  } else {
    const comum = baseEvento(v, identityKey, resolucaoCliente);
    const eventType = classificacao.eventType;
    let amount = null;
    if (eventType === 'SALE_PAID') amount = v.amountPaid;
    else if (eventType === 'DEBT_CREATED') amount = v.amountDebt;
    // SALE_PARTIALLY_PAID: amount permanece null - ver amountPaid/amountDebt

    eventos.push(
      Object.assign(
        {
          eventId: `${eventType}:${identityKey}`,
          eventType,
        },
        comum,
        {
          amount,
          amountPaid: v.amountPaid,
          amountDebt: v.amountDebt,
        },
      ),
    );
  }

  if (v.cancelled === true) {
    const comum = baseEvento(v, identityKey, resolucaoCliente);
    eventos.push(
      Object.assign(
        {
          eventId: `SALE_CANCELLED:${identityKey}`,
          eventType: 'SALE_CANCELLED',
        },
        comum,
        {
          amount: null,
          amountPaid: null,
          amountDebt: null,
        },
      ),
    );
  }

  return eventos;
}

module.exports = { gerarEventosVenda };
