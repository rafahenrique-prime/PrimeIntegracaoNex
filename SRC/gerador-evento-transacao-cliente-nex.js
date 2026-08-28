'use strict';

/**
 * Construtor PURO de evento de transacao do extrato individual do cliente
 * (Fase EXPORT-FIRST - Fase E). Hoje so produz DEBT_PAYMENT (unico
 * eventType formalizado como fonte-primaria para este export - ver
 * classificador-evento-transacao-cliente-nex.js).
 *
 * IMPORTANTE: o extrato individual do cliente NAO repete nexCustomerCode
 * nem customerName por linha (auditado nas fases anteriores) - por isso
 * este construtor NUNCA infere esses campos a partir da propria linha.
 * Eles DEVEM vir do contexto de geracao do relatorio (qual cliente foi
 * selecionado na tela do NEX), fornecido explicitamente pelo chamador.
 *
 * NAO inventa relatedSaleId - o export nao expoe vinculo explicito entre
 * quitacao e venda de origem (Checkpoint D.1). O evento e valido sem ele.
 */

/**
 * @param {Object} transacaoNormalizada - saida de normalizarTransacaoClienteNex
 * @param {string} identityKey - saida de gerarChaveIdentidadeTransacaoNex(...).identityKey
 * @param {{nexCustomerCode:string, customerName?:string}} contextoCliente - fornecido
 *   pelo chamador (contexto do relatorio), NUNCA inferido da linha
 * @param {{status:'CLASSIFIED', eventType:string} | {status:'UNCLASSIFIED', motivo:string}} classificacao
 * @returns {Object} evento DEBT_PAYMENT, ou entrada UNCLASSIFIED
 */
function gerarEventoTransacaoCliente(transacaoNormalizada, identityKey, contextoCliente, classificacao) {
  const t = transacaoNormalizada || {};
  const ctx = contextoCliente || {};

  if (classificacao.status === 'UNCLASSIFIED') {
    return {
      status: 'UNCLASSIFIED',
      motivo: classificacao.motivo,
      nexTransactionId: t.nexTransactionId,
      identityKey,
    };
  }

  const eventType = classificacao.eventType; // 'DEBT_PAYMENT'

  return {
    eventId: `${eventType}:${identityKey}`,
    eventType,
    identityKey,
    nexTransactionId: t.nexTransactionId,
    occurredAt: t.occurredAt,
    nexCustomerCode: ctx.nexCustomerCode != null ? ctx.nexCustomerCode : null,
    customerName: ctx.customerName != null ? ctx.customerName : null,
    customerResolutionStatus: ctx.nexCustomerCode != null ? 'RESOLVED' : 'REVIEW_REQUIRED',
    amount: t.amountPaid,
    amountPaid: t.amountPaid,
    amountDebt: t.amountDebt,
    paymentMethod: t.paymentMethod || null,
    items: null,
    cancelled: t.cancelled === true,
    cancelledAt: null,
    // relatedSaleId deliberadamente OMITIDO - o export nao expoe vinculo
    // explicito entre quitacao e venda de origem (Checkpoint D.1); o
    // evento e valido sem ele, nunca inferido por coincidencia de valor.
    source: t.source || null,
  };
}

module.exports = { gerarEventoTransacaoCliente };
