'use strict';

/**
 * Teste de SRC/normalizar-cliente-nex.js (Fase EXPORT-FIRST - Fase B).
 * Executar com: node TESTES\teste-normalizar-cliente-nex.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { normalizarClienteNex, validarClienteNex } = require(path.join(SRC, 'normalizar-cliente-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

// ---------- 1. MATHEUS HENRIQUE DEPRE (292) - dado real auditado ----------
console.log('\n=== 1. MATHEUS HENRIQUE DEPRE (Código 292) ===');
const matheus = normalizarClienteNex({
  nome: 'MATHEUS HENRIQUE DEPRE',
  codigo: '292',
  debitoCredito: '',
  celular: '98429308',
  telefone: '',
  cpfCnpj: '',
  status: 'Ativo',
  incluidoEm: '23/12/2020 19:20:20',
  alteradoEm: '24/06/2024 18:52:20',
});
todosPassaram &= check('nexCustomerCode = "292" (string)', matheus.nexCustomerCode === '292');
todosPassaram &= check('nexCustomerCode e tipo string (nao Number)', typeof matheus.nexCustomerCode === 'string');
todosPassaram &= check('nome preservado', matheus.nome === 'MATHEUS HENRIQUE DEPRE');
todosPassaram &= check('nomeNormalizado = "MATHEUS HENRIQUE DEPRE"', matheus.nomeNormalizado === 'MATHEUS HENRIQUE DEPRE');
todosPassaram &= check('celular = "98429308"', matheus.celular === '98429308');
todosPassaram &= check('telefone vazio vira null', matheus.telefone === null);
todosPassaram &= check('status = "Ativo"', matheus.status === 'Ativo');
todosPassaram &= check('source = "export_clientes"', matheus.source === 'export_clientes');
const validacaoMatheus = validarClienteNex(matheus);
todosPassaram &= check('Matheus: status = valido', validacaoMatheus.status === 'valido');
todosPassaram &= check('Matheus: sem erros', validacaoMatheus.erros.length === 0);

// ---------- 2. CANELINHA (316) - dado real auditado ----------
console.log('\n=== 2. CANELINHA (Código 316) ===');
const canelinha = normalizarClienteNex({
  nome: 'CANELINHA',
  codigo: '316',
  observacoes: 'DIA 23-04',
  celular: '97158642',
  status: 'Ativo',
});
todosPassaram &= check('nexCustomerCode = "316"', canelinha.nexCustomerCode === '316');
todosPassaram &= check('nomeNormalizado = "CANELINHA"', canelinha.nomeNormalizado === 'CANELINHA');

// ---------- 3. Nome com acento e espacos extras ----------
console.log('\n=== 3. Nome com acento e espacos extras ===');
const comAcento = normalizarClienteNex({ nome: '  André   Luís  ', codigo: '13' });
todosPassaram &= check('nome preserva o original (com acentos/espacos)', comAcento.nome === 'André   Luís');
todosPassaram &= check('nomeNormalizado remove acentos e colapsa espacos', comAcento.nomeNormalizado === 'ANDRE LUIS');

// ---------- 4. Codigo com zero a esquerda preservado como string ----------
console.log('\n=== 4. Codigo com zero a esquerda (hipotetico) preservado ===');
const comZero = normalizarClienteNex({ nome: 'CLIENTE TESTE', codigo: '007' });
todosPassaram &= check('codigo "007" preservado exatamente (nao virou 7)', comZero.nexCustomerCode === '007');

// ---------- 5. Campos essenciais ausentes (Codigo) ----------
console.log('\n=== 5. Codigo ausente ===');
const semCodigo = normalizarClienteNex({ nome: 'CLIENTE SEM CODIGO', codigo: '' });
todosPassaram &= check('nexCustomerCode = null', semCodigo.nexCustomerCode === null);
const validacaoSemCodigo = validarClienteNex(semCodigo);
todosPassaram &= check('status = invalido', validacaoSemCodigo.status === 'invalido');
todosPassaram &= check('erro menciona Código', validacaoSemCodigo.erros.some((e) => e.includes('Código')));

// ---------- 6. Campos essenciais ausentes (Nome) ----------
console.log('\n=== 6. Nome ausente ===');
const semNome = normalizarClienteNex({ nome: '', codigo: '999' });
todosPassaram &= check('nome = string vazia (nao undefined)', semNome.nome === '');
const validacaoSemNome = validarClienteNex(semNome);
todosPassaram &= check('status = invalido', validacaoSemNome.status === 'invalido');
todosPassaram &= check('erro menciona Nome', validacaoSemNome.erros.some((e) => e.includes('Nome')));

// ---------- 7. Registro totalmente vazio nao lanca excecao ----------
console.log('\n=== 7. Registro vazio (defensivo) ===');
let lancouExcecao = false;
try {
  normalizarClienteNex({});
  normalizarClienteNex(null);
} catch (e) {
  lancouExcecao = true;
}
todosPassaram &= check('normalizarClienteNex nao lanca excecao com entrada vazia/null', !lancouExcecao);

console.log(
  '\nResultado geral normalizar-cliente-nex.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
