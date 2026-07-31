'use strict';

/**
 * Teste PERMANENTE de SRC/simular-importacao.js (Fase 2C).
 * Preservado a partir do scratchpad em 2026-07-30 (Fase 4D - preparacao
 * pre-commit): caminhos absolutos trocados por relativos; require('xlsx')
 * direto em vez de caminho hardcoded; teste com o arquivo real agora
 * verifica existencia primeiro (o .xls real e ignorado pelo Git de
 * proposito - um clone limpo do repositorio nao vai te-lo). Ajuste
 * incorporado: checks de formatarRelatorioTexto() (antes so cobertas
 * pelo script de demonstracao relatorio-final.js, que nao foi preservado
 * como arquivo separado por ser redundante com este teste).
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const PROJETO = path.join(__dirname, '..');
const SRC = path.join(PROJETO, 'SRC');
const { normalizarCliente } = require(path.join(SRC, 'normalizar-clientes'));
const { validarLote } = require(path.join(SRC, 'validar-normalizados'));
const { simularImportacao, formatarRelatorioTexto } = require(path.join(SRC, 'simular-importacao'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;
const ctx = { fonteArquivo: 'teste.xls', dataSnapshot: '2026-07-30' };

// ---------- TESTE 1: lote vazio ----------
console.log('\n=== TESTE 1: lote vazio ===');
const v1 = validarLote([]);
const r1 = simularImportacao([], v1, ctx);
todosPassaram &= check('lote vazio: total_registros = 0', r1.totais.total_registros === 0);
todosPassaram &= check('lote vazio: novos = 0', r1.previsao_importacao.novos === 0);
todosPassaram &= check('lote vazio: nao lanca excecao', true);

// ---------- TESTE 2: cliente unico ----------
console.log('\n=== TESTE 2: cliente unico (com debito, com celular, sem CPF) ===');
const unico = [normalizarCliente({
  'Código': 1, 'Nome': 'Cliente Unico Teste', 'Débito / Crédito': 'Débito- R$ 100,00',
  'Celular': '11999998888', 'Observações': '2x 50,00 dia 5',
}, ctx)];
const v2 = validarLote(unico);
const r2 = simularImportacao(unico, v2, ctx);
todosPassaram &= check('unico: total_registros = 1', r2.totais.total_registros === 1);
todosPassaram &= check('unico: clientes_com_debito = 1', r2.totais.clientes_com_debito === 1);
todosPassaram &= check('unico: total_debito = 100', r2.totais.total_debito === 100);
todosPassaram &= check('unico: com_celular = 1', r2.totais.com_celular === 1);
todosPassaram &= check('unico: sem_cpf = 1', r2.totais.sem_cpf === 1);
todosPassaram &= check('unico: observacoes_estruturadas = 1', r2.totais.observacoes_estruturadas === 1);
todosPassaram &= check('unico: novos = 1 (validos+com_aviso)', r2.previsao_importacao.novos === 1);
todosPassaram &= check('unico: atualizacoes = 0', r2.previsao_importacao.atualizacoes === 0);
todosPassaram &= check('unico: ignorados = 0', r2.previsao_importacao.ignorados === 0);

// ---------- TESTE 2b: formatarRelatorioTexto com dado sintetico ----------
console.log('\n=== TESTE 2b: formatarRelatorioTexto (texto formatado) ===');
const textoRelatorio = formatarRelatorioTexto(r2);
todosPassaram &= check('formatarRelatorioTexto retorna string nao vazia', typeof textoRelatorio === 'string' && textoRelatorio.length > 0);
todosPassaram &= check('texto contem o aviso de simulacao', textoRelatorio.includes('SIMULACAO'));
todosPassaram &= check('texto contem o total de registros', textoRelatorio.includes('Total de registros: 1'));
todosPassaram &= check('texto contem o total do debito formatado', textoRelatorio.includes('Total do debito: R$ 100.00'));

// ---------- TESTE 3: lote completo real (1.386 registros), se o arquivo existir neste ambiente ----------
console.log('\n=== TESTE 3: lote completo real (clientes-nex.xls) ===');
const arquivoReal = path.join(PROJETO, 'EXPORTADOS', 'clientes-nex.xls');
if (fs.existsSync(arquivoReal)) {
  const wb = XLSX.readFile(arquivoReal, { type: 'binary' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(ws, { defval: '' });
  const contextoReal = { fonteArquivo: 'clientes-nex.xls', dataSnapshot: '2026-07-30' };
  const normalizadosReais = linhas.map((l) => normalizarCliente(l, contextoReal));
  const v3 = validarLote(normalizadosReais);
  const r3 = simularImportacao(normalizadosReais, v3, contextoReal);
  todosPassaram &= check('real: total_registros = 1386', r3.totais.total_registros === 1386);
  todosPassaram &= check('real: validos + com_aviso + invalidos = total', r3.totais.validos + r3.totais.validos_com_aviso + r3.totais.invalidos === 1386);
  todosPassaram &= check('real: clientes_com_debito = 36', r3.totais.clientes_com_debito === 36);
  todosPassaram &= check('real: total_debito = 25414.58', r3.totais.total_debito === 25414.58);
  todosPassaram &= check('real: total_credito = 394.07', r3.totais.total_credito === 394.07);
  todosPassaram &= check('real: novos + ignorados = total', r3.previsao_importacao.novos + r3.previsao_importacao.ignorados === 1386);
  const textoReal = formatarRelatorioTexto(r3);
  todosPassaram &= check('real: formatarRelatorioTexto contem "Revisao manual: 28"', textoReal.includes('Revisao manual: 28'));
} else {
  console.log('AVISO: EXPORTADOS/clientes-nex.xls nao encontrado neste ambiente (arquivo real, intencionalmente fora do Git) - pulando teste com dados reais.');
}

// ---------- TESTE 4: lote misto com registros invalidos ----------
console.log('\n=== TESTE 4: lote misto (2 validos + 1 invalido forcado) ===');
const bom1 = normalizarCliente({ 'Código': 10, 'Nome': 'Bom Um', 'Débito / Crédito': '', 'Celular': '11911112222' }, ctx);
const bom2 = normalizarCliente({ 'Código': 11, 'Nome': 'Bom Dois', 'Débito / Crédito': 'Débito- R$ 30,00', 'Celular': '11933334444' }, ctx);
const ruim = Object.assign({}, bom2, { nome: '' }); // forcado invalido: nome vazio
const misto = [bom1, bom2, ruim];
const v4 = validarLote(misto);
const r4 = simularImportacao(misto, v4, ctx);
todosPassaram &= check('misto: total_registros = 3', r4.totais.total_registros === 3);
todosPassaram &= check('misto: invalidos = 1', r4.totais.invalidos === 1);
todosPassaram &= check('misto: ignorados = 1', r4.previsao_importacao.ignorados === 1);
todosPassaram &= check('misto: novos = 2 (exclui o invalido)', r4.previsao_importacao.novos === 2);

console.log('\nResultado geral simular-importacao.js:', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
process.exitCode = todosPassaram ? 0 : 1;
