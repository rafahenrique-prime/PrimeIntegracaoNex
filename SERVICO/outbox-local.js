'use strict';

/**
 * Outbox local persistente (Fase F3.2) - fila de trabalho pendente/estado
 * operacional de envio, separada CONCEITUALMENTE do checkpoint (Fase F3.1,
 * SERVICO/checkpoint-sqlite.js):
 *
 *   checkpoint = fatos JA processados/confirmados (historico, so leitura
 *                apos o fato).
 *   outbox     = trabalho PENDENTE ou em andamento (estado operacional
 *                mutavel do envio, de PENDING ate um estado terminal).
 *
 * Usa a MESMA base SQLite do checkpoint (mesmo arquivo .db), em tabela
 * separada (`outbox`) - node:sqlite/SQLite suporta multiplas conexoes ao
 * mesmo arquivo (WAL habilita leitura/escrita concorrente com seguranca);
 * nao ha necessidade de compartilhar a instancia de DatabaseSync entre os
 * dois modulos para isso funcionar, e mante-los como conexoes
 * independentes preserva o encapsulamento de cada um (cada modulo e
 * testavel isoladamente, como ja e o padrao deste projeto).
 *
 * ESTA FASE (F3.2) implementa SOMENTE o modelo persistente e suas
 * transicoes de estado - NAO envia HTTP, NAO faz retry temporal/backoff
 * real (o campo `next_attempt_at` existe no schema, preparado para F3.5,
 * mas nada aqui ainda o usa para agendar nada), NAO conecta ao pipeline
 * real (isso e F3.4).
 *
 * NUNCA armazena secret nem assinatura HMAC - o schema nao tem campo para
 * isso; `payload` e o evento de NEGOCIO (mesmo formato ja produzido por
 * SERVICO/repositorio-eventos-http.js::construirEventoParaEnvio), nunca
 * inclui credenciais.
 */

const { DatabaseSync } = require('node:sqlite');

/** Estados possiveis - nenhum estado alem destes 7 e criado. */
const ESTADOS = Object.freeze({
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  SENT: 'SENT',
  REVIEW_STORED: 'REVIEW_STORED',
  RETRY: 'RETRY',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
});

/**
 * Matriz de transicoes permitidas. Qualquer transicao fora desta lista e
 * rejeitada explicitamente (nunca silenciosamente ignorada nem aplicada).
 * PENDING/RETRY -> SENDING e feito por claimNext(). SENDING -> * e feito
 * por registrarResultado() (ou transicionar() diretamente, para o caso de
 * orfao). Estados finais (SENT/REVIEW_STORED/REJECTED/FAILED) nao tem
 * transicao de saida nesta fase - reprocessamento a partir deles e uma
 * decisao de produto fora do escopo de F3.2.
 */
const TRANSICOES_PERMITIDAS = Object.freeze({
  [ESTADOS.PENDING]: [ESTADOS.SENDING],
  [ESTADOS.RETRY]: [ESTADOS.SENDING],
  [ESTADOS.SENDING]: [ESTADOS.SENT, ESTADOS.REVIEW_STORED, ESTADOS.RETRY, ESTADOS.REJECTED, ESTADOS.FAILED],
  [ESTADOS.SENT]: [],
  [ESTADOS.REVIEW_STORED]: [],
  [ESTADOS.REJECTED]: [],
  // FAILED -> PENDING (F5.5-FIX2): unica saida permitida a partir de um
  // estado terminal, e exclusivamente via reabrirFailed() - uma
  // intervencao humana explicita apos a causa raiz externa (ex.: secret
  // incorreto) ter sido corrigida. Nunca automatica (detector/runner/
  // processador jamais chamam isso sozinhos).
  [ESTADOS.FAILED]: [ESTADOS.PENDING],
});

/**
 * Mapeamento de resultado remoto (contrato real do backend, ja
 * homologado em SERVICO/repositorio-eventos-http.js) para o novo estado
 * da outbox. ERROR (falha transitoria - rede/timeout/5xx esgotados) vira
 * RETRY aqui; o AGENDAMENTO de quando tentar de novo (backoff/jitter) e
 * responsabilidade da F3.5, nao desta fase.
 */
const RESULTADO_PARA_ESTADO = Object.freeze({
  CREATED: ESTADOS.SENT,
  UNCHANGED: ESTADOS.SENT,
  UPDATED: ESTADOS.SENT,
  REVIEW_STORED: ESTADOS.REVIEW_STORED,
  REJECTED: ESTADOS.REJECTED,
  ERROR: ESTADOS.RETRY,
});

/** Erro explicito: mesmo eventId ja enfileirado com contentHash DIFERENTE. */
class ConflitoDeConteudoError extends Error {
  constructor(eventId, hashExistente, hashNovo) {
    super(
      `Outbox: eventId "${eventId}" ja enfileirado com contentHash diferente ` +
        `(existente="${hashExistente}", novo="${hashNovo}"). Nao sobrescrito ` +
        `silenciosamente - decisao humana necessaria antes de prosseguir.`,
    );
    this.name = 'ConflitoDeConteudoError';
    this.eventId = eventId;
    this.hashExistente = hashExistente;
    this.hashNovo = hashNovo;
  }
}

/** Erro explicito: transicao de estado nao permitida pela matriz. */
class TransicaoInvalidaError extends Error {
  constructor(eventId, estadoAtual, estadoDesejado) {
    super(`Outbox: transicao "${estadoAtual}" -> "${estadoDesejado}" nao permitida para eventId "${eventId}".`);
    this.name = 'TransicaoInvalidaError';
    this.eventId = eventId;
    this.estadoAtual = estadoAtual;
    this.estadoDesejado = estadoDesejado;
  }
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS outbox (
    event_id              TEXT PRIMARY KEY,
    identity_key          TEXT,
    content_hash          TEXT NOT NULL,
    event_type            TEXT,
    occurred_at           TEXT,
    occurred_at_timezone  TEXT,
    source_status         TEXT,
    nex_transaction_id    TEXT,
    nex_customer_code     TEXT,
    payload_json          TEXT NOT NULL,
    status                TEXT NOT NULL,
    tentativas            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at       TEXT,
    http_status           INTEGER,
    result                TEXT,
    correlation_id        TEXT,
    ultimo_erro           TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_status_created_at ON outbox (status, created_at);
  CREATE INDEX IF NOT EXISTS idx_outbox_nex_transaction_id ON outbox (nex_transaction_id);
`;

function agoraIso() {
  return new Date().toISOString();
}

function linhaParaObjeto(linha) {
  if (!linha) return null;
  return {
    eventId: linha.event_id,
    identityKey: linha.identity_key,
    contentHash: linha.content_hash,
    eventType: linha.event_type,
    occurredAt: linha.occurred_at,
    occurredAtTimezone: linha.occurred_at_timezone,
    sourceStatus: linha.source_status,
    nexTransactionId: linha.nex_transaction_id,
    nexCustomerCode: linha.nex_customer_code,
    payload: JSON.parse(linha.payload_json),
    status: linha.status,
    tentativas: linha.tentativas,
    nextAttemptAt: linha.next_attempt_at,
    httpStatus: linha.http_status,
    result: linha.result,
    correlationId: linha.correlation_id,
    ultimoErro: linha.ultimo_erro,
    createdAt: linha.created_at,
    updatedAt: linha.updated_at,
  };
}

class OutboxLocal {
  /**
   * @param {string} caminhoArquivo - mesmo arquivo .db usado pelo
   *   checkpoint (SERVICO/checkpoint-sqlite.js), ou ':memory:' para testes.
   */
  constructor(caminhoArquivo) {
    if (!caminhoArquivo) {
      throw new Error('OutboxLocal: caminhoArquivo obrigatorio (use ":memory:" para testes).');
    }
    this._db = new DatabaseSync(caminhoArquivo);
    if (caminhoArquivo !== ':memory:') {
      this._db.exec('PRAGMA journal_mode = WAL;');
    }
    this._db.exec(SCHEMA_SQL);
  }

  /** @param {string} eventId @returns {Promise<Object|null>} */
  async buscarPorEventId(eventId) {
    const linha = this._db.prepare('SELECT * FROM outbox WHERE event_id = ?').get(String(eventId));
    return linhaParaObjeto(linha);
  }

  /**
   * Enfileira um evento vindo do Gate (mesmo shape ja produzido pelo
   * pipeline real - Fase E.1/F1A.2). Atomico: valida, verifica duplicidade
   * e insere dentro de uma unica transacao.
   *
   * @param {{eventId:string, identityKey?:string, contentHash:string,
   *   eventType?:string, occurredAt?:string, occurredAtTimezone?:string,
   *   sourceStatus?:string, nexTransactionId?:string, nexCustomerCode?:string,
   *   payload:Object}} evento
   * @returns {Promise<{criado:boolean, motivo?:string, item:Object}>}
   *   criado=true se um novo item PENDING foi inserido; criado=false com
   *   motivo="JA_ENFILEIRADO_MESMO_HASH" se o mesmo eventId+contentHash ja
   *   existia (idempotente, no-op seguro).
   * @throws {ConflitoDeConteudoError} se o eventId ja existe com um
   *   contentHash DIFERENTE - nunca sobrescreve silenciosamente.
   */
  async enqueue(evento) {
    if (!evento || !evento.eventId) {
      throw new Error('OutboxLocal.enqueue: eventId obrigatorio.');
    }
    if (!evento.contentHash) {
      throw new Error('OutboxLocal.enqueue: contentHash obrigatorio.');
    }
    if (evento.payload === undefined) {
      throw new Error('OutboxLocal.enqueue: payload obrigatorio.');
    }

    this._db.exec('BEGIN');
    try {
      const existente = this._db.prepare('SELECT content_hash FROM outbox WHERE event_id = ?').get(evento.eventId);

      if (existente) {
        this._db.exec('COMMIT');
        if (existente.content_hash === evento.contentHash) {
          return { criado: false, motivo: 'JA_ENFILEIRADO_MESMO_HASH', item: await this.buscarPorEventId(evento.eventId) };
        }
        throw new ConflitoDeConteudoError(evento.eventId, existente.content_hash, evento.contentHash);
      }

      const agora = agoraIso();
      this._db
        .prepare(
          `INSERT INTO outbox
             (event_id, identity_key, content_hash, event_type, occurred_at,
              occurred_at_timezone, source_status, nex_transaction_id,
              nex_customer_code, payload_json, status, tentativas,
              next_attempt_at, http_status, result, correlation_id,
              ultimo_erro, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          evento.eventId,
          evento.identityKey != null ? evento.identityKey : null,
          evento.contentHash,
          evento.eventType != null ? evento.eventType : null,
          evento.occurredAt != null ? evento.occurredAt : null,
          evento.occurredAtTimezone != null ? evento.occurredAtTimezone : null,
          evento.sourceStatus != null ? evento.sourceStatus : null,
          evento.nexTransactionId != null ? evento.nexTransactionId : null,
          evento.nexCustomerCode != null ? evento.nexCustomerCode : null,
          JSON.stringify(evento.payload),
          ESTADOS.PENDING,
          agora,
          agora,
        );
      this._db.exec('COMMIT');
    } catch (erro) {
      try { this._db.exec('ROLLBACK'); } catch (e) { /* transacao ja finalizada acima - ok */ }
      throw erro;
    }

    return { criado: true, item: await this.buscarPorEventId(evento.eventId) };
  }

  /**
   * Aplica uma transicao de estado explicita, validando contra
   * TRANSICOES_PERMITIDAS. Uso interno de registrarResultado() e
   * recuperarOrfaos(), mas exposto publicamente para permitir transicoes
   * pontuais (ex.: marcar FAILED manualmente apos esgotar retries, na
   * F3.5) sem reimplementar a validacao em outro lugar.
   *
   * @param {string} eventId
   * @param {string} novoStatus
   * @param {{httpStatus?:number|null, result?:string|null, correlationId?:string|null,
   *   ultimoErro?:string|null, incrementarTentativa?:boolean, nextAttemptAt?:string|null}} [extra]
   *   `nextAttemptAt` (Fase F3.5): quando presente, define a partir de
   *   quando o item volta a ser elegivel em claimNext() - usado ao
   *   transicionar para RETRY com backoff calculado. Quando OMITIDO
   *   (undefined), e sempre limpo para null (elegivel imediatamente) -
   *   este e o comportamento correto tanto para transicoes terminais
   *   (SENT/REVIEW_STORED/REJECTED/FAILED, onde next_attempt_at deixa de
   *   fazer sentido) quanto para recuperarOrfaos() (SENDING orfao ->
   *   RETRY elegivel JA, sem esperar backoff nenhum).
   */
  async transicionar(eventId, novoStatus, extra) {
    const opc = extra || {};

    this._db.exec('BEGIN');
    try {
      const existente = this._db.prepare('SELECT status, tentativas FROM outbox WHERE event_id = ?').get(eventId);
      if (!existente) {
        throw new Error(`OutboxLocal.transicionar: eventId "${eventId}" nao encontrado na outbox.`);
      }

      const permitidas = TRANSICOES_PERMITIDAS[existente.status] || [];
      if (!permitidas.includes(novoStatus)) {
        throw new TransicaoInvalidaError(eventId, existente.status, novoStatus);
      }

      const agora = agoraIso();
      const novasTentativas = opc.incrementarTentativa ? existente.tentativas + 1 : existente.tentativas;

      this._db
        .prepare(
          `UPDATE outbox SET
             status = ?,
             http_status = COALESCE(?, http_status),
             result = COALESCE(?, result),
             correlation_id = COALESCE(?, correlation_id),
             ultimo_erro = ?,
             tentativas = ?,
             next_attempt_at = ?,
             updated_at = ?
           WHERE event_id = ?`,
        )
        .run(
          novoStatus,
          opc.httpStatus != null ? opc.httpStatus : null,
          opc.result != null ? opc.result : null,
          opc.correlationId != null ? opc.correlationId : null,
          opc.ultimoErro != null ? opc.ultimoErro : null,
          novasTentativas,
          opc.nextAttemptAt != null ? opc.nextAttemptAt : null,
          agora,
          eventId,
        );

      this._db.exec('COMMIT');
    } catch (erro) {
      try { this._db.exec('ROLLBACK'); } catch (e) { /* ja finalizada acima - ok */ }
      throw erro;
    }

    return this.buscarPorEventId(eventId);
  }

  /**
   * Seleciona deterministicamente o proximo item elegivel (PENDING ou
   * RETRY, ordenado por created_at e desempatado por event_id) e o
   * transiciona atomicamente para SENDING, incrementando `tentativas`
   * (isto marca o INICIO de uma tentativa de comunicacao). Retorna null
   * se nao houver nenhum item elegivel.
   *
   * Respeita `next_attempt_at` (Fase F3.5): itens RETRY com next_attempt_at
   * no futuro nao sao elegiveis; PENDING e sempre elegivel imediatamente;
   * um RETRY futuro nunca bloqueia um PENDING mais novo, pois a clausula
   * WHERE ja filtra por elegibilidade ANTES da ordenacao.
   *
   * FONTE DE TEMPO (Fase F3.5.1): por padrao usa o relogio real
   * (`new Date()`) para decidir "agora", preservando compatibilidade com
   * chamadas existentes (`claimNext()` sem argumento). Quando o chamador
   * PRECISA de tempo deterministico/injetavel de ponta a ponta (ex.:
   * SERVICO/processador-outbox-nex.js, que tambem usa o mesmo `now` para
   * calcular o backoff/next_attempt_at daquela mesma iteracao), pode
   * passar explicitamente `agora` (Date) - assim a decisao de
   * ELEGIBILIDADE e o CALCULO de backoff da mesma operacao sempre
   * enxergam a MESMA fonte de tempo, nunca duas independentes.
   *
   * Ainda com 1 unico processo/writer, a selecao+transicao ocorre dentro
   * de uma unica transacao SQLite, garantindo a semantica atomica correta
   * desde ja (nenhum outro codigo pode "roubar" o mesmo item entre a
   * leitura e a escrita).
   *
   * @param {Date} [agora] - injetavel para tempo deterministico; default
   *   `new Date()` (relogio real), preservando o comportamento e a
   *   assinatura ja usados por chamadores existentes.
   * @returns {Promise<Object|null>}
   */
  async claimNext(agora) {
    const agoraDate = agora || new Date();
    const agoraIsoStr = agoraDate.toISOString();

    this._db.exec('BEGIN');
    try {
      const candidato = this._db
        .prepare(
          `SELECT event_id FROM outbox
             WHERE status IN ('${ESTADOS.PENDING}', '${ESTADOS.RETRY}')
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY created_at ASC, event_id ASC
             LIMIT 1`,
        )
        .get(agoraIsoStr);

      if (!candidato) {
        this._db.exec('COMMIT');
        return null;
      }

      this._db
        .prepare('UPDATE outbox SET status = ?, tentativas = tentativas + 1, updated_at = ? WHERE event_id = ?')
        .run(ESTADOS.SENDING, agoraIsoStr, candidato.event_id);

      this._db.exec('COMMIT');
      return this.buscarPorEventId(candidato.event_id);
    } catch (erro) {
      try { this._db.exec('ROLLBACK'); } catch (e) { /* ja finalizada acima - ok */ }
      throw erro;
    }
  }

  /**
   * Traduz um resultado remoto (contrato real ja homologado de
   * SERVICO/repositorio-eventos-http.js::enviarEvento) na transicao de
   * estado correspondente. Exige que o item esteja atualmente em SENDING
   * (transicao invalida a partir de qualquer outro estado e rejeitada).
   *
   * @param {string} eventId
   * @param {{result:'CREATED'|'UNCHANGED'|'UPDATED'|'REVIEW_STORED'|'REJECTED'|'ERROR',
   *   httpStatus?:number|null, correlationId?:string|null, erro?:string|null}} resposta
   */
  async registrarResultado(eventId, resposta) {
    const resultado = resposta && resposta.result;
    const novoStatus = RESULTADO_PARA_ESTADO[resultado];
    if (!novoStatus) {
      throw new Error(`OutboxLocal.registrarResultado: result "${resultado}" desconhecido (contrato inesperado).`);
    }
    return this.transicionar(eventId, novoStatus, {
      httpStatus: resposta.httpStatus,
      result: resultado,
      correlationId: resposta.correlationId,
      ultimoErro: resposta.erro != null ? resposta.erro : null,
    });
  }

  /**
   * Identifica itens deixados em SENDING (unico processo/writer nesta
   * fase - qualquer SENDING encontrado ao abrir a outbox necessariamente
   * sobrou de uma execucao anterior interrompida, nunca de um envio em
   * andamento agora). NAO consulta o Base44, NAO assume que o POST
   * anterior falhou ou teve sucesso - o estado e genuinamente ambiguo.
   *
   * Transiciona cada orfao para RETRY, preservando eventId/contentHash/
   * payload intactos, para que uma futura tentativa (F3.5) possa
   * reenviar o MESMO evento e receber UNCHANGED do backend caso ele ja
   * tivesse sido aceito - nunca gera um eventId novo.
   *
   * @returns {Promise<Array<Object>>} itens recuperados (ja em RETRY)
   */
  async recuperarOrfaos() {
    const orfaos = this._db.prepare(`SELECT event_id FROM outbox WHERE status = '${ESTADOS.SENDING}'`).all();
    const recuperados = [];
    for (const linha of orfaos) {
      const item = await this.transicionar(linha.event_id, ESTADOS.RETRY, {
        ultimoErro: 'Recuperado de SENDING orfao apos reinicio - resultado do envio anterior desconhecido.',
      });
      recuperados.push(item);
    }
    return recuperados;
  }

  /**
   * Reabre manualmente um item terminal FAILED, devolvendo-o a PENDING
   * para ser reclamado pelo processador normalmente (F5.5-FIX2). Uso
   * EXCLUSIVAMENTE humano/deliberado - nunca chamado pelo detector,
   * runner ou processador automaticamente. Preserva eventId/contentHash/
   * payload/tentativas (nunca reseta), compoe ultimoErro (nunca apaga a
   * evidencia da falha original).
   *
   * @param {string} eventId
   * @param {{motivo:string, operador?:string}} contexto - motivo
   *   obrigatorio (nao vazio); operador opcional, para auditoria.
   * @returns {Promise<Object>}
   * @throws {Error} se motivo for vazio/ausente, ou se o eventId nao existir.
   * @throws {TransicaoInvalidaError} se o item NAO estiver em FAILED
   *   (SENT/REVIEW_STORED/REJECTED continuam sem nenhuma saida permitida).
   */
  async reabrirFailed(eventId, contexto) {
    if (!contexto || !contexto.motivo || !String(contexto.motivo).trim()) {
      throw new Error('OutboxLocal.reabrirFailed: motivo obrigatorio (nao vazio).');
    }
    const existente = await this.buscarPorEventId(eventId);
    if (!existente) {
      throw new Error(`OutboxLocal.reabrirFailed: eventId "${eventId}" nao encontrado na outbox.`);
    }

    // A validacao de estado permitido continua centralizada na matriz
    // TRANSICOES_PERMITIDAS (via transicionar()) - nao duplicada aqui.
    const ultimoErroComposto =
      `Reaberto manualmente em ${agoraIso()} ` +
      `(motivo: ${contexto.motivo}${contexto.operador ? `, operador: ${contexto.operador}` : ''}). ` +
      `Erro anterior: ${existente.ultimoErro != null ? JSON.stringify(existente.ultimoErro) : '(nenhum registrado)'}`;

    return this.transicionar(eventId, ESTADOS.PENDING, { ultimoErro: ultimoErroComposto });
  }

  /** @param {string} nexTransactionId @returns {Promise<Array<Object>>} */
  async listarPorNexTransactionId(nexTransactionId) {
    const linhas = this._db
      .prepare('SELECT * FROM outbox WHERE nex_transaction_id = ? ORDER BY created_at ASC')
      .all(String(nexTransactionId));
    return linhas.map(linhaParaObjeto);
  }

  /**
   * Lista todos os itens em um determinado status (ex.: SENT,
   * REVIEW_STORED) - usado pela Fase F3.7 (auditarConsistencia) para
   * cruzar itens terminais da outbox contra o checkpoint. Somente
   * leitura, nao muda nenhum estado.
   * @param {string} status - um de ESTADOS
   * @returns {Promise<Array<Object>>}
   */
  async listarPorStatus(status) {
    const linhas = this._db.prepare('SELECT * FROM outbox WHERE status = ? ORDER BY created_at ASC').all(status);
    return linhas.map(linhaParaObjeto);
  }

  /** Fecha a conexao com o banco. */
  fechar() {
    this._db.close();
  }
}

module.exports = {
  OutboxLocal,
  ESTADOS,
  TRANSICOES_PERMITIDAS,
  RESULTADO_PARA_ESTADO,
  ConflitoDeConteudoError,
  TransicaoInvalidaError,
};
