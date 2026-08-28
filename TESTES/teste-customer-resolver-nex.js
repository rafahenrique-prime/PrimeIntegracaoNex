'use strict';

/**
 * Teste de SRC/customer-resolver-nex.js (Fase EXPORT-FIRST - Fase C).
 * Executar com: node TESTES\teste-customer-resolver-nex.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { criarIndiceClientes, resolverCliente, resolverClienteDaVenda } = require(path.join(SRC, 'customer-resolver-nex'));
const { normalizarClienteNex } = require(path.join(SRC, 'normalizar-cliente-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

// ---------- Indice base, com dados reais + sinteticos coerentes ----------
const clientesBase = [
  normalizarClienteNex({ nome: 'MATHEUS HENRIQUE DEPRE', codigo: '292', status: 'Ativo' }),
  normalizarClienteNex({ nome: 'CANELINHA', codigo: '316', status: 'Ativo' }),
  // Ambiguidade real do cadastro (CAROL BARBOSA tem 5 codigos reais: 236-240; aqui uso 3 para o teste)
  normalizarClienteNex({ nome: 'CAROL BARBOSA', codigo: '236' }),
  normalizarClienteNex({ nome: 'CAROL BARBOSA', codigo: '238' }),
  normalizarClienteNex({ nome: 'CAROL BARBOSA', codigo: '240' }),
  // Cliente com nome vazio - nao deve virar candidato utilizavel
  normalizarClienteNex({ nome: '', codigo: '999' }),
  // Cliente sem codigo - nao deve virar candidato utilizavel
  normalizarClienteNex({ nome: 'SEM CODIGO', codigo: '' }),
];

// ---------- 1. Construcao do indice ----------
console.log('\n=== 1. criarIndiceClientes ===');
const indice = criarIndiceClientes(clientesBase);
todosPassaram &= check('indice e uma Map', indice instanceof Map);
todosPassaram &= check('MATHEUS HENRIQUE DEPRE tem exatamente 1 candidato', indice.get('MATHEUS HENRIQUE DEPRE').length === 1);
todosPassaram &= check('CANELINHA tem exatamente 1 candidato', indice.get('CANELINHA').length === 1);
todosPassaram &= check('CAROL BARBOSA tem 3 candidatos (ambiguidade preservada, NAO colapsada)', indice.get('CAROL BARBOSA').length === 3);
todosPassaram &= check('cliente com nome vazio NAO entra no indice', !indice.has(''));
todosPassaram &= check('cliente sem codigo NAO entra no indice', !indice.has('SEM CODIGO'));
todosPassaram &= check('indice nao tem chave por codigo-unico (e Map<nome, array>)', Array.isArray(indice.get('CANELINHA')));

// ---------- 2. MATHEUS HENRIQUE DEPRE -> RESOLVED / 292 ----------
console.log('\n=== 2. MATHEUS HENRIQUE DEPRE -> RESOLVED (292) ===');
const rMatheus = resolverCliente('MATHEUS HENRIQUE DEPRE', indice);
todosPassaram &= check('status = RESOLVED', rMatheus.status === 'RESOLVED');
todosPassaram &= check('nexCustomerCode = "292"', rMatheus.nexCustomerCode === '292');
todosPassaram &= check('nexCustomerCode e string', typeof rMatheus.nexCustomerCode === 'string');
todosPassaram &= check('nomeOriginal preservado', rMatheus.nomeOriginal === 'MATHEUS HENRIQUE DEPRE');

// ---------- 3. CANELINHA -> RESOLVED / 316 ----------
console.log('\n=== 3. CANELINHA -> RESOLVED (316) ===');
const rCanelinha = resolverCliente('CANELINHA', indice);
todosPassaram &= check('status = RESOLVED', rCanelinha.status === 'RESOLVED');
todosPassaram &= check('nexCustomerCode = "316"', rCanelinha.nexCustomerCode === '316');

// ---------- 4. Nome com acento, espacos extras e caixa mista -> ainda RESOLVED / 292 ----------
console.log('\n=== 4. "  Matheus Henrique Depré  " -> RESOLVED (292), prova reuso de normalizarNomeClienteNex ===');
const rMatheusVariado = resolverCliente('  Matheus Henrique Depré  ', indice);
todosPassaram &= check('status = RESOLVED', rMatheusVariado.status === 'RESOLVED');
todosPassaram &= check('nexCustomerCode = "292"', rMatheusVariado.nexCustomerCode === '292');
todosPassaram &= check('nomeOriginal preserva o texto bruto (com acento/espacos)', rMatheusVariado.nomeOriginal === 'Matheus Henrique Depré');
todosPassaram &= check('nomeNormalizado = "MATHEUS HENRIQUE DEPRE"', rMatheusVariado.nomeNormalizado === 'MATHEUS HENRIQUE DEPRE');

// ---------- 5. CAROL BARBOSA -> REVIEW_REQUIRED / MULTIPLOS_MATCHES ----------
console.log('\n=== 5. CAROL BARBOSA -> REVIEW_REQUIRED / MULTIPLOS_MATCHES ===');
const rCarol = resolverCliente('CAROL BARBOSA', indice);
todosPassaram &= check('status = REVIEW_REQUIRED', rCarol.status === 'REVIEW_REQUIRED');
todosPassaram &= check('motivo = MULTIPLOS_MATCHES', rCarol.motivo === 'MULTIPLOS_MATCHES');
todosPassaram &= check('candidatos preservados (3)', rCarol.candidatos.length === 3);
todosPassaram &= check(
  'candidatos contem os 3 codigos esperados',
  ['236', '238', '240'].every((c) => rCarol.candidatos.some((cand) => cand.nexCustomerCode === c)),
);
todosPassaram &= check('nenhum campo nexCustomerCode escolhido automaticamente na resolucao ambigua', !('nexCustomerCode' in rCarol));

// ---------- 6. GORDO PROZA -> REVIEW_REQUIRED / SEM_MATCH ----------
console.log('\n=== 6. GORDO PROZA -> REVIEW_REQUIRED / SEM_MATCH ===');
const rGordo = resolverCliente('GORDO PROZA', indice);
todosPassaram &= check('status = REVIEW_REQUIRED', rGordo.status === 'REVIEW_REQUIRED');
todosPassaram &= check('motivo = SEM_MATCH', rGordo.motivo === 'SEM_MATCH');
todosPassaram &= check('candidatos = [] (vazio)', Array.isArray(rGordo.candidatos) && rGordo.candidatos.length === 0);

// ---------- 7. Ausencia TOTAL de fuzzy matching ----------
console.log('\n=== 7. Ausencia de fuzzy matching (nome parecido NAO deve casar) ===');
const rParecidoMatheus = resolverCliente('MATHEUS HENRIQUE', indice); // existe "MATHEUS HENRIQUE DEPRE", mas nao "MATHEUS HENRIQUE" puro
todosPassaram &= check('"MATHEUS HENRIQUE" (sem DEPRE) -> SEM_MATCH (nao aproxima por prefixo)', rParecidoMatheus.status === 'REVIEW_REQUIRED' && rParecidoMatheus.motivo === 'SEM_MATCH');

const rSubstring = resolverCliente('CANELIN', indice); // substring de CANELINHA, nao deve casar via includes/startsWith
todosPassaram &= check('"CANELIN" (substring) -> SEM_MATCH (nao usa includes/startsWith)', rSubstring.status === 'REVIEW_REQUIRED' && rSubstring.motivo === 'SEM_MATCH');

const rComErroDigitacao = resolverCliente('CANELINHAA', indice); // 1 letra a mais - fuzzy/Levenshtein casaria, exato nao deve
todosPassaram &= check('"CANELINHAA" (erro de digitacao) -> SEM_MATCH (nao usa Levenshtein/similaridade)', rComErroDigitacao.status === 'REVIEW_REQUIRED' && rComErroDigitacao.motivo === 'SEM_MATCH');

// ---------- 8. Cliente sem customerName na venda ----------
console.log('\n=== 8. Venda sem customerName (null) ===');
const rVazio = resolverCliente(null, indice);
todosPassaram &= check('nomeVenda null -> REVIEW_REQUIRED/SEM_MATCH (nao lanca excecao)', rVazio.status === 'REVIEW_REQUIRED' && rVazio.motivo === 'SEM_MATCH');
todosPassaram &= check('nomeNormalizado = string vazia', rVazio.nomeNormalizado === '');

const rStringVazia = resolverCliente('', indice);
todosPassaram &= check('nomeVenda string vazia -> REVIEW_REQUIRED/SEM_MATCH', rStringVazia.status === 'REVIEW_REQUIRED' && rStringVazia.motivo === 'SEM_MATCH');

const rSoEspacos = resolverCliente('   ', indice);
todosPassaram &= check('nomeVenda so espacos -> REVIEW_REQUIRED/SEM_MATCH', rSoEspacos.status === 'REVIEW_REQUIRED' && rSoEspacos.motivo === 'SEM_MATCH');

// ---------- 9. resolverClienteDaVenda - nao muta a venda original ----------
console.log('\n=== 9. resolverClienteDaVenda - imutabilidade ===');
const vendaOriginal = Object.freeze({ nexTransactionId: '15756', customerName: 'MATHEUS HENRIQUE DEPRE' });
const combinado = resolverClienteDaVenda(vendaOriginal, indice);
todosPassaram &= check('venda original congelada nao foi mutada (Object.freeze nao lancou)', combinado.venda === vendaOriginal);
todosPassaram &= check('resolucaoCliente.status = RESOLVED', combinado.resolucaoCliente.status === 'RESOLVED');
todosPassaram &= check('resolucaoCliente.nexCustomerCode = "292"', combinado.resolucaoCliente.nexCustomerCode === '292');
todosPassaram &= check('venda original NAO ganhou campo nexCustomerCode por mutacao', !('nexCustomerCode' in vendaOriginal));

const vendaSemCliente = { nexTransactionId: '1', customerName: null };
const combinadoSemCliente = resolverClienteDaVenda(vendaSemCliente, indice);
todosPassaram &= check('venda sem customerName -> resolucaoCliente REVIEW_REQUIRED/SEM_MATCH', combinadoSemCliente.resolucaoCliente.status === 'REVIEW_REQUIRED' && combinadoSemCliente.resolucaoCliente.motivo === 'SEM_MATCH');

// ---------- 10. Indice vazio nao lanca excecao ----------
console.log('\n=== 10. Indice vazio / entradas invalidas ===');
const indiceVazio = criarIndiceClientes([]);
todosPassaram &= check('indice de lista vazia e Map vazia', indiceVazio.size === 0);
const indiceComLixo = criarIndiceClientes([null, undefined, {}]);
todosPassaram &= check('indice ignora entradas invalidas sem lancar excecao', indiceComLixo.size === 0);
const rSemIndice = resolverCliente('QUALQUER NOME', undefined);
todosPassaram &= check('resolverCliente sem indice (undefined) nao lanca excecao', rSemIndice.status === 'REVIEW_REQUIRED' && rSemIndice.motivo === 'SEM_MATCH');

console.log(
  '\nResultado geral customer-resolver-nex.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
