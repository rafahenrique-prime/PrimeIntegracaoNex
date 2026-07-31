'use strict';

/**
 * Teste PERMANENTE de SRC/parser-observacoes.js (Fase 2A).
 * Recriado em 2026-07-30 (Fase 4D - preparacao pre-commit): este modulo
 * nunca teve um arquivo de teste preservado - os casos abaixo reproduzem
 * exatamente os testes isolados ja executados e aprovados durante a
 * Fase 2A, sem nenhuma regra nova.
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { classificarObservacao } = require(path.join(SRC, 'parser-observacoes'));

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
  'Estruturada (dia + parcela + valor)',
  classificarObservacao('2x 75,00 todo dia 20'),
  { categoria: 'estruturada', vazio: false, dias: [20], parcelas: [2], valores: ['75,00'] },
);

todosPassaram &= check(
  'Parcialmente estruturada (so dia)',
  classificarObservacao('dia 15'),
  { categoria: 'parcialmente_estruturada', vazio: false, dias: [15], parcelas: [], valores: [] },
);

todosPassaram &= check(
  'Texto operacional (sem sinal reconhecivel)',
  classificarObservacao('avisar antes de entregar'),
  { categoria: 'texto_operacional', vazio: false, dias: [], parcelas: [], valores: [] },
);

todosPassaram &= check(
  'Ambigua (dois dias conflitantes)',
  classificarObservacao('dia 5 ou dia 20'),
  { categoria: 'ambigua', vazio: false, dias: [5, 20], parcelas: [], valores: [] },
);

todosPassaram &= check(
  'Vazia',
  classificarObservacao(''),
  { categoria: 'vazia', vazio: true, dias: [], parcelas: [], valores: [] },
);

console.log('\nResultado geral parser-observacoes.js:', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
process.exitCode = todosPassaram ? 0 : 1;
