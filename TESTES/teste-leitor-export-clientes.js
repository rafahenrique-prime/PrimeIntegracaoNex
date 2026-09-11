'use strict';

/**
 * Teste de SERVICO/leitor-export-clientes.js (Fase EXPORT-FIRST - Fase A).
 * Executar com: node TESTES\teste-leitor-export-clientes.js
 */

const path = require('path');
const PROJETO = path.join(__dirname, '..');
const XLSX = require(path.join(PROJETO, 'node_modules', 'xlsx'));
const { lerExportClientes, ErroLeituraExportClientes } = require(path.join(PROJETO, 'SERVICO', 'leitor-export-clientes'));

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

// Cabecalho real auditado (subconjunto suficiente para o teste; colunas
// extras do export real - Endereco, CEP, etc. - nao sao necessarias aqui
// pois o mapeamento e por nome de coluna, nao por posicao fixa).
const HEADER = [
  '',
  'Ação',
  'Nome',
  'Débito / Crédito',
  'Código',
  'Observações',
  'Sexo',
  'Telefone',
  'Celular',
  'Incluído Em',
  'Alterado Em',
  'Status',
];

// ---------- 1. Fixture baseada nos dados reais auditados ----------
console.log('\n=== 1. Fixture real: MATHEUS HENRIQUE DEPRE (292) e CANELINHA (316) ===');
const buffer1 = construirXlsBuffer([
  HEADER,
  ['', '', 'MATHEUS HENRIQUE DEPRE', '', '292', '', 'M', '', '98429308', '23/12/2020 19:20:20', '24/06/2024 18:52:20', 'Ativo'],
  ['', '', 'CANELINHA', '', '316', 'DIA 23-04', 'M', '', '97158642', '29/12/2020 16:46:40', '15/04/2024 15:41:41', 'Ativo'],
]);
const r1 = lerExportClientes(buffer1, { nomeArquivo: 'clientes.xls' });
todosPassaram &= check('2 linhas lidas', r1.linhas.length === 2);
todosPassaram &= check('Matheus: nome correto', r1.linhas[0].nome === 'MATHEUS HENRIQUE DEPRE');
todosPassaram &= check('Matheus: codigo = "292"', r1.linhas[0].codigo === '292');
todosPassaram &= check('Matheus: celular = "98429308"', r1.linhas[0].celular === '98429308');
todosPassaram &= check('Canelinha: codigo = "316"', r1.linhas[1].codigo === '316');
todosPassaram &= check('Canelinha: observacoes preservada', r1.linhas[1].observacoes === 'DIA 23-04');
todosPassaram &= check(
  'linhaBruta preserva TODAS as colunas originais (inclusive "Ação" vazia)',
  r1.linhas[0].linhaBruta['Ação'] === '' && r1.linhas[0].linhaBruta['Status'] === 'Ativo',
);

// ---------- 2. Linha totalmente vazia e descartada ----------
console.log('\n=== 2. Linha totalmente vazia e descartada ===');
const buffer2 = construirXlsBuffer([
  HEADER,
  ['', '', 'CLIENTE UM', '', '1', '', '', '', '', '', '', 'Ativo'],
  ['', '', '', '', '', '', '', '', '', '', '', ''],
  ['', '', 'CLIENTE DOIS', '', '2', '', '', '', '', '', '', 'Ativo'],
]);
const r2 = lerExportClientes(buffer2, {});
todosPassaram &= check('linha vazia descartada (2 linhas validas, nao 3)', r2.linhas.length === 2);

// ---------- 3. Campos opcionais vazios nao quebram o leitor ----------
console.log('\n=== 3. Campos opcionais vazios ===');
const buffer3 = construirXlsBuffer([HEADER, ['', '', 'CLIENTE SEM DADOS EXTRA', '', '3', '', '', '', '', '', '', '']]);
const r3 = lerExportClientes(buffer3, {});
todosPassaram &= check('1 linha lida mesmo com quase tudo vazio', r3.linhas.length === 1);
todosPassaram &= check('celular vazio vira string vazia (nao undefined/erro)', r3.linhas[0].celular === '');

// ---------- 4. Arquivo vazio ----------
console.log('\n=== 4. Arquivo vazio (buffer nulo/vazio) ===');
let erro4 = null;
try {
  lerExportClientes(Buffer.alloc(0), {});
} catch (e) {
  erro4 = e;
}
todosPassaram &= check('lanca ErroLeituraExportClientes', erro4 instanceof ErroLeituraExportClientes);
todosPassaram &= check('codigo = arquivo_vazio', erro4 && erro4.codigo === 'arquivo_vazio');

// ---------- 5. Conteudo que nao e um XLS real ----------
// A biblioteca xlsx e tolerante e le texto puro como uma planilha de 1
// celula (nao lanca erro de parsing) - o erro so surge depois, quando as
// colunas essenciais ("Código"/"Nome") nao sao encontradas no cabecalho.
console.log('\n=== 5. Conteudo que nao e um XLS real (texto puro) ===');
let erro5 = null;
try {
  lerExportClientes(Buffer.from('isto nao e um xls valido'), {});
} catch (e) {
  erro5 = e;
}
todosPassaram &= check('lanca ErroLeituraExportClientes', erro5 instanceof ErroLeituraExportClientes);
todosPassaram &= check('codigo = colunas_inesperadas (sem "Código"/"Nome" no cabecalho lido)', erro5 && erro5.codigo === 'colunas_inesperadas');

// ---------- 5b. Buffer binario corrompido ----------
// A biblioteca xlsx (versao usada neste projeto) e tao tolerante que ate
// bytes binarios arbitrarios sao "lidos" como uma planilha de 1 celula
// (nunca lanca durante XLSX.read/sheet_to_json neste caso) - por isso o
// codigo "erro_leitura" (try/catch em volta de XLSX.read) fica reservado
// para os poucos formatos que a biblioteca genuinamente rejeita (nao
// reproduzido por este teste); o caminho real de protecao contra lixo e
// sempre a validacao de colunas essenciais logo em seguida.
console.log('\n=== 5b. Buffer binario corrompido (ainda assim rejeitado, via checagem de colunas) ===');
let erro5b = null;
try {
  lerExportClientes(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]), {});
} catch (e) {
  erro5b = e;
}
todosPassaram &= check('lanca ErroLeituraExportClientes', erro5b instanceof ErroLeituraExportClientes);
todosPassaram &= check('codigo = colunas_inesperadas', erro5b && erro5b.codigo === 'colunas_inesperadas');

// ---------- 6. Colunas essenciais ausentes ----------
console.log('\n=== 6. Colunas essenciais ausentes (sem "Código"/"Nome") ===');
const buffer6 = construirXlsBuffer([
  ['Foo', 'Bar'],
  ['x', 'y'],
]);
let erro6 = null;
try {
  lerExportClientes(buffer6, {});
} catch (e) {
  erro6 = e;
}
todosPassaram &= check('lanca ErroLeituraExportClientes', erro6 instanceof ErroLeituraExportClientes);
todosPassaram &= check('codigo = colunas_inesperadas', erro6 && erro6.codigo === 'colunas_inesperadas');

// ---------- 7. Telefone/Celular numerico na planilha (F6.16G.1 - fix notacao cientifica) ----------
// Reproduz estruturalmente os casos reais homologados 823/825/906/911: uma
// celula de Telefone/Celular armazenada como NUMERO puro no XLS (nao texto)
// deve ser lida como string decimal completa, nunca em notacao cientifica.
console.log('\n=== 7. Telefone/Celular numerico: sem notacao cientifica ===');

function semNotacaoCientifica(v) {
  return !/e\+/i.test(String(v));
}

const buffer7a = construirXlsBuffer([
  HEADER,
  ['', '', 'CELULAR NUMERICO GRANDE', '', '823', '', '', '', 349844217008, '', '', 'Ativo'],
]);
const r7a = lerExportClientes(buffer7a, {});
todosPassaram &= check('celular numerico -> string decimal completa (nao notacao cientifica)', r7a.linhas[0].celular === '349844217008');
todosPassaram &= check('celular numerico: sem notacao cientifica', semNotacaoCientifica(r7a.linhas[0].celular));

const buffer7b = construirXlsBuffer([
  HEADER,
  ['', '', 'TELEFONE NUMERICO MUITO GRANDE', '', '825', '', '', 34981228716153, '', '', '', 'Ativo'],
]);
const r7b = lerExportClientes(buffer7b, {});
todosPassaram &= check('telefone numerico grande -> string decimal completa', r7b.linhas[0].telefone === '34981228716153');
todosPassaram &= check('telefone numerico: sem notacao cientifica', semNotacaoCientifica(r7b.linhas[0].telefone));

const buffer7c = construirXlsBuffer([
  HEADER,
  ['', '', 'TELEFONE E CELULAR COMO TEXTO', '', '902', '', '', '32210000', '98429308', '23/12/2020 19:20:20', '24/06/2024 18:52:20', 'Ativo'],
]);
const r7c = lerExportClientes(buffer7c, {});
todosPassaram &= check('telefone como texto preservado ("32210000")', r7c.linhas[0].telefone === '32210000');
todosPassaram &= check('celular como texto preservado ("98429308")', r7c.linhas[0].celular === '98429308');
todosPassaram &= check('Incluído Em (data-texto) nao afetado pelo fix', r7c.linhas[0].incluidoEm === '23/12/2020 19:20:20');
todosPassaram &= check('Alterado Em (data-texto) nao afetado pelo fix', r7c.linhas[0].alteradoEm === '24/06/2024 18:52:20');

const buffer7d = construirXlsBuffer([
  HEADER,
  ['', '', 'TELEFONE E CELULAR VAZIOS', '', '903', '', '', '', '', '', '', 'Ativo'],
]);
const r7d = lerExportClientes(buffer7d, {});
todosPassaram &= check('telefone vazio permanece string vazia', r7d.linhas[0].telefone === '');
todosPassaram &= check('celular vazio permanece string vazia', r7d.linhas[0].celular === '');

console.log(
  '\nResultado geral leitor-export-clientes.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
