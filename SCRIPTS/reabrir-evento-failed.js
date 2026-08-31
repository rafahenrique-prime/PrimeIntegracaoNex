'use strict';

/**
 * CLI dedicado (F5.5-FIX2/FIX3) para reabrir manualmente UM evento
 * terminal FAILED na outbox, via OutboxLocal.reabrirFailed() (SERVICO/
 * outbox-local.js). Ferramenta operacional pontual, auditavel, FORA do
 * loop automatico (nunca chamada pelo detector/runner/processador).
 *
 * TRAVA DESTA PRIMEIRA VERSAO (homologacao do secret corrigido):
 * aceita SOMENTE o eventId "SALE_PAID:NEX:15770" - qualquer outro
 * eventId falha fechado, propositalmente, para eliminar o risco de
 * atingir #15768/#15769 (ou qualquer outro FAILED futuro) por engano
 * nesta primeira prova real. Generalizar exige uma decisao consciente
 * futura, fora desta tarefa.
 *
 * NUNCA: imprime payload, imprime secret, faz HTTP diretamente, altera
 * checkpoint diretamente, reabre mais de um item por execucao.
 *
 * A logica central (executarReabertura) e exportada separadamente de
 * main() para ser testavel offline sem stdin real e sem tocar o banco
 * de producao - os testes injetam dbPath (arquivo temporario) e
 * confirmar (funcao fake, sem readline real).
 *
 * Uso (CLI real):
 *   node SCRIPTS/reabrir-evento-failed.js --eventId "SALE_PAID:NEX:15770" --motivo "..." [--operador "..."]
 */

const path = require('path');
const readline = require('readline');
const { OutboxLocal, ESTADOS } = require(path.join(__dirname, '..', 'SERVICO', 'outbox-local'));

const EVENT_ID_PERMITIDO = 'SALE_PAID:NEX:15770';
const DB_PATH_PADRAO = path.join(__dirname, '..', 'OUTPUT', 'integracao-nex.db');
const CONFIRMACAO_ESPERADA = 'REABRIR';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const chave = argv[i];
    if (chave === '--eventId') { args.eventId = argv[i + 1]; i += 1; }
    else if (chave === '--motivo') { args.motivo = argv[i + 1]; i += 1; }
    else if (chave === '--operador') { args.operador = argv[i + 1]; i += 1; }
  }
  return args;
}

function resumoSemPayload(item) {
  if (!item) return null;
  return {
    eventId: item.eventId,
    status: item.status,
    tentativas: item.tentativas,
    httpStatus: item.httpStatus,
    result: item.result,
    correlationId: item.correlationId,
    contentHash: item.contentHash,
    updatedAt: item.updatedAt,
  };
}

function perguntarViaStdin(texto) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(texto, (resposta) => {
      rl.close();
      resolve(resposta);
    });
  });
}

/**
 * Logica central, testavel isoladamente (sem stdin real, sem tocar o
 * banco de producao). Retorna um relatorio estruturado em vez de
 * imprimir diretamente - main() (CLI real) e responsavel por imprimir.
 *
 * @param {{eventId:string, motivo:string, operador?:string, dbPath?:string,
 *   eventIdPermitido?:string, confirmar?:(texto:string)=>Promise<string>,
 *   log?:(...args:any[])=>void}} opcoes
 * @returns {Promise<{sucesso:boolean, motivoFalha?:string, antes?:Object,
 *   depois?:Object, cancelado?:boolean}>}
 */
async function executarReabertura(opcoes) {
  const opc = opcoes || {};
  const dbPath = opc.dbPath || DB_PATH_PADRAO;
  const eventIdPermitido = opc.eventIdPermitido || EVENT_ID_PERMITIDO;
  const confirmar = opc.confirmar || perguntarViaStdin;
  const log = opc.log || (() => {});

  if (!opc.eventId) {
    return { sucesso: false, motivoFalha: 'EVENT_ID_OBRIGATORIO' };
  }
  if (!opc.motivo || !String(opc.motivo).trim()) {
    return { sucesso: false, motivoFalha: 'MOTIVO_OBRIGATORIO' };
  }
  if (opc.eventId !== eventIdPermitido) {
    return { sucesso: false, motivoFalha: 'EVENT_ID_NAO_PERMITIDO' };
  }

  const outbox = new OutboxLocal(dbPath);
  try {
    const antes = await outbox.buscarPorEventId(opc.eventId);
    if (!antes) {
      return { sucesso: false, motivoFalha: 'EVENT_ID_NAO_ENCONTRADO' };
    }
    if (antes.status !== ESTADOS.FAILED) {
      return { sucesso: false, motivoFalha: 'STATUS_NAO_FAILED', antes: resumoSemPayload(antes) };
    }

    log('BEFORE (sem payload):', JSON.stringify(resumoSemPayload(antes), null, 2));

    const resposta = await confirmar(`Para confirmar a reabertura de "${opc.eventId}", digite exatamente ${CONFIRMACAO_ESPERADA}: `);
    if (resposta !== CONFIRMACAO_ESPERADA) {
      return { sucesso: false, cancelado: true, antes: resumoSemPayload(antes) };
    }

    const depois = await outbox.reabrirFailed(opc.eventId, { motivo: opc.motivo, operador: opc.operador });
    log('AFTER (sem payload):', JSON.stringify(resumoSemPayload(depois), null, 2));

    return { sucesso: true, antes: resumoSemPayload(antes), depois: resumoSemPayload(depois) };
  } finally {
    outbox.fechar();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultado = await executarReabertura({
    eventId: args.eventId,
    motivo: args.motivo,
    operador: args.operador,
    log: (...a) => console.log(...a),
  });

  if (resultado.motivoFalha === 'EVENT_ID_OBRIGATORIO') {
    console.error('ERRO: --eventId obrigatorio. Abortando. Nenhuma mutacao realizada.');
    process.exitCode = 1;
  } else if (resultado.motivoFalha === 'MOTIVO_OBRIGATORIO') {
    console.error('ERRO: --motivo obrigatorio (nao vazio). Abortando. Nenhuma mutacao realizada.');
    process.exitCode = 1;
  } else if (resultado.motivoFalha === 'EVENT_ID_NAO_PERMITIDO') {
    console.error(
      `ERRO: esta versao do CLI aceita SOMENTE o eventId "${EVENT_ID_PERMITIDO}" ` +
        `(trava de homologacao do F5.5-FIX3). Recebido: "${args.eventId}". Abortando. Nenhuma mutacao realizada.`,
    );
    process.exitCode = 1;
  } else if (resultado.motivoFalha === 'EVENT_ID_NAO_ENCONTRADO') {
    console.error(`ERRO: eventId "${args.eventId}" nao encontrado na outbox. Abortando.`);
    process.exitCode = 1;
  } else if (resultado.motivoFalha === 'STATUS_NAO_FAILED') {
    console.error(
      `ERRO: eventId "${args.eventId}" nao esta em FAILED (status atual: "${resultado.antes.status}"). ` +
        'Abortando. Nenhuma mutacao realizada.',
    );
    process.exitCode = 1;
  } else if (resultado.cancelado) {
    console.log('Confirmacao nao corresponde. Operacao CANCELADA. Nenhuma mutacao realizada.');
  } else if (resultado.sucesso) {
    console.log(`Evento "${args.eventId}" reaberto para PENDING. O processador ja em execucao (se o servico estiver RUNNING) reclamara este item no proximo ciclo.`);
  }
}

if (require.main === module) {
  main().catch((erro) => {
    console.error('Erro inesperado:', erro && erro.message);
    process.exitCode = 1;
  });
}

module.exports = { executarReabertura, EVENT_ID_PERMITIDO, CONFIRMACAO_ESPERADA };
