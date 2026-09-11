'use strict';

/**
 * Teste de SRC/normalizar-cliente-nex.js (Fase EXPORT-FIRST - Fase B).
 * Executar com: node TESTES\teste-normalizar-cliente-nex.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { normalizarClienteNex, validarClienteNex, ehPlaceholder, montarEndereco } = require(path.join(SRC, 'normalizar-cliente-nex'));

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

// ---------- 8. Placeholders literais (F6.16G - hardening) ----------
console.log('\n=== 8. ehPlaceholder: placeholders literais ===');
todosPassaram &= check('null real -> placeholder', ehPlaceholder(null) === true);
todosPassaram &= check('undefined real -> placeholder', ehPlaceholder(undefined) === true);
todosPassaram &= check('"" -> placeholder', ehPlaceholder('') === true);
todosPassaram &= check('"   " -> placeholder', ehPlaceholder('   ') === true);
todosPassaram &= check('"null" -> placeholder', ehPlaceholder('null') === true);
todosPassaram &= check('"NULL" -> placeholder (case-insensitive)', ehPlaceholder('NULL') === true);
todosPassaram &= check('"undefined" -> placeholder', ehPlaceholder('undefined') === true);
todosPassaram &= check('"UNDEFINED" -> placeholder (case-insensitive)', ehPlaceholder('UNDEFINED') === true);
todosPassaram &= check('"NaN" -> placeholder', ehPlaceholder('NaN') === true);
todosPassaram &= check('"nan" -> placeholder (case-insensitive)', ehPlaceholder('nan') === true);

// ---------- 9. Hifen isolado vs hifen dentro de valor real ----------
console.log('\n=== 9. Hifen: isolado vira ausente, dentro de valor real e preservado ===');
todosPassaram &= check('"-" com tratarHifenComoAusente=true -> placeholder', ehPlaceholder('-', { tratarHifenComoAusente: true }) === true);
todosPassaram &= check('"-" com tratarHifenComoAusente=false -> NAO placeholder', ehPlaceholder('-', { tratarHifenComoAusente: false }) === false);
todosPassaram &= check('"Rua A-10" (hifenMode=true) -> NUNCA placeholder', ehPlaceholder('Rua A-10', { tratarHifenComoAusente: true }) === false);
todosPassaram &= check('"Rua A-10" (hifenMode=false) -> NUNCA placeholder', ehPlaceholder('Rua A-10', { tratarHifenComoAusente: false }) === false);

const emailComHifen = normalizarClienteNex({ nome: 'X', codigo: '1', email: '-' });
todosPassaram &= check('email "-" -> ausente (null)', emailComHifen.email === null);
const telefoneComHifen = normalizarClienteNex({ nome: 'X', codigo: '1', telefone: '-' });
todosPassaram &= check('telefone "-" -> ausente (null)', telefoneComHifen.telefone === null);
const cpfComHifen = normalizarClienteNex({ nome: 'X', codigo: '1', cpfCnpj: '-' });
todosPassaram &= check('cpfCnpj "-" -> ausente (null)', cpfComHifen.cpfCnpj === null);
const obsComHifen = normalizarClienteNex({ nome: 'X', codigo: '1', observacoes: '-' });
todosPassaram &= check('observacoes "-" -> PRESERVADO (nao e placeholder ali)', obsComHifen.observacoes === '-');

// ---------- 10. Endereco: componentes e placeholders ----------
console.log('\n=== 10. montarEndereco ===');
todosPassaram &= check('todos componentes vazios -> endereco ausente (null)', montarEndereco({}) === null);
todosPassaram &= check('linhaBruta undefined -> endereco ausente (null)', montarEndereco(undefined) === null);

const enderecoRealComCepPlaceholder = montarEndereco({
  Endereço: 'Rua das Flores', Número: '123', Complemento: '', Bairro: 'Centro',
  Cidade: 'São Paulo', Estado: 'SP', CEP: '-',
});
todosPassaram &= check(
  'endereco real + CEP "-" -> preserva endereco real, remove so o CEP placeholder',
  enderecoRealComCepPlaceholder === 'Rua das Flores, 123, Centro, São Paulo, SP',
);

const enderecoIsoladoHifen = montarEndereco({ Endereço: '-' });
todosPassaram &= check('endereco (Endereço) "-" isolado -> ausente (null)', enderecoIsoladoHifen === null);

const clienteComEnderecoENex = normalizarClienteNex({
  nome: 'X', codigo: '1',
  linhaBruta: { Endereço: 'Rua A-10', Número: '', Complemento: '', Bairro: '', Cidade: '', Estado: '', CEP: '' },
});
todosPassaram &= check('normalizarClienteNex: "Rua A-10" preservado dentro do endereco composto', clienteComEnderecoENex.endereco === 'Rua A-10');

// ---------- 11. Email/Observacoes: "null" vira ausente, texto real preservado ----------
console.log('\n=== 11. Email/Observacoes ===');
const clienteEmailNull = normalizarClienteNex({ nome: 'X', codigo: '1', email: 'null' });
todosPassaram &= check('email "null" -> ausente (null)', clienteEmailNull.email === null);
const clienteEmailReal = normalizarClienteNex({ nome: 'X', codigo: '1', email: 'contato@exemplo.com' });
todosPassaram &= check('email real preservado', clienteEmailReal.email === 'contato@exemplo.com');
const clienteObsNull = normalizarClienteNex({ nome: 'X', codigo: '1', observacoes: 'null' });
todosPassaram &= check('observacoes "null" -> ausente (null)', clienteObsNull.observacoes === null);
const clienteObsReal = normalizarClienteNex({ nome: 'X', codigo: '1', observacoes: 'DIA 23-04' });
todosPassaram &= check('observacoes texto real preservado', clienteObsReal.observacoes === 'DIA 23-04');

// ---------- 12. Telefone/Celular: reais preservados, placeholders ausentes ----------
console.log('\n=== 12. Telefone/Celular ===');
const clienteContatoReal = normalizarClienteNex({ nome: 'X', codigo: '1', celular: '98429308', telefone: '32210000' });
todosPassaram &= check('celular real preservado', clienteContatoReal.celular === '98429308');
todosPassaram &= check('telefone real preservado', clienteContatoReal.telefone === '32210000');
const clienteContatoPlaceholder = normalizarClienteNex({ nome: 'X', codigo: '1', celular: 'undefined', telefone: 'NaN' });
todosPassaram &= check('celular placeholder -> ausente', clienteContatoPlaceholder.celular === null);
todosPassaram &= check('telefone placeholder -> ausente', clienteContatoPlaceholder.telefone === null);

// ---------- 13. Status: valor bruto preservado + statusBase44 mapeado ----------
console.log('\n=== 13. Status ===');
const clienteAtivo = normalizarClienteNex({ nome: 'X', codigo: '1', status: 'Ativo' });
todosPassaram &= check('status bruto = "Ativo" (preservado, nao quebra contrato existente)', clienteAtivo.status === 'Ativo');
todosPassaram &= check('statusBase44 = "ativo"', clienteAtivo.statusBase44 === 'ativo');
const clienteInativo = normalizarClienteNex({ nome: 'X', codigo: '1', status: 'Inativo' });
todosPassaram &= check('statusBase44 = "inativo"', clienteInativo.statusBase44 === 'inativo');

// ---------- 14. Casos reais homologados (F6.16E/F6.16F) - reproduzidos estruturalmente, sem PII ----------
console.log('\n=== 14. Casos reais homologados (884, 950, 965, 992, 1182, 1362) ===');

// 884/950: endereco inteiro era literalmente "-" -> deve virar ausente
const caso884 = normalizarClienteNex({ nome: 'CLIENTE 884', codigo: '884', linhaBruta: { Endereço: '-' } });
todosPassaram &= check('caso 884: endereco "-" isolado -> ausente', caso884.endereco === null);
const caso950 = normalizarClienteNex({ nome: 'CLIENTE 950', codigo: '950', linhaBruta: { Endereço: '-' } });
todosPassaram &= check('caso 950: endereco "-" isolado -> ausente', caso950.endereco === null);

// 965/992: endereco real com CEP="-" -> preserva o real, remove so o CEP
const caso965 = normalizarClienteNex({
  nome: 'CLIENTE 965', codigo: '965',
  linhaBruta: { Endereço: 'Rua Exemplo', Número: '10', Bairro: 'Bairro X', CEP: '-' },
});
todosPassaram &= check('caso 965: endereco real preservado, CEP "-" removido', caso965.endereco === 'Rua Exemplo, 10, Bairro X');
const caso992 = normalizarClienteNex({
  nome: 'CLIENTE 992', codigo: '992',
  linhaBruta: { Endereço: 'Avenida Exemplo', Número: '200', Bairro: 'Bairro Y', Cidade: 'Cidade Z', CEP: '-' },
});
todosPassaram &= check('caso 992: endereco real preservado, CEP "-" removido', caso992.endereco === 'Avenida Exemplo, 200, Bairro Y, Cidade Z');

// 1182: observacoes = "null" -> ausente
const caso1182 = normalizarClienteNex({ nome: 'CLIENTE 1182', codigo: '1182', observacoes: 'null' });
todosPassaram &= check('caso 1182: observacoes "null" -> ausente', caso1182.observacoes === null);

// 1362: email = "null" E observacoes = "null" -> ambos ausentes
const caso1362 = normalizarClienteNex({ nome: 'CLIENTE 1362', codigo: '1362', email: 'null', observacoes: 'null' });
todosPassaram &= check('caso 1362: email "null" -> ausente', caso1362.email === null);
todosPassaram &= check('caso 1362: observacoes "null" -> ausente', caso1362.observacoes === null);

console.log(
  '\nResultado geral normalizar-cliente-nex.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
