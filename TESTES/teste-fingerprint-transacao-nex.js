'use strict';

/**
 * Teste de SRC/fingerprint-transacao-nex.js (Fase EXPORT-FIRST - Fase D).
 * Executar com: node TESTES\teste-fingerprint-transacao-nex.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const {
  gerarFingerprintVenda,
  gerarFingerprintTransacaoCliente,
} = require(path.join(SRC, 'fingerprint-transacao-nex'));
const { normalizarVendaNex } = require(path.join(SRC, 'normalizar-venda-nex'));
const { normalizarTransacaoClienteNex } = require(path.join(SRC, 'normalizar-transacao-cliente-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

const venda15751 = normalizarVendaNex({
  numero: '15751',
  tipo: 'Venda',
  data: '8/28/26',
  hora: '14:17',
  itens: '1 X BRAND 018 HUGO BOSS',
  cliente: 'CANELINHA',
  subtotal: 'R$ 97.00 ',
  valorPago: 'R$ 97.00 ',
  meioPagto: 'Cartão de Crédito',
});

// ---------- 1. Determinismo: mesma entrada -> mesmo fingerprint ----------
console.log('\n=== 1. Determinismo ===');
todosPassaram &= check(
  'gerarFingerprintVenda e deterministico (2 chamadas identicas)',
  gerarFingerprintVenda(venda15751) === gerarFingerprintVenda(normalizarVendaNex({
    numero: '15751',
    tipo: 'Venda',
    data: '8/28/26',
    hora: '14:17',
    itens: '1 X BRAND 018 HUGO BOSS',
    cliente: 'CANELINHA',
    subtotal: 'R$ 97.00 ',
    valorPago: 'R$ 97.00 ',
    meioPagto: 'Cartão de Crédito',
  })),
);
todosPassaram &= check('fingerprint e uma string hexadecimal (SHA-256, 64 chars)', /^[0-9a-f]{64}$/.test(gerarFingerprintVenda(venda15751)));

// ---------- 2. `source` NAO afeta o fingerprint ----------
console.log('\n=== 2. "source" excluido do fingerprint (mesmo fato, fontes diferentes) ===');
const vendaComOutroSource = Object.assign({}, venda15751, { source: 'export_extrato_cliente_individual' });
todosPassaram &= check(
  'fingerprint identico mesmo com source diferente',
  gerarFingerprintVenda(venda15751) === gerarFingerprintVenda(vendaComOutroSource),
);

// ---------- 3. Mudanca em campo relevante MUDA o fingerprint ----------
console.log('\n=== 3. Mudanca de amountPaid muda o fingerprint ===');
const vendaValorDiferente = Object.assign({}, venda15751, { amountPaid: 96 });
todosPassaram &= check(
  'fingerprint diferente quando amountPaid muda',
  gerarFingerprintVenda(venda15751) !== gerarFingerprintVenda(vendaValorDiferente),
);

// ---------- 4. Ordem incidental de propriedades JS nao afeta o fingerprint ----------
console.log('\n=== 4. Ordem de propriedades JS nao afeta o fingerprint (canonicalizacao) ===');
const vendaReordenada = {};
Object.keys(venda15751).reverse().forEach((k) => { vendaReordenada[k] = venda15751[k]; });
todosPassaram &= check(
  'fingerprint identico independente da ordem das chaves no objeto JS',
  gerarFingerprintVenda(venda15751) === gerarFingerprintVenda(vendaReordenada),
);

// ---------- 5. Ordem dos ITENS (array) e um FATO, nao acidente - deve importar ----------
console.log('\n=== 5. Ordem dos itens (array) e preservada como fato ===');
const vendaMultiItem = normalizarVendaNex({
  numero: '13005',
  tipo: 'Venda',
  data: '1/18/25',
  hora: '14:20',
  itens: '1 X CAMISETAS SUEDINE PREMIUM\r\n1 X BERMUDAS JR IMPORTADAS COM FORRO',
});
const vendaMultiItemInvertida = normalizarVendaNex({
  numero: '13005',
  tipo: 'Venda',
  data: '1/18/25',
  hora: '14:20',
  itens: '1 X BERMUDAS JR IMPORTADAS COM FORRO\r\n1 X CAMISETAS SUEDINE PREMIUM',
});
todosPassaram &= check(
  'fingerprint MUDA se a ordem dos itens for diferente (ordem de array e fato, nao ruido)',
  gerarFingerprintVenda(vendaMultiItem) !== gerarFingerprintVenda(vendaMultiItemInvertida),
);

// ---------- 6. Pagamento parcial #9999: amountPaid e amountDebt entram JUNTOS ----------
console.log('\n=== 6. #9999 pagamento parcial - amountPaid e amountDebt afetam o fingerprint ===');
const v9999 = normalizarVendaNex({
  numero: '9999', tipo: 'Venda', data: '10/19/23', hora: '17:23',
  valorPago: 'R$ 420.00 ', debitado: 'R$ 139.00 ', meioPagto: 'Cartão de Débito',
});
const v9999OutroDebito = Object.assign({}, v9999, { amountDebt: 100 });
todosPassaram &= check(
  'mudar SO amountDebt muda o fingerprint (amountPaid preservado)',
  gerarFingerprintVenda(v9999) !== gerarFingerprintVenda(v9999OutroDebito),
);
const v9999MesmoValores = normalizarVendaNex({
  numero: '9999', tipo: 'Venda', data: '10/19/23', hora: '17:23',
  valorPago: 'R$ 420.00 ', debitado: 'R$ 139.00 ', meioPagto: 'Cartão de Débito',
});
todosPassaram &= check('reimportacao identica de #9999 -> mesmo fingerprint', gerarFingerprintVenda(v9999) === gerarFingerprintVenda(v9999MesmoValores));

// ---------- 7. Fingerprint de transacao do cliente (Pagamento Débito) ----------
console.log('\n=== 7. gerarFingerprintTransacaoCliente - #15758 ===');
const t15758 = normalizarTransacaoClienteNex({
  noTran: '15758', data: '8/28/26', hora: '17:08', totalFinal: 'R$ 89.00 ',
  tipo: 'Pagamento Débito', vlProdutos: 'R$ 89.00 ', valorPago: 'R$ 89.00 ', meioPagto: 'Dinheiro',
});
const t15758Igual = normalizarTransacaoClienteNex({
  noTran: '15758', data: '8/28/26', hora: '17:08', totalFinal: 'R$ 89.00 ',
  tipo: 'Pagamento Débito', vlProdutos: 'R$ 89.00 ', valorPago: 'R$ 89.00 ', meioPagto: 'Dinheiro',
});
todosPassaram &= check('fingerprint identico para reimportacao identica de #15758', gerarFingerprintTransacaoCliente(t15758) === gerarFingerprintTransacaoCliente(t15758Igual));

const t15758ValorDiferente = Object.assign({}, t15758, { amountPaid: 90 });
todosPassaram &= check('fingerprint muda se amountPaid mudar', gerarFingerprintTransacaoCliente(t15758) !== gerarFingerprintTransacaoCliente(t15758ValorDiferente));

console.log(
  '\nResultado geral fingerprint-transacao-nex.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
