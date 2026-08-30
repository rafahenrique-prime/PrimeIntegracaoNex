'use strict';

/**
 * Logger estruturado local (Fase F3.6) - observabilidade da integracao,
 * NUNCA parte do caminho financeiro. Escreve JSON Lines (1 objeto JSON
 * por linha, append-only) em arquivo diario, com sanitizacao defensiva
 * de secret/HMAC/credenciais e minimizacao de PII.
 *
 * PRINCIPIO CENTRAL: o logger e SEMPRE best-effort. Uma falha de escrita
 * (disco cheio, permissao negada, arquivo bloqueado) NUNCA deve derrubar
 * o pipeline financeiro - todo metodo publico captura suas proprias
 * excecoes internamente e nunca lanca para o chamador.
 *
 * NAO faz HTTP, NAO acessa Base44/.nx1/NEX, NAO envia telemetria externa,
 * NAO cria dashboard. E puramente um arquivo local .jsonl.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NIVEIS = Object.freeze({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 });

/**
 * Chaves consideradas SECRET - nunca devem aparecer em log, sob nenhuma
 * circunstancia. Comparacao case-insensitive, por substring do nome da
 * chave (ex.: "X-Nex-Signature" contem "signature").
 */
const CHAVES_SECRETAS = [
  'secret', 'hmac', 'signature', 'authorization', 'bearer', 'cookie',
  'senha', 'password', 'credential', 'token',
];

/**
 * Chaves consideradas PII (dado pessoal) - minimizadas por padrao, mesmo
 * nao sendo credenciais. Nome completo do cliente, telefone, documento,
 * endereco e e-mail nunca sao necessarios para diagnosticar o pipeline
 * (eventId/nexCustomerCode/nexTransactionId ja bastam).
 */
const CHAVES_PII = [
  'customername', 'nome', 'telefone', 'celular', 'cpf', 'cpfcnpj', 'cnpj',
  'endereco', 'email', 'e-mail',
];

const TODAS_AS_CHAVES_SENSIVEIS = [...CHAVES_SECRETAS, ...CHAVES_PII];

const CAMPO_REDIGIDO = '[REDACTED]';

/**
 * Chaves cujo VALOR nunca deve ser persistido por inteiro (mesmo sem
 * conter uma chave sensivel dentro dele) - o payload de dominio bruto e
 * potencialmente grande e pode conter PII/campos financeiros detalhados
 * que nao agregam valor de diagnostico. Por padrao, `payload` inteiro e
 * substituido por um resumo (chaves presentes), nunca omitido
 * silenciosamente - o chamador sempre sabe que havia um payload.
 */
const CHAVES_DE_PAYLOAD_BRUTO = ['payload'];

function ehChaveSensivel(chave) {
  const chaveMinuscula = String(chave).toLowerCase();
  return TODAS_AS_CHAVES_SENSIVEIS.some((sensivel) => chaveMinuscula.includes(sensivel));
}

/**
 * Sanitiza recursivamente um valor: objetos/arrays sao percorridos,
 * chaves sensiveis (secret/HMAC/PII) tem seu valor substituido por
 * "[REDACTED]", `payload` bruto e reduzido a um resumo (lista de chaves).
 * Protegido contra referencias circulares via WeakSet. Nunca lanca -
 * qualquer erro inesperado durante a sanitizacao retorna um marcador
 * seguro em vez de propagar a excecao.
 *
 * @param {*} valor
 * @param {WeakSet} [visitados]
 * @returns {*}
 */
function sanitizar(valor, visitados) {
  try {
    const vistos = visitados || new WeakSet();
    if (valor === null || typeof valor !== 'object') return valor;
    if (vistos.has(valor)) return '[REF_CIRCULAR]';
    vistos.add(valor);

    if (Array.isArray(valor)) {
      return valor.map((item) => sanitizar(item, vistos));
    }

    const resultado = {};
    for (const [chave, valorOriginal] of Object.entries(valor)) {
      if (CHAVES_DE_PAYLOAD_BRUTO.includes(chave.toLowerCase()) && valorOriginal && typeof valorOriginal === 'object') {
        resultado[chave] = { _resumo: 'payload bruto omitido do log (ver eventId/contentHash)', _chaves: Object.keys(valorOriginal) };
        continue;
      }
      if (ehChaveSensivel(chave)) {
        resultado[chave] = CAMPO_REDIGIDO;
        continue;
      }
      resultado[chave] = sanitizar(valorOriginal, vistos);
    }
    return resultado;
  } catch (erroDeSanitizacao) {
    return '[ERRO_AO_SANITIZAR]';
  }
}

/**
 * Serializa um Error de forma util e segura: name/message (ja passada
 * pelo sanitizador, caso a mensagem contenha algo sensivel por acidente)
 * e code, quando existir. Stack SOMENTE quando `incluirStack` for true
 * (tipicamente so em DEBUG) - nunca por padrao em INFO/WARN/ERROR.
 */
function serializarErro(erro, incluirStack) {
  if (!erro) return null;
  const base = {
    name: erro.name || 'Error',
    message: sanitizarMensagemDeErro(String(erro.message || '')),
  };
  if (erro.code != null) base.code = erro.code;
  if (incluirStack && erro.stack) base.stack = erro.stack;
  return base;
}

function sanitizarMensagemDeErro(mensagem) {
  // sanitizar() so atua sobre objetos - para uma string solta, aplicamos
  // uma checagem simples de substring por seguranca (defesa em profundidade;
  // nenhuma mensagem de erro do projeto deveria conter segredo, mas o
  // logger nao confia nisso).
  const minuscula = String(mensagem).toLowerCase();
  if (TODAS_AS_CHAVES_SENSIVEIS.some((s) => minuscula.includes(s))) {
    return '[MENSAGEM_COM_POSSIVEL_DADO_SENSIVEL_REDIGIDA]';
  }
  return mensagem;
}

/** Logger no-op - usado como default quando nenhum logger e injetado, para nunca tornar observabilidade obrigatoria para o pipeline funcionar. */
const LOGGER_NULO = Object.freeze({
  debug() {}, info() {}, warn() {}, error() {}, aplicarRetencao() { return { removidos: [] }; },
});

class LoggerEstruturado {
  /**
   * @param {Object} opcoes
   * @param {string} opcoes.diretorio - onde os arquivos .jsonl sao escritos.
   * @param {string} [opcoes.prefixoArquivo] - default 'prime-integracao-nex'.
   * @param {string} [opcoes.nivelMinimo] - 'DEBUG'|'INFO'|'WARN'|'ERROR', default 'INFO'.
   * @param {number} [opcoes.retencaoDias] - default 30.
   * @param {string} [opcoes.runId] - identificador LOCAL desta execucao/processo
   *   (nunca confundir com correlationId remoto do Base44) - default
   *   gerado via crypto.randomUUID().
   * @param {Function} [opcoes.nowImpl] - `() => Date`, injetavel para
   *   testes deterministicos de rotacao/retencao.
   * @param {Object} [opcoes.fsImpl] - injetavel para testes (default: `fs`).
   * @param {Function} [opcoes.onErroInterno] - `(erro) => void`, chamado
   *   quando a PROPRIA escrita do log falha (disco cheio, permissao,
   *   etc.) - nunca lanca, apenas notifica. Default: no-op silencioso.
   */
  constructor(opcoes) {
    const opc = opcoes || {};
    if (!opc.diretorio) throw new Error('LoggerEstruturado: opcoes.diretorio obrigatorio.');

    this._diretorio = opc.diretorio;
    this._prefixoArquivo = opc.prefixoArquivo || 'prime-integracao-nex';
    this._nivelMinimo = NIVEIS[opc.nivelMinimo] != null ? NIVEIS[opc.nivelMinimo] : NIVEIS.INFO;
    this._retencaoDias = opc.retencaoDias != null ? opc.retencaoDias : 30;
    this._runId = opc.runId || crypto.randomUUID();
    this._now = opc.nowImpl || (() => new Date());
    this._fs = opc.fsImpl || fs;
    this._onErroInterno = typeof opc.onErroInterno === 'function' ? opc.onErroInterno : () => {};
  }

  get runId() {
    return this._runId;
  }

  _nomeArquivoDoDia(data) {
    const dataIso = data.toISOString().slice(0, 10); // YYYY-MM-DD (UTC, deterministico)
    return `${this._prefixoArquivo}-${dataIso}.jsonl`;
  }

  _caminhoArquivoAtual() {
    return path.join(this._diretorio, this._nomeArquivoDoDia(this._now()));
  }

  /**
   * Metodo central - normalmente usado via debug()/info()/warn()/error().
   * Nunca lanca: falha de escrita e reportada via onErroInterno e engolida.
   *
   * @param {string} nivel - 'DEBUG'|'INFO'|'WARN'|'ERROR'
   * @param {string} component - ex.: 'detector', 'orquestrador', 'processadorOutbox'
   * @param {string} event - nome estavel do evento (ex.: 'ARQUIVO_PRONTO')
   * @param {Object} [dados] - campos adicionais (sanitizados antes de gravar)
   */
  registrar(nivel, component, event, dados) {
    try {
      const nivelNum = NIVEIS[nivel];
      if (nivelNum == null || nivelNum < this._nivelMinimo) return;

      const linha = {
        timestamp: this._now().toISOString(),
        level: nivel,
        component,
        event,
        runId: this._runId,
        ...sanitizar(dados || {}),
      };

      const texto = JSON.stringify(linha) + '\n';

      try {
        if (!this._fs.existsSync(this._diretorio)) {
          this._fs.mkdirSync(this._diretorio, { recursive: true });
        }
        this._fs.appendFileSync(this._caminhoArquivoAtual(), texto);
      } catch (erroDeEscrita) {
        this._onErroInterno(erroDeEscrita);
      }
    } catch (erroInesperado) {
      // Nunca deixa o logger propagar erro para o chamador (pipeline
      // financeiro nunca pode quebrar por causa de observabilidade).
      try { this._onErroInterno(erroInesperado); } catch (e) { /* best-effort mesmo aqui */ }
    }
  }

  debug(component, event, dados) { this.registrar('DEBUG', component, event, dados); }
  info(component, event, dados) { this.registrar('INFO', component, event, dados); }
  warn(component, event, dados) { this.registrar('WARN', component, event, dados); }

  /**
   * @param {string} component
   * @param {string} event
   * @param {Object} [dados] - pode incluir `dados.erro` (um Error) - sera
   *   serializado via serializarErro (sem stack, a menos que
   *   `dados.incluirStack === true`).
   */
  error(component, event, dados) {
    const d = dados || {};
    const { erro, incluirStack, ...resto } = d;
    this.registrar('ERROR', component, event, {
      ...resto,
      erro: erro ? serializarErro(erro, incluirStack === true) : undefined,
    });
  }

  /**
   * Remove arquivos de log ANTIGOS reconhecidamente pertencentes a este
   * logger (mesmo prefixo, extensao .jsonl, data valida no nome) e mais
   * velhos que `retencaoDias`. NUNCA remove arquivo que nao bata
   * EXATAMENTE com o padrao `${prefixo}-YYYY-MM-DD.jsonl` - qualquer
   * outro arquivo no diretorio (nome estranho, prefixo diferente, sem
   * data valida) e ignorado, mesmo que pareça um log.
   *
   * @returns {{removidos: Array<string>}}
   */
  aplicarRetencao() {
    const removidos = [];
    try {
      if (!this._fs.existsSync(this._diretorio)) return { removidos };
      const nomes = this._fs.readdirSync(this._diretorio);
      const prefixoEscapado = this._prefixoArquivo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const padrao = new RegExp(`^${prefixoEscapado}-(\\d{4})-(\\d{2})-(\\d{2})\\.jsonl$`);
      const agora = this._now();
      const limiteMs = this._retencaoDias * 24 * 60 * 60 * 1000;

      for (const nome of nomes) {
        const m = nome.match(padrao);
        if (!m) continue; // nunca toca em arquivos que nao batem exatamente com o padrao

        const [, ano, mes, dia] = m;
        const dataDoArquivo = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia)));
        if (Number.isNaN(dataDoArquivo.getTime())) continue; // data invalida no nome (ex.: mes 13) -> nunca remove

        const idadeMs = agora.getTime() - dataDoArquivo.getTime();
        if (idadeMs > limiteMs) {
          try {
            this._fs.unlinkSync(path.join(this._diretorio, nome));
            removidos.push(nome);
          } catch (erroAoRemover) {
            this._onErroInterno(erroAoRemover);
          }
        }
      }
    } catch (erroInesperado) {
      this._onErroInterno(erroInesperado);
    }
    return { removidos };
  }
}

module.exports = {
  LoggerEstruturado,
  LOGGER_NULO,
  sanitizar,
  serializarErro,
  NIVEIS,
  CHAVES_SECRETAS,
  CHAVES_PII,
};
