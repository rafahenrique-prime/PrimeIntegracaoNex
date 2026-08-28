'use strict';

/**
 * Leitor puro do export oficial "CLIENTE -> TRANSAÇÕES -> EXPORTAR LISTA DE
 * TRANSAÇÕES" do NEX (extrato individual de transacoes de um cliente,
 * Fase EXPORT-FIRST). So le e devolve uma estrutura bruta previsivel - NAO
 * gera evento DEBT_PAYMENT, NAO tenta relacionar quitacao a venda original.
 * Essas responsabilidades pertencem a fases posteriores, ainda nao aprovadas.
 *
 * Cabecalhos reais auditados (23 colunas, sem coluna vazia inicial):
 * "Ação", "No.Tran", "Data", "Hora", "Total Final", "Tipo", "Descrição",
 * "Observações", "Vl.Produtos", "Desconto", "Tx.Entrega/Frete", "Valor Pago",
 * "Meio Pagto", "Debitado", "Crédito", "Crédito Usado", "Funcionário",
 * "Vendedor", "Entregador/Transp.", "Cancelado", "Cancelado por",
 * "Cancelado Em", "Recebido Por".
 *
 * IMPORTANTE: a ultima linha da planilha e uma linha de TOTALIZACAO
 * (No.Tran e Data vazios, mas Total Final/Vl.Produtos preenchidos com
 * somatorios) - auditada e confirmada como nao sendo uma transacao real.
 * Este leitor descarta essa linha automaticamente.
 */

const XLSX = require('xlsx');
const path = require('path');
const SRC_DIR = path.join(__dirname, '..', 'SRC');
const {
  ehLinhaVazia,
  ehLinhaDeTotalizacaoTransacoes,
  mapearLinhaPorCabecalho,
} = require(path.join(SRC_DIR, 'utilitarios-export-nex'));

class ErroLeituraExportTransacoes extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroLeituraExportTransacoes';
    this.codigo = codigo;
  }
}

const MAPA_CAMPOS = {
  'No.Tran': 'noTran',
  Data: 'data',
  Hora: 'hora',
  'Total Final': 'totalFinal',
  Tipo: 'tipo',
  Descrição: 'descricao',
  Observações: 'observacoes',
  'Vl.Produtos': 'vlProdutos',
  Desconto: 'desconto',
  'Valor Pago': 'valorPago',
  'Meio Pagto': 'meioPagto',
  Debitado: 'debitado',
  Crédito: 'credito',
  'Crédito Usado': 'creditoUsado',
  Funcionário: 'funcionario',
  Vendedor: 'vendedor',
  Cancelado: 'cancelado',
  'Cancelado por': 'canceladoPor',
  'Cancelado Em': 'canceladoEm',
  'Recebido Por': 'recebidoPor',
};

/**
 * @param {Buffer} buffer - conteudo bruto do arquivo .xls
 * @param {Object} [opcoes]
 * @param {string} [opcoes.nomeArquivo]
 * @returns {{ linhas: Object[] }} - sem a linha de totalizacao
 * @throws {ErroLeituraExportTransacoes}
 */
function lerExportTransacoesCliente(buffer, opcoes) {
  const op = opcoes || {};
  const nomeArquivo = op.nomeArquivo || 'arquivo.xls';

  if (!buffer || !buffer.length) {
    throw new ErroLeituraExportTransacoes('arquivo_vazio', 'Nenhum arquivo foi enviado.');
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    throw new ErroLeituraExportTransacoes(
      'erro_leitura',
      `Nao foi possivel ler "${nomeArquivo}". Verifique se e um .xls valido exportado pelo NEX.`,
    );
  }

  const sheetName = workbook.SheetNames && workbook.SheetNames[0];
  if (!sheetName) {
    throw new ErroLeituraExportTransacoes('planilha_vazia', 'A planilha nao contem nenhuma aba com dados.');
  }

  const ws = workbook.Sheets[sheetName];
  const linhasBrutas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  if (!linhasBrutas.length) {
    throw new ErroLeituraExportTransacoes('planilha_vazia', 'A planilha nao contem nenhum registro.');
  }

  const headers = linhasBrutas[0];
  if (headers.indexOf('No.Tran') === -1 || headers.indexOf('Tipo') === -1) {
    throw new ErroLeituraExportTransacoes(
      'colunas_inesperadas',
      'A planilha nao contem as colunas "No.Tran"/"Tipo" esperadas do extrato individual de transações do NEX.',
    );
  }

  const linhas = linhasBrutas
    .slice(1)
    .filter((linha) => !ehLinhaVazia(linha))
    .map((linha) => mapearLinhaPorCabecalho(headers, linha, MAPA_CAMPOS))
    .filter((campos) => !ehLinhaDeTotalizacaoTransacoes(campos));

  return { linhas };
}

module.exports = { lerExportTransacoesCliente, ErroLeituraExportTransacoes };
