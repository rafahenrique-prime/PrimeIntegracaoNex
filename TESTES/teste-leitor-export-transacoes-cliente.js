'use strict';

/**
 * Teste de SERVICO/leitor-export-transacoes-cliente.js
 * (Fase EXPORT-FIRST - Fase A).
 * Executar com: node TESTES\teste-leitor-export-transacoes-cliente.js
 */

const path = require('path');
const PROJETO = path.join(__dirname, '..');
const XLSX = require(path.join(PROJETO, 'node_modules', 'xlsx'));
const {
  lerExportTransacoesCliente,
  ErroLeituraExportTransacoes,
} = require(path.join(PROJETO, 'SERVICO', 'leitor-export-transacoes-cliente'));

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
  'Ação',
  'No.Tran',
  'Data',
  'Hora',
  'Total Final',
  'Tipo',
  'Descrição',
  'Observações',
  'Vl.Produtos',
  'Desconto',
  'Tx.Entrega/Frete',
  'Valor Pago',
  'Meio Pagto',
  'Debitado',
  'Crédito',
  'Crédito Usado',
  'Funcionário',
  'Vendedor',
  'Entregador/Transp.',
  'Cancelado',
  'Cancelado por',
  'Cancelado Em',
  'Recebido Por',
];

function linhaTransacao(campos) {
  const defaults = {
    Ação: '',
    'No.Tran': '',
    Data: '',
    Hora: '',
    'Total Final': '',
    Tipo: '',
    Descrição: '',
    Observações: '',
    'Vl.Produtos': '',
    Desconto: '',
    'Tx.Entrega/Frete': '',
    'Valor Pago': '',
    'Meio Pagto': '',
    Debitado: '',
    Crédito: '',
    'Crédito Usado': '',
    Funcionário: 'admin',
    Vendedor: '',
    'Entregador/Transp.': '',
    Cancelado: 'Não',
    'Cancelado por': '',
    'Cancelado Em': '',
    'Recebido Por': '',
  };
  const merged = Object.assign({}, defaults, campos);
  return HEADER.map((h) => merged[h]);
}

// ---------- 1. Extrato real de MATHEUS HENRIQUE DEPRE: vendas #15756/#15757 + quitacoes #15758/#15759 ----------
console.log('\n=== 1. Extrato real (vendas + quitacoes) ===');
const buffer1 = construirXlsBuffer([
  HEADER,
  linhaTransacao({
    'No.Tran': '15759',
    Data: '8/28/26',
    Hora: '17:18',
    'Total Final': 'R$ 87.00 ',
    Tipo: 'Pagamento Débito',
    'Vl.Produtos': 'R$ 87.00 ',
    'Valor Pago': 'R$ 87.00 ',
    'Meio Pagto': 'Dinheiro',
  }),
  linhaTransacao({
    'No.Tran': '15758',
    Data: '8/28/26',
    Hora: '17:08',
    'Total Final': 'R$ 89.00 ',
    Tipo: 'Pagamento Débito',
    'Vl.Produtos': 'R$ 89.00 ',
    'Valor Pago': 'R$ 89.00 ',
    'Meio Pagto': 'Dinheiro',
  }),
  linhaTransacao({
    'No.Tran': '15757',
    Data: '8/28/26',
    Hora: '16:43',
    'Total Final': 'R$ 87.00 ',
    Tipo: 'Venda',
    Descrição: '1 X BRAND 018 HUGO BOSS',
    'Vl.Produtos': 'R$ 87.00 ',
    Debitado: 'R$ 87.00 ',
    Vendedor: 'RAFAEL PRIME TIBERY',
  }),
  linhaTransacao({
    'No.Tran': '15756',
    Data: '8/28/26',
    Hora: '16:37',
    'Total Final': 'R$ 89.00 ',
    Tipo: 'Venda',
    Descrição: '1 X BRAND 018 HUGO BOSS',
    'Vl.Produtos': 'R$ 89.00 ',
    Debitado: 'R$ 89.00 ',
    Vendedor: 'RAFAEL PRIME TIBERY',
  }),
  // Linha de totalizacao final (No.Tran e Data vazios, Total Final/Vl.Produtos preenchidos) - DEVE ser descartada.
  linhaTransacao({ 'Total Final': '6221', 'Vl.Produtos': '6499', Desconto: '278', 'Valor Pago': '3370', Debitado: '2851' }),
]);
const r1 = lerExportTransacoesCliente(buffer1, { nomeArquivo: 'extrato.xls' });
todosPassaram &= check('4 transacoes reais lidas (totalizacao descartada)', r1.linhas.length === 4);
todosPassaram &= check(
  'nenhuma linha remanescente com No.Tran vazio',
  r1.linhas.every((l) => l.noTran !== ''),
);

const pagamento15758 = r1.linhas.find((l) => l.noTran === '15758');
todosPassaram &= check('#15758 encontrado', !!pagamento15758);
todosPassaram &= check('#15758: Tipo = Pagamento Débito', pagamento15758.tipo === 'Pagamento Débito');
todosPassaram &= check('#15758: Meio Pagto = Dinheiro', pagamento15758.meioPagto === 'Dinheiro');
todosPassaram &= check('#15758: Valor Pago = "R$ 89.00 "', pagamento15758.valorPago === 'R$ 89.00 ');
todosPassaram &= check('#15758: nao tem campo de venda original (nao existe no leitor)', pagamento15758.descricao === '');

const venda15756 = r1.linhas.find((l) => l.noTran === '15756');
todosPassaram &= check('#15756: Tipo = Venda', venda15756.tipo === 'Venda');
todosPassaram &= check('#15756: Debitado = "R$ 89.00 "', venda15756.debitado === 'R$ 89.00 ');

// ---------- 2. So a linha de totalizacao + linhas vazias, sem transacao real ----------
console.log('\n=== 2. Extrato so com totalizacao (nenhuma transacao real) ===');
const buffer2 = construirXlsBuffer([
  HEADER,
  linhaTransacao({ 'Total Final': '100', 'Vl.Produtos': '100' }),
]);
const r2 = lerExportTransacoesCliente(buffer2, {});
todosPassaram &= check('0 transacoes (so a totalizacao, corretamente descartada)', r2.linhas.length === 0);

// ---------- 3. Linha em branco explicita e descartada ----------
console.log('\n=== 3. Linha em branco (todos os campos vazios) ===');
const linhaVaziaArr = HEADER.map(() => '');
const buffer3 = construirXlsBuffer([
  HEADER,
  linhaTransacao({ 'No.Tran': '1', Data: '1/1/26', Tipo: 'Venda' }),
  linhaVaziaArr,
]);
const r3 = lerExportTransacoesCliente(buffer3, {});
todosPassaram &= check('1 transacao (linha em branco descartada)', r3.linhas.length === 1);

// ---------- 4. Erros esperados ----------
console.log('\n=== 4. Erros esperados ===');
let erroVazio = null;
try {
  lerExportTransacoesCliente(Buffer.alloc(0), {});
} catch (e) {
  erroVazio = e;
}
todosPassaram &= check(
  'arquivo vazio -> arquivo_vazio',
  erroVazio instanceof ErroLeituraExportTransacoes && erroVazio.codigo === 'arquivo_vazio',
);

// A biblioteca xlsx e tolerante e le texto/bytes arbitrarios como planilha
// de 1 celula (nao lanca em XLSX.read) - o erro real vem da checagem de
// colunas essenciais logo em seguida, nao do try/catch de leitura.
let erroInvalido = null;
try {
  lerExportTransacoesCliente(Buffer.from('nao e um xls'), {});
} catch (e) {
  erroInvalido = e;
}
todosPassaram &= check(
  'conteudo invalido -> colunas_inesperadas (rejeitado via checagem de colunas)',
  erroInvalido instanceof ErroLeituraExportTransacoes && erroInvalido.codigo === 'colunas_inesperadas',
);

const bufferSemColunas = construirXlsBuffer([['Foo', 'Bar'], ['x', 'y']]);
let erroColunas = null;
try {
  lerExportTransacoesCliente(bufferSemColunas, {});
} catch (e) {
  erroColunas = e;
}
todosPassaram &= check(
  'colunas essenciais ausentes -> colunas_inesperadas',
  erroColunas instanceof ErroLeituraExportTransacoes && erroColunas.codigo === 'colunas_inesperadas',
);

console.log(
  '\nResultado geral leitor-export-transacoes-cliente.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
