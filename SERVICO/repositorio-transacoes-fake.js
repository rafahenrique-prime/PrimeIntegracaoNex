'use strict';

/**
 * FAKE de um repositorio de transacoes NEX normalizadas (Fase EXPORT-FIRST
 * - Fase D/D.2), no mesmo espirito de RepositorioClientesFake (Fase 4A/4C):
 * existe exclusivamente para testar idempotencia/dedupe em memoria, antes
 * de qualquer decisao de backend real. Nao conhece IGNITE PRIME, HTTP,
 * SQLite, Supabase, Base44 ou qualquer API - nao toca disco nem rede.
 *
 * CHAVE DE ARMAZENAMENTO (Fase D.2): `item.identityKey`, quando presente
 * (produzida por SRC/identidade-transacao-nex.js - pode depender so de
 * nexTransactionId, ou de nexTransactionId+occurredAt para IDs nao
 * numericos). Callers anteriores a Fase D.2 que ainda salvam sem
 * `identityKey` continuam funcionando: a chave cai de volta para
 * `nexTransactionId` (comportamento identico ao da Fase D original).
 * NUNCA nexCustomerCode.
 *
 * Guarda, por transacao, o registro normalizado mais recente e o
 * fingerprint associado (para nao recalcular a cada comparacao).
 *
 * Operacoes: buscarPorIdentityKey() (Fase D.2, uso recomendado),
 * buscarPorNexTransactionId() (legado - so encontra itens salvos SEM
 * identityKey; nao serve para IDs nao-numericos, que podem ter mais de
 * uma transacao por nexTransactionId), salvar(), listar().
 */

function clonar(obj) {
  return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
}

function chaveDeArmazenamento(item) {
  if (item.identityKey != null) return String(item.identityKey);
  return String(item.nexTransactionId);
}

class RepositorioTransacoesFake {
  /**
   * @param {Array<{identityKey?:string, nexTransactionId:string, registro:Object, fingerprint:string}>} [dadosIniciais]
   */
  constructor(dadosIniciais) {
    this._dados = new Map();
    (dadosIniciais || []).forEach((item) => {
      if (item && (item.identityKey != null || item.nexTransactionId != null)) {
        this._dados.set(chaveDeArmazenamento(item), clonar(item));
      }
    });
  }

  /**
   * Busca pela identidade tecnica (Fase D.2) - uso recomendado por
   * qualquer chamador novo. Funciona corretamente tanto para IDs
   * puramente numericos quanto para IDs nao-numericos (que podem ter
   * multiplas transacoes com o mesmo nexTransactionId).
   */
  async buscarPorIdentityKey(identityKey) {
    const item = this._dados.get(String(identityKey));
    return item ? clonar(item) : null;
  }

  /**
   * LEGADO (Fase D, pre-D.2): busca direta por nexTransactionId. So
   * encontra itens que foram salvos SEM `identityKey` (chamadores
   * anteriores a Fase D.2). Nao deve ser usado para IDs nao-numericos.
   */
  async buscarPorNexTransactionId(nexTransactionId) {
    const item = this._dados.get(String(nexTransactionId));
    return item ? clonar(item) : null;
  }

  /**
   * Upsert - substitui integralmente a entrada existente (nao faz merge
   * parcial de campos). Chave de armazenamento = identityKey quando
   * presente, senao nexTransactionId (compatibilidade com a Fase D).
   * @param {{identityKey?:string, nexTransactionId:string, registro:Object, fingerprint:string}} item
   */
  async salvar(item) {
    if (!item || (item.identityKey == null && item.nexTransactionId == null)) return;
    this._dados.set(chaveDeArmazenamento(item), clonar(item));
  }

  async listar() {
    return [...this._dados.values()].map(clonar);
  }
}

module.exports = { RepositorioTransacoesFake };
