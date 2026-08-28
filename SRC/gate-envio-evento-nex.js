'use strict';

/**
 * Gate de envio / quarentena (Fase EXPORT-FIRST - Fase E.1).
 *
 * PRINCIPIO: esta camada NAO decide novamente o evento - a classificacao
 * da Fase E continua Source of Truth local. Esta funcao pura responde
 * SOMENTE: "este evento esta seguro para ser enviado?", nunca corrige ou
 * inventa informacao ausente. Nunca muta o evento original (so o
 * referencia dentro do resultado).
 *
 * EVENTOS QUE EXIGEM CLIENTE RESOLVIDO: os 5 event types aprovados na
 * Fase E (SALE_PAID, DEBT_CREATED, SALE_PARTIALLY_PAID, DEBT_PAYMENT,
 * SALE_CANCELLED) SEMPRE envolvem um cliente - por isso a exigencia de
 * `customerResolutionStatus === 'RESOLVED'` + `nexCustomerCode` presente
 * se aplica universalmente a todos eles, sem excecao por eventType.
 *
 * DECISAO DE GRANULARIDADE DOCUMENTADA: o objeto de evento produzido pela
 * Fase E carrega `customerResolutionStatus` ('RESOLVED'|'REVIEW_REQUIRED')
 * mas NAO o motivo fino da resolucao (SEM_MATCH vs MULTIPLOS_MATCHES) - a
 * Fase E nao expos esse campo no shape do evento. Para nao reabrir/alterar
 * codigo da Fase E ja aprovada so para esta granularidade opcional ("se
 * util", nao obrigatoria), o motivo usado aqui e o generico
 * `CUSTOMER_NOT_RESOLVED` para qualquer caso de cliente nao resolvido
 * (SEM_MATCH, MULTIPLOS_MATCHES, ou nexCustomerCode ausente por qualquer
 * outro motivo). Essa e uma decisao consciente de escopo minimo, nao uma
 * lacuna descoberta tardiamente.
 */

const EVENT_TYPES_QUE_EXIGEM_CLIENTE = new Set([
  'SALE_PAID',
  'DEBT_CREATED',
  'SALE_PARTIALLY_PAID',
  'DEBT_PAYMENT',
  'SALE_CANCELLED',
]);

/**
 * @param {Object} entrada - uma entrada da saida de gerarEventosDeVenda(...)
 *   ou gerarEventoDeTransacaoCliente(...) - pode ser um evento classificado,
 *   uma entrada {status:'UNCLASSIFIED', ...}, ou {status:'INVALID_IDENTITY', ...}
 * @returns {{status:'READY_TO_SEND'|'REVIEW_REQUIRED', reason:string|null, event:Object}}
 */
function avaliarGateEnvio(entrada) {
  if (!entrada) {
    return { status: 'REVIEW_REQUIRED', reason: 'INVALID_EVENT_ENTRY', event: entrada };
  }

  if (entrada.status === 'UNCLASSIFIED') {
    return { status: 'REVIEW_REQUIRED', reason: 'UNCLASSIFIED_EVENT', event: entrada };
  }

  if (entrada.status === 'INVALID_IDENTITY') {
    return { status: 'REVIEW_REQUIRED', reason: 'INVALID_IDENTITY', event: entrada };
  }

  // A partir daqui, entrada e um evento classificado (tem eventType/eventId/identityKey).
  if (!entrada.identityKey || !entrada.eventId) {
    return { status: 'REVIEW_REQUIRED', reason: 'INVALID_IDENTITY', event: entrada };
  }

  if (EVENT_TYPES_QUE_EXIGEM_CLIENTE.has(entrada.eventType)) {
    const clienteResolvido = entrada.customerResolutionStatus === 'RESOLVED' && !!entrada.nexCustomerCode;
    if (!clienteResolvido) {
      return { status: 'REVIEW_REQUIRED', reason: 'CUSTOMER_NOT_RESOLVED', event: entrada };
    }
  }

  return { status: 'READY_TO_SEND', reason: null, event: entrada };
}

/**
 * Processa um lote de entradas (eventos + UNCLASSIFIED + INVALID_IDENTITY)
 * e separa em readyToSend/reviewRequired, com estatisticas por motivo.
 * A Fase F devera consumir SOMENTE `readyToSend`, nunca o lote bruto.
 *
 * @param {Array<Object>} entradas
 * @returns {{readyToSend:Array, reviewRequired:Array, estatisticas:{total:number, readyToSend:number, reviewRequired:number, reasons:Object}}}
 */
function avaliarLoteEnvio(entradas) {
  const lista = Array.isArray(entradas) ? entradas : [];
  const readyToSend = [];
  const reviewRequired = [];

  for (const entrada of lista) {
    const resultado = avaliarGateEnvio(entrada);
    if (resultado.status === 'READY_TO_SEND') readyToSend.push(resultado);
    else reviewRequired.push(resultado);
  }

  const reasons = {};
  reviewRequired.forEach((r) => {
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  });

  return {
    readyToSend,
    reviewRequired,
    estatisticas: {
      total: lista.length,
      readyToSend: readyToSend.length,
      reviewRequired: reviewRequired.length,
      reasons,
    },
  };
}

module.exports = { avaliarGateEnvio, avaliarLoteEnvio, EVENT_TYPES_QUE_EXIGEM_CLIENTE };
