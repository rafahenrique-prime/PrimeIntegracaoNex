'use strict';

/**
 * Checkpoint local persistente (Fase F3.1) - armazena, em SQLite, o
 * historico de eventos ja processados pela integracao (identidade,
 * contentHash, resultado remoto). Responsabilidade UNICA desta fase:
 * idempotencia LOCAL - responder "este eventId, com este contentHash,
 * ja foi confirmado antes?" sem depender de rede.
 *
 * NAO SUBSTITUI a idempotencia remota do PRIME COBRANCAS (mesma
 * origin+eventId+contentHash -> UNCHANGED, garantida pelo backend). Este
 * checkpoint e um COMPLEMENTO: evita reprocessar/reenviar localmente algo
 * que ja se sabe confirmado, reduzindo trafego e ruido de auditoria, e
 * permite recuperacao apos reinicio sem depender so da rede.
 *
 * NAO conhece outbox (F3.2), detector (F3.3), orquestrador (F3.4), retry
 * (F3.5) ou logger (F3.6) - e um modulo de persistencia isolado, testavel
 * sozinho, seguindo o mesmo espirito de SERVICO/repositorio-transacoes-fake.js
 * (metodos async por consistencia com o resto do projeto, mesmo operando
 * de forma sincrona internamente via node:sqlite).
 *
 * NUNCA armazena secret nem assinatura HMAC - o schema nao tem campo para
 * isso e nenhum metodo aceita esses valores.
 *
 * Usa `node:sqlite` (nativo do Node, disponivel a partir do Node 22.5+,
 * confirmado disponivel e funcional nesta instalacao - Node v24.18.1) -
 * nenhuma dependencia externa (ex.: better-sqlite3) foi necessaria.
 *
 * WAL (Write-Ahead Logging) e habilitado para bancos em arquivo: reduz
 * contencao entre escrita e leitura concorrente e e mais resiliente a
 * corrupcao em caso de crash no meio de uma transacao, comparado ao modo
 * padrao (rollback journal). F3/F4 continuam com 1 unico processo/writer -
 * WAL aqui e sobre robustez a crash, nao sobre suportar multiplos
 * escritores simultaneos (isso NAO e um objetivo desta fase).
 */

const { DatabaseSync } = require('node:sqlite');

/**
 * Resultados remotos que representam confirmacao efetiva (o backend
 * aceitou/reconheceu o evento, com ou sem mudanca). REJECTED e ERROR
 * NUNCA contam como confirmado - precisam de nova tentativa ou revisao
 * manual, nunca devem ser tratados como "ja resolvido".
 */
const RESULTADOS_CONFIRMADOS = new Set(['CREATED', 'UNCHANGED', 'UPDATED', 'REVIEW_STORED']);

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS eventos_processados (
    event_id           TEXT PRIMARY KEY,
    identity_key       TEXT,
    nex_transaction_id TEXT,
    content_hash       TEXT,
    status             TEXT,
    http_status        INTEGER,
    result             TEXT,
    correlation_id     TEXT,
    erro               TEXT,
    tentativas         INTEGER NOT NULL DEFAULT 0,
    primeira_vez       TEXT NOT NULL,
    ultima_vez         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_eventos_processados_nex_transaction_id
    ON eventos_processados (nex_transaction_id);
`;

function agoraIso() {
  return new Date().toISOString();
}

function linhaParaObjeto(linha) {
  if (!linha) return null;
  return {
    eventId: linha.event_id,
    identityKey: linha.identity_key,
    nexTransactionId: linha.nex_transaction_id,
    contentHash: linha.content_hash,
    status: linha.status,
    httpStatus: linha.http_status,
    result: linha.result,
    correlationId: linha.correlation_id,
    erro: linha.erro,
    tentativas: linha.tentativas,
    primeiraVez: linha.primeira_vez,
    ultimaVez: linha.ultima_vez,
  };
}

class CheckpointSqlite {
  /**
   * @param {string} caminhoArquivo - caminho do arquivo .db, ou ':memory:'
   *   para um banco efemero (usado pelos testes). Nunca aponta, por
   *   padrao, para nenhum arquivo real de producao - o caminho real
   *   operacional sera decidido em F3.7/F4, fora do Git (.gitignore).
   */
  constructor(caminhoArquivo) {
    if (!caminhoArquivo) {
      throw new Error('CheckpointSqlite: caminhoArquivo obrigatorio (use ":memory:" para testes).');
    }
    this._db = new DatabaseSync(caminhoArquivo);
    if (caminhoArquivo !== ':memory:') {
      this._db.exec('PRAGMA journal_mode = WAL;');
    }
    this._db.exec(SCHEMA_SQL);
  }

  /**
   * Busca o registro de checkpoint de um eventId. Retorna null se nunca
   * visto.
   * @param {string} eventId
   * @returns {Promise<Object|null>}
   */
  async buscarEvento(eventId) {
    const linha = this._db
      .prepare('SELECT * FROM eventos_processados WHERE event_id = ?')
      .get(String(eventId));
    return linhaParaObjeto(linha);
  }

  /**
   * Responde SOMENTE "este eventId, com este contentHash EXATO, ja foi
   * confirmado por um resultado remoto de sucesso?" - nunca considera
   * confirmado um eventId com contentHash DIFERENTE (o conteudo mudou,
   * precisa ser reavaliado/reenviado), nem um eventId cujo ultimo
   * resultado conhecido seja REJECTED/ERROR (isso exige nova tentativa
   * ou revisao manual, nunca e tratado como "ja resolvido").
   * @param {string} eventId
   * @param {string} contentHash
   * @returns {Promise<boolean>}
   */
  async eventoJaConfirmado(eventId, contentHash) {
    const linha = await this.buscarEvento(eventId);
    if (!linha) return false;
    if (linha.contentHash !== contentHash) return false;
    return RESULTADOS_CONFIRMADOS.has(linha.result);
  }

  /**
   * Cria (ou substitui integralmente, se ja existir) o registro de um
   * eventId. Uso tipico: primeira vez que o evento e observado, ANTES de
   * qualquer tentativa de envio (status inicial, sem result/httpStatus
   * ainda) - `atualizarEvento` e o metodo usado depois, quando a resposta
   * remota chega.
   *
   * Transacional: a leitura do estado anterior (para calcular
   * primeira_vez/tentativas ao re-registrar) e a escrita ocorrem dentro
   * da mesma transacao SQLite, evitando estado parcial em caso de falha
   * no meio da operacao.
   *
   * @param {{eventId:string, identityKey?:string, nexTransactionId?:string,
   *   contentHash?:string, status?:string, httpStatus?:number|null,
   *   result?:string|null, correlationId?:string|null, erro?:string|null}} dados
   */
  async registrarEvento(dados) {
    if (!dados || !dados.eventId) {
      throw new Error('CheckpointSqlite.registrarEvento: eventId obrigatorio.');
    }
    const agora = agoraIso();

    this._db.exec('BEGIN');
    try {
      const existente = this._db
        .prepare('SELECT primeira_vez, tentativas FROM eventos_processados WHERE event_id = ?')
        .get(dados.eventId);

      const primeiraVez = existente ? existente.primeira_vez : agora;
      const tentativas = existente ? existente.tentativas : 0;

      this._db
        .prepare(
          `INSERT INTO eventos_processados
             (event_id, identity_key, nex_transaction_id, content_hash, status,
              http_status, result, correlation_id, erro, tentativas, primeira_vez, ultima_vez)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
             identity_key = excluded.identity_key,
             nex_transaction_id = excluded.nex_transaction_id,
             content_hash = excluded.content_hash,
             status = excluded.status,
             http_status = excluded.http_status,
             result = excluded.result,
             correlation_id = excluded.correlation_id,
             erro = excluded.erro,
             tentativas = excluded.tentativas,
             ultima_vez = excluded.ultima_vez`,
        )
        .run(
          dados.eventId,
          dados.identityKey != null ? dados.identityKey : null,
          dados.nexTransactionId != null ? dados.nexTransactionId : null,
          dados.contentHash != null ? dados.contentHash : null,
          dados.status != null ? dados.status : null,
          dados.httpStatus != null ? dados.httpStatus : null,
          dados.result != null ? dados.result : null,
          dados.correlationId != null ? dados.correlationId : null,
          dados.erro != null ? dados.erro : null,
          tentativas,
          primeiraVez,
          agora,
        );

      this._db.exec('COMMIT');
    } catch (erro) {
      this._db.exec('ROLLBACK');
      throw erro;
    }

    return this.buscarEvento(dados.eventId);
  }

  /**
   * Atualiza campos de um eventId JA registrado (ex.: resposta remota
   * chegou depois do envio). Incrementa `tentativas` em 1 sempre que
   * chamado (representa mais uma tentativa de comunicacao concluida,
   * com sucesso ou falha). Lanca erro se o eventId nao existir - use
   * `registrarEvento` para criar o registro inicial primeiro.
   *
   * @param {string} eventId
   * @param {{status?:string, httpStatus?:number|null, result?:string|null,
   *   correlationId?:string|null, erro?:string|null}} campos
   */
  async atualizarEvento(eventId, campos) {
    const agora = agoraIso();

    this._db.exec('BEGIN');
    try {
      const existente = this._db
        .prepare('SELECT tentativas FROM eventos_processados WHERE event_id = ?')
        .get(eventId);
      if (!existente) {
        throw new Error(`CheckpointSqlite.atualizarEvento: eventId "${eventId}" nao registrado. Use registrarEvento primeiro.`);
      }

      this._db
        .prepare(
          `UPDATE eventos_processados SET
             status = COALESCE(?, status),
             http_status = ?,
             result = COALESCE(?, result),
             correlation_id = COALESCE(?, correlation_id),
             erro = ?,
             tentativas = ?,
             ultima_vez = ?
           WHERE event_id = ?`,
        )
        .run(
          campos && campos.status != null ? campos.status : null,
          campos && campos.httpStatus != null ? campos.httpStatus : null,
          campos && campos.result != null ? campos.result : null,
          campos && campos.correlationId != null ? campos.correlationId : null,
          campos && campos.erro != null ? campos.erro : null,
          existente.tentativas + 1,
          agora,
          eventId,
        );

      this._db.exec('COMMIT');
    } catch (erro) {
      this._db.exec('ROLLBACK');
      throw erro;
    }

    return this.buscarEvento(eventId);
  }

  /**
   * Lista todos os registros associados a um nexTransactionId (util para
   * inspecao/depuracao - um mesmo nexTransactionId pode ter mais de um
   * eventId, ex.: DEBT_CREATED e SALE_CANCELLED sobre a mesma venda).
   * @param {string} nexTransactionId
   * @returns {Promise<Array<Object>>}
   */
  async listarPorNexTransactionId(nexTransactionId) {
    const linhas = this._db
      .prepare('SELECT * FROM eventos_processados WHERE nex_transaction_id = ? ORDER BY primeira_vez ASC')
      .all(String(nexTransactionId));
    return linhas.map(linhaParaObjeto);
  }

  /** Fecha a conexao com o banco. Idempotente do ponto de vista do chamador. */
  fechar() {
    this._db.close();
  }
}

module.exports = { CheckpointSqlite, RESULTADOS_CONFIRMADOS };
