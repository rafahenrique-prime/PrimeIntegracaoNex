'use strict';

/**
 * Leitor puro do export oficial "VENDAS -> HISTÓRICO -> EXPORTAR" do NEX
 * (Fase EXPORT-FIRST). So le e devolve uma estrutura bruta previsivel -
 * NAO classifica SALE_PAID/DEBT_CREATED, NAO resolve cliente (CustomerResolver),
 * NAO faz dedupe. Essas responsabilidades pertencem a fases posteriores
 * (Fase B em diante), ainda nao aprovadas.
 *
 * Cabecalhos reais auditados (27 colunas, primeira sempre vazia):
 * "", "Ação", "Número", "Resumo", "Tipo", "Data", "Hora", "Origem", "Itens",
 * "Cliente", "Observações", "Vendedor", "Desconto", "Subtotal", "Entrega",
 * "Valor Pago", "Meio Pagto", "Crédito Usado", "Debitado", "Troco",
 * "Tx.Ent/Frete", "Transp/Entregador", "Cancelado", "Cancelado por",
 * "Cancelado Em", "Creditado", "Funcionário".
 */

const XLSX = require('xlsx');
const path = require('path');
const SRC_DIR = path.join(__dirname, '..', 'SRC');
const { ehLinhaVazia, mapearLinhaPorCabecalho } = require(path.join(SRC_DIR, 'utilitarios-export-nex'));

class ErroLeituraExportVendas extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroLeituraExportVendas';
    this.codigo = codigo;
  }
}

const MAPA_CAMPOS = {
  Número: 'numero',
  Resumo: 'resumo',
  Tipo: 'tipo',
  Data: 'data',
  Hora: 'hora',
  Origem: 'origem',
  Itens: 'itens',
  Cliente: 'cliente',
  Observações: 'observacoes',
  Vendedor: 'vendedor',
  Desconto: 'desconto',
  Subtotal: 'subtotal',
  Entrega: 'entrega',
  'Valor Pago': 'valorPago',
  'Meio Pagto': 'meioPagto',
  'Crédito Usado': 'creditoUsado',
  Debitado: 'debitado',
  Troco: 'troco',
  Cancelado: 'cancelado',
  'Cancelado por': 'canceladoPor',
  'Cancelado Em': 'canceladoEm',
  Creditado: 'creditado',
  Funcionário: 'funcionario',
};

/**
 * @param {Buffer} buffer - conteudo bruto do arquivo .xls
 * @param {Object} [opcoes]
 * @param {string} [opcoes.nomeArquivo]
 * @returns {{ linhas: Object[] }}
 * @throws {ErroLeituraExportVendas}
 */
function lerExportVendas(buffer, opcoes) {
  const op = opcoes || {};
  const nomeArquivo = op.nomeArquivo || 'arquivo.xls';

  if (!buffer || !buffer.length) {
    throw new ErroLeituraExportVendas('arquivo_vazio', 'Nenhum arquivo foi enviado.');
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    throw new ErroLeituraExportVendas(
      'erro_leitura',
      `Nao foi possivel ler "${nomeArquivo}". Verifique se e um .xls valido exportado pelo NEX.`,
    );
  }

  const sheetName = workbook.SheetNames && workbook.SheetNames[0];
  if (!sheetName) {
    throw new ErroLeituraExportVendas('planilha_vazia', 'A planilha nao contem nenhuma aba com dados.');
  }

  const ws = workbook.Sheets[sheetName];
  const linhasBrutas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  if (!linhasBrutas.length) {
    throw new ErroLeituraExportVendas('planilha_vazia', 'A planilha nao contem nenhum registro.');
  }

  const headers = linhasBrutas[0];
  if (headers.indexOf('Número') === -1 || headers.indexOf('Tipo') === -1) {
    throw new ErroLeituraExportVendas(
      'colunas_inesperadas',
      'A planilha nao contem as colunas "Número"/"Tipo" esperadas do export de Vendas -> Histórico do NEX.',
    );
  }

  const linhas = linhasBrutas
    .slice(1)
    .filter((linha) => !ehLinhaVazia(linha))
    .map((linha) => mapearLinhaPorCabecalho(headers, linha, MAPA_CAMPOS));

  return { linhas };
}

module.exports = { lerExportVendas, ErroLeituraExportVendas };
