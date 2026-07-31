'use strict';

/**
 * FAKE do contrato RepositorioClientes definido na Fase 4A.
 *
 * ATENCAO: isto NAO e um banco de dados nem uma solucao definitiva.
 * Existe exclusivamente para permitir testar a arquitetura (Repository +
 * ServicoSincronizacao) de ponta a ponta antes de qualquer decisao de
 * backend real (Base44, Supabase, etc). Os dados vivem só em um Map
 * dentro do processo, nunca tocam disco, rede ou qualquer SDK externo, e
 * desaparecem quando o processo termina.
 *
 * Contrato implementado (identico ao documentado em
 * DOCS/arquitetura-persistencia.md):
 *   buscarTodos()                  -> Promise<PrimeCliente[]>
 *   buscarPorNexCodigo(nex_codigo) -> Promise<PrimeCliente|null>
 *   salvarLote(clientes)           -> Promise<void>
 *
 * Nao conhece Base44, Supabase, SQLite, JSON em disco ou qualquer API.
 */

function clonar(obj) {
  return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
}

class RepositorioClientesFake {
  /**
   * @param {Object[]} [dadosIniciais] - estado inicial (ex.: simular uma base ja existente)
   */
  constructor(dadosIniciais) {
    this._dados = new Map();
    (dadosIniciais || []).forEach((c) => {
      if (c && c.nex_codigo !== null && c.nex_codigo !== undefined) {
        this._dados.set(String(c.nex_codigo), clonar(c));
      }
    });
    this._falhaProximaGravacao = null;
  }

  async buscarTodos() {
    return [...this._dados.values()].map(clonar);
  }

  async buscarPorNexCodigo(nexCodigo) {
    const c = this._dados.get(String(nexCodigo));
    return c ? clonar(c) : null;
  }

  async salvarLote(clientes) {
    if (this._falhaProximaGravacao) {
      const erro = this._falhaProximaGravacao;
      this._falhaProximaGravacao = null; // consome a falha - so a proxima chamada e afetada
      throw erro;
    }
    (clientes || []).forEach((c) => {
      if (!c || c.nex_codigo === null || c.nex_codigo === undefined) return;
      this._dados.set(String(c.nex_codigo), clonar(c));
    });
  }

  /**
   * Somente para testes: faz a PROXIMA chamada a salvarLote() rejeitar com
   * o erro informado (ou um erro padrao), sem alterar o estado interno.
   */
  simularFalhaNaProximaGravacao(erro) {
    this._falhaProximaGravacao = erro || new Error('Falha simulada em salvarLote (RepositorioClientesFake)');
  }
}

module.exports = { RepositorioClientesFake };
