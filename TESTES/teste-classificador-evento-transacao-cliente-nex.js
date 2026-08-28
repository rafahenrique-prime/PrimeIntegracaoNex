'use strict';

/**
 * Teste de SRC/classificador-evento-transacao-cliente-nex.js
 * (Fase EXPORT-FIRST - Fase E).
 * Executar com: node TESTES\teste-classificador-evento-transacao-cliente-nex.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { classificarTransacaoCliente } = require(path.join(SRC, 'classificador-evento-transacao-cliente-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

console.log('\n=== DEBT_PAYMENT ===');
todosPassaram &= check('#15758 (Pagamento Débito) -> DEBT_PAYMENT', classificarTransacaoCliente({ transactionType: 'Pagamento Débito' }).eventType === 'DEBT_PAYMENT');
todosPassaram &= check('#15759 (Pagamento Débito) -> DEBT_PAYMENT', classificarTransacaoCliente({ transactionType: 'Pagamento Débito' }).eventType === 'DEBT_PAYMENT');

console.log('\n=== UNCLASSIFIED (politica de fonte: nao faz merge com Vendas) ===');
const rVenda = classificarTransacaoCliente({ transactionType: 'Venda' });
todosPassaram &= check('Tipo "Venda" no extrato individual -> UNCLASSIFIED (fonte primaria e Export Vendas)', rVenda.status === 'UNCLASSIFIED');
todosPassaram &= check('motivo documenta a politica de nao-merge', rVenda.motivo.includes('EXPORT_VENDAS'));

todosPassaram &= check('tipo desconhecido -> UNCLASSIFIED', classificarTransacaoCliente({ transactionType: 'Devolução' }).status === 'UNCLASSIFIED');
todosPassaram &= check('tipo ausente -> UNCLASSIFIED', classificarTransacaoCliente({}).status === 'UNCLASSIFIED');
todosPassaram &= check('registro null -> UNCLASSIFIED (nao lanca excecao)', classificarTransacaoCliente(null).status === 'UNCLASSIFIED');

console.log(
  '\nResultado geral classificador-evento-transacao-cliente-nex.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
