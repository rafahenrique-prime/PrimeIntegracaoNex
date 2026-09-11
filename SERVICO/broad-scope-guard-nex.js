'use strict';

/**
 * BROAD_SCOPE_GUARD (Fase HARDENING 2E) - responde SOMENTE "este export de
 * Vendas cobre pelo menos tudo que a baseline ampla ja conhecida cobre?",
 * ANTES de qualquer avaliacao financeira (DATE_GATE/anti-replay/checkpoint/
 * outbox). Nunca decide se uma transacao especifica e elegivel para envio -
 * isso continua 100% responsabilidade dos gates existentes.
 *
 * PRINCIPIO CENTRAL: um filtro/visualizacao do NEX mais restrito do que o
 * esperado (ex.: "vendas do caixa atual" em vez de "todas vendas") produz
 * um XLS tecnicamente valido, mas que OMITE silenciosamente vendas ja
 * conhecidas. Nenhum gate existente (DATE_GATE, anti-replay, checkpoint)
 * consegue perceber essa omissao - todos avaliam evento a evento, nunca o
 * arquivo como um todo. Este modulo fecha essa lacuna especifica.
 *
 * IDENTIDADE DE ESCOPO: nexTransactionId, NUNCA contentHash. Um registro
 * historico com um campo legitimamente alterado (ex. cancelamento
 * posterior) continua "presente" para fins de escopo - contentHash/
 * idempotencia financeira permanece 100% responsabilidade do checkpoint
 * (SERVICO/checkpoint-sqlite.js), nunca deste modulo.
 *
 * BASELINE V1 E IMUTAVEL: derivada uma UNICA vez do export amplo real
 * homologado (vendas-auto-20260908-092926.xls, 4893 linhas/4885
 * nexTransactionId unicos) e persistida em
 * SERVICO/baseline-transacoes-conhecidas.json. Este modulo NUNCA escreve
 * nesse arquivo - so le e valida. Atualizacao automatica da baseline a
 * partir de execucoes futuras e uma NAO-FEATURE deliberada desta fase
 * (documentado no proprio arquivo JSON) - evita que uma execucao
 * corrompida/parcial "ensine" uma baseline ruim silenciosamente.
 *
 * RISCO RESIDUAL DOCUMENTADO (nao escondido): este guard prova que "o
 * export atual nao perdeu nenhuma venda ja conhecida pela baseline" -
 * NUNCA prova que uma venda genuinamente nova, que nunca apareceu em
 * nenhum export ate agora, nao esta sendo omitida. Isso permanece um
 * risco residual real, fora do escopo desta fase.
 *
 * BASELINE E DADO PRIVADO, NUNCA COMMITADO: o repositorio e PUBLICO;
 * SERVICO/baseline-transacoes-conhecidas.json (~4885 nexTransactionId
 * reais) fica fora do Git (ver .gitignore) e so existe localmente, restaurada
 * de backup privado. O schema esperado esta documentado (com dados 100%
 * sinteticos) em SERVICO/baseline-transacoes-conhecidas.example.json. Numa
 * instalacao nova, SEM a baseline real restaurada, carregarBaseline()
 * retorna `valida:false` e avaliarEscopoAmplo() bloqueia
 * (BLOCK_BASELINE_INVALIDA) - fail-closed por design, nunca um fallback
 * permissivo. Restaurar a baseline real e' pre-requisito operacional antes
 * de liberar processamento de Vendas numa instalacao nova.
 */

const path = require('path');
const fs = require('fs');

const CAMINHO_BASELINE_PADRAO = path.join(__dirname, 'baseline-transacoes-conhecidas.json');

/** Sinais estaticos secundarios (defesa em profundidade), todos derivados
 * do MESMO export amplo real usado para gerar a baseline - nunca
 * inventados. Ver auditoria HARDENING 2E/2E.1 para a evidencia real por
 * tras de cada valor. */
const ROW_COUNT_FLOOR = 500;
const MIN_TRANSACTION_ID_LIMITE = 10;
const OLDEST_OCCURRED_AT_LIMITE = '2021-01-01T00:00:00.000';

/** As 5 ancoras exigidas na V1 - TODAS obrigatorias (nao 3-de-5): a
 * baseline principal ja prova presenca individual de cada uma, entao
 * exigir todas nao adiciona custo real e maximiza fail-closed. */
const ANCORAS_OBRIGATORIAS = Object.freeze(['3', '9929', '15704', '15751', '15756']);

const REGEX_ID_NUMERICO = /^\d+$/;
const REGEX_DATA_HORA_LOCAL_NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?$/;

function normalizarChaveComparavel(isoLocal) {
  const s = String(isoLocal).trim();
  if (!REGEX_DATA_HORA_LOCAL_NAIVE.test(s)) return null;
  return s.includes('.') ? s : `${s}.000`;
}

/**
 * Carrega e valida a baseline persistida - fail-closed em qualquer
 * anomalia estrutural (nunca tenta "consertar"/tolerar um JSON
 * parcialmente inconsistente).
 *
 * @param {Object} [opcoes]
 * @param {string} [opcoes.caminho] - default CAMINHO_BASELINE_PADRAO
 * @param {Object} [opcoes.fsImpl] - injetavel para testes (default `fs`)
 * @returns {{valida:true, ids:Set<string>, idsArray:string[], sourceFile:string, sourceSha256:string}
 *   | {valida:false, motivo:string}}
 */
function carregarBaseline(opcoes) {
  const opc = opcoes || {};
  const caminho = opc.caminho || CAMINHO_BASELINE_PADRAO;
  const fsImpl = opc.fsImpl || fs;

  let bruto;
  try {
    bruto = fsImpl.readFileSync(caminho, 'utf8');
  } catch (erro) {
    return { valida: false, motivo: 'ARQUIVO_BASELINE_AUSENTE' };
  }

  let json;
  try {
    json = JSON.parse(bruto);
  } catch (erro) {
    return { valida: false, motivo: 'JSON_BASELINE_INVALIDO' };
  }

  if (!json || typeof json !== 'object') return { valida: false, motivo: 'JSON_BASELINE_INVALIDO' };
  if (json.version !== 1) return { valida: false, motivo: 'VERSION_BASELINE_INESPERADA' };
  if (!json.sourceSha256 || typeof json.sourceSha256 !== 'string' || json.sourceSha256.trim() === '') {
    return { valida: false, motivo: 'SOURCE_SHA256_AUSENTE' };
  }
  if (!Array.isArray(json.ids) || json.ids.length === 0) {
    return { valida: false, motivo: 'IDS_BASELINE_VAZIO_OU_AUSENTE' };
  }
  if (typeof json.uniqueTransactionCount !== 'number') {
    return { valida: false, motivo: 'UNIQUE_TRANSACTION_COUNT_AUSENTE' };
  }

  const idsUnicos = new Set();
  for (const id of json.ids) {
    if (id == null || typeof id !== 'string' || id.trim() === '') {
      return { valida: false, motivo: 'ID_BASELINE_NULO_OU_VAZIO' };
    }
    if (idsUnicos.has(id)) {
      return { valida: false, motivo: 'ID_BASELINE_DUPLICADO' };
    }
    idsUnicos.add(id);
  }

  if (json.uniqueTransactionCount !== json.ids.length) {
    return { valida: false, motivo: 'UNIQUE_TRANSACTION_COUNT_DIVERGENTE_DO_ARRAY' };
  }

  return {
    valida: true,
    ids: idsUnicos,
    idsArray: json.ids,
    sourceFile: json.sourceFile || null,
    sourceSha256: json.sourceSha256,
  };
}

/**
 * Avalia se um export de Vendas ja parseado/normalizado prova cobertura
 * ampla suficiente. NUNCA le arquivo nenhum diretamente (recebe as
 * vendas ja normalizadas pelo chamador) - funcao pura, facil de testar
 * isoladamente com fixtures em memoria.
 *
 * @param {Object} opcoes
 * @param {Array<Object>} opcoes.vendasNormalizadas - saida de
 *   normalizarVendaNex(), uma por linha do export
 * @param {Object} opcoes.baseline - resultado de carregarBaseline()
 * @param {number} [opcoes.rowCountFloor] - HARDENING 2E, so para testes:
 *   sobrepoe ROW_COUNT_FLOOR (default: valor real de producao). NUNCA
 *   definido pelo runner real - so testes que precisam de fixtures
 *   pequenas para exercitar OUTRA logica (nao o proprio scope guard)
 *   sobrepoem este valor.
 * @param {number} [opcoes.minTransactionIdLimite] - idem, sobrepoe
 *   MIN_TRANSACTION_ID_LIMITE.
 * @param {string} [opcoes.oldestOccurredAtLimite] - idem, sobrepoe
 *   OLDEST_OCCURRED_AT_LIMITE.
 * @param {string[]} [opcoes.ancorasObrigatorias] - idem, sobrepoe
 *   ANCORAS_OBRIGATORIAS.
 * @returns {{resultado:'PASS'|'BLOCK_ESCOPO_INCOMPLETO'|'BLOCK_BASELINE_INVALIDA',
 *   motivo?:string, rowCount:number, uniqueIds:number, baselineIds?:number,
 *   missingBaselineCount?:number, missingBaselineSample?:string[],
 *   minTransactionId?:number|null, oldestOccurredAt?:string|null,
 *   anchorsFound?:string[], anchorsMissing?:string[]}}
 */
function avaliarEscopoAmplo(opcoes) {
  const opc = opcoes || {};
  const vendasNormalizadas = Array.isArray(opc.vendasNormalizadas) ? opc.vendasNormalizadas : [];
  const baseline = opc.baseline;
  const rowCountFloor = opc.rowCountFloor != null ? opc.rowCountFloor : ROW_COUNT_FLOOR;
  const minTransactionIdLimite = opc.minTransactionIdLimite != null ? opc.minTransactionIdLimite : MIN_TRANSACTION_ID_LIMITE;
  const oldestOccurredAtLimite = opc.oldestOccurredAtLimite != null ? normalizarChaveComparavel(opc.oldestOccurredAtLimite) || OLDEST_OCCURRED_AT_LIMITE : OLDEST_OCCURRED_AT_LIMITE;
  const ancorasObrigatorias = Array.isArray(opc.ancorasObrigatorias) ? opc.ancorasObrigatorias : ANCORAS_OBRIGATORIAS;

  if (!baseline || !baseline.valida) {
    return { resultado: 'BLOCK_BASELINE_INVALIDA', motivo: baseline ? baseline.motivo : 'BASELINE_NAO_FORNECIDA' };
  }

  const rowCount = vendasNormalizadas.length;
  const idsAtuais = new Set();
  let minTransactionId = null;
  let oldestOccurredAt = null;

  for (const vn of vendasNormalizadas) {
    const idBruto = vn && vn.nexTransactionId;
    if (idBruto != null && String(idBruto).trim() !== '') {
      const id = String(idBruto).trim();
      idsAtuais.add(id);
      if (REGEX_ID_NUMERICO.test(id)) {
        const n = Number(id);
        if (minTransactionId === null || n < minTransactionId) minTransactionId = n;
      }
    }
    const chave = vn && vn.occurredAt ? normalizarChaveComparavel(vn.occurredAt) : null;
    if (chave != null && (oldestOccurredAt == null || chave < oldestOccurredAt)) {
      oldestOccurredAt = chave;
    }
  }

  const missingBaseline = [];
  for (const id of baseline.idsArray) {
    if (!idsAtuais.has(id)) missingBaseline.push(id);
  }

  const anchorsFound = ancorasObrigatorias.filter((a) => idsAtuais.has(a));
  const anchorsMissing = ancorasObrigatorias.filter((a) => !idsAtuais.has(a));

  const oldestOk = oldestOccurredAt != null && oldestOccurredAt <= oldestOccurredAtLimite;
  const minIdOk = minTransactionId != null && minTransactionId <= minTransactionIdLimite;
  const rowCountOk = rowCount >= rowCountFloor;
  const supersetOk = missingBaseline.length === 0;
  const anchorsOk = anchorsMissing.length === 0;

  const base = {
    rowCount,
    uniqueIds: idsAtuais.size,
    baselineIds: baseline.idsArray.length,
    missingBaselineCount: missingBaseline.length,
    missingBaselineSample: missingBaseline.slice(0, 20),
    minTransactionId,
    oldestOccurredAt,
    anchorsFound,
    anchorsMissing,
  };

  if (supersetOk && rowCountOk && minIdOk && oldestOk && anchorsOk) {
    return Object.assign({ resultado: 'PASS' }, base);
  }

  const motivos = [];
  if (!supersetOk) motivos.push('BASELINE_SUPERSET_INCOMPLETO');
  if (!rowCountOk) motivos.push('ROW_COUNT_ABAIXO_DO_PISO');
  if (!minIdOk) motivos.push('MIN_TRANSACTION_ID_ACIMA_DO_LIMITE');
  if (!oldestOk) motivos.push('OLDEST_OCCURRED_AT_RECENTE_DEMAIS');
  if (!anchorsOk) motivos.push('ANCORA_AUSENTE');

  return Object.assign({ resultado: 'BLOCK_ESCOPO_INCOMPLETO', motivo: motivos.join(',') }, base);
}

module.exports = {
  carregarBaseline,
  avaliarEscopoAmplo,
  CAMINHO_BASELINE_PADRAO,
  ROW_COUNT_FLOOR,
  MIN_TRANSACTION_ID_LIMITE,
  OLDEST_OCCURRED_AT_LIMITE,
  ANCORAS_OBRIGATORIAS,
};
