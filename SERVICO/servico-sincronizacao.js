'use strict';

/**
 * Servico de sincronizacao: coordena Repository + modulos de dominio.
 * NAO contem regra de negocio propria - a filtragem de elegibilidade usa
 * SRC/validar-normalizados.js (mesma regra ja validada), e o resto
 * continua 100% em SRC/. Este arquivo so orquestra a sequencia:
 *
 *   filtrar registros elegiveis (revalidados aqui, nao confia no que o
 *   chamador diz que e valido)
 *        -> Repository.buscarTodos()
 *        -> comparar-clientes.gerarPlanoSincronizacao()
 *        -> executar-plano-importacao.executarPlanoImportacao()
 *        -> Repository.salvarLote()
 *
 * Nao conhece Base44, Supabase, SQLite, JSON ou qualquer tecnologia de
 * persistencia - so conhece o CONTRATO do Repository (buscarTodos/
 * buscarPorNexCodigo/salvarLote), injetado por quem chamar este servico.
 * Se o Repository falhar, o erro propaga sem ser mascarado.
 *
 * Fase 5 (revisao critica): duas correcoes em relacao a versao original -
 * 1) A filtragem de "quais registros sao elegiveis para sincronizar"
 *    estava no adaptador HTTP (SERVICO/servidor-local.js); moveu para
 *    ca, que e o lugar correto (qualquer chamador de sincronizar(),
 *    HTTP ou nao, ganha a mesma regra automaticamente). Alem disso, a
 *    elegibilidade agora e REVALIDADA aqui com validarRegistro() em vez
 *    de confiar no campo validacao_status que veio de fora (que poderia
 *    ter sido adulterado antes de chegar ate aqui).
 * 2) sincronizar() agora serializa chamadas por instancia de repository
 *    (fila em memoria) para eliminar a corrida entre buscarTodos() e
 *    salvarLote() quando duas sincronizacoes concorrentes (duplo clique,
 *    duas abas) usam o mesmo Repository - sem isso, a segunda podia ler
 *    um "antes" desatualizado e perder a escrita da primeira.
 */

const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'SRC');
const { gerarPlanoSincronizacao } = require(path.join(SRC_DIR, 'comparar-clientes'));
const { executarPlanoImportacao } = require(path.join(SRC_DIR, 'executar-plano-importacao'));
const { validarRegistro } = require(path.join(SRC_DIR, 'validar-normalizados'));

function validarRepository(repository) {
  const metodosEsperados = ['buscarTodos', 'buscarPorNexCodigo', 'salvarLote'];
  const faltando = metodosEsperados.filter((m) => typeof (repository && repository[m]) !== 'function');
  if (faltando.length) {
    throw new Error('Repository invalido: nao implementa o(s) metodo(s) ' + faltando.join(', '));
  }
}

// So registros validos/com aviso sao elegiveis para sincronizacao - a
// mesma semantica de "ignorados" ja usada desde a Fase 2C. Revalida com
// SRC/validar-normalizados.js em vez de confiar no validacao_status que
// veio de fora, para nao aceitar como "valido" algo que um cliente
// (navegador) apenas AFIRMOU ser valido.
function apenasImportaveis(novaImportacao) {
  return (novaImportacao || []).filter((r) => r && validarRegistro(r).status !== 'invalido');
}

// Serializa as chamadas de sincronizar() por instancia de repository -
// ver nota "Fase 5 (revisao critica), item 2" acima.
const filasPorRepository = new WeakMap();

function executarNaFila(repository, tarefa) {
  const anterior = filasPorRepository.get(repository) || Promise.resolve();
  const atual = anterior.then(tarefa, tarefa);
  // Nunca deixa uma falha travar a fila para a proxima chamada; a
  // rejeicao real ainda propaga para quem chamou esta execucao (via `atual`).
  filasPorRepository.set(repository, atual.catch(() => {}));
  return atual;
}

/**
 * @param {Object} repository - implementacao do contrato RepositorioClientes (ex.: RepositorioClientesFake)
 * @param {Object[]} novaImportacao - clientes normalizados (objeto PRIME completo por item)
 * @param {Object} contexto - { dataExecucao, geradorPrimeId } - exigido por executar-plano-importacao.js
 * @returns {Promise<{ baseAntes: Object[], plano: Object, execucao: Object, totalProcessado: number }>}
 */
function sincronizar(repository, novaImportacao, contexto) {
  validarRepository(repository);

  return executarNaFila(repository, async () => {
    const importaveis = apenasImportaveis(novaImportacao);
    const baseAntes = await repository.buscarTodos();
    const plano = gerarPlanoSincronizacao(baseAntes, importaveis);
    const execucao = executarPlanoImportacao(baseAntes, importaveis, plano, contexto);

    // Se salvarLote falhar, a excecao propaga sem tratamento especial -
    // o chamador recebe a promise rejeitada e nenhum resultado "parcial"
    // e devolvido como se fosse sucesso.
    await repository.salvarLote(execucao.nova_base);

    return { baseAntes, plano, execucao, totalProcessado: importaveis.length };
  });
}

module.exports = { sincronizar, apenasImportaveis };
