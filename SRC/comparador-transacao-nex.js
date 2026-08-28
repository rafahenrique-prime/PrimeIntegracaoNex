'use strict';

/**
 * Comparador puro NEW/UNCHANGED/CHANGED (Fase EXPORT-FIRST - Fase D).
 *
 * NAO decide eventType (SALE_PAID/DEBT_CREATED/DEBT_PAYMENT/etc.) - isso
 * pertence a Fase E, ainda nao aprovada. Aqui so classificamos se um
 * registro normalizado e novo, identico ao que ja conhecemos, ou mudou.
 *
 * A identidade usada e SEMPRE nexTransactionId - nunca nexCustomerCode
 * (resolucao de cliente e independente de dedupe, conforme decidido).
 */

const path = require('path');
const {
  CAMPOS_FINGERPRINT_VENDA,
  CAMPOS_FINGERPRINT_TRANSACAO_CLIENTE,
  selecionarFatos,
  calcularFingerprint,
} = require(path.join(__dirname, 'fingerprint-transacao-nex'));

function valoresIguais(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

/**
 * Compara dois registros normalizados (mesmo nexTransactionId, por
 * construcao - o chamador e quem decide que sao "o mesmo id") usando a
 * lista de campos relevantes fornecida.
 *
 * @param {Object|null} registroConhecido - o que ja estava armazenado (ou
 *   null/undefined se nao havia nada com esse nexTransactionId ainda)
 * @param {Object} registroAtual - o registro normalizado recem-lido
 * @param {string[]} campos - CAMPOS_FINGERPRINT_VENDA ou
 *   CAMPOS_FINGERPRINT_TRANSACAO_CLIENTE
 * @returns {{status:'NEW'|'UNCHANGED'|'CHANGED', nexTransactionId:string, changedFields?:Array}}
 */
function compararRegistros(registroConhecido, registroAtual, campos) {
  const nexTransactionId = registroAtual && registroAtual.nexTransactionId != null ? registroAtual.nexTransactionId : null;

  if (!registroConhecido) {
    return { status: 'NEW', nexTransactionId };
  }

  const fatosAtual = selecionarFatos(registroAtual, campos);
  const fatosConhecido = selecionarFatos(registroConhecido, campos);

  const fingerprintAtual = calcularFingerprint(fatosAtual);
  const fingerprintConhecido = calcularFingerprint(fatosConhecido);

  if (fingerprintAtual === fingerprintConhecido) {
    return { status: 'UNCHANGED', nexTransactionId };
  }

  const changedFields = [];
  for (const campo of campos) {
    if (!valoresIguais(fatosConhecido[campo], fatosAtual[campo])) {
      changedFields.push({ field: campo, before: fatosConhecido[campo], after: fatosAtual[campo] });
    }
  }

  return { status: 'CHANGED', nexTransactionId, changedFields };
}

/**
 * @param {Object} vendaAtual - saida de normalizarVendaNex
 * @param {Object|null} vendaConhecida - o que ja estava armazenado (mesmo shape)
 */
function compararVenda(vendaConhecida, vendaAtual) {
  return compararRegistros(vendaConhecida, vendaAtual, CAMPOS_FINGERPRINT_VENDA);
}

/**
 * @param {Object} transacaoAtual - saida de normalizarTransacaoClienteNex
 * @param {Object|null} transacaoConhecida - o que ja estava armazenado (mesmo shape)
 */
function compararTransacaoCliente(transacaoConhecida, transacaoAtual) {
  return compararRegistros(transacaoConhecida, transacaoAtual, CAMPOS_FINGERPRINT_TRANSACAO_CLIENTE);
}

module.exports = { compararRegistros, compararVenda, compararTransacaoCliente };
