'use strict';

/**
 * Estado persistente do bootstrap (Fase F3.7) - maquina de estados
 * NOT_STARTED -> DRY_RUN -> BASELINED -> APPROVED, mais as tabelas de
 * baseline de ARQUIVOS (por sha256 do conteudo) e de EVENTOS historicos
 * (por eventId+contentHash).
 *
 * Usa a MESMA base SQLite dos demais modulos (node:sqlite, WAL), em
 * tabelas separadas - mesmo padrao ja usado por checkpoint-sqlite.js e
 * outbox-local.js (conexao propria, mesmo arquivo).
 *
 * DISTINCAO CRITICA: baseline local (`BASELINED_LOCAL`) NUNCA e o mesmo
 * que confirmacao remota (`RESULTADOS_CONFIRMADOS` da Fase F3.1 -
 * CREATED/UNCHANGED/UPDATED/REVIEW_STORED, que so o backend real pode
 * emitir). Este modulo nunca escreve na tabela `eventos_processados` do
 * checkpoint - baseline vive em sua PROPRIA tabela, sem se misturar com
 * o historico de confirmacao remota.
 */

const { DatabaseSync } = require('node:sqlite');

const ESTADOS_BOOTSTRAP = Object.freeze({
  NOT_STARTED: 'NOT_STARTED',
  DRY_RUN: 'DRY_RUN',
  BASELINED: 'BASELINED',
  APPROVED: 'APPROVED',
});

/** Transicoes permitidas - qualquer outra e rejeitada explicitamente. */
const TRANSICOES_BOOTSTRAP_PERMITIDAS = Object.freeze({
  [ESTADOS_BOOTSTRAP.NOT_STARTED]: [ESTADOS_BOOTSTRAP.DRY_RUN],
  [ESTADOS_BOOTSTRAP.DRY_RUN]: [ESTADOS_BOOTSTRAP.DRY_RUN, ESTADOS_BOOTSTRAP.BASELINED],
  [ESTADOS_BOOTSTRAP.BASELINED]: [ESTADOS_BOOTSTRAP.BASELINED, ESTADOS_BOOTSTRAP.APPROVED],
  [ESTADOS_BOOTSTRAP.APPROVED]: [],
});

class TransicaoBootstrapInvalidaError extends Error {
  constructor(estadoAtual, estadoDesejado) {
    super(`EstadoBootstrapSqlite: transicao "${estadoAtual}" -> "${estadoDesejado}" nao permitida.`);
    this.name = 'TransicaoBootstrapInvalidaError';
    this.estadoAtual = estadoAtual;
    this.estadoDesejado = estadoDesejado;
  }
}

const CHAVE_UNICA = 'default';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS bootstrap_state (
    id                    TEXT PRIMARY KEY,
    status                TEXT NOT NULL,
    cutoff                TEXT,
    started_at            TEXT,
    dry_run_completed_at  TEXT,
    completed_at          TEXT,
    approved_at           TEXT,
    baseline_files_count  INTEGER NOT NULL DEFAULT 0,
    baseline_events_count INTEGER NOT NULL DEFAULT 0,
    version               INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS baseline_arquivos (
    sha256       TEXT PRIMARY KEY,
    nome         TEXT,
    mtime        TEXT,
    baseline_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS baseline_eventos (
    event_id            TEXT PRIMARY KEY,
    content_hash        TEXT NOT NULL,
    nex_transaction_id  TEXT,
    status              TEXT NOT NULL DEFAULT 'BASELINED_LOCAL',
    baseline_at         TEXT NOT NULL,
    alterado_em         TEXT,
    hash_anterior       TEXT
  );
`;

function agoraIso() {
  return new Date().toISOString();
}

function linhaEstadoParaObjeto(linha) {
  if (!linha) {
    return {
      status: ESTADOS_BOOTSTRAP.NOT_STARTED,
      cutoff: null,
      startedAt: null,
      dryRunCompletedAt: null,
      completedAt: null,
      approvedAt: null,
      baselineFilesCount: 0,
      baselineEventsCount: 0,
      version: 1,
    };
  }
  return {
    status: linha.status,
    cutoff: linha.cutoff,
    startedAt: linha.started_at,
    dryRunCompletedAt: linha.dry_run_completed_at,
    completedAt: linha.completed_at,
    approvedAt: linha.approved_at,
    baselineFilesCount: linha.baseline_files_count,
    baselineEventsCount: linha.baseline_events_count,
    version: linha.version,
  };
}

class EstadoBootstrapSqlite {
  /** @param {string} caminhoArquivo - mesmo arquivo .db dos demais modulos, ou ':memory:' para testes. */
  constructor(caminhoArquivo) {
    if (!caminhoArquivo) throw new Error('EstadoBootstrapSqlite: caminhoArquivo obrigatorio (use ":memory:" para testes).');
    this._db = new DatabaseSync(caminhoArquivo);
    if (caminhoArquivo !== ':memory:') this._db.exec('PRAGMA journal_mode = WAL;');
    this._db.exec(SCHEMA_SQL);
  }

  /** @returns {Promise<Object>} estado atual (NOT_STARTED por default, se nunca iniciado) */
  async obterEstado() {
    const linha = this._db.prepare('SELECT * FROM bootstrap_state WHERE id = ?').get(CHAVE_UNICA);
    return linhaEstadoParaObjeto(linha);
  }

  async _transicionarPara(novoStatus, camposExtras) {
    const atual = await this.obterEstado();
    const permitidas = TRANSICOES_BOOTSTRAP_PERMITIDAS[atual.status] || [];
    if (!permitidas.includes(novoStatus)) {
      throw new TransicaoBootstrapInvalidaError(atual.status, novoStatus);
    }
    const agora = agoraIso();
    const linhaExistente = this._db.prepare('SELECT id FROM bootstrap_state WHERE id = ?').get(CHAVE_UNICA);
    const extras = camposExtras || {};

    if (!linhaExistente) {
      this._db
        .prepare(
          `INSERT INTO bootstrap_state
             (id, status, cutoff, started_at, dry_run_completed_at, completed_at, approved_at, baseline_files_count, baseline_events_count, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          CHAVE_UNICA, novoStatus,
          extras.cutoff != null ? extras.cutoff : null,
          extras.startedAt != null ? extras.startedAt : (novoStatus === ESTADOS_BOOTSTRAP.DRY_RUN ? agora : null),
          extras.dryRunCompletedAt != null ? extras.dryRunCompletedAt : null,
          extras.completedAt != null ? extras.completedAt : null,
          extras.approvedAt != null ? extras.approvedAt : null,
          extras.baselineFilesCount != null ? extras.baselineFilesCount : 0,
          extras.baselineEventsCount != null ? extras.baselineEventsCount : 0,
        );
    } else {
      this._db
        .prepare(
          `UPDATE bootstrap_state SET
             status = ?,
             cutoff = COALESCE(?, cutoff),
             dry_run_completed_at = COALESCE(?, dry_run_completed_at),
             completed_at = COALESCE(?, completed_at),
             approved_at = COALESCE(?, approved_at),
             baseline_files_count = COALESCE(?, baseline_files_count),
             baseline_events_count = COALESCE(?, baseline_events_count)
           WHERE id = ?`,
        )
        .run(
          novoStatus,
          extras.cutoff != null ? extras.cutoff : null,
          extras.dryRunCompletedAt != null ? extras.dryRunCompletedAt : null,
          extras.completedAt != null ? extras.completedAt : null,
          extras.approvedAt != null ? extras.approvedAt : null,
          extras.baselineFilesCount != null ? extras.baselineFilesCount : null,
          extras.baselineEventsCount != null ? extras.baselineEventsCount : null,
          CHAVE_UNICA,
        );
    }
    return this.obterEstado();
  }

  /**
   * NOT_STARTED -> DRY_RUN (ou DRY_RUN -> DRY_RUN, para permitir rodar o
   * dry-run novamente antes de confirmar o baseline). Define o cutoff na
   * primeira chamada; chamadas seguintes preservam o cutoff ja definido a
   * menos que um novo seja passado explicitamente.
   * @param {string} cutoff - ISO local (mesmo formato de occurredAt do dominio)
   */
  async iniciarDryRun(cutoff) {
    return this._transicionarPara(ESTADOS_BOOTSTRAP.DRY_RUN, { cutoff, dryRunCompletedAt: agoraIso() });
  }

  /**
   * DRY_RUN -> BASELINED. So a transicao de estado - persistir os
   * registros de baseline_arquivos/baseline_eventos e responsabilidade do
   * chamador (SERVICO/bootstrap-integracao-nex.js), via
   * baselinarArquivo()/baselinarEvento() ANTES de chamar este metodo.
   */
  async confirmarBaseline(contagens) {
    const c = contagens || {};
    return this._transicionarPara(ESTADOS_BOOTSTRAP.BASELINED, {
      completedAt: agoraIso(),
      baselineFilesCount: c.baselineFilesCount != null ? c.baselineFilesCount : 0,
      baselineEventsCount: c.baselineEventsCount != null ? c.baselineEventsCount : 0,
    });
  }

  /** BASELINED -> APPROVED. Acao humana explicita - nunca automatica. */
  async aprovar() {
    return this._transicionarPara(ESTADOS_BOOTSTRAP.APPROVED, { approvedAt: agoraIso() });
  }

  /**
   * Registra um arquivo como baseline (idempotente - mesmo sha256
   * registrado de novo e um no-op silencioso, nunca duplica).
   * @param {string} sha256
   * @param {string} [nome]
   * @param {string} [mtime]
   */
  async baselinarArquivo(sha256, nome, mtime) {
    const existente = this._db.prepare('SELECT sha256 FROM baseline_arquivos WHERE sha256 = ?').get(sha256);
    if (existente) return { criado: false };
    this._db
      .prepare('INSERT INTO baseline_arquivos (sha256, nome, mtime, baseline_at) VALUES (?, ?, ?, ?)')
      .run(sha256, nome != null ? nome : null, mtime != null ? mtime : null, agoraIso());
    return { criado: true };
  }

  /** @param {string} sha256 @returns {Promise<boolean>} */
  async arquivoEhBaseline(sha256) {
    return this._db.prepare('SELECT 1 FROM baseline_arquivos WHERE sha256 = ?').get(sha256) != null;
  }

  /**
   * Registra um evento historico como BASELINED_LOCAL (NUNCA
   * CONFIRMED_REMOTE - essa distincao e estrutural, ver cabecalho do
   * modulo). Idempotente: mesmo eventId+mesmo contentHash -> no-op.
   * Mesmo eventId com contentHash DIFERENTE do ja registrado -> NAO
   * ignora silenciosamente: atualiza o registro, marca `alterado_em` e
   * `hash_anterior`, e retorna `alterado:true` para o chamador decidir
   * (a Fase F3.7 apenas detecta e reporta; nao decide automaticamente
   * reenviar).
   * @param {string} eventId
   * @param {string} contentHash
   * @param {string} [nexTransactionId]
   * @returns {Promise<{criado:boolean, alterado:boolean, hashAnterior?:string}>}
   */
  async baselinarEvento(eventId, contentHash, nexTransactionId) {
    const existente = this._db.prepare('SELECT content_hash FROM baseline_eventos WHERE event_id = ?').get(eventId);
    const agora = agoraIso();

    if (!existente) {
      this._db
        .prepare('INSERT INTO baseline_eventos (event_id, content_hash, nex_transaction_id, status, baseline_at) VALUES (?, ?, ?, ?, ?)')
        .run(eventId, contentHash, nexTransactionId != null ? nexTransactionId : null, 'BASELINED_LOCAL', agora);
      return { criado: true, alterado: false };
    }

    if (existente.content_hash === contentHash) {
      return { criado: false, alterado: false };
    }

    this._db
      .prepare('UPDATE baseline_eventos SET content_hash = ?, alterado_em = ?, hash_anterior = ? WHERE event_id = ?')
      .run(contentHash, agora, existente.content_hash, eventId);
    return { criado: false, alterado: true, hashAnterior: existente.content_hash };
  }

  /**
   * @param {string} eventId
   * @param {string} contentHash
   * @returns {Promise<{ehBaseline:boolean, hashMudou:boolean}>} - `ehBaseline`
   *   true se o eventId existe no baseline; `hashMudou` true se existe MAS
   *   com um contentHash diferente do informado (evento historico alterado).
   */
  async avaliarEventoContraBaseline(eventId, contentHash) {
    const linha = this._db.prepare('SELECT content_hash FROM baseline_eventos WHERE event_id = ?').get(eventId);
    if (!linha) return { ehBaseline: false, hashMudou: false };
    return { ehBaseline: true, hashMudou: linha.content_hash !== contentHash };
  }

  /** @param {string} eventId @returns {Promise<Object|null>} */
  async buscarEventoBaseline(eventId) {
    const linha = this._db.prepare('SELECT * FROM baseline_eventos WHERE event_id = ?').get(eventId);
    if (!linha) return null;
    return {
      eventId: linha.event_id,
      contentHash: linha.content_hash,
      nexTransactionId: linha.nex_transaction_id,
      status: linha.status,
      baselineAt: linha.baseline_at,
      alteradoEm: linha.alterado_em,
      hashAnterior: linha.hash_anterior,
    };
  }

  fechar() {
    this._db.close();
  }
}

module.exports = {
  EstadoBootstrapSqlite,
  ESTADOS_BOOTSTRAP,
  TRANSICOES_BOOTSTRAP_PERMITIDAS,
  TransicaoBootstrapInvalidaError,
};
