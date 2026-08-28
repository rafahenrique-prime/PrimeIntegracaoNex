'use strict';

/**
 * Teste de SERVICO/gerador-eventos-nex.js (Fase EXPORT-FIRST - Fase E):
 * integracao identidade + CustomerResolver + classificacao + evento.
 * Executar com: node TESTES\teste-gerador-eventos-nex.js
 */

const path = require('path');
const PROJETO = path.join(__dirname, '..');
const { normalizarVendaNex } = require(path.join(PROJETO, 'SRC', 'normalizar-venda-nex'));
const { normalizarTransacaoClienteNex } = require(path.join(PROJETO, 'SRC', 'normalizar-transacao-cliente-nex'));
const { normalizarClienteNex } = require(path.join(PROJETO, 'SRC', 'normalizar-cliente-nex'));
const { criarIndiceClientes } = require(path.join(PROJETO, 'SRC', 'customer-resolver-nex'));
const { gerarEventosDeVenda, gerarEventoDeTransacaoCliente } = require(path.join(PROJETO, 'SERVICO', 'gerador-eventos-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

// Indice de clientes: Matheus (292, unico), Canelinha (316, unico), CAROL BARBOSA (ambigua, 2 codigos)
const indice = criarIndiceClientes([
  normalizarClienteNex({ nome: 'MATHEUS HENRIQUE DEPRE', codigo: '292' }),
  normalizarClienteNex({ nome: 'CANELINHA', codigo: '316' }),
  normalizarClienteNex({ nome: 'CAROL BARBOSA', codigo: '236' }),
  normalizarClienteNex({ nome: 'CAROL BARBOSA', codigo: '238' }),
]);

// ---------- 1. #15751/#15753/#15755 -> SALE_PAID ----------
console.log('\n=== 1. #15751/#15753/#15755 -> SALE_PAID ===');
const v15751 = normalizarVendaNex({ numero: '15751', tipo: 'Venda', data: '8/28/26', hora: '14:17', cliente: 'CANELINHA', valorPago: 'R$ 97.00 ', meioPagto: 'Cartão de Crédito' });
const eventos15751 = gerarEventosDeVenda(v15751, indice);
todosPassaram &= check('#15751: 1 evento gerado', eventos15751.length === 1);
todosPassaram &= check('#15751: eventType = SALE_PAID', eventos15751[0].eventType === 'SALE_PAID');
todosPassaram &= check('#15751: eventId = "SALE_PAID:NEX:15751"', eventos15751[0].eventId === 'SALE_PAID:NEX:15751');
todosPassaram &= check('#15751: amount = 97', eventos15751[0].amount === 97);
todosPassaram &= check('#15751: cliente RESOLVED -> nexCustomerCode = "316"', eventos15751[0].customerResolutionStatus === 'RESOLVED' && eventos15751[0].nexCustomerCode === '316');

const v15753 = normalizarVendaNex({ numero: '15753', tipo: 'Venda', data: '8/28/26', hora: '14:38', cliente: 'CANELINHA', valorPago: 'R$ 98.00 ', meioPagto: 'Dinheiro' });
todosPassaram &= check('#15753 -> SALE_PAID, amount=98', gerarEventosDeVenda(v15753, indice)[0].eventType === 'SALE_PAID' && gerarEventosDeVenda(v15753, indice)[0].amount === 98);

const v15755 = normalizarVendaNex({ numero: '15755', tipo: 'Venda', data: '8/28/26', hora: '16:28', cliente: 'CANELINHA', valorPago: 'R$ 95.00 ', meioPagto: 'Cartão de Débito' });
todosPassaram &= check('#15755 -> SALE_PAID, amount=95', gerarEventosDeVenda(v15755, indice)[0].eventType === 'SALE_PAID' && gerarEventosDeVenda(v15755, indice)[0].amount === 95);

// ---------- 2. #15756/#15757 -> DEBT_CREATED ----------
console.log('\n=== 2. #15756/#15757 -> DEBT_CREATED ===');
const v15756 = normalizarVendaNex({ numero: '15756', tipo: 'Venda', data: '8/28/26', hora: '16:37', cliente: 'MATHEUS HENRIQUE DEPRE', debitado: 'R$ 89.00 ' });
const eventos15756 = gerarEventosDeVenda(v15756, indice);
todosPassaram &= check('#15756: eventType = DEBT_CREATED', eventos15756[0].eventType === 'DEBT_CREATED');
todosPassaram &= check('#15756: eventId = "DEBT_CREATED:NEX:15756"', eventos15756[0].eventId === 'DEBT_CREATED:NEX:15756');
todosPassaram &= check('#15756: amount = 89', eventos15756[0].amount === 89);
todosPassaram &= check('#15756: nexCustomerCode = "292"', eventos15756[0].nexCustomerCode === '292');

const v15757 = normalizarVendaNex({ numero: '15757', tipo: 'Venda', data: '8/28/26', hora: '16:43', cliente: 'MATHEUS HENRIQUE DEPRE', debitado: 'R$ 87.00 ' });
todosPassaram &= check('#15757 -> DEBT_CREATED, amount=87', gerarEventosDeVenda(v15757, indice)[0].eventType === 'DEBT_CREATED' && gerarEventosDeVenda(v15757, indice)[0].amount === 87);

// ---------- 3. #9999 -> SALE_PARTIALLY_PAID ----------
console.log('\n=== 3. #9999 -> SALE_PARTIALLY_PAID ===');
const v9999 = normalizarVendaNex({ numero: '9999', tipo: 'Venda', data: '10/19/23', hora: '17:23', valorPago: 'R$ 420.00 ', debitado: 'R$ 139.00 ', meioPagto: 'Cartão de Débito' });
const eventos9999 = gerarEventosDeVenda(v9999, indice);
todosPassaram &= check('#9999: 1 evento (nao 2)', eventos9999.length === 1);
todosPassaram &= check('#9999: eventType = SALE_PARTIALLY_PAID', eventos9999[0].eventType === 'SALE_PARTIALLY_PAID');
todosPassaram &= check('#9999: amountPaid = 420 preservado', eventos9999[0].amountPaid === 420);
todosPassaram &= check('#9999: amountDebt = 139 preservado', eventos9999[0].amountDebt === 139);
todosPassaram &= check('#9999: eventId = "SALE_PARTIALLY_PAID:NEX:9999"', eventos9999[0].eventId === 'SALE_PARTIALLY_PAID:NEX:9999');

// ---------- 4. #15758/#15759 -> DEBT_PAYMENT (contexto de cliente explicito) ----------
console.log('\n=== 4. #15758/#15759 -> DEBT_PAYMENT ===');
const t15758 = normalizarTransacaoClienteNex({ noTran: '15758', data: '8/28/26', hora: '17:08', tipo: 'Pagamento Débito', valorPago: 'R$ 89.00 ', meioPagto: 'Dinheiro' });
const eventoT15758 = gerarEventoDeTransacaoCliente(t15758, { nexCustomerCode: '292', customerName: 'MATHEUS HENRIQUE DEPRE' });
todosPassaram &= check('#15758: eventType = DEBT_PAYMENT', eventoT15758.eventType === 'DEBT_PAYMENT');
todosPassaram &= check('#15758: eventId = "DEBT_PAYMENT:NEX:15758"', eventoT15758.eventId === 'DEBT_PAYMENT:NEX:15758');
todosPassaram &= check('#15758: amount = 89, paymentMethod = Dinheiro', eventoT15758.amount === 89 && eventoT15758.paymentMethod === 'Dinheiro');
todosPassaram &= check('#15758: nexCustomerCode = "292" (do CONTEXTO, nao inferido)', eventoT15758.nexCustomerCode === '292');
todosPassaram &= check('#15758: relatedSaleId NAO existe no evento', !('relatedSaleId' in eventoT15758));

const t15759 = normalizarTransacaoClienteNex({ noTran: '15759', data: '8/28/26', hora: '17:18', tipo: 'Pagamento Débito', valorPago: 'R$ 87.00 ', meioPagto: 'Dinheiro' });
const eventoT15759 = gerarEventoDeTransacaoCliente(t15759, { nexCustomerCode: '292', customerName: 'MATHEUS HENRIQUE DEPRE' });
todosPassaram &= check('#15759: eventType = DEBT_PAYMENT, amount=87', eventoT15759.eventType === 'DEBT_PAYMENT' && eventoT15759.amount === 87);

// Sem contexto de cliente fornecido -> nexCustomerCode null, nao inventado
const eventoSemContexto = gerarEventoDeTransacaoCliente(t15758, {});
todosPassaram &= check('sem contexto de cliente -> nexCustomerCode null (nao inventado)', eventoSemContexto.nexCustomerCode === null);
todosPassaram &= check('sem contexto -> customerResolutionStatus = REVIEW_REQUIRED', eventoSemContexto.customerResolutionStatus === 'REVIEW_REQUIRED');

// Venda dentro do extrato individual -> UNCLASSIFIED (politica de fonte)
const t15756NoExtrato = normalizarTransacaoClienteNex({ noTran: '15756', data: '8/28/26', hora: '16:37', tipo: 'Venda', debitado: 'R$ 89.00 ' });
const eventoVendaNoExtrato = gerarEventoDeTransacaoCliente(t15756NoExtrato, { nexCustomerCode: '292' });
todosPassaram &= check('Venda dentro do extrato individual -> UNCLASSIFIED (nao faz merge com Export Vendas)', eventoVendaNoExtrato.status === 'UNCLASSIFIED');

// ---------- 5. #5595: cenario A (ja cancelada na 1a leitura) ----------
console.log('\n=== 5. #5595 cenario A: ja cancelada na primeira leitura ===');
const v5595JaCancelada = normalizarVendaNex({ numero: '5595', tipo: 'Venda', data: '12/16/21', hora: '15:36', cancelado: 'Sim', canceladoEm: '16/12/2021 15:42:00' });
const eventos5595A = gerarEventosDeVenda(v5595JaCancelada, indice);
todosPassaram &= check('cenario A: 2 entradas (base UNCLASSIFIED + SALE_CANCELLED)', eventos5595A.length === 2);
todosPassaram &= check('cenario A: primeira entrada e a base (UNCLASSIFIED, sem valores)', eventos5595A[0].status === 'UNCLASSIFIED');
todosPassaram &= check('cenario A: segunda entrada e SALE_CANCELLED', eventos5595A[1].eventType === 'SALE_CANCELLED');
todosPassaram &= check('cenario A: eventId SALE_CANCELLED = "SALE_CANCELLED:NEX:5595"', eventos5595A[1].eventId === 'SALE_CANCELLED:NEX:5595');
todosPassaram &= check('cenario A: SALE_CANCELLED preserva cancelledAt', eventos5595A[1].cancelledAt === '16/12/2021 15:42:00');
todosPassaram &= check('cenario A: SALE_CANCELLED nao inventa amount', eventos5595A[1].amount === null && eventos5595A[1].amountPaid === null && eventos5595A[1].amountDebt === null);

// ---------- 6. #5595: cenario B (nao cancelada -> cancelada depois, via CHANGED) ----------
console.log('\n=== 6. #5595 cenario B: nao cancelada -> cancelada posteriormente ===');
const v5595Antes = normalizarVendaNex({ numero: '5595', tipo: 'Venda', data: '12/16/21', hora: '15:36', cancelado: 'Não' });
const eventosAntes = gerarEventosDeVenda(v5595Antes, indice);
todosPassaram &= check('antes do cancelamento: 1 entrada so (base UNCLASSIFIED, sem SALE_CANCELLED)', eventosAntes.length === 1 && eventosAntes[0].status === 'UNCLASSIFIED');

const v5595Depois = normalizarVendaNex({ numero: '5595', tipo: 'Venda', data: '12/16/21', hora: '15:36', cancelado: 'Sim', canceladoEm: '16/12/2021 15:42:00' });
const eventosDepois = gerarEventosDeVenda(v5595Depois, indice);
todosPassaram &= check('depois do cancelamento: 2 entradas (base + SALE_CANCELLED)', eventosDepois.length === 2);
todosPassaram &= check('SALE_CANCELLED so aparece apos a mudanca (nunca NEW identity)', eventosDepois[1].eventId === 'SALE_CANCELLED:NEX:5595');

// ---------- 7. Venda com CustomerResolver SEM_MATCH / MULTIPLOS_MATCHES ----------
console.log('\n=== 7. Cliente SEM_MATCH e MULTIPLOS_MATCHES no evento ===');
const vSemMatch = normalizarVendaNex({ numero: '1', tipo: 'Venda', data: '1/1/26', hora: '10:00', cliente: 'GORDO PROZA', valorPago: 'R$ 10.00 ' });
const eventoSemMatch = gerarEventosDeVenda(vSemMatch, indice)[0];
todosPassaram &= check('SEM_MATCH: nexCustomerCode = null (nao inventado)', eventoSemMatch.nexCustomerCode === null);
todosPassaram &= check('SEM_MATCH: customerResolutionStatus = REVIEW_REQUIRED', eventoSemMatch.customerResolutionStatus === 'REVIEW_REQUIRED');
todosPassaram &= check('SEM_MATCH: customerName preservado', eventoSemMatch.customerName === 'GORDO PROZA');

const vMultiplos = normalizarVendaNex({ numero: '2', tipo: 'Venda', data: '1/1/26', hora: '10:00', cliente: 'CAROL BARBOSA', valorPago: 'R$ 10.00 ' });
const eventoMultiplos = gerarEventosDeVenda(vMultiplos, indice)[0];
todosPassaram &= check('MULTIPLOS_MATCHES: nexCustomerCode = null (nenhum codigo escolhido)', eventoMultiplos.nexCustomerCode === null);
todosPassaram &= check('MULTIPLOS_MATCHES: customerResolutionStatus = REVIEW_REQUIRED', eventoMultiplos.customerResolutionStatus === 'REVIEW_REQUIRED');

// ---------- 8. UNCLASSIFIED explicito ----------
console.log('\n=== 8. Combinacao invalida -> UNCLASSIFIED ===');
const vInvalida = normalizarVendaNex({ numero: '3', tipo: 'Venda', data: '1/1/26', hora: '10:00' });
const eventoInvalido = gerarEventosDeVenda(vInvalida, indice)[0];
todosPassaram &= check('sem amountPaid/amountDebt -> UNCLASSIFIED', eventoInvalido.status === 'UNCLASSIFIED');
todosPassaram &= check('UNCLASSIFIED preserva nexTransactionId e identityKey', eventoInvalido.nexTransactionId === '3' && eventoInvalido.identityKey === 'NEX:3');

// ---------- 9. IDEMPOTENCIA de eventId ----------
console.log('\n=== 9. Idempotencia de eventId (reprocessamento) ===');
const eventos15751B = gerarEventosDeVenda(normalizarVendaNex({ numero: '15751', tipo: 'Venda', data: '8/28/26', hora: '14:17', cliente: 'CANELINHA', valorPago: 'R$ 97.00 ', meioPagto: 'Cartão de Crédito' }), indice);
todosPassaram &= check('#15751 reprocessado -> mesmo eventId', eventos15751[0].eventId === eventos15751B[0].eventId);

const eventos15756B = gerarEventosDeVenda(normalizarVendaNex({ numero: '15756', tipo: 'Venda', data: '8/28/26', hora: '16:37', cliente: 'MATHEUS HENRIQUE DEPRE', debitado: 'R$ 89.00 ' }), indice);
todosPassaram &= check('#15756 reprocessado -> mesmo eventId', eventos15756[0].eventId === eventos15756B[0].eventId);

const eventoT15758B = gerarEventoDeTransacaoCliente(normalizarTransacaoClienteNex({ noTran: '15758', data: '8/28/26', hora: '17:08', tipo: 'Pagamento Débito', valorPago: 'R$ 89.00 ', meioPagto: 'Dinheiro' }), { nexCustomerCode: '292' });
todosPassaram &= check('#15758 reprocessado -> mesmo eventId', eventoT15758.eventId === eventoT15758B.eventId);

const eventos9999B = gerarEventosDeVenda(normalizarVendaNex({ numero: '9999', tipo: 'Venda', data: '10/19/23', hora: '17:23', valorPago: 'R$ 420.00 ', debitado: 'R$ 139.00 ', meioPagto: 'Cartão de Débito' }), indice);
todosPassaram &= check('#9999 reprocessado (reimportacao identica) -> mesmo eventId', eventos9999[0].eventId === eventos9999B[0].eventId);

// ---------- 10. Mudanca de valor comercial (CHANGED que NAO e cancelamento) -> MESMO eventId + payload atualizado ----------
console.log('\n=== 10. Correcao de valor -> mesmo eventId, payload atualizado (decisao documentada) ===');
const vCorrecaoAntes = normalizarVendaNex({ numero: '1', tipo: 'Venda', data: '1/1/26', hora: '10:00', valorPago: 'R$ 97.00 ' });
const vCorrecaoDepois = normalizarVendaNex({ numero: '1', tipo: 'Venda', data: '1/1/26', hora: '10:00', valorPago: 'R$ 96.00 ' });
const eventoCorrecaoAntes = gerarEventosDeVenda(vCorrecaoAntes, indice)[0];
const eventoCorrecaoDepois = gerarEventosDeVenda(vCorrecaoDepois, indice)[0];
todosPassaram &= check('mesmo eventId antes/depois da correcao de valor', eventoCorrecaoAntes.eventId === eventoCorrecaoDepois.eventId);
todosPassaram &= check('payload (amount) reflete o valor atualizado', eventoCorrecaoAntes.amount === 97 && eventoCorrecaoDepois.amount === 96);

// ---------- 11. TESTE DE LOTE: 8 transacoes conhecidas -> 8 eventos classificados ----------
console.log('\n=== 11. Teste de lote (8 transacoes conhecidas) ===');
const loteVendas = [v15751, v15753, v15755, v15756, v15757].map((v) => gerarEventosDeVenda(v, indice)[0]);
const lotePagamentos = [
  gerarEventoDeTransacaoCliente(t15758, { nexCustomerCode: '292' }),
  gerarEventoDeTransacaoCliente(t15759, { nexCustomerCode: '292' }),
];
const loteParcial = gerarEventosDeVenda(v9999, indice)[0];
const todosOsEventosDoLote = [...loteVendas, ...lotePagamentos, loteParcial];

todosPassaram &= check('total de 8 eventos', todosOsEventosDoLote.length === 8);
todosPassaram &= check('3 SALE_PAID', todosOsEventosDoLote.filter((e) => e.eventType === 'SALE_PAID').length === 3);
todosPassaram &= check('2 DEBT_CREATED', todosOsEventosDoLote.filter((e) => e.eventType === 'DEBT_CREATED').length === 2);
todosPassaram &= check('2 DEBT_PAYMENT', todosOsEventosDoLote.filter((e) => e.eventType === 'DEBT_PAYMENT').length === 2);
todosPassaram &= check('1 SALE_PARTIALLY_PAID', todosOsEventosDoLote.filter((e) => e.eventType === 'SALE_PARTIALLY_PAID').length === 1);
const eventIdsUnicos = new Set(todosOsEventosDoLote.map((e) => e.eventId));
todosPassaram &= check('8 eventId distintos (sem duplicatas)', eventIdsUnicos.size === 8);

console.log(
  '\nResultado geral gerador-eventos-nex.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
