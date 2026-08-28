'use strict';

/**
 * Teste de SRC/classificador-evento-venda-nex.js (Fase EXPORT-FIRST - Fase E).
 * Executar com: node TESTES\teste-classificador-evento-venda-nex.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { classificarVenda } = require(path.join(SRC, 'classificador-evento-venda-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

console.log('\n=== SALE_PAID ===');
todosPassaram &= check('#15751 (97/null) -> SALE_PAID', classificarVenda({ amountPaid: 97, amountDebt: null }).eventType === 'SALE_PAID');
todosPassaram &= check('#15753 (98/null) -> SALE_PAID', classificarVenda({ amountPaid: 98, amountDebt: null }).eventType === 'SALE_PAID');
todosPassaram &= check('#15755 (95/null) -> SALE_PAID', classificarVenda({ amountPaid: 95, amountDebt: null }).eventType === 'SALE_PAID');
todosPassaram &= check('amountDebt=0 tambem conta como ausente', classificarVenda({ amountPaid: 50, amountDebt: 0 }).eventType === 'SALE_PAID');

console.log('\n=== DEBT_CREATED ===');
todosPassaram &= check('#15756 (null/89) -> DEBT_CREATED', classificarVenda({ amountPaid: null, amountDebt: 89 }).eventType === 'DEBT_CREATED');
todosPassaram &= check('#15757 (null/87) -> DEBT_CREATED', classificarVenda({ amountPaid: null, amountDebt: 87 }).eventType === 'DEBT_CREATED');
todosPassaram &= check('amountPaid=0 tambem conta como ausente', classificarVenda({ amountPaid: 0, amountDebt: 40 }).eventType === 'DEBT_CREATED');

console.log('\n=== SALE_PARTIALLY_PAID ===');
todosPassaram &= check('#9999 (420/139) -> SALE_PARTIALLY_PAID', classificarVenda({ amountPaid: 420, amountDebt: 139 }).eventType === 'SALE_PARTIALLY_PAID');

console.log('\n=== UNCLASSIFIED ===');
todosPassaram &= check('ambos ausentes -> UNCLASSIFIED', classificarVenda({ amountPaid: null, amountDebt: null }).status === 'UNCLASSIFIED');
todosPassaram &= check('ambos zero -> UNCLASSIFIED', classificarVenda({ amountPaid: 0, amountDebt: 0 }).status === 'UNCLASSIFIED');
todosPassaram &= check('registro vazio -> UNCLASSIFIED (nao lanca excecao)', classificarVenda({}).status === 'UNCLASSIFIED');
todosPassaram &= check('registro null -> UNCLASSIFIED (nao lanca excecao)', classificarVenda(null).status === 'UNCLASSIFIED');
todosPassaram &= check('motivo presente para UNCLASSIFIED', typeof classificarVenda({}).motivo === 'string');

console.log(
  '\nResultado geral classificador-evento-venda-nex.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
