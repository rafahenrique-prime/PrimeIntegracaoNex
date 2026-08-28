'use strict';

/**
 * Teste de SERVICO/leitor-export-vendas.js (Fase EXPORT-FIRST - Fase A).
 * Executar com: node TESTES\teste-leitor-export-vendas.js
 */

const path = require('path');
const PROJETO = path.join(__dirname, '..');
const XLSX = require(path.join(PROJETO, 'node_modules', 'xlsx'));
const { lerExportVendas, ErroLeituraExportVendas } = require(path.join(PROJETO, 'SERVICO', 'leitor-export-vendas'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

function construirXlsBuffer(linhas) {
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}

const HEADER = [
  '',
  'Ação',
  'Número',
  'Resumo',
  'Tipo',
  'Data',
  'Hora',
  'Origem',
  'Itens',
  'Cliente',
  'Observações',
  'Vendedor',
  'Desconto',
  'Subtotal',
  'Entrega',
  'Valor Pago',
  'Meio Pagto',
  'Crédito Usado',
  'Debitado',
  'Troco',
  'Tx.Ent/Frete',
  'Transp/Entregador',
  'Cancelado',
  'Cancelado por',
  'Cancelado Em',
  'Creditado',
  'Funcionário',
];

function linhaVenda(campos) {
  // Constroi uma linha na ordem exata de HEADER, com defaults vazios.
  const defaults = {
    '': '',
    Ação: '',
    Número: '',
    Resumo: '',
    Tipo: 'Venda',
    Data: '',
    Hora: '',
    Origem: 'Local',
    Itens: '',
    Cliente: '',
    Observações: '',
    Vendedor: 'RAFAEL PRIME TIBERY',
    Desconto: '',
    Subtotal: '',
    Entrega: 'Não',
    'Valor Pago': '',
    'Meio Pagto': '',
    'Crédito Usado': '',
    Debitado: '',
    Troco: '',
    'Tx.Ent/Frete': '',
    'Transp/Entregador': '',
    Cancelado: 'Não',
    'Cancelado por': '',
    'Cancelado Em': '',
    Creditado: '',
    Funcionário: 'RAFAEL PRIME TIBERY',
  };
  const merged = Object.assign({}, defaults, campos);
  return HEADER.map((h) => merged[h]);
}

// ---------- 1. Vendas pagas reais (#15751, #15753, #15755) ----------
console.log('\n=== 1. Vendas pagas reais (Cartao Credito / Dinheiro / Cartao Debito) ===');
const buffer1 = construirXlsBuffer([
  HEADER,
  linhaVenda({
    Número: '15751',
    Resumo: 'R$ 97.00 ',
    Data: '8/28/26',
    Hora: '14:17',
    Itens: '1 X BRAND 018 HUGO BOSS',
    Cliente: 'CANELINHA',
    Subtotal: 'R$ 97.00 ',
    'Valor Pago': 'R$ 97.00 ',
    'Meio Pagto': 'Cartão de Crédito',
  }),
  linhaVenda({
    Número: '15753',
    Resumo: 'R$ 98.00 ',
    Data: '8/28/26',
    Hora: '14:38',
    Itens: '1 X BRAND 018 HUGO BOSS',
    Cliente: 'CANELINHA',
    Subtotal: 'R$ 98.00 ',
    'Valor Pago': 'R$ 98.00 ',
    'Meio Pagto': 'Dinheiro',
  }),
  linhaVenda({
    Número: '15755',
    Resumo: 'R$ 95.00 ',
    Data: '8/28/26',
    Hora: '16:28',
    Itens: '1 X BRAND 018 HUGO BOSS',
    Cliente: 'CANELINHA',
    Subtotal: 'R$ 95.00 ',
    'Valor Pago': 'R$ 95.00 ',
    'Meio Pagto': 'Cartão de Débito',
  }),
]);
const r1 = lerExportVendas(buffer1, { nomeArquivo: 'vendas.xls' });
todosPassaram &= check('3 linhas lidas', r1.linhas.length === 3);
todosPassaram &= check('#15751: numero correto', r1.linhas[0].numero === '15751');
todosPassaram &= check('#15751: meioPagto = Cartão de Crédito', r1.linhas[0].meioPagto === 'Cartão de Crédito');
todosPassaram &= check('#15751: debitado vazio (nao e fiado)', r1.linhas[0].debitado === '');
todosPassaram &= check('#15753: meioPagto = Dinheiro', r1.linhas[1].meioPagto === 'Dinheiro');
todosPassaram &= check('#15755: meioPagto = Cartão de Débito', r1.linhas[2].meioPagto === 'Cartão de Débito');

// ---------- 2. Fiado real (#15756, #15757) ----------
console.log('\n=== 2. Fiado real (Debitado preenchido, Valor Pago/Meio Pagto vazios) ===');
const buffer2 = construirXlsBuffer([
  HEADER,
  linhaVenda({
    Número: '15756',
    Resumo: 'R$ 89.00 ',
    Data: '8/28/26',
    Hora: '16:37',
    Itens: '1 X BRAND 018 HUGO BOSS',
    Cliente: 'MATHEUS HENRIQUE DEPRE',
    Subtotal: 'R$ 89.00 ',
    'Valor Pago': '',
    'Meio Pagto': '',
    Debitado: 'R$ 89.00 ',
  }),
  linhaVenda({
    Número: '15757',
    Resumo: 'R$ 87.00 ',
    Data: '8/28/26',
    Hora: '16:43',
    Itens: '1 X BRAND 018 HUGO BOSS',
    Cliente: 'MATHEUS HENRIQUE DEPRE',
    Subtotal: 'R$ 87.00 ',
    'Valor Pago': '',
    'Meio Pagto': '',
    Debitado: 'R$ 87.00 ',
  }),
]);
const r2 = lerExportVendas(buffer2, {});
todosPassaram &= check('#15756: debitado = "R$ 89.00 "', r2.linhas[0].debitado === 'R$ 89.00 ');
todosPassaram &= check('#15756: valorPago vazio', r2.linhas[0].valorPago === '');
todosPassaram &= check('#15757: cliente correto', r2.linhas[1].cliente === 'MATHEUS HENRIQUE DEPRE');

// ---------- 3. Venda multi-item ----------
console.log('\n=== 3. Venda multi-item (#13005 real) ===');
const buffer3 = construirXlsBuffer([
  HEADER,
  linhaVenda({
    Número: '13005',
    Itens: '1 X CAMISETAS SUEDINE PREMIUM\r\n1 X BERMUDAS JR IMPORTADAS COM FORRO',
    Cliente: 'MATHEUS HENRIQUE DEPRE',
  }),
]);
const r3 = lerExportVendas(buffer3, {});
todosPassaram &= check('itens preserva o texto bruto com CRLF', r3.linhas[0].itens.includes('\r\n'));

// ---------- 4. Cancelamento ----------
console.log('\n=== 4. Cancelamento (venda #5595 real) ===');
const buffer4 = construirXlsBuffer([
  HEADER,
  linhaVenda({
    Número: '5595',
    Cancelado: 'Sim',
    'Cancelado por': 'admin',
    'Cancelado Em': '16/12/2021 15:42:00',
  }),
]);
const r4 = lerExportVendas(buffer4, {});
todosPassaram &= check('cancelado = "Sim"', r4.linhas[0].cancelado === 'Sim');
todosPassaram &= check('canceladoPor = "admin"', r4.linhas[0].canceladoPor === 'admin');
todosPassaram &= check('canceladoEm preservado', r4.linhas[0].canceladoEm === '16/12/2021 15:42:00');

// ---------- 5. Valor com espacos extras preservado bruto (parsing e responsabilidade de outra fase) ----------
console.log('\n=== 5. Valor monetario com espacos extras chega intacto ao leitor ===');
const buffer5 = construirXlsBuffer([HEADER, linhaVenda({ Número: '1', Subtotal: 'R$ 97.00 ' })]);
const r5 = lerExportVendas(buffer5, {});
todosPassaram &= check('subtotal preservado exatamente como veio (com espaco)', r5.linhas[0].subtotal === 'R$ 97.00 ');

// ---------- 6. Linha em branco e descartada ----------
console.log('\n=== 6. Linha em branco e descartada ===');
const linhaVaziaArr = HEADER.map(() => '');
const buffer6 = construirXlsBuffer([HEADER, linhaVenda({ Número: '1' }), linhaVaziaArr, linhaVenda({ Número: '2' })]);
const r6 = lerExportVendas(buffer6, {});
todosPassaram &= check('2 linhas validas (a vazia foi descartada)', r6.linhas.length === 2);

// ---------- 7. Arquivo vazio / invalido / colunas ausentes ----------
console.log('\n=== 7. Erros esperados ===');
let erroVazio = null;
try {
  lerExportVendas(Buffer.alloc(0), {});
} catch (e) {
  erroVazio = e;
}
todosPassaram &= check('arquivo vazio -> ErroLeituraExportVendas/arquivo_vazio', erroVazio instanceof ErroLeituraExportVendas && erroVazio.codigo === 'arquivo_vazio');

// A biblioteca xlsx e tolerante e le texto/bytes arbitrarios como planilha
// de 1 celula (nao lanca em XLSX.read) - o erro real vem da checagem de
// colunas essenciais logo em seguida, nao do try/catch de leitura.
let erroInvalido = null;
try {
  lerExportVendas(Buffer.from('bytes invalidos'), {});
} catch (e) {
  erroInvalido = e;
}
todosPassaram &= check(
  'conteudo invalido -> colunas_inesperadas (rejeitado via checagem de colunas)',
  erroInvalido instanceof ErroLeituraExportVendas && erroInvalido.codigo === 'colunas_inesperadas',
);

const bufferSemColunas = construirXlsBuffer([['Foo', 'Bar'], ['x', 'y']]);
let erroColunas = null;
try {
  lerExportVendas(bufferSemColunas, {});
} catch (e) {
  erroColunas = e;
}
todosPassaram &= check(
  'colunas essenciais ausentes -> colunas_inesperadas',
  erroColunas instanceof ErroLeituraExportVendas && erroColunas.codigo === 'colunas_inesperadas',
);

console.log(
  '\nResultado geral leitor-export-vendas.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
