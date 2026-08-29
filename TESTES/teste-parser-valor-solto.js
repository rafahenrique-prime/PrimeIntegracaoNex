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

// ---------- CORRECAO DE BUG: formato EN-US (virgula=milhar, ponto=decimal) ----------
// Bug real encontrado na auditoria F2.3 (transacao #13252): valores EN-US
// com separador de milhar eram lidos como se fossem BR, produzindo um
// resultado com 1000x menos magnitude (ex.: "R$ 1,135.00" virava 1.135 em
// vez de 1135). Corrigido em parseValorBR: o separador DECIMAL e sempre o
// que ocorre por ULTIMO na string, independente de ser virgula ou ponto.
console.log('\n=== CORRECAO DE BUG: formato EN-US e ambos os formatos com milhar ===');
todosPassaram &= check('BUG REAL #13252: "R$ 1,135.00" (EN-US) -> 1135, NAO 1.135', parseValorSolto('R$ 1,135.00'), 1135);
todosPassaram &= check('"1,135.00" (EN-US, sem "R$") -> 1135', parseValorSolto('1,135.00'), 1135);
todosPassaram &= check('"R$ 1.135,00" (BR) -> 1135 (regressao explicita)', parseValorSolto('R$ 1.135,00'), 1135);
todosPassaram &= check('"1.135,00" (BR, sem "R$") -> 1135', parseValorSolto('1.135,00'), 1135);
todosPassaram &= check('"R$ 12.345,67" (BR, milhar+decimal) -> 12345.67', parseValorSolto('R$ 12.345,67'), 12345.67);
todosPassaram &= check('"12.345,67" (BR, sem "R$") -> 12345.67', parseValorSolto('12.345,67'), 12345.67);
todosPassaram &= check('"R$ 12,345.67" (EN-US, milhar+decimal) -> 12345.67', parseValorSolto('R$ 12,345.67'), 12345.67);
todosPassaram &= check('"12,345.67" (EN-US, sem "R$") -> 12345.67', parseValorSolto('12,345.67'), 12345.67);
todosPassaram &= check('"R$ 89" (sem separador) -> 89', parseValorSolto('R$ 89'), 89);
todosPassaram &= check('"89,00" (BR, sem milhar) -> 89', parseValorSolto('89,00'), 89);
todosPassaram &= check('"0" -> 0', parseValorSolto('0'), 0);
todosPassaram &= check('"0,00" -> 0', parseValorSolto('0,00'), 0);
todosPassaram &= check('"0.00" -> 0', parseValorSolto('0.00'), 0);

// Mesmas correcoes verificadas diretamente em parseValorBR (usado tambem
// pelo parser de Debito/Credito rotulado - garante que a correcao e
// visivel na funcao compartilhada, nao so no wrapper).
todosPassaram &= check('parseValorBR("1,135.00") (EN-US) -> 1135', parseValorBR('1,135.00'), 1135);
todosPassaram &= check('parseValorBR("1.135,00") (BR) -> 1135 (regressao explicita)', parseValorBR('1.135,00'), 1135);
todosPassaram &= check('parseValorBR("12,345.67") (EN-US) -> 12345.67', parseValorBR('12,345.67'), 12345.67);
todosPassaram &= check('parseValorBR("12.345,67") (BR) -> 12345.67 (regressao explicita)', parseValorBR('12.345,67'), 12345.67);

console.log(
  '\nResultado geral parseValorSolto:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
