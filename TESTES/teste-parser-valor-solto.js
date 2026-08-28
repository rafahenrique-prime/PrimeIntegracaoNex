'use strict';

/**
 * Teste de SRC/parser-financeiro.js::parseValorSolto (Fase EXPORT-FIRST -
 * Fase A). Arquivo separado de teste-parser-financeiro.js (teste PERMANENTE
 * ja existente da Fase 2A) para nao mexer num teste ja aprovado.
 * Executar com: node TESTES\teste-parser-valor-solto.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { parseValorSolto, parseValorBR } = require(path.join(SRC, 'parser-financeiro'));

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

todosPassaram &= check('"R$ 87.00 " (ponto decimal, com espaco a direita)', parseValorSolto('R$ 87.00 '), 87);
todosPassaram &= check('"R$ 1.135,00" (padrao BR: ponto=milhar, virgula=decimal)', parseValorSolto('R$ 1.135,00'), 1135);
todosPassaram &= check('"87.00" sem "R$"', parseValorSolto('87.00'), 87);
todosPassaram &= check('String vazia', parseValorSolto(''), null);
todosPassaram &= check('null', parseValorSolto(null), null);
todosPassaram &= check('undefined', parseValorSolto(undefined), null);
todosPassaram &= check('Apenas espacos', parseValorSolto('   '), null);
todosPassaram &= check('"R$" sozinho, sem numero', parseValorSolto('R$'), null);
todosPassaram &= check('Valor de venda real #15751 (R$ 97.00 )', parseValorSolto('R$ 97.00 '), 97);
todosPassaram &= check('Valor de venda real #15756 (R$ 89.00 )', parseValorSolto('R$ 89.00 '), 89);
todosPassaram &= check('Valor com centavos reais (R$ 97.90)', parseValorSolto('R$ 97.90'), 97.9);
todosPassaram &= check('Valor grande com virgula BR (R$ 25.414,58)', parseValorSolto('R$ 25.414,58'), 25414.58);

// Garante que a extensao nao alterou o comportamento ja aprovado de parseValorBR.
todosPassaram &= check('parseValorBR("150,00") continua igual (regressao)', parseValorBR('150,00'), 150);
todosPassaram &= check('parseValorBR("1.234,56") continua igual (regressao)', parseValorBR('1.234,56'), 1234.56);

console.log(
  '\nResultado geral parseValorSolto:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
