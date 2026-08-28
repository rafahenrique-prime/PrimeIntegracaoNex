'use strict';

/**
 * Teste de SRC/normalizar-venda-nex.js (Fase EXPORT-FIRST - Fase B).
 * Executar com: node TESTES\teste-normalizar-venda-nex.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { normalizarVendaNex, validarVendaNex } = require(path.join(SRC, 'normalizar-venda-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

// ---------- 1. #15751 - CANELINHA, Cartao Credito, venda paga total ----------
console.log('\n=== 1. #15751 - CANELINHA - Cartão de Crédito (venda paga total) ===');
const v15751 = normalizarVendaNex({
  numero: '15751',
  tipo: 'Venda',
  data: '8/28/26',
  hora: '14:17',
  itens: '1 X BRAND 018 HUGO BOSS',
  cliente: 'CANELINHA',
  subtotal: 'R$ 97.00 ',
  valorPago: 'R$ 97.00 ',
  meioPagto: 'Cartão de Crédito',
  debitado: '',
  cancelado: 'Não',
  vendedor: 'RAFAEL PRIME TIBERY',
  funcionario: 'admin',
});
todosPassaram &= check('nexTransactionId = "15751"', v15751.nexTransactionId === '15751');
todosPassaram &= check('occurredAt = "2026-08-28T14:17:00"', v15751.occurredAt === '2026-08-28T14:17:00');
todosPassaram &= check('customerName = "CANELINHA"', v15751.customerName === 'CANELINHA');
todosPassaram &= check('amountPaid = 97', v15751.amountPaid === 97);
todosPassaram &= check('amountDebt = null (venda paga total)', v15751.amountDebt === null);
todosPassaram &= check('paymentMethod = "Cartão de Crédito"', v15751.paymentMethod === 'Cartão de Crédito');
todosPassaram &= check('items = [{quantidade:1, produto:"BRAND 018 HUGO BOSS"}]', JSON.stringify(v15751.items) === JSON.stringify([{ quantidade: 1, produto: 'BRAND 018 HUGO BOSS' }]));
todosPassaram &= check('cancelled = false', v15751.cancelled === false);
const val15751 = validarVendaNex(v15751, { data: '8/28/26', hora: '14:17' });
todosPassaram &= check('#15751: valida sem erros', val15751.status === 'valido' && val15751.erros.length === 0);

// ---------- 2. #15753 - CANELINHA, Dinheiro ----------
console.log('\n=== 2. #15753 - CANELINHA - Dinheiro ===');
const v15753 = normalizarVendaNex({
  numero: '15753',
  tipo: 'Venda',
  data: '8/28/26',
  hora: '14:38',
  itens: '1 X BRAND 018 HUGO BOSS',
  cliente: 'CANELINHA',
  subtotal: 'R$ 98.00 ',
  valorPago: 'R$ 98.00 ',
  meioPagto: 'Dinheiro',
});
todosPassaram &= check('amountPaid = 98', v15753.amountPaid === 98);
todosPassaram &= check('amountDebt = null', v15753.amountDebt === null);
todosPassaram &= check('paymentMethod = "Dinheiro"', v15753.paymentMethod === 'Dinheiro');

// ---------- 3. #15755 - CANELINHA, Cartao Debito ----------
console.log('\n=== 3. #15755 - CANELINHA - Cartão de Débito ===');
const v15755 = normalizarVendaNex({
  numero: '15755',
  tipo: 'Venda',
  data: '8/28/26',
  hora: '16:28',
  itens: '1 X BRAND 018 HUGO BOSS',
  cliente: 'CANELINHA',
  subtotal: 'R$ 95.00 ',
  valorPago: 'R$ 95.00 ',
  meioPagto: 'Cartão de Débito',
});
todosPassaram &= check('amountPaid = 95', v15755.amountPaid === 95);
todosPassaram &= check('amountDebt = null', v15755.amountDebt === null);
todosPassaram &= check('paymentMethod = "Cartão de Débito"', v15755.paymentMethod === 'Cartão de Débito');

// ---------- 4. #15756 - MATHEUS, fiado total ----------
console.log('\n=== 4. #15756 - MATHEUS HENRIQUE DEPRE - FIADO TOTAL ===');
const v15756 = normalizarVendaNex({
  numero: '15756',
  tipo: 'Venda',
  data: '8/28/26',
  hora: '16:37',
  itens: '1 X BRAND 018 HUGO BOSS',
  cliente: 'MATHEUS HENRIQUE DEPRE',
  subtotal: 'R$ 89.00 ',
  valorPago: '',
  meioPagto: '',
  debitado: 'R$ 89.00 ',
});
todosPassaram &= check('amountPaid = null (fiado total)', v15756.amountPaid === null);
todosPassaram &= check('amountDebt = 89', v15756.amountDebt === 89);
todosPassaram &= check('paymentMethod = null', v15756.paymentMethod === null);
todosPassaram &= check('customerName = "MATHEUS HENRIQUE DEPRE"', v15756.customerName === 'MATHEUS HENRIQUE DEPRE');

// ---------- 5. #15757 - MATHEUS, fiado total ----------
console.log('\n=== 5. #15757 - MATHEUS HENRIQUE DEPRE - FIADO TOTAL ===');
const v15757 = normalizarVendaNex({
  numero: '15757',
  tipo: 'Venda',
  data: '8/28/26',
  hora: '16:43',
  itens: '1 X BRAND 018 HUGO BOSS',
  cliente: 'MATHEUS HENRIQUE DEPRE',
  subtotal: 'R$ 87.00 ',
  valorPago: '',
  meioPagto: '',
  debitado: 'R$ 87.00 ',
});
todosPassaram &= check('amountPaid = null', v15757.amountPaid === null);
todosPassaram &= check('amountDebt = 87', v15757.amountDebt === 87);

// ---------- 6. #9999 - PAGAMENTO PARCIAL (caso real critico) ----------
console.log('\n=== 6. #9999 - PAGAMENTO PARCIAL (real, MATHEUS HENRIQUE) ===');
const v9999 = normalizarVendaNex({
  numero: '9999',
  tipo: 'Venda',
  data: '10/19/23',
  hora: '17:23',
  itens: '3 X CAMISETAS DIESEL HUGO BOSS PRADA 18/07\r\n1 X BERMUDA TOP JR DIESEL HUGO BOSS',
  cliente: 'MATHEUS HENRIQUE',
  subtotal: 'R$ 796.00 ',
  desconto: 'R$ 237.00 ',
  valorPago: 'R$ 420.00 ',
  meioPagto: 'Cartão de Débito',
  debitado: 'R$ 139.00 ',
});
todosPassaram &= check('amountPaid = 420 (preservado, NAO descartado)', v9999.amountPaid === 420);
todosPassaram &= check('amountDebt = 139 (preservado, NAO descartado)', v9999.amountDebt === 139);
todosPassaram &= check('ambos os valores coexistem no MESMO objeto (nao 2 objetos)', typeof v9999 === 'object' && !Array.isArray(v9999));
todosPassaram &= check('paymentMethod = "Cartão de Débito" (preservado mesmo com debito residual)', v9999.paymentMethod === 'Cartão de Débito');
todosPassaram &= check('nenhum campo eventType foi inventado', !('eventType' in v9999));

// ---------- 7. Venda multi-item ----------
console.log('\n=== 7. Venda multi-item (#13005 real) ===');
const v13005 = normalizarVendaNex({
  numero: '13005',
  tipo: 'Venda',
  data: '1/18/25',
  hora: '14:20',
  itens: '1 X CAMISETAS SUEDINE PREMIUM\r\n1 X BERMUDAS JR IMPORTADAS COM FORRO',
  cliente: 'MATHEUS HENRIQUE DEPRE',
  subtotal: 'R$ 308.00 ',
  desconto: 'R$ 8.00 ',
  valorPago: 'R$ 300.00 ',
  meioPagto: 'Dinheiro',
});
todosPassaram &= check('items tem 2 entradas', v13005.items.length === 2);
todosPassaram &= check('discount = 8', v13005.discount === 8);

// ---------- 8. Campos opcionais vazios ----------
console.log('\n=== 8. Campos opcionais vazios ===');
const minimo = normalizarVendaNex({ numero: '1', tipo: 'Venda', data: '1/1/26', hora: '10:00' });
todosPassaram &= check('customerName = null quando ausente', minimo.customerName === null);
todosPassaram &= check('items = [] quando ausente', Array.isArray(minimo.items) && minimo.items.length === 0);
todosPassaram &= check('observations = null quando ausente', minimo.observations === null);
todosPassaram &= check('discount = null quando ausente', minimo.discount === null);

// ---------- 9. Cancelamento ----------
console.log('\n=== 9. Cancelamento (venda #5595 real) ===');
const v5595 = normalizarVendaNex({
  numero: '5595',
  tipo: 'Venda',
  data: '12/16/21',
  hora: '15:36',
  cancelado: 'Sim',
  canceladoEm: '16/12/2021 15:42:00',
});
todosPassaram &= check('cancelled = true', v5595.cancelled === true);
todosPassaram &= check('cancelledAt preservado', v5595.cancelledAt === '16/12/2021 15:42:00');

// ---------- 10. Campos essenciais ausentes ----------
console.log('\n=== 10. Numero ausente ===');
const semNumero = normalizarVendaNex({ tipo: 'Venda', data: '1/1/26', hora: '10:00' });
todosPassaram &= check('nexTransactionId = null', semNumero.nexTransactionId === null);
const valSemNumero = validarVendaNex(semNumero, { data: '1/1/26', hora: '10:00' });
todosPassaram &= check('invalido: falta Número', valSemNumero.status === 'invalido' && valSemNumero.erros.some((e) => e.includes('Número')));

console.log('\n=== 11. Data invalida ===');
const dataInvalida = normalizarVendaNex({ numero: '2', tipo: 'Venda', data: '13/40/26', hora: '10:00' });
todosPassaram &= check('occurredAt = null (data invalida)', dataInvalida.occurredAt === null);
const valDataInvalida = validarVendaNex(dataInvalida, { data: '13/40/26', hora: '10:00' });
todosPassaram &= check('invalido: Data invalida', valDataInvalida.status === 'invalido' && valDataInvalida.erros.some((e) => e.includes('Data')));

console.log('\n=== 12. Hora invalida ===');
const horaInvalida = normalizarVendaNex({ numero: '3', tipo: 'Venda', data: '1/1/26', hora: '25:99' });
const valHoraInvalida = validarVendaNex(horaInvalida, { data: '1/1/26', hora: '25:99' });
todosPassaram &= check('invalido: Hora invalida', valHoraInvalida.status === 'invalido' && valHoraInvalida.erros.some((e) => e.includes('Hora')));

console.log('\n=== 13. Tipo inesperado (nao e "Venda" nem "Devolução") ===');
const tipoInesperado = normalizarVendaNex({ numero: '4', tipo: 'Orçamento', data: '1/1/26', hora: '10:00' });
const valTipoInesperado = validarVendaNex(tipoInesperado, { data: '1/1/26', hora: '10:00' });
todosPassaram &= check(
  'valido_com_aviso: tipo desconhecido gera aviso, nao erro (nao rejeita tipos futuros desconhecidos)',
  valTipoInesperado.status === 'valido_com_aviso' && valTipoInesperado.avisos.some((a) => a.includes('Orçamento')),
);

console.log('\n=== 14. Tipo ausente ===');
const tipoAusente = normalizarVendaNex({ numero: '5', data: '1/1/26', hora: '10:00' });
const valTipoAusente = validarVendaNex(tipoAusente, { data: '1/1/26', hora: '10:00' });
todosPassaram &= check('invalido: falta Tipo', valTipoAusente.status === 'invalido' && valTipoAusente.erros.some((e) => e.includes('Tipo')));

console.log('\n=== 15. Registro vazio nao lanca excecao ===');
let lancouExcecao = false;
try {
  normalizarVendaNex({});
  normalizarVendaNex(null);
} catch (e) {
  lancouExcecao = true;
}
todosPassaram &= check('normalizarVendaNex nao lanca excecao com entrada vazia/null', !lancouExcecao);

console.log(
  '\nResultado geral normalizar-venda-nex.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
