'use strict';

/**
 * REPARO LOCAL ADMINISTRATIVO (Fase F5.7.1) - ferramenta de reconciliacao
 * outbox <-> checkpoint, executada SOB DEMANDA (nunca automaticamente pelo
 * detector/runner/processador/startup). Nao e "auto-repair silencioso":
 * por padrao roda em modo SOMENTE LEITURA (dry-run), e qualquer gravacao
 * exige o operador passar --aplicar e depois confirmar digitando
 * exatamente "RECONCILIAR".
 *
 * ORIGEM (auditoria F5.7): a outbox e o checkpoint sao gravados em duas
 * transacoes SQLite independentes (mesma conexao fisica de arquivo, WAL,
 * mas conexoes DatabaseSync distintas - SERVICO/outbox-local.js e
 * SERVICO/checkpoint-sqlite.js). A outbox e SEMPRE gravada primeiro; o
 * checkpoint depois (SERVICO/processador-outbox-nex.js::
 * _registrarNoCheckpoint). Um crash entre essas duas escritas pode deixar
 * o checkpoint ausente ou incompleto, mesmo com a outbox corretamente
 * terminal. A auditoria completa (F5.7) confirmou que isso NUNCA causa
 * reenvio/duplicacao (a propria outbox.enqueue() ja bloqueia reenfileirar
 * um eventId ja existente, em qualquer status, pelo mesmo contentHash) -
 * o unico efeito real de uma divergencia e um GAP DE AUDITORIA local, nunca
 * um risco financeiro ou de replay. Por isso este reparo NUNCA precisa
 * fazer HTTP: ele so completa, localmente, um registro que o proprio
 * sistema ja sabia ter confirmado.
 *
 * CASOS REPARAVEIS (E SOMENTE ESTES):
 *   outbox.status em {SENT, REVIEW_STORED}
 *   E outbox.result em {CREATED, UNCHANGED, UPDATED, REVIEW_STORED}
 *   E (checkpoint ausente OU checkpoint incompleto de forma compativel
 *      com a janela de crash: mesmo contentHash, result/httpStatus/
 *      correlationId/erro todos null, nenhuma informacao contraditoria)
 *
 * NUNCA REPARAVEL AUTOMATICAMENTE (reportado, nunca corrigido aqui):
 *   - outbox REJECTED/FAILED (auditoria informativa apenas - FAILED
 *     continua exclusivamente sob SCRIPTS/reabrir-evento-failed.js, nunca
 *     misturado com esta ferramenta);
 *   - checkpoint existente com QUALQUER evidencia contraditoria (result
 *     preenchido e diferente/nao-confirmado, contentHash diferente,
 *     httpStatus/correlationId/erro ja preenchidos de forma incompativel
 *     com "incompleto") - classificado NAO_REPARAVEL_CONTRADITORIO, exige
 *     investigacao humana, NUNCA sobrescrito;
 *   - checkpoint terminal confirmado SEM outbox correspondente -
 *     classificado CRITICO_CHECKPOINT_SEM_OUTBOX; o checkpoint nao carrega
 *     payload/sourceStatus/eventType suficientes para reconstruir uma
 *     linha de outbox valida (o schema exige payload_json NOT NULL) -
 *     jamais inventado. Sempre investigacao humana.
 *
 * GARANTIA ESTRUTURAL: este arquivo NAO importa SERVICO/
 * repositorio-eventos-http.js, nao usa `fetch`, nao chama nenhuma funcao
 * de transporte HTTP, e NUNCA escreve na outbox (so le, via
 * OutboxLocal.listarPorStatus/buscarPorEventId, metodos publicos ja
 * existentes e somente leitura). A unica escrita possivel e no checkpoint,
 * e somente para os 2 casos reparaveis acima.
 *
 * LISTAGEM COMPLETA DO CHECKPOINT (F5.7.1, decisao registrada): para
 * detectar "checkpoint terminal sem outbox correspondente" e necessario
 * varrer TODOS os registros do checkpoint - SERVICO/checkpoint-sqlite.js
 * nao expoe esse metodo publicamente (por design, e essa fase optou por
 * NAO adicionar um metodo novo la). Este script abre sua PROPRIA conexao
 * `node:sqlite` sobre o MESMO arquivo .db, em modo somente-leitura
 * (`readOnly: true`), exclusivamente para esse SELECT pontual - nunca
 * escreve por essa conexao, nunca a usa para nada alem dessa varredura.
 *
 * Uso (CLI real):
 *   node SCRIPTS/reconciliar-consistencia.js                 (dry-run, so relatorio)
 *   node SCRIPTS/reconciliar-consistencia.js --aplicar        (aplica os reparaveis, com confirmacao)
 */

const path = require('path');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');
const { OutboxLocal, ESTADOS: ESTADOS_OUTBOX } = require(path.join(__dirname, '..', 'SERVICO', 'outbox-local'));
const { CheckpointSqlite, RESULTADOS_CONFIRMADOS } = require(path.join(__dirname, '..', 'SERVICO', 'checkpoint-sqlite'));

const DB_PATH_PADRAO = path.join(__dirname, '..', 'OUTPUT', 'integracao-nex.db');
const CONFIRMACAO_ESPERADA = 'RECONCILIAR';

function perguntarViaStdin(texto) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(texto, (resposta) => {
      rl.close();
      resolve(resposta);
    });
  });
}

function resumirHash(hash) {
  if (!hash) return null;
  return hash.length > 12 ? `${hash.slice(0, 12)}...` : hash;
}

/**
 * Classifica a relacao entre um item terminal (SENT/REVIEW_STORED) da
 * outbox e o que existe (ou nao) no checkpoint. Funcao pura, testavel
 * isoladamente. Nunca decide "reparar" sozinha - so classifica.
 *
 * @param {Object} item - item da outbox (ja filtrado por SENT/REVIEW_STORED
 *   com result em RESULTADOS_CONFIRMADOS pelo chamador)
 * @param {Object|null} registro - retorno de checkpoint.buscarEvento()
 * @returns {{classificacao:string, motivoContradicao?:string}}
 */
function classificarDivergencia(item, registro) {
  if (!registro) {
    return { classificacao: 'REPARAVEL_AUSENTE' };
  }
  if (registro.contentHash !== item.contentHash) {
    return { classificacao: 'NAO_REPARAVEL_CONTRADITORIO', motivoContradicao: 'CONTENT_HASH_DIVERGENTE' };
  }
  if (registro.result == null) {
    const semOutrosSinais = registro.httpStatus == null && registro.correlationId == null && registro.erro == null;
    if (semOutrosSinais) {
      return { classificacao: 'REPARAVEL_INCOMPLETO' };
    }
    return { classificacao: 'NAO_REPARAVEL_CONTRADITORIO', motivoContradicao: 'CAMPOS_PARCIAIS_INESPERADOS' };
  }
  if (RESULTADOS_CONFIRMADOS.has(registro.result) && registro.result === item.result) {
    return { classificacao: 'CONSISTENTE' };
  }
  return { classificacao: 'NAO_REPARAVEL_CONTRADITORIO', motivoContradicao: 'RESULT_DIVERGENTE_OU_NAO_CONFIRMADO' };
}

/**
 * Resumo seguro de uma divergencia para exibicao/log - nunca inclui
 * payload, secret, HMAC ou PII alem do estritamente operacional ja
 * presente nos metadados da outbox/checkpoint.
 */
function resumoSemPayload(item, registro, classificacao, extra) {
  return {
    eventId: item.eventId,
    outboxStatus: item.status,
    outboxResult: item.result,
    outboxHttpStatus: item.httpStatus,
    contentHashResumo: resumirHash(item.contentHash),
    checkpointPresente: registro != null,
    checkpointStatus: registro ? registro.status : null,
    checkpointResult: registro ? registro.result : null,
    classificacao,
    ...(extra || {}),
  };
}

/**
 * Levanta todas as divergencias outbox<->checkpoint, classificadas.
 * SOMENTE LEITURA - nao grava nada, independente de `opcoes.aplicar`.
 *
 * @param {{dbPath?:string}} opcoes
 * @returns {Promise<Array<Object>>} cada item tem os campos de
 *   resumoSemPayload() + `_itemOutbox` (interno, nunca logado/exibido,
 *   usado somente por `repararDivergencia` para copiar os campos reais).
 */
async function levantarDivergencias(outbox, checkpoint, dbLeitura) {
  const divergencias = [];

  for (const status of [ESTADOS_OUTBOX.SENT, ESTADOS_OUTBOX.REVIEW_STORED]) {
    // eslint-disable-next-line no-await-in-loop
    const itens = await outbox.listarPorStatus(status);
    for (const item of itens) {
      if (!RESULTADOS_CONFIRMADOS.has(item.result)) continue;
      // eslint-disable-next-line no-await-in-loop
      const registro = await checkpoint.buscarEvento(item.eventId);
      const { classificacao, motivoContradicao } = classificarDivergencia(item, registro);
      if (classificacao === 'CONSISTENTE') continue;
      divergencias.push({
        ...resumoSemPayload(item, registro, classificacao, motivoContradicao ? { motivoContradicao } : {}),
        _itemOutbox: item,
      });
    }
  }

  for (const status of [ESTADOS_OUTBOX.REJECTED, ESTADOS_OUTBOX.FAILED]) {
    // eslint-disable-next-line no-await-in-loop
    const itens = await outbox.listarPorStatus(status);
    for (const item of itens) {
      // eslint-disable-next-line no-await-in-loop
      const registro = await checkpoint.buscarEvento(item.eventId);
      if (!registro) {
        divergencias.push({
          ...resumoSemPayload(item, registro, 'SOMENTE_AUDITORIA'),
          _itemOutbox: item,
        });
      }
    }
  }

  const placeholders = [...RESULTADOS_CONFIRMADOS].map(() => '?').join(',');
  const linhasCheckpoint = dbLeitura
    .prepare(`SELECT event_id, content_hash, result, status FROM eventos_processados WHERE result IN (${placeholders})`)
    .all(...RESULTADOS_CONFIRMADOS);
  for (const linha of linhasCheckpoint) {
    // eslint-disable-next-line no-await-in-loop
    const itemOutbox = await outbox.buscarPorEventId(linha.event_id);
    if (!itemOutbox) {
      divergencias.push({
        eventId: linha.event_id,
        outboxStatus: null,
        outboxResult: null,
        outboxHttpStatus: null,
        contentHashResumo: resumirHash(linha.content_hash),
        checkpointPresente: true,
        checkpointStatus: linha.status,
        checkpointResult: linha.result,
        classificacao: 'CRITICO_CHECKPOINT_SEM_OUTBOX',
        _itemOutbox: null,
      });
    }
  }

  return divergencias;
}

/**
 * Aplica o reparo LOCAL (nunca HTTP) para uma unica divergencia reparavel,
 * reaproveitando exatamente o mesmo mapeamento de campos ja usado por
 * SERVICO/processador-outbox-nex.js::_registrarNoCheckpoint - nunca
 * inventa um valor que a outbox nao tinha.
 *
 * Preserva a semantica real de `tentativas` do checkpoint (F5.7 secao 9):
 *   - REPARAVEL_AUSENTE: registrarEvento() (tentativas comeca em 0) +
 *     atualizarEvento() (incrementa para 1) - identico ao que teria
 *     acontecido sem o crash.
 *   - REPARAVEL_INCOMPLETO: SOMENTE atualizarEvento() (a linha ja existe
 *     com tentativas=0 de um registrarEvento() anterior bem-sucedido;
 *     incrementa para 1) - nunca chama registrarEvento() de novo, o que
 *     duplicaria/distorceria o incremento.
 *
 * @param {Object} checkpoint - instancia de CheckpointSqlite
 * @param {Object} divergencia - um item retornado por levantarDivergencias()
 */
async function repararDivergencia(checkpoint, divergencia) {
  const item = divergencia._itemOutbox;
  if (divergencia.classificacao === 'REPARAVEL_AUSENTE') {
    await checkpoint.registrarEvento({
      eventId: item.eventId,
      identityKey: item.identityKey,
      nexTransactionId: item.nexTransactionId,
      contentHash: item.contentHash,
      status: 'PROCESSADO_LOCALMENTE',
    });
    await checkpoint.atualizarEvento(item.eventId, {
      status: 'PROCESSADO_LOCALMENTE',
      httpStatus: item.httpStatus,
      result: item.result,
      correlationId: item.correlationId,
      erro: item.ultimoErro != null ? item.ultimoErro : null,
    });
    return;
  }
  if (divergencia.classificacao === 'REPARAVEL_INCOMPLETO') {
    await checkpoint.atualizarEvento(item.eventId, {
      status: 'PROCESSADO_LOCALMENTE',
      httpStatus: item.httpStatus,
      result: item.result,
      correlationId: item.correlationId,
      erro: item.ultimoErro != null ? item.ultimoErro : null,
    });
    return;
  }
  throw new Error(`reconciliar-consistencia: classificacao "${divergencia.classificacao}" nao e reparavel - isto e um bug de chamada, nao deveria ter chegado aqui.`);
}

/**
 * Logica central, testavel isoladamente (sem stdin real, sem tocar o
 * banco de producao). SOMENTE LEITURA por padrao; grava no checkpoint
 * (nunca na outbox, nunca via HTTP) apenas quando `opcoes.aplicar===true`
 * E a confirmacao exata "RECONCILIAR" for recebida.
 *
 * @param {{dbPath?:string, aplicar?:boolean, confirmar?:(texto:string)=>Promise<string>,
 *   log?:(...args:any[])=>void}} opcoes
 * @returns {Promise<{divergencias:Array<Object>, reparaveis:Array<Object>,
 *   aplicados:Array<string>, cancelado?:boolean}>}
 */
async function executarReconciliacao(opcoes) {
  const opc = opcoes || {};
  const dbPath = opc.dbPath || DB_PATH_PADRAO;
  const aplicar = opc.aplicar === true;
  const confirmar = opc.confirmar || perguntarViaStdin;
  const log = opc.log || (() => {});

  const outbox = new OutboxLocal(dbPath);
  const checkpoint = new CheckpointSqlite(dbPath);
  const dbLeitura = new DatabaseSync(dbPath, { readOnly: true });

  try {
    const divergencias = await levantarDivergencias(outbox, checkpoint, dbLeitura);

    for (const d of divergencias) {
      // eslint-disable-next-line no-unused-vars
      const { _itemOutbox, ...paraLog } = d;
      log(JSON.stringify(paraLog));
    }

    const reparaveis = divergencias.filter(
      (d) => d.classificacao === 'REPARAVEL_AUSENTE' || d.classificacao === 'REPARAVEL_INCOMPLETO',
    );

    if (!aplicar) {
      log(`Modo dry-run (padrao): ${divergencias.length} divergencia(s) encontrada(s), ${reparaveis.length} reparavel(is) localmente. Nenhuma escrita realizada. Use --aplicar para reparar.`);
      return { divergencias, reparaveis, aplicados: [] };
    }

    if (reparaveis.length === 0) {
      log('Modo --aplicar: nenhuma divergencia reparavel encontrada. Nenhuma escrita realizada.');
      return { divergencias, reparaveis, aplicados: [] };
    }

    log(`ATENCAO: esta operacao ira gravar no checkpoint local (NUNCA na outbox, NUNCA via HTTP) para ${reparaveis.length} evento(s) ja confirmados na outbox mas ausentes/incompletos no checkpoint.`);
    const resposta = await confirmar(`Para confirmar o reparo de ${reparaveis.length} item(ns), digite exatamente ${CONFIRMACAO_ESPERADA}: `);
    if (resposta !== CONFIRMACAO_ESPERADA) {
      log('Confirmacao nao corresponde. Operacao CANCELADA. Nenhuma escrita realizada.');
      return { divergencias, reparaveis, aplicados: [], cancelado: true };
    }

    const aplicados = [];
    for (const d of reparaveis) {
      // eslint-disable-next-line no-await-in-loop
      await repararDivergencia(checkpoint, d);
      aplicados.push(d.eventId);
      log(`Reparado (checkpoint local, sem HTTP): ${d.eventId} (${d.classificacao})`);
    }

    return { divergencias, reparaveis, aplicados };
  } finally {
    outbox.fechar();
    checkpoint.fechar();
    dbLeitura.close();
  }
}

function parseArgs(argv) {
  return { aplicar: argv.includes('--aplicar') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultado = await executarReconciliacao({
    aplicar: args.aplicar,
    log: (...a) => console.log(...a),
  });

  if (resultado.cancelado) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((erro) => {
    console.error('Erro inesperado:', erro && erro.message);
    process.exitCode = 1;
  });
}

module.exports = {
  executarReconciliacao,
  classificarDivergencia,
  levantarDivergencias,
  repararDivergencia,
  CONFIRMACAO_ESPERADA,
};
