'use strict';

/**
 * Teste de SRC/parser-itens-venda.js (Fase EXPORT-FIRST - Fase A).
 * Executar com: node TESTES\teste-parser-itens-venda.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { parseItensVenda } = require(path.join(SRC, 'parser-itens-venda'));

function check(desc, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((pass ? 'PASS' : 'FALHOU') + ' - ' + desc);
  if (!pass) {
    console.log('  esperado:', JSON.stringify(expected));
    console.log('  obtido  :', JSON.stringify(actual));
  }
  return pass;
}

let todosPassaram = true;

todosPassaram &= check(
  'Item unico (venda #15756)',
  parseItensVenda('1 X BRAND 018 HUGO BOSS'),
  [{ quantidade: 1, produto: 'BRAND 018 HUGO BOSS' }],
);

todosPassaram &= check(
  'Multi-item com CRLF (venda #13005 real)',
  parseItensVenda('1 X CAMISETAS SUEDINE PREMIUM\r\n1 X BERMUDAS JR IMPORTADAS COM FORRO'),
  [
    { quantidade: 1, produto: 'CAMISETAS SUEDINE PREMIUM' },
    { quantidade: 1, produto: 'BERMUDAS JR IMPORTADAS COM FORRO' },
  ],
);

todosPassaram &= check(
  'Quantidade maior que 1 (venda #12098 real)',
  parseItensVenda('2 X CAMISETAS VARIADAS  G2/G3'),
  [{ quantidade: 2, produto: 'CAMISETAS VARIADAS  G2/G3' }],
);

todosPassaram &= check('String vazia', parseItensVenda(''), []);
todosPassaram &= check('null', parseItensVenda(null), []);
todosPassaram &= check('undefined', parseItensVenda(undefined), []);

todosPassaram &= check(
  'Linha fora do padrao "N X produto" preserva o texto sem inventar quantidade',
  parseItensVenda('texto livre sem padrao'),
  [{ quantidade: null, produto: 'texto livre sem padrao' }],
);

todosPassaram &= check(
  'Tres itens (venda #12746 real)',
  parseItensVenda(
    '1 X 2025 BRAND FAME FEM ROBO ROSA\r\n1 X CARTEIRAS LINHA PREMIUM 07/06\r\n1 X CAMISETAS DIESEL HUGO BOSS PRADA 18/07',
  ),
  [
    { quantidade: 1, produto: '2025 BRAND FAME FEM ROBO ROSA' },
    { quantidade: 1, produto: 'CARTEIRAS LINHA PREMIUM 07/06' },
    { quantidade: 1, produto: 'CAMISETAS DIESEL HUGO BOSS PRADA 18/07' },
  ],
);

console.log('\nResultado geral parser-itens-venda.js:', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
process.exitCode = todosPassaram ? 0 : 1;
