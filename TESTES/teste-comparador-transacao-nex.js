'use strict';

/**
 * Teste de SRC/comparador-transacao-nex.js (Fase EXPORT-FIRST - Fase D).
 * Executar com: node TESTES\teste-comparador-transacao-nex.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { compararVenda, compararTransacaoCliente } = require(path.join(SRC, 'comparador-transacao-nex'));
const { normalizarVendaNex } = require(path.join(SRC, 'normalizar-venda-nex'));
const { normalizarTransacaoClienteNex } = require(path.join(SRC, 'normalizar-transacao-cliente-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

// ---------- 1. NEW: nada conhecido ainda ----------
console.log('\n=== 1. NEW (nenhum registro conhecido) ===');
const v15751 = normalizarVendaNex({
  numero: '15751', tipo: 'Venda', data: '8/28/26', hora: '14:17',
  cliente: 'CANELINHA', subtotal: 'R$ 97.00 ', valorPago: 'R$ 97.00 ', meioPagto: 'Cartão de Crédito',
});
const rNew = compararVenda(null, v15751);
todosPassaram &= check('status = NEW', rNew.status === 'NEW');
todosPassaram &= check('nexTransactionId = "15751"', rNew.nexTransactionId === '15751');
todosPassaram &= check('NEW nao tem changedFields', !('changedFields' in rNew));

// ---------- 2. UNCHANGED: mesmo registro reimportado ----------
console.log('\n=== 2. UNCHANGED (reimportacao identica) ===');
const v15751Igual = normalizarVendaNex({
  numero: '15751', tipo: 'Venda', data: '8/28/26', hora: '14:17',
  cliente: 'CANELINHA', subtotal: 'R$ 97.00 ', valorPago: 'R$ 97.00 ', meioPagto: 'Cartão de Crédito',
});
const rUnchanged = compararVenda(v15751, v15751Igual);
todosPassaram &= check('status = UNCHANGED', rUnchanged.status === 'UNCHANGED');
todosPassaram &= check('nexTransactionId preservado', rUnchanged.nexTransactionId === '15751');

// ---------- 3. CHANGED: cancelamento posterior (venda #5595 real) ----------
console.log('\n=== 3. CHANGED - cancelamento posterior (#5595 real) ===');
const v5595Antes = normalizarVendaNex({
  numero: '5595', tipo: 'Venda', data: '12/16/21', hora: '15:36',
  cancelado: 'Não', canceladoEm: '',
});
const v5595Depois = normalizarVendaNex({
  numero: '5595', tipo: 'Venda', data: '12/16/21', hora: '15:36',
  cancelado: 'Sim', canceladoEm: '16/12/2021 15:42:00',
});
const rCancelado = compararVenda(v5595Antes, v5595Depois);
todosPassaram &= check('status = CHANGED', rCancelado.status === 'CHANGED');
todosPassaram &= check(
  'changedFields inclui "cancelled" (false -> true)',
  rCancelado.changedFields.some((c) => c.field === 'cancelled' && c.before === false && c.after === true),
);
todosPassaram &= check(
  'changedFields inclui "cancelledAt" (null -> preenchido)',
  rCancelado.changedFields.some((c) => c.field === 'cancelledAt' && c.before === null && c.after === '16/12/2021 15:42:00'),
);
todosPassaram &= check(
  'changedFields NAO inclui campos que nao mudaram (ex.: nexTransactionId)',
  !rCancelado.changedFields.some((c) => c.field === 'nexTransactionId'),
);

// ---------- 4. CHANGED: campo comercial (amountPaid) ----------
console.log('\n=== 4. CHANGED - mudanca de amountPaid (97 -> 96) ===');
const vAntes = normalizarVendaNex({ numero: '1', tipo: 'Venda', data: '1/1/26', hora: '10:00', valorPago: 'R$ 97.00 ' });
const vDepois = normalizarVendaNex({ numero: '1', tipo: 'Venda', data: '1/1/26', hora: '10:00', valorPago: 'R$ 96.00 ' });
const rAmountPaid = compararVenda(vAntes, vDepois);
todosPassaram &= check('status = CHANGED', rAmountPaid.status === 'CHANGED');
todosPassaram &= check(
  'changedFields contem amountPaid (97 -> 96)',
  rAmountPaid.changedFields.some((c) => c.field === 'amountPaid' && c.before === 97 && c.after === 96),
);
todosPassaram &= check('prova que o mecanismo nao e especifico de cancelamento', rAmountPaid.changedFields.length === 1 && rAmountPaid.changedFields[0].field === 'amountPaid');

// ---------- 5. #9999 pagamento parcial: mudanca em amountDebt ----------
console.log('\n=== 5. #9999 - mudanca em amountDebt (139 -> 100) ===');
const v9999Antes = normalizarVendaNex({ numero: '9999', tipo: 'Venda', data: '10/19/23', hora: '17:23', valorPago: 'R$ 420.00 ', debitado: 'R$ 139.00 ' });
const v9999Depois = normalizarVendaNex({ numero: '9999', tipo: 'Venda', data: '10/19/23', hora: '17:23', valorPago: 'R$ 420.00 ', debitado: 'R$ 100.00 ' });
const r9999 = compararVenda(v9999Antes, v9999Depois);
todosPassaram &= check('status = CHANGED', r9999.status === 'CHANGED');
todosPassaram &= check('changedFields contem amountDebt (139 -> 100)', r9999.changedFields.some((c) => c.field === 'amountDebt' && c.before === 139 && c.after === 100));
todosPassaram &= check('amountPaid NAO aparece em changedFields (nao mudou)', !r9999.changedFields.some((c) => c.field === 'amountPaid'));

const v9999Identica = normalizarVendaNex({ numero: '9999', tipo: 'Venda', data: '10/19/23', hora: '17:23', valorPago: 'R$ 420.00 ', debitado: 'R$ 139.00 ' });
todosPassaram &= check('#9999 reimportacao identica -> UNCHANGED', compararVenda(v9999Antes, v9999Identica).status === 'UNCHANGED');

// ---------- 6. Transacao do cliente (Pagamento Débito) ----------
console.log('\n=== 6. compararTransacaoCliente - #15758 ===');
const t15758 = normalizarTransacaoClienteNex({
  noTran: '15758', data: '8/28/26', hora: '17:08', totalFinal: 'R$ 89.00 ',
  tipo: 'Pagamento Débito', valorPago: 'R$ 89.00 ', meioPagto: 'Dinheiro',
});
todosPassaram &= check('NEW quando nao conhecido', compararTransacaoCliente(null, t15758).status === 'NEW');
const t15758Igual = normalizarTransacaoClienteNex({
  noTran: '15758', data: '8/28/26', hora: '17:08', totalFinal: 'R$ 89.00 ',
  tipo: 'Pagamento Débito', valorPago: 'R$ 89.00 ', meioPagto: 'Dinheiro',
});
todosPassaram &= check('UNCHANGED quando identico', compararTransacaoCliente(t15758, t15758Igual).status === 'UNCHANGED');

console.log(
  '\nResultado geral comparador-transacao-nex.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
