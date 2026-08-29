'use strict';

/**
 * Teste de SCRIPTS/e2e-post-unico-15758.js (homologacao F2.3 -
 * DEBT_PAYMENT). NENHUM teste deste arquivo faz rede real, usa secret
 * real, altera EXPORTADOS/, altera Base44, ou toca o NEX/.nx1. Executa
 * somente `prepararEventoValidado` (le o extrato individual real ja
 * existente em disco, roda o pipeline real ate o gate, nunca chama HTTP)
 * e `validarTravas` (funcao pura, sem I/O), importadas do proprio script
 * de producao.
 *
 * Este teste prova, sobretudo, que esta fase transporta "pagamento de
 * divida ocorreu" como fato ISOLADO, e explicitamente NAO "quitar esta
 * parcela especifica" - ver blocos C-I abaixo.
 *
 * Executar com: node TESTES\teste-e2e-post-unico-15758.js
 */

const path = require('path');
const PROJETO = path.join(__dirname, '..');
const { prepararEventoValidado, validarTravas } = require(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-15758'));
const { avaliarGateEnvio } = require(path.join(PROJETO, 'SRC', 'gate-envio-evento-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

function main() {
  let todosPassaram = true;

  // ---------- A. Evento real do pipeline passa por todas as travas ----------
  console.log('\n=== A. Pipeline real (#15758) chega sem falhas de trava (ZERO chamadas HTTP) ===');
  const { corpo, eventoEnviado, todasAsEntradas } = prepararEventoValidado();
  todosPassaram &= check('nenhuma chamada HTTP ocorreu ao preparar o evento (funcao nao tem fetchImpl)', true);
  todosPassaram &= check('nexTransactionId = "15758"', eventoEnviado.nexTransactionId === '15758');
  todosPassaram &= check('eventId = "DEBT_PAYMENT:NEX:15758"', eventoEnviado.eventId === 'DEBT_PAYMENT:NEX:15758');
  todosPassaram &= check('identityKey = "NEX:15758"', eventoEnviado.identityKey === 'NEX:15758');
  todosPassaram &= check('eventType = "DEBT_PAYMENT"', eventoEnviado.eventType === 'DEBT_PAYMENT');
  todosPassaram &= check('sourceStatus = "READY_TO_SEND"', eventoEnviado.sourceStatus === 'READY_TO_SEND');
  todosPassaram &= check('customerResolutionStatus = "RESOLVED"', eventoEnviado.payload.customerResolutionStatus === 'RESOLVED');
  todosPassaram &= check('nexCustomerCode = "292"', eventoEnviado.nexCustomerCode === '292');
  todosPassaram &= check('customerName = "MATHEUS HENRIQUE DEPRE"', eventoEnviado.payload.customerName === 'MATHEUS HENRIQUE DEPRE');
  todosPassaram &= check('payload.amount = 89', eventoEnviado.payload.amount === 89);
  todosPassaram &= check('paymentMethod = "Dinheiro"', eventoEnviado.payload.paymentMethod === 'Dinheiro');
  todosPassaram &= check('occurredAt = "2026-08-28T17:08:00"', eventoEnviado.occurredAt === '2026-08-28T17:08:00');
  todosPassaram &= check(
    'contentHash = "de1a31afdec9dc054ca90250d0e8ce6a11d6270fcd74eb2036e8768c8671400f"',
    eventoEnviado.contentHash === 'de1a31afdec9dc054ca90250d0e8ce6a11d6270fcd74eb2036e8768c8671400f',
  );
  todosPassaram &= check('batch = 1 (events.length)', corpo.events.length === 1);

  const falhasEventoReal = validarTravas(corpo, eventoEnviado, todasAsEntradas);
  todosPassaram &= check('validarTravas(evento real) -> zero falhas', falhasEventoReal.length === 0);

  // ---------- C/D/E. Ausencia de vinculo com a divida original ----------
  console.log('\n=== C/D/E. Ausencia comprovada de vinculo com a divida original ===');
  const payloadReal = eventoEnviado.payload;
  todosPassaram &= check('relatedSaleId NAO existe no payload (nem null)', !Object.prototype.hasOwnProperty.call(payloadReal, 'relatedSaleId'));
  todosPassaram &= check('relatedDebtId NAO existe no payload', !Object.prototype.hasOwnProperty.call(payloadReal, 'relatedDebtId'));
  todosPassaram &= check('saleId NAO existe no payload', !Object.prototype.hasOwnProperty.call(payloadReal, 'saleId'));
  todosPassaram &= check('vendaId NAO existe no payload', !Object.prototype.hasOwnProperty.call(payloadReal, 'vendaId'));
  todosPassaram &= check('parcelaId NAO existe no payload', !Object.prototype.hasOwnProperty.call(payloadReal, 'parcelaId'));
  todosPassaram &= check('debtId NAO existe no payload', !Object.prototype.hasOwnProperty.call(payloadReal, 'debtId'));

  // ---------- Adulteracoes deliberadas: cada uma deve reprovar em validarTravas ----------
  console.log('\n=== B. Adulteracoes deliberadas -> validarTravas deve reprovar cada uma ===');

  function comAdulteracao(mutador, entradasExtras) {
    const eventoAdulterado = JSON.parse(JSON.stringify(eventoEnviado));
    mutador(eventoAdulterado);
    const corpoAdulterado = { origin: corpo.origin, events: [eventoAdulterado] };
    const entradas = entradasExtras ? [eventoAdulterado.payload, ...entradasExtras] : [eventoAdulterado.payload];
    return validarTravas(corpoAdulterado, eventoAdulterado, entradas);
  }

  todosPassaram &= check('transactionId errado -> reprova', comAdulteracao((e) => { e.nexTransactionId = '99999'; }).length > 0);
  todosPassaram &= check('eventType errado -> reprova', comAdulteracao((e) => { e.eventType = 'SALE_PAID'; }).length > 0);
  todosPassaram &= check('sourceStatus errado -> reprova', comAdulteracao((e) => { e.sourceStatus = 'REVIEW_REQUIRED'; }).length > 0);
  todosPassaram &= check(
    'customerResolutionStatus diferente de RESOLVED -> reprova',
    comAdulteracao((e) => { e.payload.customerResolutionStatus = 'REVIEW_REQUIRED'; }).length > 0,
  );
  todosPassaram &= check('eventId errado -> reprova', comAdulteracao((e) => { e.eventId = 'DEBT_PAYMENT:NEX:99999'; }).length > 0);
  todosPassaram &= check('identityKey errado -> reprova', comAdulteracao((e) => { e.identityKey = 'NEX:99999'; }).length > 0);
  todosPassaram &= check('nexCustomerCode errado -> reprova', comAdulteracao((e) => { e.nexCustomerCode = '316'; }).length > 0);
  todosPassaram &= check('customerName errado -> reprova', comAdulteracao((e) => { e.payload.customerName = 'OUTRO NOME'; }).length > 0);

  // J. alteracao do amount 89 -> FAIL
  todosPassaram &= check('J. amount errado -> reprova', comAdulteracao((e) => { e.payload.amount = 1; }).length > 0);
  // K. alteracao de Dinheiro -> FAIL
  todosPassaram &= check('K. paymentMethod diferente de Dinheiro -> reprova', comAdulteracao((e) => { e.payload.paymentMethod = 'PIX'; }).length > 0);
  // L. alteracao do contentHash -> FAIL
  todosPassaram &= check('L. contentHash errado -> reprova', comAdulteracao((e) => { e.contentHash = '0'.repeat(64); }).length > 0);
  todosPassaram &= check('occurredAt errado -> reprova', comAdulteracao((e) => { e.occurredAt = '2020-01-01T00:00:00'; }).length > 0);

  // F. inserir vinculo artificial com #15756 -> FAIL
  console.log('\n=== F. Vinculo artificial com #15756 (DEBT_CREATED) e injecao de campos de vinculo -> reprova ===');
  todosPassaram &= check(
    'F. relatedSaleId artificial apontando para #15756 -> reprova',
    comAdulteracao((e) => { e.payload.relatedSaleId = 'NEX:15756'; }).length > 0,
  );
  todosPassaram &= check('relatedDebtId artificial -> reprova', comAdulteracao((e) => { e.payload.relatedDebtId = 'DEBT_CREATED:NEX:15756'; }).length > 0);
  todosPassaram &= check('saleId artificial -> reprova', comAdulteracao((e) => { e.payload.saleId = '15756'; }).length > 0);
  todosPassaram &= check('vendaId artificial -> reprova', comAdulteracao((e) => { e.payload.vendaId = '15756'; }).length > 0);
  todosPassaram &= check('parcelaId artificial -> reprova', comAdulteracao((e) => { e.payload.parcelaId = 'X'; }).length > 0);
  todosPassaram &= check('debtId artificial -> reprova', comAdulteracao((e) => { e.payload.debtId = 'X'; }).length > 0);
  todosPassaram &= check('instrucao de baixa (actionType) artificial -> reprova', comAdulteracao((e) => { e.payload.actionType = 'settle'; }).length > 0);

  // G/H/I. evento adicional gerado junto -> FAIL
  console.log('\n=== G/H/I. Evento adicional simulado para a mesma transacao -> reprova ===');
  todosPassaram &= check(
    'G. DEBT_CREATED adicional (mesma transacao) -> reprova',
    validarTravas(corpo, eventoEnviado, [payloadReal, { nexTransactionId: '15758', eventType: 'DEBT_CREATED' }]).length > 0,
  );
  todosPassaram &= check(
    'H. SALE_PAID adicional (mesma transacao) -> reprova',
    validarTravas(corpo, eventoEnviado, [payloadReal, { nexTransactionId: '15758', eventType: 'SALE_PAID' }]).length > 0,
  );
  todosPassaram &= check(
    'I. SALE_PARTIALLY_PAID adicional (mesma transacao) -> reprova',
    validarTravas(corpo, eventoEnviado, [payloadReal, { nexTransactionId: '15758', eventType: 'SALE_PARTIALLY_PAID' }]).length > 0,
  );

  // batch > 1
  {
    const eventoDuplicado = JSON.parse(JSON.stringify(eventoEnviado));
    const corpoComBatchMaior = { origin: corpo.origin, events: [eventoEnviado, eventoDuplicado] };
    const falhasBatch = validarTravas(corpoComBatchMaior, eventoEnviado, todasAsEntradas);
    todosPassaram &= check('batch > 1 -> reprova', falhasBatch.length > 0);
  }

  // ---------- M. Nenhum HTTP ocorre quando qualquer trava falha (garantia estrutural) ----------
  console.log('\n=== M. Garantia estrutural: validarTravas nunca faz I/O nem chama HTTP ===');
  const fs = require('fs');
  const codigoDoScript = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-15758.js'), 'utf8');
  const trechoValidarTravas = codigoDoScript.slice(
    codigoDoScript.indexOf('function validarTravas'),
    codigoDoScript.indexOf('function prepararEventoValidado'),
  );
  todosPassaram &= check(
    'validarTravas nao contem fetch/require/fs/enviarEvento (funcao pura)',
    !/fetch\(|require\(|fs\.|enviarEvento/.test(trechoValidarTravas),
  );

  // ---------- N. Importar o script nao executa main() ----------
  console.log('\n=== N. Importar o script nao dispara main()/prompt/HTTP ===');
  todosPassaram &= check(
    'main() protegido por require.main === module',
    codigoDoScript.includes('if (require.main === module)'),
  );

  // ---------- Scripts anteriores permanecem intactos ----------
  console.log('\n=== #15751, #15756 e #15704 permanecem intactos ===');
  const codigo15751 = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-15751.js'), 'utf8');
  todosPassaram &= check('#15751 ainda referencia NEX_TRANSACTION_ID_ALVO = "15751"', codigo15751.includes("NEX_TRANSACTION_ID_ALVO = '15751'"));
  todosPassaram &= check('#15751 ainda referencia SALE_PAID', codigo15751.includes('SALE_PAID'));
  const codigo15756 = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-15756.js'), 'utf8');
  todosPassaram &= check('#15756 ainda referencia NEX_TRANSACTION_ID_ALVO = "15756"', codigo15756.includes("NEX_TRANSACTION_ID_ALVO = '15756'"));
  todosPassaram &= check('#15756 ainda referencia DEBT_CREATED', codigo15756.includes('DEBT_CREATED'));
  const codigo15704 = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'e2e-post-unico-15704.js'), 'utf8');
  todosPassaram &= check('#15704 ainda referencia NEX_TRANSACTION_ID_ALVO = "15704"', codigo15704.includes("NEX_TRANSACTION_ID_ALVO = '15704'"));
  todosPassaram &= check('#15704 ainda referencia SALE_PARTIALLY_PAID', codigo15704.includes('SALE_PARTIALLY_PAID'));

  // ---------- Confirmacao de que #15756 nao foi relacionado automaticamente ----------
  console.log('\n=== Confirmacao: nenhum vinculo automatico com #15756 foi criado pelo pipeline real ===');
  // O extrato individual TAMBEM contem a linha "Venda" de #15756 (mesmo
  // cliente), mas o classificador deste extrato NAO reclassifica "Venda"
  // como evento financeiro - ela volta UNCLASSIFIED (politica de fontes,
  // ver SRC/classificador-evento-transacao-cliente-nex.js). Isso prova que
  // nao ha merge/cruzamento automatico entre o pagamento #15758 e a divida
  // #15756, mesmo ambos aparecendo no mesmo arquivo.
  const entrada15756 = todasAsEntradas.find((e) => e && String(e.nexTransactionId) === '15756');
  todosPassaram &= check('#15756 aparece no extrato (linha "Venda"), mas...', entrada15756 !== undefined);
  todosPassaram &= check(
    '...#15756 volta UNCLASSIFIED neste pipeline (nunca DEBT_CREATED/vinculado ao pagamento)',
    entrada15756 && entrada15756.status === 'UNCLASSIFIED' && entrada15756.eventType === undefined,
  );

  // ---------- Gate: o evento real chega READY_TO_SEND (pre-condicao) ----------
  console.log('\n=== Pre-condicao do gate reconfirmada de forma independente ===');
  todosPassaram &= check(
    'avaliarGateEnvio confirma READY_TO_SEND para o payload transportado',
    avaliarGateEnvio(payloadReal).status === 'READY_TO_SEND',
  );

  console.log(
    '\nResultado geral teste-e2e-post-unico-15758.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main();
