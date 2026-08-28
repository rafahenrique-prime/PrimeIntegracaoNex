'use strict';

/**
 * Orquestracao de geracao de eventos de negocio (Fase EXPORT-FIRST - Fase
 * E): liga IDENTIDADE + CustomerResolver + CLASSIFICACAO + construtor de
 * evento para produzir o(s) evento(s) de UM registro normalizado de cada
 * vez. Nao integra HTTP, nao conhece IGNITE PRIME/Repository real.
 *
 * Segue o mesmo espirito de SERVICO/dedupe-transacoes-nex.js: cada peca
 * (identidade, resolver, classificador, construtor de evento) e pura e
 * teria sido testada isoladamente nas fases anteriores - este arquivo so
 * orquestra a sequencia de chamadas.
 */

const path = require('path');
const { gerarChaveIdentidadeTransacaoNex } = require(path.join(__dirname, '..', 'SRC', 'identidade-transacao-nex'));
const { resolverCliente } = require(path.join(__dirname, '..', 'SRC', 'customer-resolver-nex'));
const { classificarVenda } = require(path.join(__dirname, '..', 'SRC', 'classificador-evento-venda-nex'));
const { classificarTransacaoCliente } = require(path.join(__dirname, '..', 'SRC', 'classificador-evento-transacao-cliente-nex'));
const { gerarEventosVenda } = require(path.join(__dirname, '..', 'SRC', 'gerador-evento-venda-nex'));
const { gerarEventoTransacaoCliente } = require(path.join(__dirname, '..', 'SRC', 'gerador-evento-transacao-cliente-nex'));

/**
 * @param {Object} vendaNormalizada - saida de normalizarVendaNex
 * @param {Map} indiceClientes - saida de criarIndiceClientes (Fase C)
 * @returns {Array<Object>} eventos (ou [{status:'INVALID_IDENTITY', ...}] se a identidade nao puder ser calculada)
 */
function gerarEventosDeVenda(vendaNormalizada, indiceClientes) {
  const identidade = gerarChaveIdentidadeTransacaoNex(vendaNormalizada);
  if (identidade.status === 'INVALID_IDENTITY') {
    return [{ status: 'INVALID_IDENTITY', motivo: identidade.motivo, nexTransactionId: vendaNormalizada ? vendaNormalizada.nexTransactionId : null }];
  }

  const resolucaoCliente = resolverCliente(vendaNormalizada.customerName, indiceClientes);
  const classificacao = classificarVenda(vendaNormalizada);

  return gerarEventosVenda(vendaNormalizada, identidade.identityKey, resolucaoCliente, classificacao);
}

/**
 * @param {Object} transacaoNormalizada - saida de normalizarTransacaoClienteNex
 * @param {{nexCustomerCode:string, customerName?:string}} contextoCliente - contexto do
 *   relatorio (qual cliente foi selecionado no NEX) - NUNCA inferido da linha
 * @returns {Object} evento DEBT_PAYMENT, entrada UNCLASSIFIED, ou INVALID_IDENTITY
 */
function gerarEventoDeTransacaoCliente(transacaoNormalizada, contextoCliente) {
  const identidade = gerarChaveIdentidadeTransacaoNex(transacaoNormalizada);
  if (identidade.status === 'INVALID_IDENTITY') {
    return { status: 'INVALID_IDENTITY', motivo: identidade.motivo, nexTransactionId: transacaoNormalizada ? transacaoNormalizada.nexTransactionId : null };
  }

  const classificacao = classificarTransacaoCliente(transacaoNormalizada);
  return gerarEventoTransacaoCliente(transacaoNormalizada, identidade.identityKey, contextoCliente, classificacao);
}

module.exports = { gerarEventosDeVenda, gerarEventoDeTransacaoCliente };
