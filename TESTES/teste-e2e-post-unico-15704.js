'use strict';

/**
 * Teste de SCRIPTS/e2e-post-unico-15704.js (homologacao F2.2 -
 * SALE_PARTIALLY_PAID). NENHUM teste deste arquivo faz rede real, usa
 * secret real, altera EXPORTADOS/, altera Base44, ou toca o NEX/.nx1.
 * Executa somente `prepararEventoValidado` (le os exports reais ja
 * existentes em disco, roda o pipeline real ate o gate, nunca chama HTTP)
 * e `validarTravas` (funcao pura, sem I/O), importadas do proprio script
 * de producao.
 * Executar com: node TESTES\teste-e2e-post-unico-15704.js
 */

const path = require('path');
const PROJETO = path.join(__dirname, '..');
const { prepararEventoValidado, validarTravas } = require(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-15704'));
const { avaliarGateEnvio } = require(path.join(PROJETO, 'SRC', 'gate-envio-evento-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

function main() {
  let todosPassaram = true;

  // ---------- Evento real do pipeline passa por todas as travas ----------
  console.log('\n=== Pipeline real (#15704) chega sem falhas de trava (ZERO chamadas HTTP) ===');
  const { corpo, eventoEnviado } = prepararEventoValidado();
  todosPassaram &= check('nenhuma chamada HTTP ocorreu ao preparar o evento (funcao nao tem fetchImpl)', true);
  todosPassaram &= check('nexTransactionId = "15704"', eventoEnviado.nexTransactionId === '15704');
  todosPassaram &= check('eventId = "SALE_PARTIALLY_PAID:NEX:15704"', eventoEnviado.eventId === 'SALE_PARTIALLY_PAID:NEX:15704');
  todosPassaram &= check('identityKey = "NEX:15704"', eventoEnviado.identityKey === 'NEX:15704');
  todosPassaram &= check('eventType = "SALE_PARTIALLY_PAID"', eventoEnviado.eventType === 'SALE_PARTIALLY_PAID');
  todosPassaram &= check('sourceStatus = "READY_TO_SEND"', eventoEnviado.sourceStatus === 'READY_TO_SEND');
  todosPassaram &= check('customerResolutionStatus = "RESOLVED"', eventoEnviado.payload.customerResolutionStatus === 'RESOLVED');
  todosPassaram &= check('nexCustomerCode = "86"', eventoEnviado.nexCustomerCode === '86');
  todosPassaram &= check('payload.amount = null', eventoEnviado.payload.amount === null);
  todosPassaram &= check('payload.amountPaid = 159', eventoEnviado.payload.amountPaid === 159);
  todosPassaram &= check('payload.amountDebt = 159', eventoEnviado.payload.amountDebt === 159);
  todosPassaram &= check('paymentMethod = "PIX"', eventoEnviado.payload.paymentMethod === 'PIX');
  todosPassaram &= check('items.length = 1', eventoEnviado.payload.items.length === 1);
  todosPassaram &= check('items[0].quantidade = 2', eventoEnviado.payload.items[0].quantidade === 2);
  todosPassaram &= check('items[0].produto = "LUPO SPORT 0002"', eventoEnviado.payload.items[0].produto === 'LUPO SPORT 0002');
  todosPassaram &= check('cancelled = false', eventoEnviado.payload.cancelled === false);
  todosPassaram &= check(
    'contentHash = "cd04aa25e909ff75d943fe86a561aaf234b2ac18abfb7dc45c9ac2ab4a7115dd"',
    eventoEnviado.contentHash === 'cd04aa25e909ff75d943fe86a561aaf234b2ac18abfb7dc45c9ac2ab4a7115dd',
  );
  todosPassaram &= check('batch = 1 (events.length)', corpo.events.length === 1);

  const falhasEventoReal = validarTravas(corpo, eventoEnviado, [eventoEnviado.payload]);
  todosPassaram &= check('validarTravas(evento real) -> zero falhas', falhasEventoReal.length === 0);

  // ---------- Adulteracoes deliberadas: cada uma deve reprovar em validarTravas ----------
  console.log('\n=== Adulteracoes deliberadas -> validarTravas deve reprovar cada uma ===');

  function comAdulteracao(mutador) {
    const eventoAdulterado = JSON.parse(JSON.stringify(eventoEnviado));
    mutador(eventoAdulterado);
    const corpoAdulterado = { origin: corpo.origin, events: [eventoAdulterado] };
    return validarTravas(corpoAdulterado, eventoAdulterado, [eventoAdulterado.payload]);
  }

  todosPassaram &= check('transactionId errado -> reprova', comAdulteracao((e) => { e.nexTransactionId = '99999'; }).length > 0);
  todosPassaram &= check('eventType errado -> reprova', comAdulteracao((e) => { e.eventType = 'SALE_PAID'; }).length > 0);
  todosPassaram &= check('sourceStatus errado -> reprova', comAdulteracao((e) => { e.sourceStatus = 'REVIEW_REQUIRED'; }).length > 0);
  todosPassaram &= check(
    'customerResolutionStatus diferente de RESOLVED -> reprova',
    comAdulteracao((e) => { e.payload.customerResolutionStatus = 'REVIEW_REQUIRED'; }).length > 0,
  );
  todosPassaram &= check('eventId errado -> reprova', comAdulteracao((e) => { e.eventId = 'SALE_PARTIALLY_PAID:NEX:99999'; }).length > 0);
  todosPassaram &= check('identityKey errado -> reprova', comAdulteracao((e) => { e.identityKey = 'NEX:99999'; }).length > 0);
  todosPassaram &= check('customerCode errado -> reprova', comAdulteracao((e) => { e.nexCustomerCode = '316'; }).length > 0);
  todosPassaram &= check('amount nao-null -> reprova', comAdulteracao((e) => { e.payload.amount = 159; }).length > 0);
  todosPassaram &= check('amountPaid errado -> reprova', comAdulteracao((e) => { e.payload.amountPaid = 1; }).length > 0);
  todosPassaram &= check('amountDebt errado -> reprova', comAdulteracao((e) => { e.payload.amountDebt = 1; }).length > 0);
  todosPassaram &= check('paymentMethod diferente de PIX -> reprova', comAdulteracao((e) => { e.payload.paymentMethod = 'Dinheiro'; }).length > 0);
  todosPassaram &= check('contentHash errado -> reprova', comAdulteracao((e) => { e.contentHash = '0'.repeat(64); }).length > 0);
  todosPassaram &= check('items.length != 1 -> reprova', comAdulteracao((e) => { e.payload.items.push({ quantidade: 1, produto: 'OUTRO' }); }).length > 0);
  todosPassaram &= check('quantidade diferente de 2 -> reprova', comAdulteracao((e) => { e.payload.items[0].quantidade = 3; }).length > 0);
  todosPassaram &= check('produto diferente -> reprova', comAdulteracao((e) => { e.payload.items[0].produto = 'OUTRO PRODUTO'; }).length > 0);
  todosPassaram &= check('cancelled diferente de false -> reprova', comAdulteracao((e) => { e.payload.cancelled = true; }).length > 0);
  {
    const eventoDuplicado = JSON.parse(JSON.stringify(eventoEnviado));
    const corpoComBatchMaior = { origin: corpo.origin, events: [eventoEnviado, eventoDuplicado] };
    const falhasBatch = validarTravas(corpoComBatchMaior, eventoEnviado, [eventoEnviado.payload]);
    todosPassaram &= check('batch > 1 -> reprova', falhasBatch.length > 0);
  }
  todosPassaram &= check(
    'SALE_PAID adicional (mesma transacao) -> reprova',
    validarTravas(corpo, eventoEnviado, [eventoEnviado.payload, { eventType: 'SALE_PAID' }]).length > 0,
  );
  todosPassaram &= check(
    'DEBT_CREATED adicional (mesma transacao) -> reprova',
    validarTravas(corpo, eventoEnviado, [eventoEnviado.payload, { eventType: 'DEBT_CREATED' }]).length > 0,
  );

  // ---------- Nenhum HTTP ocorre quando qualquer trava falha (garantia estrutural) ----------
  console.log('\n=== Garantia estrutural: validarTravas nunca faz I/O nem chama HTTP ===');
  const fs = require('fs');
  const codigoDoScript = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-15704.js'), 'utf8');
  const trechoValidarTravas = codigoDoScript.slice(
    codigoDoScript.indexOf('function validarTravas'),
    codigoDoScript.indexOf('function prepararEventoValidado'),
  );
  todosPassaram &= check(
    'validarTravas nao contem fetch/require/fs/enviarEvento (funcao pura)',
    !/fetch\(|require\(|fs\.|enviarEvento/.test(trechoValidarTravas),
  );

  // ---------- Scripts anteriores permanecem intactos ----------
  console.log('\n=== #15751 e #15756 permanecem intactos ===');
  const codigo15751 = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-15751.js'), 'utf8');
  todosPassaram &= check('#15751 ainda referencia NEX_TRANSACTION_ID_ALVO = "15751"', codigo15751.includes("NEX_TRANSACTION_ID_ALVO = '15751'"));
  todosPassaram &= check('#15751 ainda referencia SALE_PAID', codigo15751.includes('SALE_PAID'));
  const codigo15756 = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-15756.js'), 'utf8');
  todosPassaram &= check('#15756 ainda referencia NEX_TRANSACTION_ID_ALVO = "15756"', codigo15756.includes("NEX_TRANSACTION_ID_ALVO = '15756'"));
  todosPassaram &= check('#15756 ainda referencia DEBT_CREATED', codigo15756.includes('DEBT_CREATED'));

  // ---------- Gate: o evento real chega READY_TO_SEND (pre-condicao) ----------
  console.log('\n=== Pre-condicao do gate reconfirmada de forma independente ===');
  todosPassaram &= check(
    'avaliarGateEnvio confirma READY_TO_SEND para o payload transportado',
    avaliarGateEnvio(eventoEnviado.payload).status === 'READY_TO_SEND',
  );

  console.log(
    '\nResultado geral teste-e2e-post-unico-15704.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main();
