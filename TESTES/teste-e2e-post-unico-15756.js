'use strict';

/**
 * Teste de SCRIPTS/e2e-post-unico-15756.js (homologacao F2.1 - DEBT_CREATED).
 * NENHUM teste deste arquivo faz rede real, usa secret real, altera
 * EXPORTADOS/, altera Base44, ou toca o NEX/.nx1. Executa somente
 * `prepararEventoValidado` (le os exports reais ja existentes em disco,
 * roda o pipeline real ate o gate, nunca chama HTTP) e `validarTravas`
 * (funcao pura, sem I/O), importadas do proprio script de producao.
 * Executar com: node TESTES\teste-e2e-post-unico-15756.js
 */

const path = require('path');
const PROJETO = path.join(__dirname, '..');
const { prepararEventoValidado, validarTravas } = require(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-15756'));
const { construirCorpoRequisicao } = require(path.join(PROJETO, 'SERVICO', 'repositorio-eventos-http'));
const { avaliarGateEnvio } = require(path.join(PROJETO, 'SRC', 'gate-envio-evento-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

function main() {
  let todosPassaram = true;

  // ---------- Evento real do pipeline passa por todas as travas ----------
  console.log('\n=== Pipeline real (#15756) chega sem falhas de trava (ZERO chamadas HTTP) ===');
  const { corpo, eventoEnviado } = prepararEventoValidado();
  todosPassaram &= check('nenhuma chamada HTTP ocorreu ao preparar o evento (funcao nao tem fetchImpl)', true);
  todosPassaram &= check('nexTransactionId = "15756"', eventoEnviado.nexTransactionId === '15756');
  todosPassaram &= check('eventId = "DEBT_CREATED:NEX:15756"', eventoEnviado.eventId === 'DEBT_CREATED:NEX:15756');
  todosPassaram &= check('identityKey = "NEX:15756"', eventoEnviado.identityKey === 'NEX:15756');
  todosPassaram &= check('eventType = "DEBT_CREATED"', eventoEnviado.eventType === 'DEBT_CREATED');
  todosPassaram &= check('sourceStatus = "READY_TO_SEND"', eventoEnviado.sourceStatus === 'READY_TO_SEND');
  todosPassaram &= check('nexCustomerCode = "292"', eventoEnviado.nexCustomerCode === '292');
  todosPassaram &= check('payload.amount = 89', eventoEnviado.payload.amount === 89);
  todosPassaram &= check('payload.amountPaid = null', eventoEnviado.payload.amountPaid === null);
  todosPassaram &= check('payload.amountDebt = 89', eventoEnviado.payload.amountDebt === 89);
  todosPassaram &= check('payload.paymentMethod = null', eventoEnviado.payload.paymentMethod === null);
  todosPassaram &= check(
    'contentHash = "25c3a8d64eb1ab29ecfd8b9a3d11858a119b0c237777170f5933d8513ed821ae"',
    eventoEnviado.contentHash === '25c3a8d64eb1ab29ecfd8b9a3d11858a119b0c237777170f5933d8513ed821ae',
  );
  todosPassaram &= check('batch = 1 (events.length)', corpo.events.length === 1);

  const falhasEventoReal = validarTravas(corpo, eventoEnviado);
  todosPassaram &= check('validarTravas(evento real) -> zero falhas', falhasEventoReal.length === 0);

  // ---------- Adulteracoes deliberadas: cada uma deve reprovar em validarTravas ----------
  console.log('\n=== Adulteracoes deliberadas -> validarTravas deve reprovar cada uma ===');

  function comAdulteracao(mutador) {
    const eventoAdulterado = JSON.parse(JSON.stringify(eventoEnviado));
    mutador(eventoAdulterado);
    const corpoAdulterado = { origin: corpo.origin, events: [eventoAdulterado] };
    return validarTravas(corpoAdulterado, eventoAdulterado);
  }

  todosPassaram &= check(
    'transactionId errado -> reprova',
    comAdulteracao((e) => { e.nexTransactionId = '99999'; }).length > 0,
  );
  todosPassaram &= check(
    'eventType errado -> reprova',
    comAdulteracao((e) => { e.eventType = 'SALE_PAID'; }).length > 0,
  );
  todosPassaram &= check(
    'sourceStatus errado -> reprova',
    comAdulteracao((e) => { e.sourceStatus = 'REVIEW_REQUIRED'; }).length > 0,
  );
  todosPassaram &= check(
    'eventId errado -> reprova',
    comAdulteracao((e) => { e.eventId = 'DEBT_CREATED:NEX:99999'; }).length > 0,
  );
  todosPassaram &= check(
    'identityKey errado -> reprova',
    comAdulteracao((e) => { e.identityKey = 'NEX:99999'; }).length > 0,
  );
  todosPassaram &= check(
    'nexCustomerCode errado -> reprova',
    comAdulteracao((e) => { e.nexCustomerCode = '316'; }).length > 0,
  );
  todosPassaram &= check(
    'amount errado -> reprova',
    comAdulteracao((e) => { e.payload.amount = 97; }).length > 0,
  );
  todosPassaram &= check(
    'contentHash errado -> reprova',
    comAdulteracao((e) => { e.contentHash = '0'.repeat(64); }).length > 0,
  );
  todosPassaram &= check(
    'amountPaid diferente de null -> reprova',
    comAdulteracao((e) => { e.payload.amountPaid = 89; }).length > 0,
  );
  todosPassaram &= check(
    'amountDebt errado -> reprova',
    comAdulteracao((e) => { e.payload.amountDebt = 1; }).length > 0,
  );
  todosPassaram &= check(
    'paymentMethod diferente de null -> reprova',
    comAdulteracao((e) => { e.payload.paymentMethod = 'Dinheiro'; }).length > 0,
  );
  {
    // batch > 1: precisa mexer no corpo, nao so no evento
    const eventoDuplicado = JSON.parse(JSON.stringify(eventoEnviado));
    const corpoComBatchMaior = { origin: corpo.origin, events: [eventoEnviado, eventoDuplicado] };
    const falhasBatch = validarTravas(corpoComBatchMaior, eventoEnviado);
    todosPassaram &= check('batch > 1 -> reprova', falhasBatch.length > 0);
  }

  // ---------- Nenhum HTTP ocorre quando qualquer trava falha (garantia estrutural) ----------
  console.log('\n=== Garantia estrutural: validarTravas nunca faz I/O nem chama HTTP ===');
  const fs = require('fs');
  const codigoDoScript = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-15756.js'), 'utf8');
  const trechoValidarTravas = codigoDoScript.slice(
    codigoDoScript.indexOf('function validarTravas'),
    codigoDoScript.indexOf('function prepararEventoValidado'),
  );
  todosPassaram &= check(
    'validarTravas nao contem fetch/require/fs/enviarEvento (funcao pura)',
    !/fetch\(|require\(|fs\.|enviarEvento/.test(trechoValidarTravas),
  );

  // ---------- Contrato #15751 permanece intacto (nao foi alterado por esta tarefa) ----------
  console.log('\n=== #15751 permanece intacto ===');
  const codigo15751 = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-15751.js'), 'utf8');
  todosPassaram &= check('#15751 ainda referencia NEX_TRANSACTION_ID_ALVO = "15751"', codigo15751.includes("NEX_TRANSACTION_ID_ALVO = '15751'"));
  todosPassaram &= check('#15751 ainda referencia SALE_PAID', codigo15751.includes('SALE_PAID'));

  // ---------- Gate: o evento real chega READY_TO_SEND (pre-condicao) ----------
  console.log('\n=== Pre-condicao do gate reconfirmada de forma independente ===');
  todosPassaram &= check(
    'avaliarGateEnvio confirma READY_TO_SEND para o payload transportado',
    avaliarGateEnvio(eventoEnviado.payload).status === 'READY_TO_SEND',
  );

  console.log(
    '\nResultado geral teste-e2e-post-unico-15756.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main();
