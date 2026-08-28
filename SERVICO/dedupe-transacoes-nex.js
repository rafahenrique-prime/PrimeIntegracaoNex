'use strict';

/**
 * Orquestracao de dedupe/idempotencia (Fase EXPORT-FIRST - Fase D/D.2):
 * liga IDENTIDADE + comparador + fingerprint + Repository (interface, nao
 * um backend especifico) para processar UM registro normalizado de cada
 * vez.
 *
 * Nao contem regra de negocio de classificacao de evento - isso e Fase E,
 * ainda nao aprovada. Este arquivo so orquestra a sequencia: calcular
 * identidade -> buscar conhecido (pela identidade) -> comparar (via
 * fingerprint) -> se NEW/CHANGED, salvar o novo estado.
 *
 * IDENTIDADE (SRC/identidade-transacao-nex.js) e FINGERPRINT
 * (SRC/fingerprint-transacao-nex.js) permanecem responsabilidades
 * separadas, conforme Fase D.2: identidade decide QUAL transacao e;
 * fingerprint decide SE ela mudou.
 *
 * Segue o mesmo espirito de SERVICO/servico-sincronizacao.js: recebe o
 * Repository por injecao de dependencia (nunca faz `require` de uma
 * implementacao concreta), entao qualquer Repository real (HTTP para
 * IGNITE PRIME, por exemplo) podera ser plugado aqui em fase futura sem
 * mudar este arquivo.
 */

const path = require('path');
const { compararVenda, compararTransacaoCliente } = require(path.join(__dirname, '..', 'SRC', 'comparador-transacao-nex'));
const {
  gerarFingerprintVenda,
  gerarFingerprintTransacaoCliente,
} = require(path.join(__dirname, '..', 'SRC', 'fingerprint-transacao-nex'));
const { gerarChaveIdentidadeTransacaoNex } = require(path.join(__dirname, '..', 'SRC', 'identidade-transacao-nex'));

/**
 * @param {Object} vendaNormalizada - saida de normalizarVendaNex
 * @param {{buscarPorIdentityKey:Function, salvar:Function}} repository
 * @returns {Promise<{status:'NEW'|'UNCHANGED'|'CHANGED', nexTransactionId:string, identityKey?:string, changedFields?:Array} | {status:'INVALID_IDENTITY', motivo:string, nexTransactionId:string}>}
 */
async function processarVenda(vendaNormalizada, repository) {
  const identidade = gerarChaveIdentidadeTransacaoNex(vendaNormalizada);
  if (identidade.status === 'INVALID_IDENTITY') {
    return { status: 'INVALID_IDENTITY', motivo: identidade.motivo, nexTransactionId: vendaNormalizada ? vendaNormalizada.nexTransactionId : null };
  }

  const conhecido = await repository.buscarPorIdentityKey(identidade.identityKey);
  const resultado = compararVenda(conhecido ? conhecido.registro : null, vendaNormalizada);

  if (resultado.status !== 'UNCHANGED') {
    await repository.salvar({
      identityKey: identidade.identityKey,
      nexTransactionId: vendaNormalizada.nexTransactionId,
      registro: vendaNormalizada,
      fingerprint: gerarFingerprintVenda(vendaNormalizada),
      tipo: 'venda',
    });
  }

  return Object.assign({}, resultado, { identityKey: identidade.identityKey });
}

/**
 * @param {Object} transacaoNormalizada - saida de normalizarTransacaoClienteNex
 * @param {{buscarPorIdentityKey:Function, salvar:Function}} repository
 * @returns {Promise<{status:'NEW'|'UNCHANGED'|'CHANGED', nexTransactionId:string, identityKey?:string, changedFields?:Array} | {status:'INVALID_IDENTITY', motivo:string, nexTransactionId:string}>}
 */
async function processarTransacaoCliente(transacaoNormalizada, repository) {
  const identidade = gerarChaveIdentidadeTransacaoNex(transacaoNormalizada);
  if (identidade.status === 'INVALID_IDENTITY') {
    return { status: 'INVALID_IDENTITY', motivo: identidade.motivo, nexTransactionId: transacaoNormalizada ? transacaoNormalizada.nexTransactionId : null };
  }

  const conhecido = await repository.buscarPorIdentityKey(identidade.identityKey);
  const resultado = compararTransacaoCliente(conhecido ? conhecido.registro : null, transacaoNormalizada);

  if (resultado.status !== 'UNCHANGED') {
    await repository.salvar({
      identityKey: identidade.identityKey,
      nexTransactionId: transacaoNormalizada.nexTransactionId,
      registro: transacaoNormalizada,
      fingerprint: gerarFingerprintTransacaoCliente(transacaoNormalizada),
      tipo: 'transacaoCliente',
    });
  }

  return Object.assign({}, resultado, { identityKey: identidade.identityKey });
}

/**
 * Processa um lote de vendas normalizadas sequencialmente contra o mesmo
 * repository, devolvendo um resultado por item na mesma ordem de entrada.
 * Util para os testes de lote/reimportacao (Fase D) - nao e um requisito
 * de performance, apenas previsibilidade.
 *
 * @param {Object[]} vendasNormalizadas
 * @param {Object} repository
 * @returns {Promise<Array>}
 */
async function processarLoteVendas(vendasNormalizadas, repository) {
  const resultados = [];
  for (const venda of vendasNormalizadas) {
    resultados.push(await processarVenda(venda, repository));
  }
  return resultados;
}

module.exports = { processarVenda, processarTransacaoCliente, processarLoteVendas };
