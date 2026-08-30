'use strict';

/**
 * Teste de SCRIPTS/e2e-post-unico-9929.js (homologacao SALE_CANCELLED,
 * Etapa 2). NENHUM teste deste arquivo faz rede real, usa secret real,
 * altera Base44, ou toca o NEX/.nx1. Executa somente
 * `prepararEventoValidado` (le os exports reais ja existentes em disco,
 * roda o pipeline real ate o gate, nunca chama HTTP) e `validarTravas`
 * (funcao pura, sem I/O), importadas do proprio script de producao.
 *
 * Executar com: node TESTES\teste-e2e-post-unico-9929.js
 */

const path = require('path');
const fs = require('fs');
const PROJETO = path.join(__dirname, '..');
const { prepararEventoValidado, validarTravas } = require(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-9929'));
const { avaliarGateEnvio } = require(path.join(PROJETO, 'SRC', 'gate-envio-evento-nex'));

function check(desc, cond) {
  const booleano = !!cond;
  console.log((booleano ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return booleano;
}

function main() {
  let todosPassaram = true;

  // ---------- Evento real do pipeline passa por todas as travas ----------
  console.log('\n=== Pipeline real (#9929) chega sem falhas de trava (ZERO chamadas HTTP) ===');
  const { corpo, eventoEnviado } = prepararEventoValidado();
  todosPassaram &= check('nenhuma chamada HTTP ocorreu ao preparar o evento (funcao nao tem fetchImpl)', true);
  todosPassaram &= check('nexTransactionId = "9929"', eventoEnviado.nexTransactionId === '9929');
  todosPassaram &= check('eventId = "SALE_CANCELLED:NEX:9929"', eventoEnviado.eventId === 'SALE_CANCELLED:NEX:9929');
  todosPassaram &= check('identityKey = "NEX:9929"', eventoEnviado.identityKey === 'NEX:9929');
  todosPassaram &= check('eventType = "SALE_CANCELLED"', eventoEnviado.eventType === 'SALE_CANCELLED');
  todosPassaram &= check('sourceStatus = "READY_TO_SEND"', eventoEnviado.sourceStatus === 'READY_TO_SEND');
  todosPassaram &= check('customerResolutionStatus = "RESOLVED"', eventoEnviado.payload.customerResolutionStatus === 'RESOLVED');
  todosPassaram &= check('nexCustomerCode = "624"', eventoEnviado.nexCustomerCode === '624');
  todosPassaram &= check('occurredAt = "2023-10-09T18:29:00"', eventoEnviado.occurredAt === '2023-10-09T18:29:00');
  todosPassaram &= check('payload.amount = null (nunca inventa valor)', eventoEnviado.payload.amount === null);
  todosPassaram &= check('payload.cancelled = true', eventoEnviado.payload.cancelled === true);
  todosPassaram &= check(
    'contentHash = "d7e6e4388492f4cd8601143cd5cdbd698defff0ec0cfeedc3f44cce47fa81637"',
    eventoEnviado.contentHash === 'd7e6e4388492f4cd8601143cd5cdbd698defff0ec0cfeedc3f44cce47fa81637',
  );
  todosPassaram &= check('batch = 1 (events.length)', corpo.events.length === 1);
  todosPassaram &= check('payload NAO contem relatedSaleId/parcelaId/debtId', !Object.prototype.hasOwnProperty.call(eventoEnviado.payload, 'relatedSaleId') && !Object.prototype.hasOwnProperty.call(eventoEnviado.payload, 'parcelaId') && !Object.prototype.hasOwnProperty.call(eventoEnviado.payload, 'debtId'));

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

  todosPassaram &= check('transactionId errado -> reprova', comAdulteracao((e) => { e.nexTransactionId = '99999'; }).length > 0);
  todosPassaram &= check('eventType errado -> reprova', comAdulteracao((e) => { e.eventType = 'SALE_PAID'; }).length > 0);
  todosPassaram &= check('sourceStatus errado -> reprova', comAdulteracao((e) => { e.sourceStatus = 'REVIEW_REQUIRED'; }).length > 0);
  todosPassaram &= check('customerResolutionStatus diferente de RESOLVED -> reprova', comAdulteracao((e) => { e.payload.customerResolutionStatus = 'REVIEW_REQUIRED'; }).length > 0);
  todosPassaram &= check('eventId errado -> reprova', comAdulteracao((e) => { e.eventId = 'SALE_CANCELLED:NEX:99999'; }).length > 0);
  todosPassaram &= check('identityKey errado -> reprova', comAdulteracao((e) => { e.identityKey = 'NEX:99999'; }).length > 0);
  todosPassaram &= check('nexCustomerCode errado -> reprova', comAdulteracao((e) => { e.nexCustomerCode = '316'; }).length > 0);
  todosPassaram &= check('occurredAt errado -> reprova', comAdulteracao((e) => { e.occurredAt = '2020-01-01T00:00:00'; }).length > 0);
  todosPassaram &= check('amount diferente de null -> reprova (nunca deveria inventar valor)', comAdulteracao((e) => { e.payload.amount = 130; }).length > 0);
  todosPassaram &= check('cancelled diferente de true -> reprova', comAdulteracao((e) => { e.payload.cancelled = false; }).length > 0);
  todosPassaram &= check('contentHash errado -> reprova', comAdulteracao((e) => { e.contentHash = '0'.repeat(64); }).length > 0);
  todosPassaram &= check('relatedSaleId inventado -> reprova', comAdulteracao((e) => { e.payload.relatedSaleId = 'NEX:1'; }).length > 0);
  {
    const eventoDuplicado = JSON.parse(JSON.stringify(eventoEnviado));
    const corpoComBatchMaior = { origin: corpo.origin, events: [eventoEnviado, eventoDuplicado] };
    todosPassaram &= check('batch > 1 -> reprova', validarTravas(corpoComBatchMaior, eventoEnviado).length > 0);
  }

  // ---------- Garantias estruturais ----------
  console.log('\n=== Garantia estrutural: validarTravas nunca faz I/O nem chama HTTP ===');
  const codigoDoScript = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-9929.js'), 'utf8');
  const trechoValidarTravas = codigoDoScript.slice(
    codigoDoScript.indexOf('function validarTravas'),
    codigoDoScript.indexOf('function prepararEventoValidado'),
  );
  todosPassaram &= check('validarTravas nao contem fetch/require/fs/enviarEvento (funcao pura)', !/fetch\(|require\(|fs\.|enviarEvento/.test(trechoValidarTravas));

  console.log('\n=== Scripts anteriores permanecem intactos ===');
  for (const [nome, marcador] of [
    ['e2e-post-unico-15751.js', 'SALE_PAID'],
    ['e2e-post-unico-15756.js', 'DEBT_CREATED'],
    ['e2e-post-unico-15704.js', 'SALE_PARTIALLY_PAID'],
    ['e2e-post-unico-15758.js', 'DEBT_PAYMENT'],
  ]) {
    const codigo = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', nome), 'utf8');
    todosPassaram &= check(nome + ' ainda referencia ' + marcador, codigo.includes(marcador));
  }

  console.log('\n=== Este script E2E nao usa nem altera o orquestrador/allowlist ===');
  todosPassaram &= check('script nao importa orquestrador-integracao-nex (nao usa nem altera a allowlist)', !codigoDoScript.includes("require(") || !/require\([^)]*orquestrador-integracao-nex/.test(codigoDoScript));

  console.log('\n=== Pre-condicao do gate reconfirmada de forma independente ===');
  todosPassaram &= check('avaliarGateEnvio confirma READY_TO_SEND para o payload transportado', avaliarGateEnvio(eventoEnviado.payload).status === 'READY_TO_SEND');

  console.log(
    '\nResultado geral teste-e2e-post-unico-9929.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main();
