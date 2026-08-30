'use strict';

/**
 * Orquestrador local do pipeline automatico (Fase F3.4).
 *
 * Responsabilidade: COORDENAR os modulos ja existentes e homologados -
 * NUNCA reimplementar logica de dominio. Recebe um arquivo (caminho ja
 * confirmado ESTAVEL pelo detector - Fase F3.3), identifica o tipo de
 * export pelo SHAPE dos cabecalhos (nao pelo nome do arquivo), executa o
 * pipeline correto (Readers -> Normalizacao -> CustomerResolver ->
 * Classificacao/Geracao de Eventos -> Gate, todos das Fases A-E.1, ja
 * homologadas), consulta o checkpoint local (Fase F3.1) e enfileira na
 * outbox (Fase F3.2) os eventos novos/mudados.
 *
 * NAO faz HTTP. NAO chama SERVICO/repositorio-eventos-http.js::enviarEvento.
 * NAO usa secret real. NAO acessa Base44/.nx1/NEX. Termina no momento em
 * que o evento esta persistido na outbox como PENDING - o envio real e
 * responsabilidade de uma fase futura (F3.5 em diante), que consumira a
 * outbox via claimNext()/enviarEvento(), nao deste modulo.
 *
 * EVENTTYPES LIBERADOS PARA ENVIO AUTOMATICO FUTURO: apenas os 4 ja
 * homologados via E2E real (SALE_PAID, DEBT_CREATED, SALE_PARTIALLY_PAID,
 * DEBT_PAYMENT). SALE_CANCELLED pode ser GERADO/CLASSIFICADO localmente
 * (a logica de dominio ja existente em SRC/gerador-evento-venda-nex.js nao
 * e alterada nem bloqueada), mas este orquestrador delibaradamente NAO o
 * enfileira na outbox - fica visivel apenas no relatorio, ate ser
 * homologado manualmente como os demais.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const { lerExportVendas } = require(path.join(__dirname, 'leitor-export-vendas'));
const { lerExportClientes } = require(path.join(__dirname, 'leitor-export-clientes'));
const { lerExportTransacoesCliente } = require(path.join(__dirname, 'leitor-export-transacoes-cliente'));
const { normalizarVendaNex } = require(path.join(__dirname, '..', 'SRC', 'normalizar-venda-nex'));
const { normalizarClienteNex } = require(path.join(__dirname, '..', 'SRC', 'normalizar-cliente-nex'));
const { normalizarTransacaoClienteNex } = require(path.join(__dirname, '..', 'SRC', 'normalizar-transacao-cliente-nex'));
const { criarIndiceClientes } = require(path.join(__dirname, '..', 'SRC', 'customer-resolver-nex'));
const { gerarEventosDeVenda, gerarEventoDeTransacaoCliente } = require(path.join(__dirname, 'gerador-eventos-nex'));
const { avaliarGateEnvio } = require(path.join(__dirname, '..', 'SRC', 'gate-envio-evento-nex'));
const { construirEventoParaEnvio } = require(path.join(__dirname, 'repositorio-eventos-http'));
const { ConflitoDeConteudoError } = require(path.join(__dirname, 'outbox-local'));
const { LOGGER_NULO } = require(path.join(__dirname, 'logger-estruturado'));

const TIPOS_EXPORT = Object.freeze({
  CLIENTES: 'CLIENTES',
  VENDAS: 'VENDAS',
  EXTRATO_INDIVIDUAL: 'EXTRATO_INDIVIDUAL',
  DESCONHECIDO: 'DESCONHECIDO',
});

/**
 * EventTypes cujo enfileiramento na outbox e permitido hoje - os 4 ja
 * homologados via E2E real (#15751/#15756/#15704/#15758). Qualquer outro
 * eventType classificado (hoje, so SALE_CANCELLED) e gerado/reportado mas
 * NUNCA enfileirado, ate passar pelo mesmo ritual de homologacao manual.
 */
const EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO = new Set([
  'SALE_PAID',
  'DEBT_CREATED',
  'SALE_PARTIALLY_PAID',
  'DEBT_PAYMENT',
]);

/**
 * Identifica o tipo de export pelo CONJUNTO DE CABECALHOS da primeira
 * linha da planilha - nunca pelo nome do arquivo. As 3 fontes oficiais
 * tem colunas mutuamente exclusivas e suficientes para distinguir sem
 * ambiguidade (auditado nas Fases A/EXPORT-FIRST):
 *   Clientes            -> tem "Código" E "Nome"
 *   Vendas -> Historico  -> tem "Número" E "Tipo" (sem "No.Tran")
 *   Extrato individual   -> tem "No.Tran" E "Tipo" (sem "Número")
 * Nunca lanca excecao - arquivo ilegivel ou sem essas colunas volta como
 * DESCONHECIDO, para o chamador decidir o que fazer (nunca inventar parser).
 *
 * @param {Buffer} buffer
 * @returns {string} um de TIPOS_EXPORT
 */
function identificarTipoExport(buffer) {
  if (!buffer || !buffer.length) return TIPOS_EXPORT.DESCONHECIDO;

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    return TIPOS_EXPORT.DESCONHECIDO;
  }

  const sheetName = workbook.SheetNames && workbook.SheetNames[0];
  if (!sheetName) return TIPOS_EXPORT.DESCONHECIDO;

  const ws = workbook.Sheets[sheetName];
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  if (!linhas.length) return TIPOS_EXPORT.DESCONHECIDO;

  const headers = linhas[0];
  if (headers.includes('Código') && headers.includes('Nome')) return TIPOS_EXPORT.CLIENTES;
  if (headers.includes('Número') && headers.includes('Tipo')) return TIPOS_EXPORT.VENDAS;
  if (headers.includes('No.Tran') && headers.includes('Tipo')) return TIPOS_EXPORT.EXTRATO_INDIVIDUAL;
  return TIPOS_EXPORT.DESCONHECIDO;
}

function chaveDeOrdenacao(registroNormalizado) {
  const ocorridoEm = registroNormalizado.occurredAt || '';
  const id = String(registroNormalizado.nexTransactionId || '');
  return `${ocorridoEm}__${id}`;
}

function ordenarDeterministicamente(lista) {
  return [...lista].sort((a, b) => chaveDeOrdenacao(a).localeCompare(chaveDeOrdenacao(b)));
}

function relatorioVazio(caminho, tipoExport) {
  return {
    arquivo: caminho,
    tipoExport,
    totalLinhas: 0,
    eventosGerados: [],
    readyToSend: [],
    reviewRequired: [],
    bloqueadosParaAutomacao: [],
    enfileirados: [],
    ignoradosCheckpoint: [],
    ignoradosAntiReplay: [],
    conflitos: [],
    erros: [],
    indiceAtualizado: false,
    erroArquivo: null,
  };
}

class OrquestradorIntegracaoNex {
  /**
   * @param {Object} opcoes
   * @param {Object} [opcoes.checkpoint] - instancia de CheckpointSqlite
   *   (SERVICO/checkpoint-sqlite.js). Obrigatoria quando `dryRun` nao for
   *   usado no processamento.
   * @param {Object} [opcoes.outbox] - instancia de OutboxLocal
   *   (SERVICO/outbox-local.js). Obrigatoria quando `dryRun` nao for usado.
   * @param {string} [opcoes.origin] - origin usado apenas para compor o
   *   payload do evento (mesmo campo ja usado por
   *   SERVICO/repositorio-eventos-http.js::construirCorpoRequisicao em
   *   fases futuras) - default 'prime-store-udi-nex-01'.
   */
  constructor(opcoes) {
    const opc = opcoes || {};
    this._checkpoint = opc.checkpoint || null;
    this._outbox = opc.outbox || null;
    this._origin = opc.origin || 'prime-store-udi-nex-01';
    // Indice de clientes (Fase C) mantido em MEMORIA durante a vida deste
    // orquestrador - nao ha persistencia/recovery dele ainda nesta F3.4
    // (documentado: se o processo reiniciar, o indice se perde e precisa
    // ser reconstruido processando novamente o export de Clientes mais
    // recente antes de processar Vendas - revisao de persistencia deste
    // contexto fica para antes da F4, conforme planejamento).
    this._indiceClientes = criarIndiceClientes([]);
    // Logger injetavel (Fase F3.6) - observabilidade, NUNCA obrigatorio:
    // sem logger passado, usa no-op e o orquestrador funciona exatamente
    // como antes (comportamento/testes da F3.4 preservados).
    this._logger = opc.logger || LOGGER_NULO;
    // Ponto de extensao ADITIVO para a Fase F3.7 (anti-replay de
    // bootstrap) - por padrao NULL, o que preserva 100% do comportamento
    // ja homologado nas Fases F3.4/F3.5/F3.6 (nenhum teste anterior passa
    // isso, entao nada muda para eles). Quando fornecido, e chamado com o
    // evento ja construido no formato HTTP (mesmo shape de
    // construirEventoParaEnvio) ANTES do checkpoint/outbox - se retornar
    // false, o evento e contabilizado em `ignoradosAntiReplay` e NUNCA
    // chega ao checkpoint/outbox. O modulo de bootstrap
    // (SERVICO/bootstrap-integracao-nex.js) e quem decide a logica de
    // anti-replay em si - o orquestrador so oferece o gancho, sem conhecer
    // baseline/cutoff/estado de bootstrap.
    this._filtroElegibilidade = typeof opc.filtroElegibilidade === 'function' ? opc.filtroElegibilidade : null;
  }

  /**
   * Processa um arquivo de export ja confirmado ESTAVEL pelo detector
   * (Fase F3.3). Nunca lanca excecao para erros esperados de conteudo -
   * erros estruturais do arquivo inteiro (leitura invalida, contexto de
   * cliente ausente para o extrato individual) sao reportados em
   * `erroArquivo`; erros por linha individual sao reportados em `erros`,
   * sem interromper o processamento das demais linhas do mesmo arquivo.
   *
   * @param {string} caminho - caminho do arquivo (info.caminho do detector)
   * @param {Object} [opcoes]
   * @param {boolean} [opcoes.dryRun] - se true, executa todo o pipeline e
   *   monta o relatorio, mas NUNCA consulta/altera checkpoint, NUNCA
   *   enfileira na outbox, NUNCA faz HTTP. Equivalente a "simular", NAO e
   *   o --dry-run operacional completo da F3.7 (que tratara bootstrap/
   *   corte historico - fora do escopo deste modulo).
   * @param {{nexCustomerCode:string, customerName?:string}} [opcoes.contextoClienteExtrato] -
   *   OBRIGATORIO quando o arquivo for um extrato individual de transacoes
   *   - o extrato nao repete nome/codigo do cliente por linha (ver
   *   SRC/gerador-evento-transacao-cliente-nex.js) - NUNCA inferido.
   * @returns {Promise<Object>} relatorio estruturado do processamento
   */
  async processarArquivo(caminho, opcoes) {
    const inicio = Date.now();
    this._logger.info('orquestrador', 'PROCESSAMENTO_INICIADO', { arquivo: caminho });
    const relatorio = await this._processarArquivoInterno(caminho, opcoes);
    const durationMs = Date.now() - inicio;

    if (relatorio.erroArquivo) {
      this._logger.warn('orquestrador', 'PROCESSAMENTO_FALHOU', {
        arquivo: caminho, tipoExport: relatorio.tipoExport, erroArquivo: relatorio.erroArquivo, durationMs,
      });
    } else {
      this._logger.info('orquestrador', 'PROCESSAMENTO_CONCLUIDO', {
        arquivo: caminho,
        tipoExport: relatorio.tipoExport,
        totalLinhas: relatorio.totalLinhas,
        readyToSend: relatorio.readyToSend.length,
        reviewRequired: relatorio.reviewRequired.length,
        bloqueadosParaAutomacao: relatorio.bloqueadosParaAutomacao.length,
        enfileirados: relatorio.enfileirados.length,
        ignoradosCheckpoint: relatorio.ignoradosCheckpoint.length,
        conflitos: relatorio.conflitos.length,
        erros: relatorio.erros.length,
        durationMs,
      });
    }
    return relatorio;
  }

  async _processarArquivoInterno(caminho, opcoes) {
    const opc = opcoes || {};
    const dryRun = opc.dryRun === true;

    let buffer;
    try {
      buffer = fs.readFileSync(caminho);
    } catch (erro) {
      const relatorio = relatorioVazio(caminho, TIPOS_EXPORT.DESCONHECIDO);
      relatorio.erroArquivo = { tipo: 'ARQUIVO_ILEGIVEL', mensagem: erro.message };
      return relatorio;
    }

    const tipoExport = identificarTipoExport(buffer);
    const relatorio = relatorioVazio(caminho, tipoExport);

    if (tipoExport === TIPOS_EXPORT.DESCONHECIDO) {
      relatorio.erroArquivo = { tipo: 'ARQUIVO_NAO_RECONHECIDO', mensagem: 'Cabecalhos nao correspondem a nenhum export oficial conhecido (Clientes/Vendas/Extrato individual).' };
      return relatorio;
    }

    if (tipoExport === TIPOS_EXPORT.CLIENTES) {
      return this._processarClientes(buffer, relatorio);
    }
    if (tipoExport === TIPOS_EXPORT.VENDAS) {
      return this._processarVendas(buffer, relatorio, dryRun);
    }
    if (tipoExport === TIPOS_EXPORT.EXTRATO_INDIVIDUAL) {
      return this._processarExtratoIndividual(buffer, relatorio, dryRun, opc.contextoClienteExtrato);
    }
    return relatorio;
  }

  _processarClientes(buffer, relatorio) {
    let linhas;
    try {
      const nomeArquivo = path.basename(relatorio.arquivo);
      ({ linhas } = lerExportClientes(buffer, { nomeArquivo }));
    } catch (erro) {
      relatorio.erroArquivo = { tipo: erro.codigo || 'ERRO_LEITURA', mensagem: erro.message };
      return relatorio;
    }

    relatorio.totalLinhas = linhas.length;
    const clientesNormalizados = linhas.map(normalizarClienteNex);
    this._indiceClientes = criarIndiceClientes(clientesNormalizados);
    relatorio.indiceAtualizado = true;
    return relatorio;
  }

  async _processarVendas(buffer, relatorio, dryRun) {
    let linhas;
    try {
      const nomeArquivo = path.basename(relatorio.arquivo);
      ({ linhas } = lerExportVendas(buffer, { nomeArquivo }));
    } catch (erro) {
      relatorio.erroArquivo = { tipo: erro.codigo || 'ERRO_LEITURA', mensagem: erro.message };
      return relatorio;
    }

    relatorio.totalLinhas = linhas.length;

    const vendasNormalizadas = [];
    for (const linha of linhas) {
      try {
        vendasNormalizadas.push(normalizarVendaNex(linha));
      } catch (erro) {
        relatorio.erros.push({ tipo: 'FALHA_AO_NORMALIZAR_LINHA', linha, mensagem: erro.message });
      }
    }

    const vendasOrdenadas = ordenarDeterministicamente(vendasNormalizadas);

    for (const venda of vendasOrdenadas) {
      let entradas;
      try {
        entradas = gerarEventosDeVenda(venda, this._indiceClientes);
      } catch (erro) {
        relatorio.erros.push({ tipo: 'FALHA_AO_GERAR_EVENTO', nexTransactionId: venda.nexTransactionId, mensagem: erro.message });
        continue;
      }

      for (const entrada of entradas) {
        // eslint-disable-next-line no-await-in-loop
        await this._processarEntradaClassificada(entrada, relatorio, dryRun);
      }
    }

    return relatorio;
  }

  async _processarExtratoIndividual(buffer, relatorio, dryRun, contextoClienteExtrato) {
    if (!contextoClienteExtrato || !contextoClienteExtrato.nexCustomerCode) {
      relatorio.erroArquivo = {
        tipo: 'CONTEXTO_CLIENTE_AUSENTE',
        mensagem:
          'Extrato individual de transacoes exige contextoClienteExtrato.nexCustomerCode explicito ' +
          '(o extrato nao repete o cliente por linha) - nunca inferido por valor/data. Arquivo NAO processado.',
      };
      return relatorio;
    }

    let linhas;
    try {
      const nomeArquivo = path.basename(relatorio.arquivo);
      ({ linhas } = lerExportTransacoesCliente(buffer, { nomeArquivo }));
    } catch (erro) {
      relatorio.erroArquivo = { tipo: erro.codigo || 'ERRO_LEITURA', mensagem: erro.message };
      return relatorio;
    }

    relatorio.totalLinhas = linhas.length;

    const transacoesNormalizadas = [];
    for (const linha of linhas) {
      try {
        transacoesNormalizadas.push(normalizarTransacaoClienteNex(linha));
      } catch (erro) {
        relatorio.erros.push({ tipo: 'FALHA_AO_NORMALIZAR_LINHA', linha, mensagem: erro.message });
      }
    }

    const transacoesOrdenadas = ordenarDeterministicamente(transacoesNormalizadas);

    for (const transacao of transacoesOrdenadas) {
      let entrada;
      try {
        entrada = gerarEventoDeTransacaoCliente(transacao, contextoClienteExtrato);
      } catch (erro) {
        relatorio.erros.push({ tipo: 'FALHA_AO_GERAR_EVENTO', nexTransactionId: transacao.nexTransactionId, mensagem: erro.message });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await this._processarEntradaClassificada(entrada, relatorio, dryRun);
    }

    return relatorio;
  }

  /**
   * Nucleo comum a Vendas e Extrato individual: avalia o gate, decide se
   * a entrada e elegivel para a outbox (tem identidade real E o eventType
   * esta na allowlist de automacao), consulta o checkpoint (se nao for
   * dryRun) e enfileira. Nunca lanca - erros de conflito de conteudo sao
   * capturados e reportados, preservando o processamento das demais
   * entradas do arquivo.
   */
  async _processarEntradaClassificada(entrada, relatorio, dryRun) {
    const resultadoGate = avaliarGateEnvio(entrada);
    relatorio.eventosGerados.push(resultadoGate);

    if (resultadoGate.status === 'READY_TO_SEND') {
      relatorio.readyToSend.push(resultadoGate);
      this._logger.debug('orquestrador', 'EVENTO_GERADO', { eventId: entrada.eventId, eventType: entrada.eventType, nexTransactionId: entrada.nexTransactionId, sourceStatus: resultadoGate.status });
    } else {
      relatorio.reviewRequired.push(resultadoGate);
      this._logger.debug('orquestrador', 'EVENTO_REVIEW_REQUIRED', { eventId: entrada.eventId || null, eventType: entrada.eventType || null, nexTransactionId: entrada.nexTransactionId, motivo: resultadoGate.reason });
    }

    // Sem eventId real (UNCLASSIFIED/INVALID_IDENTITY) - nunca pode virar
    // envio financeiro, e nao tem identidade para entrar na outbox.
    if (!entrada.eventId) return;

    if (!EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO.has(entrada.eventType)) {
      relatorio.bloqueadosParaAutomacao.push(resultadoGate);
      this._logger.debug('orquestrador', 'EVENTO_BLOQUEADO_AUTOMACAO', { eventId: entrada.eventId, eventType: entrada.eventType });
      return;
    }

    const eventoParaEnvio = construirEventoParaEnvio(resultadoGate);

    if (this._filtroElegibilidade && this._filtroElegibilidade(eventoParaEnvio) === false) {
      relatorio.ignoradosAntiReplay.push(eventoParaEnvio.eventId);
      this._logger.debug('orquestrador', 'EVENTO_IGNORADO_ANTI_REPLAY', { eventId: eventoParaEnvio.eventId });
      return;
    }

    if (dryRun) {
      // Simulacao: NAO consulta checkpoint, NAO toca a outbox.
      return;
    }

    if (this._checkpoint) {
      const jaConfirmado = await this._checkpoint.eventoJaConfirmado(eventoParaEnvio.eventId, eventoParaEnvio.contentHash);
      if (jaConfirmado) {
        relatorio.ignoradosCheckpoint.push(eventoParaEnvio.eventId);
        this._logger.debug('orquestrador', 'EVENTO_JA_CONFIRMADO', { eventId: eventoParaEnvio.eventId, contentHash: eventoParaEnvio.contentHash });
        return;
      }
    }

    if (!this._outbox) return;

    try {
      const resultadoEnqueue = await this._outbox.enqueue(eventoParaEnvio);
      if (resultadoEnqueue.criado) {
        relatorio.enfileirados.push(eventoParaEnvio.eventId);
        this._logger.debug('orquestrador', 'OUTBOX_ENFILEIRADO', { eventId: eventoParaEnvio.eventId, eventType: eventoParaEnvio.eventType, contentHash: eventoParaEnvio.contentHash, sourceStatus: eventoParaEnvio.sourceStatus });
      }
      // criado:false com motivo JA_ENFILEIRADO_MESMO_HASH e um no-op
      // idempotente esperado (reprocessamento de arquivo ja visto) - nao
      // e erro, simplesmente nao aparece de novo em `enfileirados`.
    } catch (erro) {
      if (erro instanceof ConflitoDeConteudoError) {
        relatorio.conflitos.push({ eventId: eventoParaEnvio.eventId, mensagem: erro.message });
        this._logger.warn('orquestrador', 'OUTBOX_CONFLITO_HASH', { eventId: eventoParaEnvio.eventId });
      } else {
        relatorio.erros.push({ tipo: 'FALHA_AO_ENFILEIRAR', eventId: eventoParaEnvio.eventId, mensagem: erro.message });
        this._logger.error('orquestrador', 'FALHA_AO_ENFILEIRAR', { eventId: eventoParaEnvio.eventId, erro });
      }
    }
  }
}

module.exports = {
  OrquestradorIntegracaoNex,
  identificarTipoExport,
  TIPOS_EXPORT,
  EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO,
};
