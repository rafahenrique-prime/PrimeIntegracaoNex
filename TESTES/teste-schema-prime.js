'use strict';

/**
 * Teste PERMANENTE de SRC/schema-prime.js (Fase 2A).
 * Recriado em 2026-07-30 (Fase 4D - preparacao pre-commit): este modulo
 * nunca teve um arquivo de teste preservado - os casos abaixo reproduzem
 * exatamente os testes isolados ja executados e aprovados durante a
 * Fase 2A (incluindo os ajustes das Fases 2A-final: saldo_debito_anterior/
 * variacao_saldo, cadastro_score, origem_sistema como enum), sem
 * nenhuma regra nova.
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { SCHEMA_PRIME } = require(path.join(SRC, 'schema-prime'));

let todosPassaram = true;
function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  todosPassaram &= cond;
}

check('E um array', Array.isArray(SCHEMA_PRIME));
check('Tem pelo menos 1 campo', SCHEMA_PRIME.length > 0);
console.log('Total de campos no schema:', SCHEMA_PRIME.length);

const chavesEsperadas = ['campo', 'tipo', 'obrigatorio', 'origem', 'finalidade', 'editavel'];
const todosComChaves = SCHEMA_PRIME.every((c) => chavesEsperadas.every((k) => Object.prototype.hasOwnProperty.call(c, k)));
check('Todos os campos tem as 6 propriedades exigidas', todosComChaves);

const nomes = SCHEMA_PRIME.map((c) => c.campo);
const semDuplicados = new Set(nomes).size === nomes.length;
check('Nenhum nome de campo duplicado', semDuplicados);

const origensValidas = new Set(['NEX', 'Derivado', 'PRIME', 'IA', 'PRIME/IA']);
const origensOk = SCHEMA_PRIME.every((c) => origensValidas.has(c.origem));
check('Todas as origens pertencem ao conjunto NEX/Derivado/PRIME/IA', origensOk);

check('prime_id presente e origem PRIME', SCHEMA_PRIME.some((c) => c.campo === 'prime_id' && c.origem === 'PRIME'));
check('nex_codigo presente e origem NEX', SCHEMA_PRIME.some((c) => c.campo === 'nex_codigo' && c.origem === 'NEX'));
check('cadastro_score presente (ajuste 2)', SCHEMA_PRIME.some((c) => c.campo === 'cadastro_score'));
check('saldo_debito_anterior presente (ajuste 1)', SCHEMA_PRIME.some((c) => c.campo === 'saldo_debito_anterior'));
check('variacao_saldo presente (ajuste 1)', SCHEMA_PRIME.some((c) => c.campo === 'variacao_saldo'));
check('origem_sistema e enum (ajuste 3)', SCHEMA_PRIME.some((c) => c.campo === 'origem_sistema' && /enum/.test(c.tipo)));

console.log('\nResultado geral schema-prime.js:', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
process.exitCode = todosPassaram ? 0 : 1;
