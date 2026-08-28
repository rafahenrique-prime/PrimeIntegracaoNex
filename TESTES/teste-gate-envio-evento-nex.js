'use strict';

/**
 * Teste de SRC/gate-envio-evento-nex.js (Fase EXPORT-FIRST - Fase E.1).
 * Executar com: node TESTES\teste-gate-envio-evento-nex.js
 */

const path = require('path');
const PROJETO = path.join(__dirname, '..');
const { normalizarVendaNex } = require(path.join(PROJETO, 'SRC', 'normalizar-venda-nex'));
const { normalizarTransacaoClienteNex } = require(path.join(PROJETO, 'SRC', 'normalizar-transacao-cliente-nex'));
const { normalizarClienteNex } = require(path.join(PROJETO, 'SRC', 'normalizar-cliente-nex'));
const { criarIndiceClientes } = require(path.join(PROJETO, 'SRC', 'customer-resolver-nex'));
const { gerarEventosDeVenda, gerarEventoDeTransacaoCliente } = require(path.join(PROJETO, 'SERVICO', 'gerador-eventos-nex'));
const { avaliarGateEnvio, avaliarLoteEnvio } = require(path.join(PROJETO, 'SRC', 'gate-envio-evento-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

const indice = criarIndiceClientes([
  normalizarClienteNex({ nome: 'MATHEUS HENRIQUE DEPRE', codigo: '292' }),
  normalizarClienteNex({ nome: 'CANELINHA', codigo: '316' }),
  normalizarClienteNex({ nome: 'CAROL BARBOSA', codigo: '236' }),
  normalizarClienteNex({ nome: 'CAROL BARBOSA', codigo: '238' }),
]);

// ---------- 1. #15751 RESOLVED -> READY_TO_SEND ----------
console.log('\n=== 1. #15751 (cliente RESOLVED) -> READY_TO_SEND ===');
const v15751 = normalizarVendaNex({ numero: '15751', tipo: 'Venda', data: '8/28/26', hora: '14:17', cliente: 'CANELINHA', valorPago: 'R$ 97.00 ', meioPagto: 'Cartão de Crédito' });
const eventos15751 = gerarEventosDeVenda(v15751, indice);
const gate15751 = avaliarGateEnvio(eventos15751[0]);
todosPassaram &= check('status = READY_TO_SEND', gate15751.status === 'READY_TO_SEND');
todosPassaram &= check('reason = null', gate15751.reason === null);
todosPassaram &= check('event referencia o evento original', gate15751.event === eventos15751[0]);

// ---------- 2. #15756 RESOLVED -> READY_TO_SEND ----------
console.log('\n=== 2. #15756 (cliente RESOLVED) -> READY_TO_SEND ===');
const v15756 = normalizarVendaNex({ numero: '15756', tipo: 'Venda', data: '8/28/26', hora: '16:37', cliente: 'MATHEUS HENRIQUE DEPRE', debitado: 'R$ 89.00 ' });
const gate15756 = avaliarGateEnvio(gerarEventosDeVenda(v15756, indice)[0]);
todosPassaram &= check('status = READY_TO_SEND', gate15756.status === 'READY_TO_SEND');

// ---------- 3. #15758 com contexto 292 -> READY_TO_SEND ----------
console.log('\n=== 3. #15758 com contexto nexCustomerCode=292 -> READY_TO_SEND ===');
const t15758 = normalizarTransacaoClienteNex({ noTran: '15758', data: '8/28/26', hora: '17:08', tipo: 'Pagamento Débito', valorPago: 'R$ 89.00 ', meioPagto: 'Dinheiro' });
const eventoT15758 = gerarEventoDeTransacaoCliente(t15758, { nexCustomerCode: '292', customerName: 'MATHEUS HENRIQUE DEPRE' });
const gateT15758 = avaliarGateEnvio(eventoT15758);
todosPassaram &= check('status = READY_TO_SEND', gateT15758.status === 'READY_TO_SEND');

// ---------- 4. #9999 com cliente resolvido -> READY_TO_SEND ----------
console.log('\n=== 4. #9999 (cliente resolvido) -> READY_TO_SEND ===');
const v9999 = normalizarVendaNex({ numero: '9999', tipo: 'Venda', data: '10/19/23', hora: '17:23', cliente: 'CANELINHA', valorPago: 'R$ 420.00 ', debitado: 'R$ 139.00 ' });
const gate9999 = avaliarGateEnvio(gerarEventosDeVenda(v9999, indice)[0]);
todosPassaram &= check('status = READY_TO_SEND', gate9999.status === 'READY_TO_SEND');

// ---------- 5. SALE_CANCELLED com cliente resolvido -> READY_TO_SEND ----------
console.log('\n=== 5. SALE_CANCELLED com cliente resolvido -> READY_TO_SEND ===');
const vCancelResolvido = normalizarVendaNex({ numero: '1', tipo: 'Venda', data: '1/1/26', hora: '10:00', cliente: 'CANELINHA', valorPago: 'R$ 50.00 ', cancelado: 'Sim', canceladoEm: '1/1/26 11:00:00' });
const eventosCancelResolvido = gerarEventosDeVenda(vCancelResolvido, indice);
const eventoCancelResolvido = eventosCancelResolvido.find((e) => e.eventType === 'SALE_CANCELLED');
const gateCancelResolvido = avaliarGateEnvio(eventoCancelResolvido);
todosPassaram &= check('SALE_CANCELLED encontrado', !!eventoCancelResolvido);
todosPassaram &= check('status = READY_TO_SEND', gateCancelResolvido.status === 'READY_TO_SEND');

// SALE_CANCELLED com cliente NAO resolvido -> REVIEW_REQUIRED (nao inventa cliente por ser cancelamento)
console.log('\n=== 5b. SALE_CANCELLED com cliente NAO resolvido -> REVIEW_REQUIRED ===');
const vCancelSemCliente = normalizarVendaNex({ numero: '2', tipo: 'Venda', data: '1/1/26', hora: '10:00', cliente: 'GORDO PROZA', valorPago: 'R$ 50.00 ', cancelado: 'Sim', canceladoEm: '1/1/26 11:00:00' });
const eventoCancelSemCliente = gerarEventosDeVenda(vCancelSemCliente, indice).find((e) => e.eventType === 'SALE_CANCELLED');
const gateCancelSemCliente = avaliarGateEnvio(eventoCancelSemCliente);
todosPassaram &= check('status = REVIEW_REQUIRED (cliente nao resolvido, mesmo sendo cancelamento)', gateCancelSemCliente.status === 'REVIEW_REQUIRED');
todosPassaram &= check('reason = CUSTOMER_NOT_RESOLVED', gateCancelSemCliente.reason === 'CUSTOMER_NOT_RESOLVED');

// ---------- 6. UNCLASSIFIED -> REVIEW_REQUIRED / UNCLASSIFIED_EVENT ----------
console.log('\n=== 6. UNCLASSIFIED -> REVIEW_REQUIRED / UNCLASSIFIED_EVENT ===');
const vSemValores = normalizarVendaNex({ numero: '3', tipo: 'Venda', data: '1/1/26', hora: '10:00', cliente: 'CANELINHA' });
const eventoUnclassified = gerarEventosDeVenda(vSemValores, indice)[0];
const gateUnclassified = avaliarGateEnvio(eventoUnclassified);
todosPassaram &= check('status = REVIEW_REQUIRED', gateUnclassified.status === 'REVIEW_REQUIRED');
todosPassaram &= check('reason = UNCLASSIFIED_EVENT', gateUnclassified.reason === 'UNCLASSIFIED_EVENT');
todosPassaram &= check('preserva identityKey/nexTransactionId para investigacao', gateUnclassified.event.identityKey === 'NEX:3' && gateUnclassified.event.nexTransactionId === '3');

// ---------- 7. SEM_MATCH -> REVIEW_REQUIRED ----------
console.log('\n=== 7. Cliente SEM_MATCH -> REVIEW_REQUIRED ===');
const vSemMatch = normalizarVendaNex({ numero: '4', tipo: 'Venda', data: '1/1/26', hora: '10:00', cliente: 'GORDO PROZA', valorPago: 'R$ 10.00 ' });
const gateSemMatch = avaliarGateEnvio(gerarEventosDeVenda(vSemMatch, indice)[0]);
todosPassaram &= check('status = REVIEW_REQUIRED', gateSemMatch.status === 'REVIEW_REQUIRED');
todosPassaram &= check('reason = CUSTOMER_NOT_RESOLVED', gateSemMatch.reason === 'CUSTOMER_NOT_RESOLVED');
todosPassaram &= check('nexCustomerCode NAO foi inventado no evento original', gateSemMatch.event.nexCustomerCode === null);

// ---------- 8. MULTIPLOS_MATCHES -> REVIEW_REQUIRED ----------
console.log('\n=== 8. Cliente MULTIPLOS_MATCHES -> REVIEW_REQUIRED ===');
const vMultiplos = normalizarVendaNex({ numero: '5', tipo: 'Venda', data: '1/1/26', hora: '10:00', cliente: 'CAROL BARBOSA', valorPago: 'R$ 10.00 ' });
const gateMultiplos = avaliarGateEnvio(gerarEventosDeVenda(vMultiplos, indice)[0]);
todosPassaram &= check('status = REVIEW_REQUIRED', gateMultiplos.status === 'REVIEW_REQUIRED');
todosPassaram &= check('reason = CUSTOMER_NOT_RESOLVED', gateMultiplos.reason === 'CUSTOMER_NOT_RESOLVED');
todosPassaram &= check('nenhum codigo foi escolhido automaticamente', gateMultiplos.event.nexCustomerCode === null);

// ---------- 9. DEBT_PAYMENT sem nexCustomerCode -> REVIEW_REQUIRED ----------
console.log('\n=== 9. DEBT_PAYMENT sem contexto de cliente -> REVIEW_REQUIRED ===');
const eventoT15758SemContexto = gerarEventoDeTransacaoCliente(t15758, {});
const gateT15758SemContexto = avaliarGateEnvio(eventoT15758SemContexto);
todosPassaram &= check('status = REVIEW_REQUIRED', gateT15758SemContexto.status === 'REVIEW_REQUIRED');
todosPassaram &= check('reason = CUSTOMER_NOT_RESOLVED', gateT15758SemContexto.reason === 'CUSTOMER_NOT_RESOLVED');

// ---------- 10. INVALID_IDENTITY -> REVIEW_REQUIRED ----------
console.log('\n=== 10. INVALID_IDENTITY -> REVIEW_REQUIRED ===');
const vSemId = normalizarVendaNex({ tipo: 'Venda', data: '1/1/26', hora: '10:00', valorPago: 'R$ 10.00 ' }); // sem numero
const gateSemId = avaliarGateEnvio(gerarEventosDeVenda(vSemId, indice)[0]);
todosPassaram &= check('status = REVIEW_REQUIRED', gateSemId.status === 'REVIEW_REQUIRED');
todosPassaram &= check('reason = INVALID_IDENTITY', gateSemId.reason === 'INVALID_IDENTITY');

// ---------- 11. Nenhum evento original e mutado ----------
console.log('\n=== 11. Imutabilidade do evento original ===');
const eventoOriginal = gerarEventosDeVenda(v15751, indice)[0];
const eventoCongelado = Object.freeze(Object.assign({}, eventoOriginal));
let lancouExcecao = false;
try {
  avaliarGateEnvio(eventoCongelado);
} catch (e) {
  lancouExcecao = true;
}
todosPassaram &= check('avaliarGateEnvio nao tenta escrever no evento (objeto congelado nao gera excecao)', !lancouExcecao);
todosPassaram &= check('conteudo do evento congelado permanece identico apos o gate', JSON.stringify(eventoCongelado) === JSON.stringify(eventoOriginal));

// ---------- 12. Processamento de lote ----------
console.log('\n=== 12. avaliarLoteEnvio - separacao e estatisticas ===');
const lote = [
  eventos15751[0], // READY_TO_SEND
  gerarEventosDeVenda(v15756, indice)[0], // READY_TO_SEND
  eventoT15758, // READY_TO_SEND
  eventoUnclassified, // REVIEW_REQUIRED / UNCLASSIFIED_EVENT
  gerarEventosDeVenda(vSemMatch, indice)[0], // REVIEW_REQUIRED / CUSTOMER_NOT_RESOLVED
  gerarEventosDeVenda(vMultiplos, indice)[0], // REVIEW_REQUIRED / CUSTOMER_NOT_RESOLVED
  gerarEventosDeVenda(vSemId, indice)[0], // REVIEW_REQUIRED / INVALID_IDENTITY
];
const resultadoLote = avaliarLoteEnvio(lote);
todosPassaram &= check('total = 7', resultadoLote.estatisticas.total === 7);
todosPassaram &= check('readyToSend = 3', resultadoLote.estatisticas.readyToSend === 3);
todosPassaram &= check('reviewRequired = 4', resultadoLote.estatisticas.reviewRequired === 4);
todosPassaram &= check('reasons.UNCLASSIFIED_EVENT = 1', resultadoLote.estatisticas.reasons.UNCLASSIFIED_EVENT === 1);
todosPassaram &= check('reasons.CUSTOMER_NOT_RESOLVED = 2', resultadoLote.estatisticas.reasons.CUSTOMER_NOT_RESOLVED === 2);
todosPassaram &= check('reasons.INVALID_IDENTITY = 1', resultadoLote.estatisticas.reasons.INVALID_IDENTITY === 1);
todosPassaram &= check('readyToSend[].event sao os eventos originais (nao clonados/alterados)', resultadoLote.readyToSend[0].event === eventos15751[0]);

console.log(
  '\nResultado geral gate-envio-evento-nex.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
