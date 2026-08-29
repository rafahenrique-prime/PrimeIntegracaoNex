'use strict';

/**
 * Processador da outbox (Fase F3.5): consome itens PENDING/RETRY
 * elegiveis, chama um TRANSPORTE INJETAVEL (nunca HTTP real nesta fase),
 * classifica o resultado e atualiza outbox (F3.2) + checkpoint (F3.1).
 *
 * NAO faz HTTP, NAO usa secret real, NAO acessa Base44/.nx1/NEX. O
 * transporte e uma dependencia injetada com o MESMO shape de retorno ja
 * homologado por SERVICO/repositorio-eventos-http.js::enviarEvento
 * ({eventId, result, httpStatus, correlationId, erro}) - o Repository
 * HTTP real podera ser encaixado aqui no futuro (F3.6+) sem reescrever
 * este processador, bastando passar `transportar: repo.enviarEvento`.
 *
 * PRINCIPIO CENTRAL (caso ambiguo critico): um item SENDING encontrado ao
 * iniciar so pode ter sobrado de uma execucao anterior interrompida -
 * nunca sabemos se o backend ja aceitou aquele envio antes do crash. A
 * recuperacao (recuperarPendencias(), que delega a
 * outbox.recuperarOrfaos() ja implementado na Fase F3.2) SEMPRE preserva
 * eventId/contentHash/payload e move o item para RETRY elegivel
 * IMEDIATAMENTE (sem esperar backoff) - a proxima tentativa reenvia o
 * MESMO evento; se o backend ja tinha aceitado, a resposta correta e
 * UNCHANGED (idempotencia remota), que este processador trata como
 * sucesso pleno, exatamente como CREATED/UPDATED.
 *
 * CLASSIFICACAO DE RESULTADO (independente da interpretacao HTTP ja feita
 * pelo Repository real - este processador decide RETRY vs terminal a
 * partir de {result, httpStatus} recebidos do transporte):
 *   result em {CREATED, UNCHANGED, UPDATED, REVIEW_STORED} -> SUCESSO (terminal)
 *   result === 'REJECTED'                                  -> REJEITADO_PERMANENTE (terminal, nunca retry)
 *   result === 'ERROR' + httpStatus em {401, 403}           -> ERRO_TECNICO_PERMANENTE (terminal -> FAILED, nunca retry)
 *   result === 'ERROR' (demais casos: rede/timeout/5xx/400** ambiguo)
 *                                                            -> FALHA_TRANSITORIA (RETRY com backoff, ate maxTentativas)
 *   qualquer outro valor                                    -> RESULTADO_DESCONHECIDO (tratado como falha transitoria
 *                                                               conservadora, nunca assume sucesso)
 * (** 400 do contrato real ja e mapeado para result=REJECTED por
 * SERVICO/repositorio-eventos-http.js, entao cai no caso REJECTED acima,
 * nao no caso ERROR - documentado para nao confundir com 401/403, que o
 * contrato real mapeia para result=ERROR e por isso precisam desta
 * distincao adicional por httpStatus AQUI, no processador.)
 *
 * ATOMICIDADE ENTRE OUTBOX E CHECKPOINT (analise, Fase F3.5): outbox e
 * checkpoint sao conexoes SQLite DISTINTAS (mesmo arquivo, WAL) - NAO
 * existe transacao cross-connection real, e este modulo NAO finge que
 * existe. A ordem de escrita e deliberada: outbox SEMPRE primeiro,
 * checkpoint depois. Se o processo morrer entre as duas escritas, o
 * estado final e outbox com o resultado terminal correto (SENT/
 * REVIEW_STORED/REJECTED/FAILED - nunca mais reclamado por claimNext(),
 * ja que a matriz de transicoes da Fase F3.2 nao permite sair desses
 * estados) e checkpoint SEM o registro correspondente. Isso NUNCA causa
 * reenvio nem duplicacao (a outbox sozinha ja impede isso), apenas um gap
 * de completude de auditoria no checkpoint - aceito conscientemente nesta
 * fase e registrado como risco residual (reconciliacao futura, fora do
 * escopo de F3.5, poderia varrer a outbox por itens terminais sem
 * contrapartida no checkpoint).
 */

const { ESTADOS, RESULTADO_PARA_ESTADO } = require(require('path').join(__dirname, 'outbox-local'));
const { RESULTADOS_CONFIRMADOS } = require(require('path').join(__dirname, 'checkpoint-sqlite'));

const POLITICA_PADRAO = Object.freeze({
  maxTentativas: 5,
  backoffBaseMs: 30000, // 30s
  backoffFatorExponencial: 2,
  backoffMaxMs: 240000, // 4min (teto)
  jitterFn: null, // sem jitter por padrao - deterministico para testes; injetavel
});

/**
 * HTTP status que, quando result==='ERROR', sao tratados como erro
 * TECNICO PERMANENTE (nunca retry) - autenticacao/autorizacao rejeitada
 * de forma estavel, retry nao mudaria o resultado.
 */
const HTTP_STATUS_TERMINAL_SEM_RETRY = new Set([401, 403]);

/**
 * Calcula o atraso (em ms) ate a proxima tentativa, exponencial com teto,
 * mais jitter opcional injetavel (para testes deterministicos, deixar
 * `jitterFn: null` ou omitir).
 * @param {number} tentativa - numero da tentativa que acabou de falhar (1-based)
 * @param {Object} politica
 * @returns {number}
 */
function calcularBackoffMs(tentativa, politica) {
  const bruto = politica.backoffBaseMs * Math.pow(politica.backoffFatorExponencial, Math.max(0, tentativa - 1));
  const comTeto = Math.min(bruto, politica.backoffMaxMs);
  const jitter = typeof politica.jitterFn === 'function' ? politica.jitterFn(comTeto, tentativa) : 0;
  return Math.max(0, comTeto + jitter);
}

/**
 * Classifica a resposta do transporte em uma das 4 categorias de decisao
 * (ver documentacao do modulo acima). Funcao pura, testavel isoladamente.
 * @param {{result?:string, httpStatus?:number|null}} resposta
 * @returns {{tipo:string, novoEstado?:string}}
 */
function classificarResposta(resposta) {
  const resultado = resposta && resposta.result;

  if (RESULTADOS_CONFIRMADOS.has(resultado)) {
    return { tipo: 'SUCESSO', novoEstado: RESULTADO_PARA_ESTADO[resultado] };
  }
  if (resultado === 'REJECTED') {
    return { tipo: 'REJEITADO_PERMANENTE' };
  }
  if (resultado === 'ERROR') {
    if (HTTP_STATUS_TERMINAL_SEM_RETRY.has(resposta.httpStatus)) {
      return { tipo: 'ERRO_TECNICO_PERMANENTE' };
    }
    return { tipo: 'FALHA_TRANSITORIA' };
  }
  return { tipo: 'RESULTADO_DESCONHECIDO' };
}

class ProcessadorOutboxNex {
  /**
   * @param {Object} opcoes
   * @param {Object} opcoes.outbox - instancia de OutboxLocal (Fase F3.2)
   * @param {Object} [opcoes.checkpoint] - instancia de CheckpointSqlite
   *   (Fase F3.1). Opcional - se ausente, resultados nao sao registrados
   *   em checkpoint (apenas na outbox).
   * @param {Function} opcoes.transportar - `(itemOutbox) => Promise<{eventId,
   *   result, httpStatus, correlationId, erro}>` - NUNCA deve fazer HTTP
   *   real nesta fase; nos testes, um fake determinstico. Espera-se que
   *   nunca rejeite a Promise (mesmo contrato do Repository real ja
   *   homologado) - mas se rejeitar mesmo assim, o processador trata como
   *   falha transitoria sanitizada, sem derrubar o processo.
   * @param {Object} [opcoes.politica] - sobrepoe POLITICA_PADRAO parcialmente.
   * @param {Function} [opcoes.nowImpl] - `() => Date`, injetavel para
   *   testes deterministicos de backoff/next_attempt_at.
   */
  constructor(opcoes) {
    const opc = opcoes || {};
    if (!opc.outbox) throw new Error('ProcessadorOutboxNex: opcoes.outbox obrigatorio.');
    if (typeof opc.transportar !== 'function') throw new Error('ProcessadorOutboxNex: opcoes.transportar obrigatorio.');

    this._outbox = opc.outbox;
    this._checkpoint = opc.checkpoint || null;
    this._transportar = opc.transportar;
    this._politica = { ...POLITICA_PADRAO, ...(opc.politica || {}) };
    this._now = opc.nowImpl || (() => new Date());
  }

  /**
   * Recupera itens SENDING orfaos (sobra de execucao anterior
   * interrompida) - delega inteiramente a outbox.recuperarOrfaos() ja
   * homologada na Fase F3.2 (SENDING -> RETRY elegivel imediatamente,
   * eventId/contentHash/payload preservados, tentativas NAO incrementadas
   * so por recuperar - a nova tentativa so conta quando houver uma
   * transmissao real de novo via processarProximo()).
   * @returns {Promise<Array<Object>>}
   */
  async recuperarPendencias() {
    return this._outbox.recuperarOrfaos();
  }

  /**
   * Processa exatamente 1 item elegivel da outbox (PENDING, ou RETRY com
   * next_attempt_at vencido) - claim atomico, 1 chamada ao transporte, 1
   * atualizacao de estado. Nunca processa mais de 1 item por chamada
   * (serial, sem paralelismo).
   * @returns {Promise<{processado:boolean, motivo?:string, eventId?:string, resultado?:string, nextAttemptAt?:string}>}
   */
  async processarProximo() {
    // FONTE UNICA DE TEMPO (Fase F3.5.1): a MESMA leitura de `this._now()`
    // e usada para decidir elegibilidade (claimNext) e, se necessario,
    // para calcular o backoff/next_attempt_at desta mesma iteracao -
    // nunca duas leituras independentes de relogio (uma injetavel, outra
    // real) para a mesma decisao. Isso torna toda a politica de
    // retry/elegibilidade deterministica de ponta a ponta em testes, e
    // continua usando o relogio real por padrao em producao (this._now
    // default e `() => new Date()`).
    const agora = this._now();
    const item = await this._outbox.claimNext(agora);
    if (!item) return { processado: false, motivo: 'FILA_VAZIA' };

    let resposta;
    try {
      resposta = await this._transportar(item);
    } catch (erroInesperado) {
      resposta = {
        eventId: item.eventId,
        result: 'ERROR',
        httpStatus: null,
        correlationId: null,
        erro: 'Erro inesperado do transporte (sanitizado): ' + (erroInesperado && erroInesperado.message ? erroInesperado.message : String(erroInesperado)),
      };
    }

    const classificacao = classificarResposta(resposta);

    if (classificacao.tipo === 'SUCESSO') {
      await this._outbox.registrarResultado(item.eventId, resposta);
      await this._registrarNoCheckpoint(item, resposta);
      return { processado: true, eventId: item.eventId, resultado: 'SUCESSO', novoEstado: classificacao.novoEstado };
    }

    if (classificacao.tipo === 'REJEITADO_PERMANENTE') {
      await this._outbox.registrarResultado(item.eventId, resposta);
      await this._registrarNoCheckpoint(item, resposta);
      return { processado: true, eventId: item.eventId, resultado: 'REJEITADO_PERMANENTE' };
    }

    if (classificacao.tipo === 'ERRO_TECNICO_PERMANENTE') {
      await this._outbox.transicionar(item.eventId, ESTADOS.FAILED, {
        httpStatus: resposta.httpStatus,
        result: resposta.result,
        correlationId: resposta.correlationId,
        ultimoErro: resposta.erro || `Erro tecnico permanente (HTTP ${resposta.httpStatus}) - nao sera tentado novamente automaticamente.`,
      });
      await this._registrarNoCheckpoint(item, resposta);
      return { processado: true, eventId: item.eventId, resultado: 'ERRO_TECNICO_PERMANENTE' };
    }

    // FALHA_TRANSITORIA ou RESULTADO_DESCONHECIDO - tratado igualmente
    // (conservador: nunca assume sucesso de um resultado nao reconhecido).
    // `item.tentativas` ja reflete a tentativa que acabou de acontecer
    // (claimNext() a incrementou no momento do claim - cada tentativa REAL
    // de transmissao conta exatamente 1 vez, sem dupla contagem e sem
    // contar a recuperacao de orfao como tentativa).
    const tentativasFeitas = item.tentativas;
    if (tentativasFeitas >= this._politica.maxTentativas) {
      await this._outbox.transicionar(item.eventId, ESTADOS.FAILED, {
        httpStatus: resposta.httpStatus,
        result: resposta.result,
        correlationId: resposta.correlationId,
        ultimoErro: (resposta.erro || 'Falha transitoria') + ` - limite de ${this._politica.maxTentativas} tentativas esgotado.`,
      });
      await this._registrarNoCheckpoint(item, resposta);
      return { processado: true, eventId: item.eventId, resultado: 'FAILED_LIMITE_TENTATIVAS' };
    }

    const atrasoMs = calcularBackoffMs(tentativasFeitas, this._politica);
    const proximaTentativaEm = new Date(agora.getTime() + atrasoMs).toISOString();
    await this._outbox.transicionar(item.eventId, ESTADOS.RETRY, {
      httpStatus: resposta.httpStatus,
      result: resposta.result,
      correlationId: resposta.correlationId,
      ultimoErro: resposta.erro || 'Falha transitoria (sanitizado).',
      nextAttemptAt: proximaTentativaEm,
    });
    return { processado: true, eventId: item.eventId, resultado: 'RETRY', nextAttemptAt: proximaTentativaEm };
  }

  /**
   * Processa itens ate a fila ficar vazia (nenhum PENDING/RETRY elegivel
   * restante) ou ate `limiteMaximo` iteracoes (protecao contra loop
   * infinito em caso de bug/teste mal configurado). Estritamente serial -
   * nunca usa Promise.all, nunca processa 2 itens ao mesmo tempo.
   * @param {{limiteMaximo?:number}} [opcoes]
   * @returns {Promise<Array<Object>>} um resultado por item processado
   */
  async processarAteEsvaziar(opcoes) {
    const limite = opcoes && opcoes.limiteMaximo != null ? opcoes.limiteMaximo : 1000;
    const resultados = [];
    for (let i = 0; i < limite; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const resultado = await this.processarProximo();
      if (!resultado.processado) break;
      resultados.push(resultado);
    }
    return resultados;
  }

  /**
   * Registra/atualiza o checkpoint para um resultado TERMINAL da outbox
   * (sucesso, rejeitado ou erro tecnico permanente) - nunca chamado para
   * RETRY (estado nao-terminal, nao faz sentido no checkpoint, que so
   * guarda o historico de resultados finais conhecidos). Ver nota de
   * atomicidade no cabecalho do modulo - escrita SEMPRE depois da outbox.
   */
  async _registrarNoCheckpoint(item, resposta) {
    if (!this._checkpoint) return;
    const existente = await this._checkpoint.buscarEvento(item.eventId);
    if (!existente) {
      await this._checkpoint.registrarEvento({
        eventId: item.eventId,
        identityKey: item.identityKey,
        nexTransactionId: item.nexTransactionId,
        contentHash: item.contentHash,
        status: 'PROCESSADO_LOCALMENTE',
      });
    }
    await this._checkpoint.atualizarEvento(item.eventId, {
      status: 'PROCESSADO_LOCALMENTE',
      httpStatus: resposta.httpStatus,
      result: resposta.result,
      correlationId: resposta.correlationId,
      erro: resposta.erro != null ? resposta.erro : null,
    });
  }
}

module.exports = {
  ProcessadorOutboxNex,
  classificarResposta,
  calcularBackoffMs,
  POLITICA_PADRAO,
  HTTP_STATUS_TERMINAL_SEM_RETRY,
};
