'use strict';

/**
 * Teste de SRC/normalizar-transacao-cliente-nex.js
 * (Fase EXPORT-FIRST - Fase B).
 * Executar com: node TESTES\teste-normalizar-transacao-cliente-nex.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const {
  normalizarTransacaoClienteNex,
  validarTransacaoClienteNex,
} = require(path.join(SRC, 'normalizar-transacao-cliente-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

// ---------- 1. #15758 - Pagamento Débito real (quitacao da venda #15756) ----------
console.log('\n=== 1. #15758 - Pagamento Débito (R$89, Dinheiro) ===');
const t15758 = normalizarTransacaoClienteNex({
  noTran: '15758',
  data: '8/28/26',
  hora: '17:08',
  totalFinal: 'R$ 89.00 ',
  tipo: 'Pagamento Débito',
  vlProdutos: 'R$ 89.00 ',
  valorPago: 'R$ 89.00 ',
  meioPagto: 'Dinheiro',
  funcionario: 'admin',
});
todosPassaram &= check('nexTransactionId = "15758"', t15758.nexTransactionId === '15758');
todosPassaram &= check('occurredAt = "2026-08-28T17:08:00"', t15758.occurredAt === '2026-08-28T17:08:00');
todosPassaram &= check(
  'transactionType preservado LITERALMENTE ("Pagamento Débito", nao convertido para DEBT_PAYMENT)',
  t15758.transactionType === 'Pagamento Débito',
);
todosPassaram &= check('totalAmount = 89', t15758.totalAmount === 89);
todosPassaram &= check('amountPaid = 89', t15758.amountPaid === 89);
todosPassaram &= check('amountDebt = null', t15758.amountDebt === null);
todosPassaram &= check('paymentMethod = "Dinheiro"', t15758.paymentMethod === 'Dinheiro');
todosPassaram &= check('employee = "admin"', t15758.employee === 'admin');
todosPassaram &= check('source = "export_extrato_cliente_individual"', t15758.source === 'export_extrato_cliente_individual');
todosPassaram &= check('nenhum nexCustomerCode foi inventado', !('nexCustomerCode' in t15758));
todosPassaram &= check('nenhuma referencia a venda original foi inventada (relatedSaleId)', !('relatedSaleId' in t15758));
const val15758 = validarTransacaoClienteNex(t15758, { data: '8/28/26', hora: '17:08' });
todosPassaram &= check('#15758: valido, sem erros', val15758.status === 'valido' && val15758.erros.length === 0);

// ---------- 2. #15759 - Pagamento Débito real (quitacao da venda #15757) ----------
console.log('\n=== 2. #15759 - Pagamento Débito (R$87, Dinheiro) ===');
const t15759 = normalizarTransacaoClienteNex({
  noTran: '15759',
  data: '8/28/26',
  hora: '17:18',
  totalFinal: 'R$ 87.00 ',
  tipo: 'Pagamento Débito',
  vlProdutos: 'R$ 87.00 ',
  valorPago: 'R$ 87.00 ',
  meioPagto: 'Dinheiro',
  funcionario: 'admin',
});
todosPassaram &= check('nexTransactionId = "15759"', t15759.nexTransactionId === '15759');
todosPassaram &= check('amountPaid = 87', t15759.amountPaid === 87);
todosPassaram &= check('transactionType = "Pagamento Débito"', t15759.transactionType === 'Pagamento Débito');

// ---------- 3. Venda dentro do mesmo extrato (Tipo = "Venda") ----------
console.log('\n=== 3. #15756 dentro do extrato (Tipo = "Venda") ===');
const t15756 = normalizarTransacaoClienteNex({
  noTran: '15756',
  data: '8/28/26',
  hora: '16:37',
  totalFinal: 'R$ 89.00 ',
  tipo: 'Venda',
  descricao: '1 X BRAND 018 HUGO BOSS',
  vlProdutos: 'R$ 89.00 ',
  debitado: 'R$ 89.00 ',
  vendedor: 'RAFAEL PRIME TIBERY',
});
todosPassaram &= check('transactionType = "Venda"', t15756.transactionType === 'Venda');
todosPassaram &= check('amountDebt = 89', t15756.amountDebt === 89);
todosPassaram &= check('description preservada', t15756.description === '1 X BRAND 018 HUGO BOSS');
todosPassaram &= check('seller preservado', t15756.seller === 'RAFAEL PRIME TIBERY');

// ---------- 4. Campos opcionais vazios ----------
console.log('\n=== 4. Campos opcionais vazios ===');
const minimo = normalizarTransacaoClienteNex({ noTran: '1', tipo: 'Venda', data: '1/1/26', hora: '10:00' });
todosPassaram &= check('description = null quando ausente', minimo.description === null);
todosPassaram &= check('paymentMethod = null quando ausente', minimo.paymentMethod === null);
todosPassaram &= check('amountPaid = null quando ausente', minimo.amountPaid === null);
todosPassaram &= check('cancelled = false por padrao', minimo.cancelled === false);

// ---------- 5. Campos essenciais ausentes ----------
console.log('\n=== 5. No.Tran ausente ===');
const semNoTran = normalizarTransacaoClienteNex({ tipo: 'Venda', data: '1/1/26', hora: '10:00' });
const valSemNoTran = validarTransacaoClienteNex(semNoTran, { data: '1/1/26', hora: '10:00' });
todosPassaram &= check('invalido: falta No.Tran', valSemNoTran.status === 'invalido' && valSemNoTran.erros.some((e) => e.includes('No.Tran')));

console.log('\n=== 6. Tipo ausente ===');
const semTipo = normalizarTransacaoClienteNex({ noTran: '2', data: '1/1/26', hora: '10:00' });
const valSemTipo = validarTransacaoClienteNex(semTipo, { data: '1/1/26', hora: '10:00' });
todosPassaram &= check('invalido: falta Tipo', valSemTipo.status === 'invalido' && valSemTipo.erros.some((e) => e.includes('Tipo')));

console.log('\n=== 7. Data/Hora invalidas ===');
const dataInvalida = normalizarTransacaoClienteNex({ noTran: '3', tipo: 'Venda', data: '99/99/26', hora: '10:00' });
const valDataInvalida = validarTransacaoClienteNex(dataInvalida, { data: '99/99/26', hora: '10:00' });
todosPassaram &= check('invalido: Data invalida', valDataInvalida.status === 'invalido' && valDataInvalida.erros.some((e) => e.includes('Data')));

const horaInvalida = normalizarTransacaoClienteNex({ noTran: '4', tipo: 'Venda', data: '1/1/26', hora: '99:99' });
const valHoraInvalida = validarTransacaoClienteNex(horaInvalida, { data: '1/1/26', hora: '99:99' });
todosPassaram &= check('invalido: Hora invalida', valHoraInvalida.status === 'invalido' && valHoraInvalida.erros.some((e) => e.includes('Hora')));

console.log('\n=== 8. Registro vazio nao lanca excecao ===');
let lancouExcecao = false;
try {
  normalizarTransacaoClienteNex({});
  normalizarTransacaoClienteNex(null);
} catch (e) {
  lancouExcecao = true;
}
todosPassaram &= check('normalizarTransacaoClienteNex nao lanca excecao com entrada vazia/null', !lancouExcecao);

console.log(
  '\nResultado geral normalizar-transacao-cliente-nex.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
