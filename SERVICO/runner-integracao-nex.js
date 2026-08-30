'use strict';

/**
 * Runner operacional do piloto F4 (Fase F4.1).
 *
 * Este modulo e SOMENTE composicao/orquestracao dos modulos ja
 * homologados (F3.1-F3.7 + F4.0) em um processo de longa duracao. NAO
 * reimplementa nenhuma logica de dominio - parser, normalizacao,
 * CustomerResolver, gerador, gate, allowlist, contentHash, anti-replay,
 * checkpoint, outbox, retry/backoff, HMAC e transporte HTTP continuam
 * 100% nos modulos originais.
 *
 * NUNCA le `process.env` diretamente - toda configuracao (incluindo
 * endpoint/origin/secret) chega via o parametro `config`, montado pelo
 * chamador (o script fino de entrada, `SCRIPTS/rodar-piloto-f4.js` na
 * F4.3). Isso mantem este modulo 100% testavel com config fake/injetada,
 * sem nunca ler segredo real nem fazer HTTP real durante os testes.
 *
 * Fail-closed: recusa iniciar (antes de abrir qualquer conexao SQLite)
 * se a configuracao obrigatoria estiver ausente, e recusa iniciar
 * detector/processamento (apos abrir os bancos, mas antes de qualquer
 * um deles aceitar trabalho) se o bootstrap nao estiver `APPROVED` ou se
 * nao houver export de Clientes disponivel - ambos reaproveitando
 * exatamente os erros ja existentes (`BootstrapNaoAprovadoError`,
 * `IndiceClientesIndisponivelError`), nunca uma segunda logica paralela.
 */

const fs = require('fs');
const path = require('path');

const { EstadoBootstrapSqlite } = require(path.join(__dirname, 'estado-bootstrap-sqlite'));
const { OutboxLocal } = require(path.join(__dirname, 'outbox-local'));
const { CheckpointSqlite } = require(path.join(__dirname, 'checkpoint-sqlite'));
const { OrquestradorIntegracaoNex } = require(path.join(__dirname, 'orquestrador-integracao-nex'));
const { BootstrapIntegracaoNex, BootstrapNaoAprovadoError } = require(path.join(__dirname, 'bootstrap-integracao-nex'));
const { ProcessadorOutboxNex } = require(path.join(__dirname, 'processador-outbox-nex'));
const { DetectorExportsNex } = require(path.join(__dirname, 'detector-exports-nex'));
const { criarRepositorioEventosHttp } = require(path.join(__dirname, 'repositorio-eventos-http'));
const { LOGGER_NULO } = require(path.join(__dirname, 'logger-estruturado'));

function sleepPadrao(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Fail-fast: valida a configuracao obrigatoria ANTES de abrir qualquer
 * recurso (conexao SQLite, detector, HTTP). Nunca abre nada com
 * configuracao incompleta.
 */
function validarConfig(config) {
  const c = config || {};
  if (!c.dbPath) {
    throw new Error('iniciarRunner: config.dbPath obrigatorio.');
  }
  if (!c.diretorioExports) {
    throw new Error('iniciarRunner: config.diretorioExports obrigatorio.');
  }
  const fsImpl = c.fsImpl || fs;
  if (!fsImpl.existsSync(c.diretorioExports)) {
    throw new Error(`iniciarRunner: config.diretorioExports nao existe ou nao e acessivel: "${c.diretorioExports}".`);
  }
  if (typeof c.transportar !== 'function') {
    if (!c.endpoint || !c.origin || !c.secret) {
      throw new Error(
        'iniciarRunner: forneca config.transportar (fake/override, para testes) OU ' +
          'config.endpoint + config.origin + config.secret (producao real via Repository HTTP).',
      );
    }
  }
  return c;
}

/**
 * Adapta um item da outbox (shape de SERVICO/outbox-local.js) para o
 * `entradaGate` que SERVICO/repositorio-eventos-http.js::enviarEvento
 * espera ({status, reason, event}). Pura composicao de shape - nenhuma
 * regra de negocio nova (o Repository ja recalcula o contentHash a
 * partir do mesmo `event`, garantindo paridade com o que foi enfileirado).
 */
function adaptarItemOutboxParaEntradaGate(itemOutbox) {
  return { status: itemOutbox.sourceStatus, reason: null, event: itemOutbox.payload };
}

/**
 * Inicia o runner operacional: abre os bancos compartilhados
 * (estado/outbox/checkpoint sobre o MESMO arquivo `config.dbPath`),
 * exige bootstrap APPROVED, inicializa o indice deterministico de
 * Clientes, roda auditoria de consistencia (so leitura/log, nunca
 * auto-correcao), recupera itens SENDING orfaos, monta o processador da
 * outbox e o detector de exports, e comeca a operar.
 *
 * @param {Object} config
 * @param {string} config.dbPath - caminho do arquivo .db operacional
 *   (mesmo arquivo para estado/outbox/checkpoint).
 * @param {string} config.diretorioExports - diretorio observado pelo detector.
 * @param {Function} [config.transportar] - `(itemOutbox) => Promise<{eventId,
 *   result, httpStatus, correlationId, erro}>` - override completo do
 *   transporte (usado pelos testes, NUNCA deve fazer HTTP real nesse
 *   caso). Se ausente, `endpoint`/`origin`/`secret` sao obrigatorios e um
 *   Repository HTTP real e construido.
 * @param {string} [config.endpoint] - NEX_PRIME_ENDPOINT (producao real).
 * @param {string} [config.origin] - NEX_PRIME_ORIGIN (producao real).
 * @param {string} [config.secret] - NEX_PRIME_INTEGRATION_SECRET (producao real,
 *   NUNCA logado - reaproveita a sanitizacao ja existente do logger).
 * @param {Object} [config.logger] - instancia de logger (default: LOGGER_NULO).
 * @param {Object} [config.fsImpl] - fs injetavel (default: fs real).
 * @param {Function} [config.sleepImpl] - sleep injetavel (default: setTimeout real).
 * @param {Function} [config.nowImpl] - `() => Date`, injetavel (repassado ao ProcessadorOutboxNex).
 * @param {Function} [config.fetchImpl] - fetch injetavel (repassado ao Repository HTTP real).
 * @param {Object} [config.contextoClienteExtrato] - repassado ao bootstrap (extrato individual).
 * @param {Array<string>} [config.extensoesAceitas]
 * @param {number} [config.intervaloEstabilidadeMs]
 * @param {number} [config.intervaloPollingMs]
 * @param {number} [config.processadorIntervaloMs] - default 30000.
 * @param {number} [config.limiteMaximoPorCiclo] - default 1000 (repassado a processarAteEsvaziar).
 * @param {Object} [config.politicaRetry] - override parcial de POLITICA_PADRAO.
 * @param {number} [config.httpTimeoutMs]
 * @param {number} [config.httpMaxRetries]
 * @param {Function} [config.httpNowImpl] - `() => number`, injetavel no Repository HTTP (timestamp).
 * @param {number} [config.shutdownTimeoutMs] - default 15000.
 * @param {Function} [config.onErroDetector] - repassado ao detector.
 * @returns {Promise<{parar: (motivo?:string) => Promise<void>}>}
 */
async function iniciarRunner(config) {
  const cfg = validarConfig(config);
  const logger = cfg.logger || LOGGER_NULO;
  const fsImpl = cfg.fsImpl || fs;

  const estado = new EstadoBootstrapSqlite(cfg.dbPath);
  const outbox = new OutboxLocal(cfg.dbPath);
  const checkpoint = new CheckpointSqlite(cfg.dbPath);

  function fecharRecursos() {
    try { outbox.fechar(); } catch (e) { /* ja fechado */ }
    try { checkpoint.fechar(); } catch (e) { /* ja fechado */ }
    try { estado.fechar(); } catch (e) { /* ja fechado */ }
  }

  let estadoAtual;
  try {
    estadoAtual = await estado.obterEstado();
  } catch (erro) {
    fecharRecursos();
    throw erro;
  }

  if (estadoAtual.status !== 'APPROVED') {
    logger.error('runner', 'RUNNER_RECUSOU_INICIAR', { motivo: 'BOOTSTRAP_NAO_APROVADO', statusAtual: estadoAtual.status });
    fecharRecursos();
    throw new BootstrapNaoAprovadoError(estadoAtual.status);
  }

  const orquestrador = new OrquestradorIntegracaoNex({ checkpoint, outbox, logger });
  const bootstrap = new BootstrapIntegracaoNex({
    estado,
    orquestrador,
    diretorioExports: cfg.diretorioExports,
    contextoClienteExtrato: cfg.contextoClienteExtrato,
    fsImpl,
    logger,
  });

  try {
    await bootstrap.inicializarIndiceClientes();
  } catch (erro) {
    logger.error('runner', 'RUNNER_RECUSOU_INICIAR', { motivo: 'INDICE_CLIENTES_INDISPONIVEL', erro: erro && erro.message });
    fecharRecursos();
    throw erro;
  }

  const inconsistencias = await bootstrap.auditarConsistencia(outbox, checkpoint);
  // auditarConsistencia() ja loga um WARN por achado internamente
  // (evento CHECKPOINT_INCONSISTENTE) - aqui so registramos o resumo.
  // Decisao documentada em F4.1: NUNCA bloquear o startup por isso, e
  // NUNCA auto-corrigir - so visibilidade para revisao manual.
  logger.info('runner', 'AUDITORIA_CONSISTENCIA_CONCLUIDA', { divergencias: inconsistencias.length });

  const transportar = typeof cfg.transportar === 'function'
    ? cfg.transportar
    : (() => {
      const repositorio = criarRepositorioEventosHttp(
        { endpoint: cfg.endpoint, origin: cfg.origin, secret: cfg.secret },
        { fetchImpl: cfg.fetchImpl, timeoutMs: cfg.httpTimeoutMs, maxRetries: cfg.httpMaxRetries, now: cfg.httpNowImpl },
      );
      return (itemOutbox) => repositorio.enviarEvento(adaptarItemOutboxParaEntradaGate(itemOutbox));
    })();

  const processador = new ProcessadorOutboxNex({
    outbox,
    checkpoint,
    transportar,
    politica: cfg.politicaRetry,
    nowImpl: cfg.nowImpl,
    logger,
  });

  const recuperados = await processador.recuperarPendencias();

  let processando = false;
  async function dispararProcessamentoOutbox() {
    if (processando) {
      logger.debug('runner', 'PROCESSAMENTO_JA_EM_ANDAMENTO', {});
      return;
    }
    processando = true;
    try {
      const limite = cfg.limiteMaximoPorCiclo != null ? cfg.limiteMaximoPorCiclo : 1000;
      await processador.processarAteEsvaziar({ limiteMaximo: limite });
    } catch (erro) {
      logger.error('runner', 'ERRO_CRITICO_PROCESSAMENTO_OUTBOX', { erro: erro && erro.message });
    } finally {
      processando = false;
    }
  }

  // Drena qualquer PENDING/RETRY pre-existente (inclusive os itens que
  // acabaram de ser recuperados de SENDING orfao acima) antes de aceitar
  // qualquer arquivo novo do detector.
  await dispararProcessamentoOutbox();

  async function onArquivoPronto(info) {
    try {
      const relatorio = await bootstrap.processarArquivoOperacional(info.caminho, cfg.opcoesProcessamento);
      logger.info('runner', 'ARQUIVO_PROCESSADO', {
        arquivo: info.caminho,
        totalLinhas: relatorio.totalLinhas,
        enfileirados: relatorio.enfileirados.length,
        ignoradosAntiReplay: (relatorio.ignoradosAntiReplay || []).length,
        historicoAlterado: (relatorio.historicoAlterado || []).length,
        bloqueadosParaAutomacao: relatorio.bloqueadosParaAutomacao.length,
        ignoradosCheckpoint: relatorio.ignoradosCheckpoint.length,
        erros: relatorio.erros.length,
      });
      if (relatorio.enfileirados.length > 0) {
        await dispararProcessamentoOutbox();
      }
    } catch (erro) {
      // Nunca derruba o processo - o detector continua ativo para o
      // proximo arquivo; o erro fica visivel no log para intervencao manual.
      logger.error('runner', 'ERRO_CRITICO_PROCESSAMENTO_ARQUIVO', { arquivo: info.caminho, erro: erro && erro.message });
    }
  }

  const detector = new DetectorExportsNex({
    diretorio: cfg.diretorioExports,
    onArquivoPronto,
    extensoesAceitas: cfg.extensoesAceitas,
    intervaloEstabilidadeMs: cfg.intervaloEstabilidadeMs,
    intervaloPollingMs: cfg.intervaloPollingMs,
    fsImpl,
    sleepImpl: cfg.sleepImpl,
    logger,
    onErro: cfg.onErroDetector,
  });

  const intervaloProcessadorMs = cfg.processadorIntervaloMs != null ? cfg.processadorIntervaloMs : 30000;
  const timerProcessador = setInterval(() => { dispararProcessamentoOutbox(); }, intervaloProcessadorMs);
  if (timerProcessador.unref) timerProcessador.unref();

  detector.iniciar();

  logger.info('runner', 'RUNNER_INICIADO', {
    bootstrapStatus: estadoAtual.status,
    cutoff: estadoAtual.cutoff,
    diretorioExports: cfg.diretorioExports,
    dbPath: cfg.dbPath,
    divergenciasConsistencia: inconsistencias.length,
    itensRecuperados: recuperados.length,
  });

  const sleepFn = cfg.sleepImpl || sleepPadrao;
  let parado = false;

  /**
   * Para o runner de forma segura e idempotente: para o detector e o
   * timer do processador primeiro (nenhum trabalho NOVO e aceito a
   * partir daqui), aguarda um processamento de outbox em voo terminar
   * (com timeout de seguranca - nunca trava indefinidamente; um item que
   * ficar em SENDING nesse caso raro e resolvido por recuperarOrfaos()
   * no proximo startup, nunca perdido), fecha as 3 conexoes SQLite, e
   * loga o motivo/estado final. NUNCA apaga/reseta o banco. Chamar
   * `parar()` mais de uma vez e seguro (no-op na segunda chamada).
   */
  async function parar(motivo) {
    if (parado) return;
    parado = true;

    detector.parar();
    clearInterval(timerProcessador);

    const timeoutMs = cfg.shutdownTimeoutMs != null ? cfg.shutdownTimeoutMs : 15000;
    const inicioEspera = Date.now();
    while (processando && Date.now() - inicioEspera < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      await sleepFn(50);
    }

    fecharRecursos();

    logger.info('runner', 'RUNNER_PARADO', { motivo: motivo || 'MANUAL' });
  }

  return {
    parar,
    // Exposto SOMENTE para uso em testes (inspecionar estado sem abrir uma
    // segunda conexao concorrente ao mesmo arquivo .db) - nao e API publica
    // estavel, nao deve ser usado pelo script de entrada real (F4.3).
    _internoParaTeste: { estado, outbox, checkpoint, bootstrap, processador, detector },
  };
}

module.exports = { iniciarRunner };
