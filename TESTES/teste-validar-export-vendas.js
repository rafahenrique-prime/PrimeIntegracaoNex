'use strict';

/**
 * Teste de SCRIPTS/validar-export-vendas.js (F6.14B2.10A) - o CLI-ponte
 * entre o Agent C# e o Reader real. Executado como subprocesso real
 * (mesma forma que o C# vai invocar), nunca importa a funcao
 * diretamente, para provar exatamente o que o Agent vai observar
 * (stdout/stderr/exit code reais). Fixtures sinteticas geradas em
 * arquivos temporarios - nunca toca EXPORT_STAGE/EXPORTADOS/OUTPUT
 * operacionais, nunca usa evidencia real com PII.
 *
 * Executar com: node TESTES\teste-validar-export-vendas.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const PROJETO = path.join(__dirname, '..');
const XLSX = require(path.join(PROJETO, 'node_modules', 'xlsx'));
const CLI = path.join(PROJETO, 'SCRIPTS', 'validar-export-vendas.js');

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'teste-validar-export-vendas-'));

function escreverFixture(nomeArquivo, buffer) {
  const caminho = path.join(TMP_DIR, nomeArquivo);
  fs.writeFileSync(caminho, buffer);
  return caminho;
}

const HEADER = [
  '', 'Ação', 'Número', 'Resumo', 'Tipo', 'Data', 'Hora', 'Origem', 'Itens',
  'Cliente', 'Observações', 'Vendedor', 'Desconto', 'Subtotal', 'Entrega',
  'Valor Pago', 'Meio Pagto', 'Crédito Usado', 'Debitado', 'Troco',
  'Tx.Ent/Frete', 'Transp/Entregador', 'Cancelado', 'Cancelado por',
  'Cancelado Em', 'Creditado', 'Funcionário',
];

function construirXlsBuffer(linhas) {
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}

function linhaVendaFixture(numero) {
  return HEADER.map((h) => {
    if (h === 'Número') return numero;
    if (h === 'Tipo') return 'Venda';
    return '';
  });
}

function rodarCli(args) {
  const resultado = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return resultado;
}

function parseUnicaLinhaJson(stdout) {
  const linhas = stdout.split('\n').filter((l) => l.trim().length > 0);
  if (linhas.length !== 1) return { erro: 'stdout nao contem exatamente 1 linha nao-vazia', linhas };
  try {
    return { json: JSON.parse(linhas[0]) };
  } catch (e) {
    return { erro: 'JSON invalido: ' + e.message };
  }
}

// ---------- A. XLS valido -> exit 0, ok:true, rows>0 ----------
console.log('\n=== A. XLS valido ===');
const xlsValido = escreverFixture('valido.xls', construirXlsBuffer([HEADER, linhaVendaFixture('1'), linhaVendaFixture('2'), linhaVendaFixture('3')]));
const rA = rodarCli([xlsValido]);
const parsedA = parseUnicaLinhaJson(rA.stdout);
todosPassaram &= check('exit code 0', rA.status === 0);
todosPassaram &= check('stdout e JSON valido', !!parsedA.json);
todosPassaram &= check('ok:true', parsedA.json && parsedA.json.ok === true);
todosPassaram &= check('rows === 3', parsedA.json && parsedA.json.rows === 3);

// ---------- B. arquivo inexistente -> exit de infraestrutura (2) ----------
console.log('\n=== B. arquivo inexistente ===');
const rB = rodarCli([path.join(TMP_DIR, 'nao-existe-de-verdade.xls')]);
todosPassaram &= check('exit code 2 (infraestrutura)', rB.status === 2);
todosPassaram &= check('stdout vazio (nenhum contrato emitido)', rB.stdout.trim() === '');

// ---------- C. arquivo vazio (0 bytes) -> Reader rejeita, exit 1 ----------
console.log('\n=== C. arquivo vazio (0 bytes) ===');
const xlsVazio = escreverFixture('vazio.xls', Buffer.alloc(0));
const rC = rodarCli([xlsVazio]);
const parsedC = parseUnicaLinhaJson(rC.stdout);
todosPassaram &= check('exit code 1 (Reader rejeitou)', rC.status === 1);
todosPassaram &= check('ok:false', parsedC.json && parsedC.json.ok === false);
todosPassaram &= check('errorCode === arquivo_vazio', parsedC.json && parsedC.json.errorCode === 'arquivo_vazio');

// ---------- D. arquivo corrompido (bytes arbitrarios, sem colunas essenciais) ----------
console.log('\n=== D. arquivo corrompido/invalido ===');
const xlsCorrompido = escreverFixture('corrompido.xls', Buffer.from('isto nao e um xls valido'));
const rD = rodarCli([xlsCorrompido]);
const parsedD = parseUnicaLinhaJson(rD.stdout);
todosPassaram &= check('exit code 1 (Reader rejeitou)', rD.status === 1);
todosPassaram &= check('ok:false', parsedD.json && parsedD.json.ok === false);
todosPassaram &= check('errorCode preservado do Reader (colunas_inesperadas)', parsedD.json && parsedD.json.errorCode === 'colunas_inesperadas');

// ---------- E. workbook sem nenhuma linha de dados (so cabecalho) ----------
console.log('\n=== E. planilha sem nenhum registro ===');
const xlsSoCabecalho = escreverFixture('so-cabecalho.xls', construirXlsBuffer([HEADER]));
const rE = rodarCli([xlsSoCabecalho]);
const parsedE = parseUnicaLinhaJson(rE.stdout);
todosPassaram &= check('exit code 0 (Reader aceita planilha so com cabecalho, 0 linhas de dados)', rE.status === 0);
todosPassaram &= check('rows === 0', parsedE.json && parsedE.json.rows === 0);

// ---------- F. cabecalhos obrigatorios ausentes ----------
console.log('\n=== F. cabecalhos obrigatorios ausentes ===');
const xlsSemColunas = escreverFixture('sem-colunas.xls', construirXlsBuffer([['Foo', 'Bar'], ['x', 'y']]));
const rF = rodarCli([xlsSemColunas]);
const parsedF = parseUnicaLinhaJson(rF.stdout);
todosPassaram &= check('exit code 1', rF.status === 1);
todosPassaram &= check('errorCode === colunas_inesperadas', parsedF.json && parsedF.json.errorCode === 'colunas_inesperadas');

// ---------- G. stdout nunca contem dados de venda ----------
console.log('\n=== G. stdout nunca vaza dado de negocio ===');
const xlsComCliente = escreverFixture('com-cliente.xls', construirXlsBuffer([
  HEADER,
  HEADER.map((h) => (h === 'Número' ? '999' : h === 'Cliente' ? 'FULANO DE TAL SIGILOSO' : h === 'Tipo' ? 'Venda' : '')),
]));
const rG = rodarCli([xlsComCliente]);
todosPassaram &= check('stdout nao contem o nome do cliente da fixture', !rG.stdout.includes('FULANO DE TAL SIGILOSO'));
todosPassaram &= check('stderr nao contem o nome do cliente da fixture', !rG.stderr.includes('FULANO DE TAL SIGILOSO'));

// ---------- H. sucesso produz exatamente 1 linha JSON em stdout ----------
console.log('\n=== H. sucesso produz exatamente 1 objeto JSON ===');
todosPassaram &= check('stdout de A tem exatamente 1 linha nao-vazia', !parsedA.erro);

// ---------- I. falha do Reader preserva o errorCode original (nao generico) ----------
console.log('\n=== I. errorCode original do Reader preservado (nao mascarado) ===');
todosPassaram &= check('C preserva arquivo_vazio (nao um erroCode generico)', parsedC.json && parsedC.json.errorCode === 'arquivo_vazio');
todosPassaram &= check('F preserva colunas_inesperadas (nao um erroCode generico)', parsedF.json && parsedF.json.errorCode === 'colunas_inesperadas');

console.log(
  '\nResultado geral validar-export-vendas.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);

try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* best-effort cleanup */ }

process.exitCode = todosPassaram ? 0 : 1;
