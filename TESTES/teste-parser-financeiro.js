'use strict';

/**
 * Teste PERMANENTE de SRC/parser-financeiro.js (Fase 2A).
 * Recriado em 2026-07-30 (Fase 4D - preparacao pre-commit): este modulo
 * nunca teve um arquivo de teste preservado - os casos abaixo reproduzem
 * exatamente os testes isolados ja executados e aprovados durante a
 * Fase 2A, sem nenhuma regra nova.
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { parseFinanceiro } = require(path.join(SRC, 'parser-financeiro'));

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
  'Debito com hifen',
  parseFinanceiro('Débito- R$ 150,00'),
  { tipo: 'reconhecido', raw: 'Débito- R$ 150,00', debito: 150, credito: 0 },
);

todosPassaram &= check(
  'Debito com dois-pontos e milhar',
  parseFinanceiro('Débito: R$ 1.234,56'),
  { tipo: 'reconhecido', raw: 'Débito: R$ 1.234,56', debito: 1234.56, credito: 0 },
);

todosPassaram &= check(
  'Credito com hifen',
  parseFinanceiro('Crédito- R$ 50,00'),
  { tipo: 'reconhecido', raw: 'Crédito- R$ 50,00', debito: 0, credito: 50 },
);

todosPassaram &= check(
  'Debito e credito na mesma celula',
  parseFinanceiro('Débito- R$ 100,00 Crédito- R$ 20,00'),
  { tipo: 'reconhecido', raw: 'Débito- R$ 100,00 Crédito- R$ 20,00', debito: 100, credito: 20 },
);

todosPassaram &= check('Celula vazia', parseFinanceiro(''), { tipo: 'vazio', raw: '', debito: null, credito: null });
todosPassaram &= check('Celula zero puro', parseFinanceiro('R$ 0,00'), { tipo: 'zero', raw: 'R$ 0,00', debito: 0, credito: 0 });
todosPassaram &= check(
  'Texto sem rotulo nem numero',
  parseFinanceiro('texto aleatorio sem valor'),
  { tipo: 'formato_nao_reconhecido', raw: 'texto aleatorio sem valor', debito: null, credito: null },
);

console.log('\nResultado geral parser-financeiro.js:', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
process.exitCode = todosPassaram ? 0 : 1;
