'use strict';

/**
 * Servico de sincronizacao: coordena Repository + modulos de dominio.
 * NAO contem regra de negocio - isso continua 100% em SRC/. Este arquivo
 * so orquestra a sequencia:
 *
 *   Repository.buscarTodos()
 *        -> comparar-clientes.gerarPlanoSincronizacao()
 *        -> executar-plano-importacao.executarPlanoImportacao()
 *        -> Repository.salvarLote()
 *
 * Nao conhece Base44, Supabase, SQLite, JSON ou qualquer tecnologia de
 * persistencia - so conhece o CONTRATO do Repository (buscarTodos/
 * buscarPorNexCodigo/salvarLote), injetado por quem chamar este servico.
 * Se o Repository falhar, o erro propaga sem ser mascarado.
 */

const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'SRC');
const { gerarPlanoSincronizacao } = require(path.join(SRC_DIR, 'comparar-clientes'));
const { executarPlanoImportacao } = require(path.join(SRC_DIR, 'executar-plano-importacao'));

function validarRepository(repository) {
  const metodosEsperados = ['buscarTodos', 'buscarPorNexCodigo', 'salvarLote'];
  const faltando = metodosEsperados.filter((m) => typeof (repository && repository[m]) !== 'function');
  if (faltando.length) {
    throw new Error('Repository invalido: nao implementa o(s) metodo(s) ' + faltando.join(', '));
  }
}

/**
 * @param {Object} repository - implementacao do contrato RepositorioClientes (ex.: RepositorioClientesFake)
 * @param {Object[]} novaImportacao - clientes normalizados produzidos pela Fase 2A (SRC/normalizar-clientes.js)
 * @param {Object} contexto - { dataExecucao, geradorPrimeId } - exigido por executar-plano-importacao.js
 * @returns {Promise<{ baseAntes: Object[], plano: Object, execucao: Object }>}
 */
async function sincronizar(repository, novaImportacao, contexto) {
  validarRepository(repository);

  const baseAntes = await repository.buscarTodos();
  const plano = gerarPlanoSincronizacao(baseAntes, novaImportacao);
  const execucao = executarPlanoImportacao(baseAntes, novaImportacao, plano, contexto);

  // Se salvarLote falhar, a excecao propaga sem tratamento especial -
  // o chamador recebe a promise rejeitada e nenhum resultado "parcial"
  // e devolvido como se fosse sucesso.
  await repository.salvarLote(execucao.nova_base);

  return { baseAntes, plano, execucao };
}

module.exports = { sincronizar };
