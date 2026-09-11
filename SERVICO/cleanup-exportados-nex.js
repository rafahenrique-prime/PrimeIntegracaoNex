'use strict';

/**
 * Cleanup administrativo de EXPORTADOS (HARDENING 1A) - avalia retencao de
 * arquivos `vendas-auto-*.xls` gerados pelo piloto recorrente
 * (PrimeNexVendasExport). Responsabilidade UNICA: decidir se um arquivo
 * pode ser movido para EXPORT_ARCHIVE (apos MOVE_AFTER_DAYS) ou apagado do
 * EXPORT_ARCHIVE (apos DELETE_ARCHIVE_AFTER_DAYS) - NUNCA executa a
 * mutacao de filesystem em si (isso e responsabilidade do chamador,
 * SCRIPTS/cleanup-exportados-nex.js, que hoje so implementa --dry-run).
 *
 * NUNCA escreve em checkpoint/outbox - usa apenas os metodos de LEITURA
 * ja existentes (CheckpointSqlite.buscarEvento, OutboxLocal.buscarPorEventId).
 *
 * ESCOPO V1 (deliberadamente reduzido - reduz blast radius):
 *   - Age SOMENTE em arquivos cujo nome bate EXATAMENTE com
 *     `vendas-auto-YYYYMMDD-HHMMSS.xls` (nomeEhVendasAutoValido). Qualquer
 *     outro nome (Exportar-*.xls, clientes*.xls, extrato*.xls, arquivos
 *     manuais/legados) e classificado IGNORE sem nenhuma outra avaliacao.
 *   - Usa exatamente o MESMO pipeline de parsing/identidade/classificacao
 *     ja homologado (leitor-export-vendas -> normalizar-venda-nex ->
 *     identidade-transacao-nex -> classificador-evento-venda-nex ->
 *     gerador-evento-venda-nex -> calcularContentHashEvento), para nunca
 *     reimplementar ou divergir da logica real de producao usada por
 *     SERVICO/orquestrador-integracao-nex.js.
 *
 * REGRA FAIL-CLOSED (Secao 2 da ordem HARDENING 1A): um arquivo so e
 * elegivel para WOULD_ARCHIVE se TODAS as transacoes "relevantes" nele
 * (aquelas cujo eventType esta na allowlist de envio automatico - as
 * unicas que algum dia entram em checkpoint/outbox) tiverem checkpoint
 * PRESENTE, com o MESMO contentHash calculado agora, com `result` em
 * RESULTADOS_CONFIRMADOS, E (quando ainda presente na outbox) em estado
 * TERMINAL (nunca PENDING/RETRY/SENDING). Qualquer ambiguidade (parsing
 * falho, identidade invalida, checkpoint ausente/divergente/nao-confirmado,
 * outbox nao-terminal) resulta em SKIP_UNSAFE - nunca WOULD_ARCHIVE.
 */

const path = require('path');
const crypto = require('crypto');

const { lerExportVendas } = require(path.join(__dirname, 'leitor-export-vendas'));
const { normalizarVendaNex } = require(path.join(__dirname, '..', 'SRC', 'normalizar-venda-nex'));
const { gerarChaveIdentidadeTransacaoNex } = require(path.join(__dirname, '..', 'SRC', 'identidade-transacao-nex'));
const { classificarVenda } = require(path.join(__dirname, '..', 'SRC', 'classificador-evento-venda-nex'));
const { gerarEventosVenda } = require(path.join(__dirname, '..', 'SRC', 'gerador-evento-venda-nex'));
const { calcularContentHashEvento } = require(path.join(__dirname, 'repositorio-eventos-http'));
const { identificarTipoExport, TIPOS_EXPORT, EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO } = require(path.join(__dirname, 'orquestrador-integracao-nex'));
const { RESULTADOS_CONFIRMADOS } = require(path.join(__dirname, 'checkpoint-sqlite'));

const PADRAO_VENDAS_AUTO = /^vendas-auto-\d{8}-\d{6}\.xls$/;

/** Cleanup V2 Fase 0 - mesmo formato hex ja usado por calcularSha256DeBuffer
 * abaixo (crypto.createHash('sha256').digest('hex')): 64 caracteres
 * hexadecimais, case-insensitive. */
const REGEX_SHA256_HEX = /^[0-9a-f]{64}$/i;

/** @param {string} nome @returns {boolean} */
function nomeEhVendasAutoValido(nome) {
  return typeof nome === 'string' && PADRAO_VENDAS_AUTO.test(nome);
}

function sleepPadrao(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calcularSha256DeBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function idadeEmDias(mtimeMs, agoraMs) {
  return (agoraMs - mtimeMs) / (24 * 60 * 60 * 1000);
}

/**
 * Extrai, do buffer de um export de Vendas, a lista de transacoes
 * "relevantes" (eventType na allowlist de envio automatico) com seu
 * eventId + contentHash ja calculados pelo MESMO caminho de codigo do
 * orquestrador real. Nunca consulta checkpoint/outbox - so parsing puro.
 *
 * @returns {{status:'OK', transacoes:Array<{eventId:string, contentHash:string, nexTransactionId:string}>, totalLinhas:number} | {status:'ERRO', motivo:string}}
 */
function extrairTransacoesRelevantes(buffer, nomeArquivo) {
  const tipoExport = identificarTipoExport(buffer);
  if (tipoExport !== TIPOS_EXPORT.VENDAS) {
    return { status: 'ERRO', motivo: 'TIPO_EXPORT_INESPERADO (esperado VENDAS, nome sugere vendas-auto mas conteudo nao bate)' };
  }

  let linhas;
  try {
    ({ linhas } = lerExportVendas(buffer, { nomeArquivo }));
  } catch (erro) {
    return { status: 'ERRO', motivo: `FALHA_LEITURA: ${erro.message}` };
  }

  const transacoes = [];
  for (const linha of linhas) {
    let vendaNormalizada;
    try {
      vendaNormalizada = normalizarVendaNex(linha);
    } catch (erro) {
      return { status: 'ERRO', motivo: `FALHA_NORMALIZACAO: ${erro.message}` };
    }

    const identidade = gerarChaveIdentidadeTransacaoNex(vendaNormalizada);
    if (identidade.status === 'INVALID_IDENTITY') {
      // Fail-closed: uma transacao sem identidade valida nunca pode ser
      // provada segura - nao ha como saber se ela geraria (ou nao) um
      // evento financeiro em outra circunstancia. Nao ignoramos
      // silenciosamente.
      return { status: 'ERRO', motivo: `IDENTIDADE_INVALIDA: ${identidade.motivo} (nexTransactionId=${vendaNormalizada && vendaNormalizada.nexTransactionId})` };
    }

    const classificacao = classificarVenda(vendaNormalizada);
    const eventos = gerarEventosVenda(vendaNormalizada, identidade.identityKey, null, classificacao);

    for (const evento of eventos) {
      if (evento.status === 'UNCLASSIFIED') continue; // nunca teve eventId, nunca foi enviado - nao relevante para o gate
      if (!EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO.has(evento.eventType)) continue; // nunca chega a checkpoint/outbox
      transacoes.push({
        eventId: evento.eventId,
        contentHash: calcularContentHashEvento(evento),
        nexTransactionId: evento.nexTransactionId,
      });
    }
  }

  return { status: 'OK', transacoes, totalLinhas: linhas.length };
}

/**
 * Avalia o estado de protecao (checkpoint + outbox) de UMA transacao
 * relevante. Somente leitura - nunca escreve.
 * @param {{eventId:string, contentHash:string}} transacao
 * @param {Object} checkpoint - instancia de CheckpointSqlite (leitura)
 * @param {Object} outbox - instancia de OutboxLocal (leitura)
 * @returns {Promise<{protegido:boolean, motivo?:string, outboxStatus?:string}>}
 */
async function avaliarProtecaoTransacao(transacao, checkpoint, outbox) {
  const itemOutbox = await outbox.buscarPorEventId(transacao.eventId);
  if (itemOutbox && ['PENDING', 'RETRY', 'SENDING'].includes(itemOutbox.status)) {
    return { protegido: false, motivo: 'OUTBOX_NAO_TERMINAL', outboxStatus: itemOutbox.status };
  }

  const linhaCheckpoint = await checkpoint.buscarEvento(transacao.eventId);
  if (!linhaCheckpoint) {
    return { protegido: false, motivo: 'CHECKPOINT_AUSENTE' };
  }
  if (linhaCheckpoint.contentHash !== transacao.contentHash) {
    return { protegido: false, motivo: 'CHECKPOINT_HASH_DIVERGENTE' };
  }
  if (!RESULTADOS_CONFIRMADOS.has(linhaCheckpoint.result)) {
    return { protegido: false, motivo: 'CHECKPOINT_RESULTADO_NAO_CONFIRMADO', outboxStatus: itemOutbox ? itemOutbox.status : null };
  }

  return { protegido: true, outboxStatus: itemOutbox ? itemOutbox.status : null };
}

/**
 * Avalia UM arquivo candidato de EXPORTADOS/ para retencao.
 *
 * @param {Object} opcoes
 * @param {string} opcoes.caminho - caminho completo do arquivo
 * @param {string} opcoes.nomeArquivo - basename
 * @param {Object} opcoes.fsImpl - injetavel (default `fs`); precisa de
 *   `statSync` e `readFileSync`
 * @param {Object} opcoes.checkpoint - instancia de CheckpointSqlite (leitura)
 * @param {Object} opcoes.outbox - instancia de OutboxLocal (leitura)
 * @param {number} opcoes.agoraMs - `Date.now()` injetavel
 * @param {number} [opcoes.moveAfterDays] - default 7
 * @param {number} [opcoes.intervaloEstabilidadeMs] - default 500
 * @param {Function} [opcoes.sleepImpl] - injetavel
 * @returns {Promise<Object>} entrada de resultado (ver shape no README do modulo)
 */
async function avaliarArquivoVendasAuto(opcoes) {
  const opc = opcoes || {};
  const fsImpl = opc.fsImpl;
  const moveAfterDays = opc.moveAfterDays != null ? opc.moveAfterDays : 7;
  const intervaloEstabilidadeMs = opc.intervaloEstabilidadeMs != null ? opc.intervaloEstabilidadeMs : 500;
  const sleep = opc.sleepImpl || sleepPadrao;

  const base = { filename: opc.nomeArquivo, caminho: opc.caminho };

  if (!nomeEhVendasAutoValido(opc.nomeArquivo)) {
    return Object.assign({}, base, { action: 'IGNORE', reason: 'FORA_DO_ESCOPO_V1 (nome nao bate com vendas-auto-YYYYMMDD-HHMMSS.xls)' });
  }

  let statInicial;
  try {
    statInicial = fsImpl.statSync(opc.caminho);
  } catch (erro) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `ARQUIVO_INACESSIVEL: ${erro.message}` });
  }

  const size = statInicial.size;
  const age = idadeEmDias(statInicial.mtimeMs, opc.agoraMs);

  if (age < moveAfterDays) {
    return Object.assign({}, base, { action: 'KEEP', reason: 'IDADE_INSUFICIENTE', size, age });
  }

  // Estabilidade: um vendas-auto-* com idade >= moveAfterDays nunca deveria
  // estar sendo escrito agora, mas verificamos mesmo assim (defesa em
  // profundidade, mesmo padrao ja usado pelo detector).
  await sleep(intervaloEstabilidadeMs);
  let statFinal;
  try {
    statFinal = fsImpl.statSync(opc.caminho);
  } catch (erro) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `ARQUIVO_SUMIU_DURANTE_ESPERA: ${erro.message}`, size, age });
  }
  if (statFinal.size !== statInicial.size || statFinal.mtimeMs !== statInicial.mtimeMs) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'ARQUIVO_INSTAVEL_SENDO_ESCRITO', size, age });
  }

  let buffer;
  try {
    buffer = fsImpl.readFileSync(opc.caminho);
  } catch (erro) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `FALHA_LEITURA: ${erro.message}`, size, age });
  }

  const sha256 = calcularSha256DeBuffer(buffer);
  const extraido = extrairTransacoesRelevantes(buffer, opc.nomeArquivo);
  if (extraido.status === 'ERRO') {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: extraido.motivo, size, age, sha256 });
  }

  const resumoStatus = {};
  let algumNaoProtegido = false;
  let motivoBloqueio = null;

  for (const transacao of extraido.transacoes) {
    // eslint-disable-next-line no-await-in-loop
    const protecao = await avaliarProtecaoTransacao(transacao, opc.checkpoint, opc.outbox);
    const chaveResumo = protecao.protegido ? 'PROTEGIDO' : protecao.motivo;
    resumoStatus[chaveResumo] = (resumoStatus[chaveResumo] || 0) + 1;
    if (!protecao.protegido && !algumNaoProtegido) {
      algumNaoProtegido = true;
      motivoBloqueio = protecao.motivo;
    }
  }

  if (algumNaoProtegido) {
    return Object.assign({}, base, {
      action: 'SKIP_UNSAFE',
      reason: motivoBloqueio,
      size,
      age,
      sha256,
      transactionCount: extraido.transacoes.length,
      checkpointStatusSummary: resumoStatus,
    });
  }

  return Object.assign({}, base, {
    action: 'WOULD_ARCHIVE',
    reason: extraido.transacoes.length === 0 ? 'SEM_TRANSACAO_FINANCEIRA_RELEVANTE' : 'TODAS_TRANSACOES_PROTEGIDAS',
    size,
    age,
    sha256,
    transactionCount: extraido.transacoes.length,
    checkpointStatusSummary: resumoStatus,
  });
}

/**
 * Avalia UM arquivo dentro de EXPORT_ARCHIVE para possivel delete
 * definitivo. NUNCA usa mtime como fonte de `archivedAt` (o move pode
 * preservar timestamps antigos do arquivo original) - exige um manifesto
 * persistente (`{ [nomeArquivo]: {archivedAt, sha256} }`) como unica fonte
 * de verdade para a idade DENTRO do archive E para uma futura revalidacao
 * de integridade (Cleanup V2 Fase 0 - o proprio delete real, que
 * revalidaria este sha256 contra o arquivo no disco, NAO e implementado
 * nesta fase; aqui so preparamos o schema e a validacao estrutural).
 *
 * Nenhum manifesto real ou legado existe nesta instalacao (verificado
 * explicitamente antes desta mudanca) - este e um formato NOVO, nao uma
 * migracao de dado real. Mesmo assim, por seguranca, uma entrada no
 * formato ANTIGO hipotetico (string ISO pura, sem sha256) e lida sem
 * lancar excecao - mas NUNCA tratada como completa (sempre
 * MANIFEST_SHA256_AUSENTE, fail-closed), pois sem hash nao ha como provar
 * integridade.
 *
 * @param {Object} opcoes
 * @param {string} opcoes.nomeArquivo
 * @param {Object} opcoes.manifest - `{ [nomeArquivo]: {archivedAt:string, sha256:string} }`
 *   (uma entrada em formato de string ISO pura tambem e aceita para
 *   leitura, mas sempre resulta em MANIFEST_SHA256_AUSENTE)
 * @param {number} opcoes.agoraMs
 * @param {number} [opcoes.deleteAfterDays] - default 30
 * @returns {Object}
 */
function avaliarArquivoArchive(opcoes) {
  const opc = opcoes || {};
  const deleteAfterDays = opc.deleteAfterDays != null ? opc.deleteAfterDays : 30;
  const base = { filename: opc.nomeArquivo };

  if (!nomeEhVendasAutoValido(opc.nomeArquivo)) {
    return Object.assign({}, base, { action: 'IGNORE', reason: 'FORA_DO_ESCOPO_V1' });
  }

  const entrada = opc.manifest && opc.manifest[opc.nomeArquivo];
  if (!entrada) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_ARCHIVED_AT_AUSENTE (nunca apagar sem saber quando foi arquivado)' });
  }

  // Formato legado hipotetico (string ISO pura, sem sha256) - lido sem
  // lancar, nunca tratado como completo (ver doc acima).
  const archivedAtIso = typeof entrada === 'string' ? entrada : entrada.archivedAt;
  const sha256 = typeof entrada === 'string' ? undefined : entrada.sha256;

  if (!archivedAtIso || typeof archivedAtIso !== 'string') {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_ARCHIVED_AT_AUSENTE (nunca apagar sem saber quando foi arquivado)' });
  }

  const archivedAtMs = Date.parse(archivedAtIso);
  if (Number.isNaN(archivedAtMs)) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_ARCHIVED_AT_INVALIDO' });
  }

  if (!sha256 || typeof sha256 !== 'string' || sha256.trim() === '') {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_SHA256_AUSENTE (sem hash nao ha como revalidar integridade antes de um delete real futuro)' });
  }
  if (!REGEX_SHA256_HEX.test(sha256)) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_SHA256_INVALIDO (esperado hex sha256 de 64 caracteres)' });
  }

  const age = idadeEmDias(archivedAtMs, opc.agoraMs);
  if (age < deleteAfterDays) {
    return Object.assign({}, base, { action: 'KEEP', reason: 'IDADE_NO_ARCHIVE_INSUFICIENTE', age, sha256 });
  }
  return Object.assign({}, base, { action: 'WOULD_DELETE', reason: 'IDADE_NO_ARCHIVE_EXCEDIDA', age, sha256 });
}

module.exports = {
  PADRAO_VENDAS_AUTO,
  REGEX_SHA256_HEX,
  nomeEhVendasAutoValido,
  extrairTransacoesRelevantes,
  avaliarProtecaoTransacao,
  avaliarArquivoVendasAuto,
  avaliarArquivoArchive,
  calcularSha256DeBuffer,
};
