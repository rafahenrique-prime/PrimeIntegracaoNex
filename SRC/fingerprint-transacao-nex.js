'use strict';

/**
 * Fingerprint deterministico de transacoes normalizadas do NEX (Fase
 * EXPORT-FIRST - Fase D). Usado para detectar NEW/UNCHANGED/CHANGED sem
 * depender de LastWriteTime, nome do arquivo, posicao da linha ou qualquer
 * outra metadata de filesystem/importacao - so dos FATOS normalizados.
 *
 * Usa crypto nativo do Node (SHA-256) - nenhuma dependencia externa nova.
 *
 * SELECAO DE CAMPOS (documentada, conforme exigido):
 *
 * VENDA (normalizarVendaNex) - CAMPOS_FINGERPRINT_VENDA:
 *   nexTransactionId, occurredAt, customerName, items, subtotal, discount,
 *   amountPaid, amountDebt, paymentMethod, cancelled, cancelledAt, seller,
 *   employee.
 *   EXCLUIDOS deliberadamente:
 *     - `source`: o mesmo fato pode aparecer em mais de um export oficial
 *       (Vendas -> Historico E Extrato individual do cliente) com o mesmo
 *       nexTransactionId - a origem do registro nao e parte do FATO.
 *     - `tipoOriginal`: usado hoje so para validacao (Fase B); nao consta
 *       na lista de campos comerciais relevantes pedida para esta fase.
 *     - `observations`: texto livre sem impacto comercial estruturado;
 *       tratado como ruido para fins de fingerprint nesta fase.
 *
 * TRANSACAO DO CLIENTE (normalizarTransacaoClienteNex) -
 * CAMPOS_FINGERPRINT_TRANSACAO_CLIENTE:
 *   nexTransactionId, occurredAt, transactionType, description, totalAmount,
 *   amountPaid, amountDebt, paymentMethod, seller, employee, cancelled.
 *   EXCLUIDO: `source`, pelo mesmo motivo acima.
 */

const crypto = require('crypto');

const CAMPOS_FINGERPRINT_VENDA = [
  'nexTransactionId',
  'occurredAt',
  'customerName',
  'items',
  'subtotal',
  'discount',
  'amountPaid',
  'amountDebt',
  'paymentMethod',
  'cancelled',
  'cancelledAt',
  'seller',
  'employee',
];

const CAMPOS_FINGERPRINT_TRANSACAO_CLIENTE = [
  'nexTransactionId',
  'occurredAt',
  'transactionType',
  'description',
  'totalAmount',
  'amountPaid',
  'amountDebt',
  'paymentMethod',
  'seller',
  'employee',
  'cancelled',
];

/**
 * Canonicaliza um valor para serializacao deterministica: objetos planos
 * tem suas chaves ordenadas alfabeticamente (recursivamente); arrays
 * preservam a ORDEM ORIGINAL (a ordem dos itens de uma venda e um fato,
 * nao um acidente de serializacao); primitivos passam direto.
 */
function canonicalizarValor(v) {
  if (Array.isArray(v)) {
    return v.map(canonicalizarValor);
  }
  if (v && typeof v === 'object') {
    const chavesOrdenadas = Object.keys(v).sort();
    const obj = {};
    for (const k of chavesOrdenadas) obj[k] = canonicalizarValor(v[k]);
    return obj;
  }
  return v === undefined ? null : v; // undefined nao e serializavel de forma estavel em JSON - normaliza para null
}

function selecionarFatos(registro, campos) {
  const r = registro || {};
  const fatos = {};
  for (const campo of campos) fatos[campo] = r[campo] === undefined ? null : r[campo];
  return fatos;
}

/**
 * @param {Object} fatos - objeto ja reduzido aos campos relevantes
 * @returns {string} hash SHA-256 hexadecimal
 */
function calcularFingerprint(fatos) {
  const json = JSON.stringify(canonicalizarValor(fatos));
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * @param {Object} vendaNormalizada - saida de normalizarVendaNex
 * @returns {string} fingerprint SHA-256
 */
function gerarFingerprintVenda(vendaNormalizada) {
  return calcularFingerprint(selecionarFatos(vendaNormalizada, CAMPOS_FINGERPRINT_VENDA));
}

/**
 * @param {Object} transacaoNormalizada - saida de normalizarTransacaoClienteNex
 * @returns {string} fingerprint SHA-256
 */
function gerarFingerprintTransacaoCliente(transacaoNormalizada) {
  return calcularFingerprint(selecionarFatos(transacaoNormalizada, CAMPOS_FINGERPRINT_TRANSACAO_CLIENTE));
}

module.exports = {
  CAMPOS_FINGERPRINT_VENDA,
  CAMPOS_FINGERPRINT_TRANSACAO_CLIENTE,
  canonicalizarValor,
  selecionarFatos,
  calcularFingerprint,
  gerarFingerprintVenda,
  gerarFingerprintTransacaoCliente,
};
