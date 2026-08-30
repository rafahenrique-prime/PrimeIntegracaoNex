'use strict';

/**
 * Detector local de arquivos de export do NEX (Fase F3.3).
 *
 * Responsabilidade UNICA: observar um diretorio e notificar, via callback,
 * quando um arquivo de export (.xls/.xlsx) estiver ESTAVEL (parou de ser
 * escrito) e tiver conteudo NOVO (nunca visto, por hash SHA-256).
 *
 * NAO faz: parsing de XLS, geracao de evento de dominio, chamada a
 * checkpoint/outbox, chamada HTTP. Essas responsabilidades pertencem a
 * fases posteriores (F3.4 - orquestrador), que consumirao o callback
 * `onArquivoPronto` deste modulo.
 *
 * ESTRATEGIA (aprovada no planejamento F3): WATCHER (node:fs.watch, nativo,
 * sem dependencia externa) para baixa latencia + POLLING periodico como
 * garantia de corretude - o sistema nunca depende SOMENTE do watcher
 * (fs.watch pode perder eventos sob certas condicoes, especialmente em
 * rede/SMB). Ao iniciar, uma varredura imediata do diretorio cobre
 * arquivos ja existentes (startup scan) - isso NAO e bootstrap/anti-replay
 * historico (isso e F3.7); aqui o detector so informa "este arquivo existe
 * e esta estavel com este conteudo", nunca decide o que fazer com isso.
 *
 * IDENTIDADE POR CONTEUDO: a chave de "ja visto" e sempre o SHA-256 do
 * conteudo do arquivo, nunca nome nem mtime - um arquivo renomeado ou
 * reexportado com o mesmo conteudo nao gera nova notificacao; o mesmo
 * nome com conteudo diferente gera notificacao nova.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LOGGER_NULO } = require(path.join(__dirname, 'logger-estruturado'));

const EXTENSOES_PADRAO = ['.xls', '.xlsx'];

function sleepPadrao(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Nomes de arquivo que NUNCA sao candidatos, independente da extensao:
 * arquivos ocultos (comecam com "."), arquivos de download em progresso
 * (.tmp/.crdownload/.part) e o lock file classico do Excel (~$arquivo.xlsx)
 * - todos indicam explicitamente "nao e um export finalizado".
 */
function nomeEhCandidatoValido(nomeArquivo, extensoesAceitas) {
  if (!nomeArquivo) return false;
  if (nomeArquivo.startsWith('.')) return false;
  if (nomeArquivo.startsWith('~$')) return false;
  const ext = path.extname(nomeArquivo).toLowerCase();
  if (['.tmp', '.crdownload', '.part'].includes(ext)) return false;
  return extensoesAceitas.includes(ext);
}

function calcularSha256(caminho, fsImpl) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsImpl.createReadStream(caminho);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function statSeguro(caminho, fsImpl) {
  return new Promise((resolve) => {
    fsImpl.stat(caminho, (erro, stat) => {
      if (erro) resolve({ erro });
      else resolve({ stat });
    });
  });
}

class DetectorExportsNex {
  /**
   * @param {Object} opcoes
   * @param {string} opcoes.diretorio - diretorio a observar (ex.: EXPORTADOS/)
   * @param {Function} opcoes.onArquivoPronto - `(info) => void|Promise<void>`,
   *   chamado quando um arquivo estavel com conteudo NOVO e encontrado.
   *   info = { caminho, nomeArquivo, tamanho, mtime, sha256 }
   * @param {Array<string>} [opcoes.extensoesAceitas] - default ['.xls', '.xlsx']
   * @param {number} [opcoes.intervaloEstabilidadeMs] - tempo entre as duas
   *   observacoes (tamanho/mtime) exigidas antes de considerar um arquivo
   *   estavel. Default 2000ms.
   * @param {number} [opcoes.intervaloPollingMs] - intervalo do polling de
   *   seguranca. Default 120000ms (2 min).
   * @param {{has:Function, add:Function}} [opcoes.hashesConhecidos] - store
   *   de dedupe por conteudo, injetavel (default: Set em memoria, valido
   *   so durante a vida do processo). NAO e o checkpoint oficial de
   *   producao - isso sera integrado em fase posterior.
   * @param {Function} [opcoes.sleepImpl] - injetavel para testes
   *   deterministicos do intervalo de estabilidade.
   * @param {Object} [opcoes.fsImpl] - injetavel para testes (default:
   *   modulo `fs` real).
   * @param {Function} [opcoes.onErro] - `(erro) => void`, chamado para
   *   erros auditaveis que nao devem derrubar o detector (arquivo sumiu,
   *   permissao negada, diretorio ausente, etc.).
   */
  constructor(opcoes) {
    if (!opcoes || !opcoes.diretorio) {
      throw new Error('DetectorExportsNex: opcoes.diretorio obrigatorio.');
    }
    if (typeof opcoes.onArquivoPronto !== 'function') {
      throw new Error('DetectorExportsNex: opcoes.onArquivoPronto obrigatorio.');
    }

    this._diretorio = opcoes.diretorio;
    this._onArquivoPronto = opcoes.onArquivoPronto;
    this._extensoesAceitas = opcoes.extensoesAceitas || EXTENSOES_PADRAO;
    this._intervaloEstabilidadeMs = opcoes.intervaloEstabilidadeMs != null ? opcoes.intervaloEstabilidadeMs : 2000;
    this._intervaloPollingMs = opcoes.intervaloPollingMs != null ? opcoes.intervaloPollingMs : 120000;
    this._hashesConhecidos = opcoes.hashesConhecidos || new Set();
    this._sleep = opcoes.sleepImpl || sleepPadrao;
    this._fs = opcoes.fsImpl || fs;
    this._onErro = typeof opcoes.onErro === 'function' ? opcoes.onErro : () => {};
    // Logger injetavel (Fase F3.6) - observabilidade, NUNCA obrigatorio:
    // se nao for passado, usa um logger no-op e o detector funciona
    // exatamente como antes (comportamento/testes da F3.3 preservados).
    this._logger = opcoes.logger || LOGGER_NULO;

    this._ultimoProcessado = new Map(); // caminho -> {tamanho, mtimeMs} do ultimo conteudo ja avaliado (estavel ou nao)
    this._avaliacoesEmAndamento = new Map(); // caminho -> Promise, evita avaliar o mesmo arquivo em paralelo
    this._reavaliacaoPendente = new Set(); // caminhos que receberam novo evento de watcher ENQUANTO ja havia uma avaliacao em andamento - precisam ser reavaliados de novo ao final (senao um evento que chegou durante a janela de estabilidade seria perdido silenciosamente)
    this._watcher = null;
    this._timerPolling = null;
    // Comeca "ativo" (nao parado) deliberadamente: varrerAgora() e
    // _avaliarArquivo() sao primitivas testaveis e utilizaveis de forma
    // independente, SEM exigir iniciar() primeiro (ver F3.3 item 15 - o
    // conjunto principal de testes deve ser deterministico, chamando
    // varrerAgora() diretamente). `_parado` so vira true explicitamente
    // apos parar() ser chamado, e existe para impedir que callbacks do
    // watcher/timer JA AGENDADOS emitam apos a parada - nao para bloquear
    // chamadas diretas e deliberadas a varrerAgora().
    this._parado = false;
  }

  /**
   * Inicia o detector: varre o diretorio imediatamente (startup scan),
   * liga o watcher nativo e agenda o polling periodico de seguranca.
   */
  iniciar() {
    this._parado = false;
    this._logger.info('detector', 'DETECTOR_INICIADO', { diretorio: this._diretorio });
    this.varrerAgora();

    try {
      this._watcher = this._fs.watch(this._diretorio, { persistent: true }, (_eventType, nomeArquivo) => {
        if (this._parado || !nomeArquivo) return;
        const caminho = path.join(this._diretorio, nomeArquivo);
        this._agendarAvaliacao(caminho);
      });
      this._watcher.on('error', (erro) => {
        this._logger.warn('detector', 'ERRO_WATCHER', { erro: erro && erro.message });
        this._onErro({ tipo: 'ERRO_WATCHER', erro });
      });
    } catch (erro) {
      this._logger.warn('detector', 'DIRETORIO_INDISPONIVEL_PARA_WATCHER', { erro: erro && erro.message });
      this._onErro({ tipo: 'DIRETORIO_INDISPONIVEL_PARA_WATCHER', erro });
    }

    this._timerPolling = setInterval(() => {
      if (this._parado) return;
      this.varrerAgora();
    }, this._intervaloPollingMs);
    if (this._timerPolling.unref) this._timerPolling.unref();
  }

  /**
   * Para o detector: fecha o watcher, cancela o timer de polling, e evita
   * que avaliacoes ja agendadas (aguardando o intervalo de estabilidade)
   * emitam `onArquivoPronto` apos a parada.
   */
  parar() {
    this._parado = true;
    if (this._watcher) {
      try { this._watcher.close(); } catch (e) { /* ja pode estar fechado */ }
      this._watcher = null;
    }
    if (this._timerPolling) {
      clearInterval(this._timerPolling);
      this._timerPolling = null;
    }
    this._logger.info('detector', 'DETECTOR_PARADO', {});
  }

  /**
   * Relista o diretorio agora e avalia (estabilidade + hash + dedupe)
   * todos os arquivos candidatos encontrados. Usado tanto pelo startup
   * scan quanto pelo polling periodico - e a operacao usada pelo
   * mecanismo de garantia de corretude (independe do watcher).
   * @returns {Promise<Array<Object>>} resultados de avaliacao (uma entrada
   *   por arquivo candidato encontrado nesta varredura)
   */
  async varrerAgora() {
    let nomes;
    try {
      nomes = await new Promise((resolve, reject) => {
        this._fs.readdir(this._diretorio, (erro, lista) => (erro ? reject(erro) : resolve(lista)));
      });
    } catch (erro) {
      this._onErro({ tipo: 'DIRETORIO_INDISPONIVEL', erro });
      return [];
    }

    const candidatos = nomes.filter((nome) => nomeEhCandidatoValido(nome, this._extensoesAceitas));
    const resultados = [];
    for (const nome of candidatos) {
      const caminho = path.join(this._diretorio, nome);
      // eslint-disable-next-line no-await-in-loop
      resultados.push(await this._avaliarArquivo(caminho));
    }
    return resultados;
  }

  /**
   * Agenda a avaliacao de um caminho (chamado pelo watcher). Se ja houver
   * uma avaliacao em andamento para o mesmo caminho, NAO inicia uma
   * segunda em paralelo (evita hashes concorrentes do mesmo arquivo) -
   * mas marca uma reavaliacao pendente, para nao perder silenciosamente
   * um evento que chegou durante a janela de estabilidade da avaliacao
   * atual (ex.: arquivo ainda mudando quando a 1a avaliacao concluiu que
   * estava instavel - sem essa reavaliacao, o estado final estavel do
   * arquivo nunca seria detectado se nenhum evento de watcher posterior
   * chegasse).
   */
  _agendarAvaliacao(caminho) {
    if (this._avaliacoesEmAndamento.has(caminho)) {
      this._reavaliacaoPendente.add(caminho);
      return;
    }
    const promessa = this._avaliarArquivo(caminho).finally(() => {
      this._avaliacoesEmAndamento.delete(caminho);
      if (this._reavaliacaoPendente.delete(caminho) && !this._parado) {
        this._agendarAvaliacao(caminho);
      }
    });
    this._avaliacoesEmAndamento.set(caminho, promessa);
  }

  /**
   * Nucleo testavel do detector: avalia UM caminho - checa extensao,
   * otimiza contra reprocessamento se tamanho/mtime ja processados sem
   * mudanca, exige duas observacoes identicas (tamanho+mtime) separadas
   * por `intervaloEstabilidadeMs` antes de considerar estavel, calcula
   * SHA-256 e verifica dedupe por conteudo antes de chamar
   * `onArquivoPronto`.
   *
   * @param {string} caminho
   * @returns {Promise<{ignorado?:string, emitido?:boolean, erro?:Error, sha256?:string}>}
   */
  async _avaliarArquivo(caminho) {
    const nomeArquivo = path.basename(caminho);
    if (!nomeEhCandidatoValido(nomeArquivo, this._extensoesAceitas)) {
      return { ignorado: 'EXTENSAO_NAO_SUPORTADA' };
    }

    const primeira = await statSeguro(caminho, this._fs);
    if (primeira.erro) {
      this._logger.warn('detector', 'ARQUIVO_INACESSIVEL', { caminho, erro: primeira.erro && primeira.erro.message });
      this._onErro({ tipo: 'ARQUIVO_INACESSIVEL', caminho, erro: primeira.erro });
      return { ignorado: 'ARQUIVO_INACESSIVEL' };
    }

    const anterior = this._ultimoProcessado.get(caminho);
    if (anterior && anterior.tamanho === primeira.stat.size && anterior.mtimeMs === primeira.stat.mtimeMs) {
      return { ignorado: 'SEM_MUDANCA_DESDE_ULTIMA_AVALIACAO' };
    }

    await this._sleep(this._intervaloEstabilidadeMs);
    if (this._parado) return { ignorado: 'DETECTOR_PARADO_DURANTE_ESPERA' };

    const segunda = await statSeguro(caminho, this._fs);
    if (segunda.erro) {
      this._onErro({ tipo: 'ARQUIVO_SUMIU_DURANTE_ESPERA', caminho, erro: segunda.erro });
      return { ignorado: 'ARQUIVO_SUMIU_DURANTE_ESPERA' };
    }

    if (segunda.stat.size !== primeira.stat.size || segunda.stat.mtimeMs !== primeira.stat.mtimeMs) {
      // Arquivo ainda sendo escrito - nao registra `_ultimoProcessado` (a
      // proxima avaliacao, seja por watcher ou polling, comeca do zero).
      this._logger.debug('detector', 'ARQUIVO_INSTAVEL', { caminho: caminho });
      return { ignorado: 'ARQUIVO_INSTAVEL_AINDA_SENDO_ESCRITO' };
    }

    this._ultimoProcessado.set(caminho, { tamanho: segunda.stat.size, mtimeMs: segunda.stat.mtimeMs });

    let sha256;
    try {
      sha256 = await calcularSha256(caminho, this._fs);
    } catch (erro) {
      this._onErro({ tipo: 'FALHA_AO_CALCULAR_HASH', caminho, erro });
      return { ignorado: 'FALHA_AO_CALCULAR_HASH', erro };
    }

    if (this._parado) return { ignorado: 'DETECTOR_PARADO_ANTES_DE_EMITIR' };

    if (this._hashesConhecidos.has(sha256)) {
      return { ignorado: 'CONTEUDO_JA_VISTO', sha256 };
    }
    this._hashesConhecidos.add(sha256);

    const info = {
      caminho,
      nomeArquivo,
      tamanho: segunda.stat.size,
      mtime: segunda.stat.mtime,
      sha256,
    };
    this._logger.info('detector', 'ARQUIVO_PRONTO', { caminho, nomeArquivo, tamanho: info.tamanho, sha256Arquivo: sha256 });
    await this._onArquivoPronto(info);
    return { emitido: true, sha256 };
  }
}

module.exports = { DetectorExportsNex, EXTENSOES_PADRAO };
