'use strict';

/**
 * Bootstrap / Dry-run operacional / Anti-replay (Fase F3.7).
 *
 * Coordena EstadoBootstrapSqlite (maquina de estados NOT_STARTED ->
 * DRY_RUN -> BASELINED -> APPROVED) com o OrquestradorIntegracaoNex ja
 * homologado (Fase F3.4), SEM reimplementar nenhuma logica de dominio
 * (parsing/normalizacao/classificacao/gate continuam 100% nos modulos
 * originais - este modulo so decide "isso e historico (baseline) ou
 * novo?" e liga o gancho de anti-replay do orquestrador).
 *
 * PRINCIPIO CENTRAL: na primeira execucao, NADA do historico pode ser
 * enviado automaticamente. O sistema so pode operar normalmente
 * (`processarArquivoOperacional`) depois de `aprovar()` ser chamado
 * EXPLICITAMENTE por um humano - nunca automaticamente apos o dry-run ou
 * o baseline. Falha fechada: qualquer tentativa de operar sem
 * `status === APPROVED` lanca `BootstrapNaoAprovadoError`.
 *
 * NAO faz HTTP, NAO acessa Base44/.nx1/NEX. Este modulo tambem NAO
 * decide sozinho a data do cutoff - ela e sempre fornecida pelo
 * chamador (nunca "agora" hardcoded).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { nomeEhCandidatoValido, EXTENSOES_PADRAO } = require(path.join(__dirname, 'detector-exports-nex'));
const { LOGGER_NULO } = require(path.join(__dirname, 'logger-estruturado'));
const { RESULTADOS_CONFIRMADOS } = require(path.join(__dirname, 'checkpoint-sqlite'));
const { ESTADOS: ESTADOS_OUTBOX } = require(path.join(__dirname, 'outbox-local'));
const { identificarTipoExport, TIPOS_EXPORT } = require(path.join(__dirname, 'orquestrador-integracao-nex'));

class BootstrapNaoAprovadoError extends Error {
  constructor(statusAtual) {
    super(`BootstrapIntegracaoNex: operacao normal bloqueada - status atual e "${statusAtual}", exige "APPROVED". Rode o dry-run, confirme o baseline e aprove explicitamente antes de operar.`);
    this.name = 'BootstrapNaoAprovadoError';
    this.statusAtual = statusAtual;
  }
}

/**
 * Erro de "falha fechada" (Fase F3.7, pendencia registrada desde a Fase
 * F3.4): nenhum export de Clientes foi encontrado no diretorio no
 * momento em que um arquivo de Vendas precisou ser processado em
 * operacao normal. Processar Vendas sem indice de clientes produziria
 * SEM_MATCH evitavel em massa - preferimos falhar explicitamente a
 * silenciosamente gerar milhares de REVIEW_REQUIRED por falta de dado
 * que na verdade estava disponivel, so nao foi carregado ainda.
 */
class IndiceClientesIndisponivelError extends Error {
  constructor(diretorio) {
    super(`BootstrapIntegracaoNex: nenhum export de Clientes encontrado em "${diretorio}" para inicializar o indice antes de processar Vendas. Operacao normal bloqueada (falha fechada) - gere/coloque um export de Clientes na pasta antes de continuar.`);
    this.name = 'IndiceClientesIndisponivelError';
    this.diretorio = diretorio;
  }
}

/**
 * CONTRATO DE TIMEZONE (auditado explicitamente na Fase F3.7.1):
 *
 * `occurredAt` e sempre uma string ISO "naive" LOCAL, SEM sufixo "Z" e
 * SEM offset - produzida por SRC/parser-datas.js::combinarDataHora, que
 * documenta explicitamente: representa o horario de PAREDE da loja em
 * America/Sao_Paulo exatamente como exibido pelo NEX, e NAO deve ser
 * tratada como UTC. `cutoff` segue exatamente o MESMO contrato (mesma
 * timezone implicita, mesmo formato) - nunca um valor com "Z"/offset.
 *
 * A versao anterior desta funcao anexava "Z" antes de fazer
 * `Date.parse`, o que faz o motor JS interpretar o valor como UTC
 * literal - uma afirmacao TECNICAMENTE FALSA sobre o dado (o valor e
 * horario de Sao Paulo, nao UTC), mesmo que o comentario dissesse o
 * contrario. Isso funcionava "por acidente" apenas porque occurredAt e
 * cutoff recebiam sempre o MESMO tratamento incorreto (erro cancelava
 * erro) - mas quebraria silenciosamente se algum dia um cutoff fosse
 * fornecido em UTC real (ex.: gerado por `new Date().toISOString()`,
 * que TEM "Z"), deslocando a comparacao pelo offset de Sao Paulo (3h)
 * sem nenhum aviso.
 *
 * CORRECAO: comparacao por STRING (wall-clock local), nunca por
 * epoch/UTC - nunca invoca Date.parse/new Date() para esta decisao,
 * portanto e 100% independente da timezone configurada na maquina que
 * executa o codigo. E correta porque o formato e sempre largura fixa e
 * zero-padded (YYYY-MM-DDTHH:mm:ss, com fracao de segundo opcional de
 * EXATAMENTE 3 digitos) - comparacao lexicografica de strings de mesmo
 * formato produz a MESMA ordem cronologica que uma comparacao numerica.
 * Um valor com "Z"/offset explicito e REJEITADO (lanca erro) em vez de
 * silenciosamente mal-interpretado.
 */
const REGEX_DATA_HORA_LOCAL_NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?$/;

function normalizarParaChaveComparavel(isoLocal, nomeDoCampo) {
  const s = String(isoLocal).trim();
  if (!REGEX_DATA_HORA_LOCAL_NAIVE.test(s)) {
    throw new Error(
      `BootstrapIntegracaoNex: ${nomeDoCampo || 'valor'} nao esta no formato esperado ` +
        `"YYYY-MM-DDTHH:mm:ss" ou "YYYY-MM-DDTHH:mm:ss.SSS" (horario local naive, SEM "Z"/offset UTC): "${s}". ` +
        'Este contrato representa sempre o horario de parede em America/Sao_Paulo, nunca UTC.',
    );
  }
  // CRITICO: comparacao lexicografica so e correta se AMBOS os valores
  // tiverem a MESMA largura. "2026-08-30T00:00:00" (sem fracao) e
  // "2026-08-30T00:00:00.000" (com fracao) representam o MESMO instante,
  // mas sem esta normalizacao o primeiro (mais curto) seria comparado
  // como "menor" que o segundo por ser prefixo dele - um bug real de
  // borda encontrado e corrigido na Fase F3.7.1. Aqui garantimos que todo
  // valor sem fracao explicita recebe ".000" antes de comparar.
  return s.includes('.') ? s : `${s}.000`;
}

/**
 * @param {string} occurredAt
 * @param {string} cutoff
 * @returns {boolean} true se occurredAt <= cutoff (BASELINE/HISTORICO)
 */
function ehBaseline(occurredAt, cutoff) {
  const a = normalizarParaChaveComparavel(occurredAt, 'occurredAt');
  const b = normalizarParaChaveComparavel(cutoff, 'cutoff');
  return a <= b;
}

function calcularSha256DeArquivo(caminho, fsImpl) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsImpl.createReadStream(caminho);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

class BootstrapIntegracaoNex {
  /**
   * @param {Object} opcoes
   * @param {Object} opcoes.estado - instancia de EstadoBootstrapSqlite (Fase F3.7)
   * @param {Object} opcoes.orquestrador - instancia de OrquestradorIntegracaoNex (Fase F3.4)
   * @param {string} opcoes.diretorioExports - diretorio com os arquivos de export
   * @param {{nexCustomerCode:string, customerName?:string}} [opcoes.contextoClienteExtrato] -
   *   repassado ao orquestrador quando processar um extrato individual
   *   (nunca inferido - mesma regra ja homologada na Fase F3.4).
   * @param {Object} [opcoes.fsImpl] - injetavel para testes (default: `fs`)
   * @param {Object} [opcoes.logger] - injetavel (default: LOGGER_NULO)
   */
  constructor(opcoes) {
    const opc = opcoes || {};
    if (!opc.estado) throw new Error('BootstrapIntegracaoNex: opcoes.estado obrigatorio.');
    if (!opc.orquestrador) throw new Error('BootstrapIntegracaoNex: opcoes.orquestrador obrigatorio.');
    if (!opc.diretorioExports) throw new Error('BootstrapIntegracaoNex: opcoes.diretorioExports obrigatorio.');

    this._estado = opc.estado;
    this._orquestrador = opc.orquestrador;
    this._diretorioExports = opc.diretorioExports;
    this._contextoClienteExtrato = opc.contextoClienteExtrato || undefined;
    this._fs = opc.fsImpl || fs;
    this._logger = opc.logger || LOGGER_NULO;
    // Pendencia da Fase F3.4 resolvida nesta fase (item 22): o indice de
    // clientes do orquestrador e reconstruido deterministicamente no
    // INICIO da sessao operacional, antes de qualquer arquivo de Vendas -
    // nunca lazy/silencioso. Esta flag e por instancia de
    // BootstrapIntegracaoNex (equivalente a "esta sessao/processo ja
    // carregou o indice uma vez").
    this._indiceClientesInicializado = false;
  }

  /**
   * Localiza, entre os arquivos candidatos do diretorio, o export de
   * Clientes MAIS RECENTE (por mtime) e o processa via orquestrador
   * (nunca dryRun - processar Clientes so atualiza o indice em memoria,
   * jamais toca checkpoint/outbox/HTTP, entao e seguro mesmo fora de
   * dryRun). Deterministico: sempre o mesmo arquivo escolhido para o
   * mesmo conjunto de arquivos (maior mtime; empate resolvido por ordem
   * alfabetica do nome, nunca aleatorio).
   *
   * @throws {IndiceClientesIndisponivelError} se nenhum export de
   *   Clientes existir no diretorio - falha fechada deliberada.
   */
  async inicializarIndiceClientes() {
    const nomes = this._listarArquivosCandidatos();
    let melhor = null;
    for (const nome of nomes) {
      const caminho = path.join(this._diretorioExports, nome);
      const buffer = this._fs.readFileSync(caminho);
      if (identificarTipoExport(buffer) !== TIPOS_EXPORT.CLIENTES) continue;
      const stat = this._fs.statSync(caminho);
      if (!melhor || stat.mtimeMs > melhor.mtimeMs || (stat.mtimeMs === melhor.mtimeMs && nome < melhor.nome)) {
        melhor = { caminho, nome, mtimeMs: stat.mtimeMs };
      }
    }
    if (!melhor) {
      throw new IndiceClientesIndisponivelError(this._diretorioExports);
    }
    await this._orquestrador.processarArquivo(melhor.caminho);
    this._indiceClientesInicializado = true;
    this._logger.info('bootstrap', 'INDICE_CLIENTES_INICIALIZADO', { arquivo: melhor.caminho });
  }

  _listarArquivosCandidatos() {
    const nomes = this._fs.readdirSync(this._diretorioExports);
    return nomes.filter((nome) => nomeEhCandidatoValido(nome, EXTENSOES_PADRAO));
  }

  /**
   * Varre o diretorio e, para cada arquivo candidato, roda o orquestrador
   * em modo dryRun (Fase F3.4 - nunca toca checkpoint/outbox) e separa as
   * entradas classificadas (com eventId real) em BASELINE (occurredAt <=
   * cutoff) e NOVO (occurredAt > cutoff). Funcao interna reaproveitada por
   * executarDryRun() e confirmarBaseline() - garante que ambas enxergam
   * exatamente a mesma classificacao.
   *
   * @param {string} cutoff
   * @returns {Promise<{arquivos: Array<{caminho:string, nome:string, sha256:string}>,
   *   baseline: Array<Object>, novos: Array<Object>, reviewRequired: number,
   *   bloqueados: number, naoReconhecidos: number, totalLinhas: number}>}
   */
  async _varrerEClassificar(cutoff) {
    const nomes = this._listarArquivosCandidatos();
    const arquivos = [];
    const baseline = [];
    const novos = [];
    let reviewRequired = 0;
    let bloqueados = 0;
    let naoReconhecidos = 0;
    let totalLinhas = 0;

    for (const nome of nomes) {
      const caminho = path.join(this._diretorioExports, nome);
      // eslint-disable-next-line no-await-in-loop
      const sha256 = await calcularSha256DeArquivo(caminho, this._fs);
      arquivos.push({ caminho, nome, sha256 });

      // eslint-disable-next-line no-await-in-loop
      const relatorio = await this._orquestrador.processarArquivo(caminho, {
        dryRun: true,
        contextoClienteExtrato: this._contextoClienteExtrato,
      });

      if (relatorio.erroArquivo) {
        if (relatorio.erroArquivo.tipo === 'ARQUIVO_NAO_RECONHECIDO') naoReconhecidos += 1;
        continue;
      }

      totalLinhas += relatorio.totalLinhas;
      bloqueados += relatorio.bloqueadosParaAutomacao.length;

      const todasComIdentidade = [...relatorio.readyToSend, ...relatorio.reviewRequired].filter((r) => r.event && r.event.eventId);
      for (const entrada of todasComIdentidade) {
        if (entrada.status === 'REVIEW_REQUIRED') reviewRequired += 1;
        const alvo = ehBaseline(entrada.event.occurredAt, cutoff) ? baseline : novos;
        alvo.push(entrada);
      }
    }

    return { arquivos, baseline, novos, reviewRequired, bloqueados, naoReconhecidos, totalLinhas };
  }

  /**
   * Primeiro passo do bootstrap: varre e classifica, transiciona o
   * estado para DRY_RUN, mas NAO persiste nenhum baseline ainda (isso e
   * confirmarBaseline()). NUNCA toca checkpoint/outbox/HTTP - e
   * inspecionavel por humano antes de qualquer decisao.
   * @param {string} cutoff
   * @returns {Promise<Object>} relatorio do dry-run
   */
  async executarDryRun(cutoff) {
    if (!cutoff) throw new Error('BootstrapIntegracaoNex.executarDryRun: cutoff obrigatorio (nunca inferido de "agora").');
    this._logger.info('bootstrap', 'BOOTSTRAP_INICIADO', { cutoff, diretorio: this._diretorioExports });

    await this._estado.iniciarDryRun(cutoff);
    const resultado = await this._varrerEClassificar(cutoff);

    const relatorio = {
      cutoff,
      totalArquivos: resultado.arquivos.length,
      totalLinhas: resultado.totalLinhas,
      baseline: resultado.baseline.length,
      novos: resultado.novos.length,
      reviewRequired: resultado.reviewRequired,
      bloqueados: resultado.bloqueados,
      naoReconhecidos: resultado.naoReconhecidos,
    };
    this._logger.info('bootstrap', 'BOOTSTRAP_DRY_RUN_CONCLUIDO', relatorio);
    return relatorio;
  }

  /**
   * Segundo passo: repete a mesma varredura/classificacao (deterministica
   * para o mesmo conjunto de arquivos+cutoff) e desta vez PERSISTE o
   * baseline de arquivos (por sha256) e de eventos historicos (por
   * eventId+contentHash, como BASELINED_LOCAL - nunca CONFIRMED_REMOTE).
   * Idempotente: rodar de novo com os mesmos arquivos/eventos nao
   * duplica nada (baselinarArquivo/baselinarEvento ja sao idempotentes).
   * Transiciona DRY_RUN -> BASELINED. NAO libera operacao normal (isso
   * exige aprovar() em separado).
   * @param {string} cutoff
   * @returns {Promise<Object>} relatorio do baseline confirmado
   */
  async confirmarBaseline(cutoff) {
    if (!cutoff) throw new Error('BootstrapIntegracaoNex.confirmarBaseline: cutoff obrigatorio.');
    const resultado = await this._varrerEClassificar(cutoff);

    for (const arquivo of resultado.arquivos) {
      // eslint-disable-next-line no-await-in-loop
      await this._estado.baselinarArquivo(arquivo.sha256, arquivo.nome);
      this._logger.debug('bootstrap', 'BASELINE_ARQUIVO', { nome: arquivo.nome, sha256Arquivo: arquivo.sha256 });
    }

    let eventosAlterados = 0;
    for (const entrada of resultado.baseline) {
      const contentHash = this._calcularHashDoEvento(entrada);
      // eslint-disable-next-line no-await-in-loop
      const r = await this._estado.baselinarEvento(entrada.event.eventId, contentHash, entrada.event.nexTransactionId);
      if (r.alterado) {
        eventosAlterados += 1;
        this._logger.warn('bootstrap', 'BASELINE_EVENTO_HASH_ALTERADO', { eventId: entrada.event.eventId, hashAnterior: r.hashAnterior, hashNovo: contentHash });
      } else {
        this._logger.debug('bootstrap', 'BASELINE_EVENTO', { eventId: entrada.event.eventId });
      }
    }

    await this._estado.confirmarBaseline({
      baselineFilesCount: resultado.arquivos.length,
      baselineEventsCount: resultado.baseline.length,
    });

    const relatorio = {
      cutoff,
      arquivosBaselinados: resultado.arquivos.length,
      eventosBaselinados: resultado.baseline.length,
      eventosAlterados,
      novosNaoBaselinados: resultado.novos.length,
    };
    this._logger.info('bootstrap', 'BOOTSTRAP_BASELINE_CONCLUIDO', relatorio);
    return relatorio;
  }

  /**
   * Calcula o mesmo contentHash que o Repository HTTP calcularia para
   * este evento (reaproveita calcularFingerprint via
   * SERVICO/repositorio-eventos-http.js, sem duplicar a logica).
   */
  _calcularHashDoEvento(entrada) {
    // eslint-disable-next-line global-require
    const { calcularContentHashEvento } = require(path.join(__dirname, 'repositorio-eventos-http'));
    return calcularContentHashEvento(entrada.event);
  }

  /**
   * Aprovacao humana EXPLICITA - a UNICA forma de liberar operacao normal.
   * Nunca chamada automaticamente por este modulo.
   */
  async aprovar() {
    const resultado = await this._estado.aprovar();
    this._logger.warn('bootstrap', 'BOOTSTRAP_APROVADO', { cutoff: resultado.cutoff, aprovadoEm: resultado.approvedAt });
    return resultado;
  }

  /**
   * Ponto de entrada para OPERACAO NORMAL (pos-aprovacao). Falha fechada:
   * se o bootstrap nao estiver APPROVED, lanca BootstrapNaoAprovadoError
   * e NAO processa nada - nunca cai silenciosamente em modo de operacao.
   *
   * Liga o gancho de anti-replay do orquestrador (filtroElegibilidade).
   * Cada evento com identidade real e classificado em UMA destas 3
   * categorias, calculadas evento a evento (nunca por arquivo inteiro -
   * um arquivo baseline alterado pode conter os 3 casos ao mesmo tempo):
   *
   *   NOVO              - occurredAt fora do baseline (nao existe no
   *                        baseline local) -> segue pipeline normal
   *                        (gate/allowlist/checkpoint/outbox).
   *   BASELINE_IDENTICO - eventId+contentHash identicos ao baseline ->
   *                        IGNORADO (nunca chega a checkpoint/outbox),
   *                        reportado em `ignoradosAntiReplay`.
   *   BASELINE_CHANGED  - eventId existe no baseline mas o contentHash
   *                        MUDOU (correcao/alteracao no NEX/export) ->
   *                        BLOQUEADO da mesma forma (nunca chega a
   *                        checkpoint/outbox, NUNCA vira READY_TO_SEND/
   *                        SENT/UPDATED remoto automaticamente), mas
   *                        reportado SEPARADAMENTE em `historicoAlterado`
   *                        (com hashAnterior/hashNovo) para revisao
   *                        humana - uma politica futura explicita podera
   *                        decidir o que fazer com isso, esta fase so
   *                        detecta e bloqueia (Fase F3.7.1).
   *
   * @param {string} caminho
   * @param {Object} [opcoesProcessamento] - repassado ao orquestrador (ex.: contextoClienteExtrato)
   * @returns {Promise<Object>} relatorio do orquestrador, com
   *   `ignoradosAntiReplay` contendo SOMENTE os identicos, e um novo
   *   campo `historicoAlterado` (array de {eventId, hashAnterior, hashNovo,
   *   classificacao:'BASELINE_CHANGED'}) para os casos de hash alterado.
   */
  async processarArquivoOperacional(caminho, opcoesProcessamento) {
    const estadoAtual = await this._estado.obterEstado();
    if (estadoAtual.status !== 'APPROVED') {
      this._logger.error('bootstrap', 'BOOTSTRAP_BLOQUEOU_EXECUCAO', { statusAtual: estadoAtual.status, arquivo: caminho });
      throw new BootstrapNaoAprovadoError(estadoAtual.status);
    }

    // Pendencia F3.4 (item 22): antes de processar um arquivo de VENDAS em
    // operacao normal, garante que o indice de clientes ja foi carregado
    // deterministicamente nesta sessao - nunca processa Vendas com indice
    // vazio silenciosamente. Clientes/Extrato individual nao dependem do
    // indice global (extrato usa contextoClienteExtrato explicito), entao
    // nao exigem essa garantia.
    if (!this._indiceClientesInicializado) {
      const buffer = this._fs.readFileSync(caminho);
      if (identificarTipoExport(buffer) === TIPOS_EXPORT.VENDAS) {
        await this.inicializarIndiceClientes(); // lanca IndiceClientesIndisponivelError se nao houver Clientes (falha fechada)
      }
    }

    // O filtro do orquestrador precisa ser SINCRONO (`(evento) => boolean`)
    // - como avaliarEventoContraBaseline e assincrono, pre-computamos as
    // decisoes rodando o orquestrador em dryRun primeiro (mesma tecnica de
    // _varrerEClassificar), sem duplicar logica de dominio.
    const decisoesPorEventId = new Map(); // eventId -> {permitido, motivo, hashAnterior?, hashNovo?}
    const relatorioSimulado = await this._orquestrador.processarArquivo(caminho, { ...opcoesProcessamento, dryRun: true });
    const todasComIdentidade = [...relatorioSimulado.readyToSend, ...relatorioSimulado.reviewRequired].filter((r) => r.event && r.event.eventId);

    for (const entrada of todasComIdentidade) {
      const contentHash = this._calcularHashDoEvento(entrada);
      // eslint-disable-next-line no-await-in-loop
      const avaliacao = await this._estado.avaliarEventoContraBaseline(entrada.event.eventId, contentHash);

      if (!avaliacao.ehBaseline) {
        decisoesPorEventId.set(entrada.event.eventId, { permitido: true, motivo: 'NOVO' });
        this._logger.debug('bootstrap', 'EVENTO_POS_CUTOFF', { eventId: entrada.event.eventId });
      } else if (!avaliacao.hashMudou) {
        decisoesPorEventId.set(entrada.event.eventId, { permitido: false, motivo: 'BASELINE_IDENTICO' });
      } else {
        // eslint-disable-next-line no-await-in-loop
        const registroAnterior = await this._estado.buscarEventoBaseline(entrada.event.eventId);
        decisoesPorEventId.set(entrada.event.eventId, {
          permitido: false,
          motivo: 'BASELINE_CHANGED',
          hashAnterior: registroAnterior ? registroAnterior.contentHash : null,
          hashNovo: contentHash,
        });
        this._logger.warn('bootstrap', 'BASELINE_EVENTO_HASH_ALTERADO', {
          eventId: entrada.event.eventId,
          hashAnterior: registroAnterior ? registroAnterior.contentHash : null,
          hashNovo: contentHash,
        });
      }
    }

    const filtroSincrono = (eventoParaEnvio) => {
      const decisao = decisoesPorEventId.get(eventoParaEnvio.eventId);
      return decisao ? decisao.permitido : true;
    };
    const filtroAnterior = this._orquestrador._filtroElegibilidade;
    this._orquestrador._filtroElegibilidade = filtroSincrono;
    let relatorioReal;
    try {
      relatorioReal = await this._orquestrador.processarArquivo(caminho, opcoesProcessamento);
    } finally {
      this._orquestrador._filtroElegibilidade = filtroAnterior;
    }

    // Pos-processamento ADITIVO (nao muda nada do que ja foi decidido pelo
    // orquestrador): separa, dentro de `ignoradosAntiReplay`, os eventos
    // BASELINE_CHANGED em um campo proprio `historicoAlterado`, para nunca
    // serem confundidos com um simples "ja visto, identico" (que continua
    // em `ignoradosAntiReplay`).
    const historicoAlterado = [];
    const ignoradosIdenticos = [];
    for (const eventId of relatorioReal.ignoradosAntiReplay) {
      const decisao = decisoesPorEventId.get(eventId);
      if (decisao && decisao.motivo === 'BASELINE_CHANGED') {
        historicoAlterado.push({ eventId, hashAnterior: decisao.hashAnterior, hashNovo: decisao.hashNovo, classificacao: 'BASELINE_CHANGED' });
      } else {
        ignoradosIdenticos.push(eventId);
      }
    }
    relatorioReal.ignoradosAntiReplay = ignoradosIdenticos;
    relatorioReal.historicoAlterado = historicoAlterado;

    return relatorioReal;
  }

  /**
   * Auditoria de consistencia entre outbox terminal (SENT/REVIEW_STORED)
   * e o checkpoint - pendencia registrada desde a Fase F3.5 (ausencia de
   * transacao cross-connection real). NAO inventa confirmacao: apenas
   * relata `CHECKPOINT_AUSENTE` para itens terminais sem contrapartida
   * confirmada no checkpoint. Somente leitura - nao corrige nada.
   *
   * @param {Object} outbox - instancia de OutboxLocal
   * @param {Object} checkpoint - instancia de CheckpointSqlite
   * @returns {Promise<Array<{eventId:string, outboxStatus:string, motivo:string}>>}
   */
  async auditarConsistencia(outbox, checkpoint) {
    const inconsistencias = [];
    for (const status of [ESTADOS_OUTBOX.SENT, ESTADOS_OUTBOX.REVIEW_STORED]) {
      // eslint-disable-next-line no-await-in-loop
      const itens = await outbox.listarPorStatus(status);
      for (const item of itens) {
        // eslint-disable-next-line no-await-in-loop
        const confirmado = await checkpoint.eventoJaConfirmado(item.eventId, item.contentHash);
        if (!confirmado) {
          inconsistencias.push({ eventId: item.eventId, outboxStatus: item.status, motivo: 'CHECKPOINT_AUSENTE' });
          this._logger.warn('bootstrap', 'CHECKPOINT_INCONSISTENTE', { eventId: item.eventId, outboxStatus: item.status });
        }
      }
    }
    return inconsistencias;
  }
}

module.exports = {
  BootstrapIntegracaoNex,
  BootstrapNaoAprovadoError,
  IndiceClientesIndisponivelError,
  ehBaseline,
  normalizarParaChaveComparavel,
};
