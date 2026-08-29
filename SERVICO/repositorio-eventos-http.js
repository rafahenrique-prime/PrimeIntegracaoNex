'use strict';

/**
 * Repository HTTP (Fase F1A.2) - implementacao CONCRETA da camada de
 * Persistencia/Transporte, conforme DOCS/arquitetura-persistencia.md:
 * "so a implementacao concreta do Repository pode saber se o destino e
 * Base44, Supabase ou outro". Este e o UNICO modulo do projeto que
 * conhece HTTP/HMAC/o contrato do endpoint `webhookNex` do PRIME
 * COBRANCAS - nenhuma peca das Fases A-E.1 (parsers, normalizadores,
 * CustomerResolver, identidade, fingerprint, classificadores, geradores
 * de evento, gate) foi alterada ou precisa saber que isto existe.
 *
 * RESPONSABILIDADE: transporte. NUNCA aplica logica financeira, nunca
 * decide classificacao, nunca escolhe Venda/Parcela - apenas entrega o
 * evento (ja classificado e avaliado pelo gate da Fase E.1) ao endpoint
 * remoto e traduz a resposta HTTP em um resultado local estruturado.
 *
 * Transporta tanto READY_TO_SEND quanto REVIEW_REQUIRED (Fase F0.1,
 * secao 16) - a distincao de status via campo `sourceStatus` no corpo da
 * requisicao, nunca via comportamento diferente deste modulo.
 *
 * IMPORTANTE SOBRE IDEMPOTENCIA (documentado conforme exigido): a
 * garantia de "mesma origin+eventId+contentHash -> UNCHANGED" e
 * responsabilidade do BACKEND remoto (read-before-write, best-effort -
 * ver Fase F0.1/F1A). Este modulo NAO implementa nem finge implementar
 * idempotencia forte - ele so garante, do lado cliente, series de
 * envio (no maximo 1 request em voo por vez, nunca paralelo) e retry
 * limitado apenas para falhas transitorias (rede/timeout/5xx).
 */

const path = require('path');
const crypto = require('crypto');
const { calcularFingerprint } = require(path.join(__dirname, '..', 'SRC', 'fingerprint-transacao-nex'));

const OCCURRED_AT_TIMEZONE_PADRAO = 'America/Sao_Paulo';

/**
 * Le a configuracao de um objeto de ambiente (por padrao process.env), sem
 * validar - a validacao fail-fast acontece em criarRepositorioEventosHttp.
 * Funcao pura, facil de testar sem tocar process.env real.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{endpoint:string|undefined, origin:string|undefined, secret:string|undefined}}
 */
function carregarConfiguracaoDeEnv(env) {
  const e = env || process.env;
  return {
    endpoint: e.NEX_PRIME_ENDPOINT,
    origin: e.NEX_PRIME_ORIGIN,
    secret: e.NEX_PRIME_INTEGRATION_SECRET,
  };
}

/**
 * ContentHash do evento: reutiliza calcularFingerprint (Fase D, ja
 * aprovada) sobre os campos de CONTEUDO do evento produzido pela Fase E
 * (nunca sobre identityKey/eventId, que sao campos de IDENTIDADE, nao de
 * conteudo - mesma separacao de responsabilidade da Fase D.2).
 */
function calcularContentHashEvento(evento) {
  return calcularFingerprint({
    eventType: evento.eventType,
    amount: evento.amount,
    amountPaid: evento.amountPaid,
    amountDebt: evento.amountDebt,
    paymentMethod: evento.paymentMethod,
    items: evento.items,
    cancelled: evento.cancelled,
    cancelledAt: evento.cancelledAt,
  });
}

/**
 * Monta o objeto do evento no formato do contrato HTTP (secao 5 da F1A),
 * a partir de uma entrada de resultado do gate (avaliarGateEnvio(...)).
 * Funcao pura - nao envia nada, so serializa a forma.
 *
 * @param {{status:'READY_TO_SEND'|'REVIEW_REQUIRED', reason:string|null, event:Object}} entradaGate
 * @returns {Object} evento no formato do contrato HTTP
 */
function construirEventoParaEnvio(entradaGate) {
  const evento = (entradaGate && entradaGate.event) || {};
  return {
    eventId: evento.eventId || null,
    identityKey: evento.identityKey || null,
    contentHash: calcularContentHashEvento(evento),
    eventType: evento.eventType || null,
    occurredAt: evento.occurredAt != null ? evento.occurredAt : null,
    occurredAtTimezone: OCCURRED_AT_TIMEZONE_PADRAO,
    payload: evento,
    sourceStatus: entradaGate ? entradaGate.status : null,
    nexTransactionId: evento.nexTransactionId != null ? evento.nexTransactionId : null,
    nexCustomerCode: evento.nexCustomerCode != null ? evento.nexCustomerCode : null,
  };
}

/**
 * Constroi o corpo da requisicao (batch=1, sempre) e o rawBody
 * EXATAMENTE como sera enviado - so um JSON.stringify, guardado, para
 * garantir que a assinatura HMAC seja calculada sobre os MESMOS bytes
 * que saem na rede (nunca serializado uma segunda vez).
 *
 * @param {string} origin
 * @param {Object} entradaGate
 * @returns {{corpo:Object, rawBody:string}}
 */
function construirCorpoRequisicao(origin, entradaGate) {
  const corpo = { origin, events: [construirEventoParaEnvio(entradaGate)] };
  const rawBody = JSON.stringify(corpo);
  return { corpo, rawBody };
}

/**
 * @param {string} secret
 * @param {string} timestamp - epoch em milissegundos (compativel com
 *   Date.now() do backend), como string
 * @param {string} rawBody - EXATAMENTE os bytes que serao enviados como body
 * @returns {string} assinatura hex
 */
function calcularAssinatura(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ehErroDeAbort(erro) {
  return erro && (erro.name === 'AbortError' || /aborted/i.test(String(erro.message || '')));
}

/**
 * @param {{endpoint:string, origin:string, secret:string}} config - OBRIGATORIOS, fail-fast se ausentes
 * @param {Object} [opcoes]
 * @param {Function} [opcoes.fetchImpl] - injetavel para testes (default: fetch global do Node)
 * @param {number} [opcoes.timeoutMs] - default 12000
 * @param {number} [opcoes.maxRetries] - tentativas ADICIONAIS alem da primeira (default 2)
 * @param {number} [opcoes.retryDelayMs] - backoff fixo entre tentativas (default 500)
 * @param {Function} [opcoes.now] - injetavel para testes (default Date.now)
 * @returns {{enviarEvento: Function}}
 */
function criarRepositorioEventosHttp(config, opcoes) {
  const cfg = config || {};
  if (!cfg.endpoint) throw new Error('Configuracao invalida: NEX_PRIME_ENDPOINT ausente.');
  if (!cfg.origin) throw new Error('Configuracao invalida: NEX_PRIME_ORIGIN ausente.');
  if (!cfg.secret) throw new Error('Configuracao invalida: NEX_PRIME_INTEGRATION_SECRET ausente.');

  const opc = opcoes || {};
  const fetchImpl = opc.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Nenhuma implementacao de fetch disponivel (nem global, nem injetada via opcoes.fetchImpl).');
  }
  const timeoutMs = opc.timeoutMs != null ? opc.timeoutMs : 12000;
  const maxRetries = opc.maxRetries != null ? opc.maxRetries : 2;
  const retryDelayMs = opc.retryDelayMs != null ? opc.retryDelayMs : 500;
  const now = opc.now || (() => Date.now());

  /**
   * Envia UM evento (batch=1). No maximo 1 request "em voo" por chamada -
   * este metodo so retorna (resolve) apos a tentativa (com seus retries)
   * terminar; chamar novamente antes disso resolver e responsabilidade do
   * chamador evitar (SERVICO/dedupe-transacoes-nex.js e
   * SERVICO/gerador-eventos-nex.js ja processam sequencialmente, sem
   * paralelismo, seguindo o mesmo padrao ja usado no projeto).
   *
   * @param {{status:'READY_TO_SEND'|'REVIEW_REQUIRED', reason:string|null, event:Object}} entradaGate
   * @returns {Promise<{eventId:string|null, result:string, correlationId:string, httpStatus:number|null, erro:string|null}>}
   */
  async function enviarEvento(entradaGate) {
    const { corpo, rawBody } = construirCorpoRequisicao(cfg.origin, entradaGate);
    const eventoEnviado = corpo.events[0];
    const requestIdLocal = crypto.randomUUID();

    let tentativa = 0;
    // tentativa 0 = primeira tentativa; 1..maxRetries = retries adicionais
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const timestamp = String(now());
      const assinatura = calcularAssinatura(cfg.secret, timestamp, rawBody);
      const headers = {
        'Content-Type': 'application/json',
        'X-Nex-Timestamp': timestamp,
        'X-Nex-Signature': assinatura,
      };

      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

      try {
        const resposta = await fetchImpl(cfg.endpoint, {
          method: 'POST',
          headers,
          body: rawBody,
          signal: controller ? controller.signal : undefined,
        });
        if (timer) clearTimeout(timer);

        if (resposta.status >= 500) {
          if (tentativa < maxRetries) {
            tentativa += 1;
            await sleep(retryDelayMs);
            continue;
          }
          return {
            eventId: eventoEnviado.eventId,
            result: 'ERROR',
            correlationId: requestIdLocal,
            httpStatus: resposta.status,
            erro: `Falha do servidor apos ${tentativa + 1} tentativa(s) (HTTP ${resposta.status}).`,
          };
        }

        let corpoResposta = null;
        try {
          corpoResposta = await resposta.json();
        } catch (e) {
          corpoResposta = null;
        }

        return interpretarResposta(resposta.status, corpoResposta, eventoEnviado.eventId, requestIdLocal);
      } catch (erro) {
        if (timer) clearTimeout(timer);
        const foiTimeout = ehErroDeAbort(erro);
        if (tentativa < maxRetries) {
          tentativa += 1;
          await sleep(retryDelayMs);
          continue;
        }
        return {
          eventId: eventoEnviado.eventId,
          result: 'ERROR',
          correlationId: requestIdLocal,
          httpStatus: null,
          erro: foiTimeout
            ? `Timeout apos ${tentativa + 1} tentativa(s).`
            : `Erro de rede apos ${tentativa + 1} tentativa(s).`,
        };
      }
    }
  }

  return { enviarEvento };
}

/**
 * Contrato OFICIAL da resposta do backend `webhookNex` (confirmado pelo
 * relatorio real da Fase F1A.1 do PRIME COBRANCAS):
 *
 *   { "correlationId": "uuid", "results": [ { "eventId": "...", "result": "..." } ] }
 *
 * O campo e `results[].result` - NAO `processingStatus`. Nao aceitamos
 * alias silencioso (`result || processingStatus`) sem necessidade
 * comprovada: existe UM contrato, e e este.
 */
const RESULTADOS_VALIDOS = new Set(['CREATED', 'UNCHANGED', 'UPDATED', 'REVIEW_STORED', 'REJECTED']);

/**
 * Traduz status HTTP + corpo de resposta em resultado local estruturado.
 * Nunca inclui o secret. Nunca propaga stack trace do servidor. Nunca
 * assume sucesso quando o corpo nao segue o contrato esperado - qualquer
 * desvio (results ausente/vazio, result ausente/desconhecido) vira ERROR
 * local sanitizado, nunca um status otimista inventado.
 */
function interpretarResposta(httpStatus, corpoResposta, eventIdEnviado, requestIdLocal) {
  const results = corpoResposta && Array.isArray(corpoResposta.results) ? corpoResposta.results : null;
  const item = results && results.length > 0 ? results[0] : null;
  const correlationId = (corpoResposta && corpoResposta.correlationId) || (item && item.correlationId) || requestIdLocal;
  const eventId = (item && item.eventId) || eventIdEnviado;

  if (httpStatus === 401) {
    return { eventId, result: 'ERROR', correlationId, httpStatus, erro: 'Autenticacao rejeitada (401).' };
  }
  if (httpStatus === 400) {
    return { eventId, result: 'REJECTED', correlationId, httpStatus, erro: (item && item.error) || 'Payload rejeitado (400).' };
  }

  if (!results || results.length === 0) {
    return { eventId, result: 'ERROR', correlationId, httpStatus, erro: 'Resposta sem "results" (contrato inesperado).' };
  }
  if (!item || !item.result) {
    return { eventId, result: 'ERROR', correlationId, httpStatus, erro: 'Item de "results" sem campo "result" (contrato inesperado).' };
  }
  if (!RESULTADOS_VALIDOS.has(item.result)) {
    return { eventId, result: 'ERROR', correlationId, httpStatus, erro: `Valor de "result" desconhecido: "${item.result}".` };
  }

  return {
    eventId,
    result: item.result,
    correlationId,
    httpStatus,
    erro: item.error || null,
  };
}

module.exports = {
  criarRepositorioEventosHttp,
  carregarConfiguracaoDeEnv,
  construirCorpoRequisicao,
  construirEventoParaEnvio,
  calcularContentHashEvento,
  calcularAssinatura,
};
