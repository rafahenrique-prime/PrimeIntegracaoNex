'use strict';

/**
 * Leitor puro do export oficial "CLIENTES -> EXPORTAR" do NEX (Fase
 * EXPORT-FIRST). So le e devolve uma estrutura bruta previsivel - nao
 * normaliza cliente, nao resolve nexCustomerCode, nao gera evento. Essas
 * responsabilidades pertencem a fases posteriores (Fase B em diante),
 * ainda nao aprovadas.
 *
 * Cabecalhos reais auditados (34 colunas, primeira sempre vazia):
 * "", "Ação", "Nome", "Débito / Crédito", "Código", "Observações",
 * "Data Nasc.", "RG/I.E.", "CPF / CNPJ", "Endereço", "Número",
 * "Complemento", "Bairro", "Cidade", "Estado", "CEP", "Sexo", "Telefone",
 * "Celular", "Entregador/Transportadora Pref.", "Email", "Incluído Em",
 * "Limite Débito", "Informações Extras", "Incluído Por", "Alterado Em",
 * "Alterado Por", "Pai", "P.Disponíveis", "P. Acumulados", "P. Resgatados",
 * "Mãe", "Status", "Produtor Rural", "PJ".
 */

const XLSX = require('xlsx');
const path = require('path');
const SRC_DIR = path.join(__dirname, '..', 'SRC');
const { ehLinhaVazia, mapearLinhaPorCabecalho } = require(path.join(SRC_DIR, 'utilitarios-export-nex'));

class ErroLeituraExportClientes extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroLeituraExportClientes';
    this.codigo = codigo;
  }
}

// Mapa "Cabecalho real do NEX" -> "campo de saida". Colunas nao listadas
// aqui (ex.: Endereço, CEP, P.Disponíveis) nao sao descartadas - ficam
// disponiveis em `linhaBruta` para uso futuro, sem precisar reler o arquivo.
const MAPA_CAMPOS = {
  Nome: 'nome',
  'Débito / Crédito': 'debitoCredito',
  Código: 'codigo',
  Observações: 'observacoes',
  Sexo: 'sexo',
  Telefone: 'telefone',
  Celular: 'celular',
  Email: 'email',
  'CPF / CNPJ': 'cpfCnpj',
  'Incluído Em': 'incluidoEm',
  'Alterado Em': 'alteradoEm',
  Status: 'status',
};

/**
 * @param {Buffer} buffer - conteudo bruto do arquivo .xls
 * @param {Object} [opcoes]
 * @param {string} [opcoes.nomeArquivo]
 * @returns {{ linhas: Object[] }}
 * @throws {ErroLeituraExportClientes}
 */
function lerExportClientes(buffer, opcoes) {
  const op = opcoes || {};
  const nomeArquivo = op.nomeArquivo || 'arquivo.xls';

  if (!buffer || !buffer.length) {
    throw new ErroLeituraExportClientes('arquivo_vazio', 'Nenhum arquivo foi enviado.');
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    throw new ErroLeituraExportClientes(
      'erro_leitura',
      `Nao foi possivel ler "${nomeArquivo}". Verifique se e um .xls valido exportado pelo NEX.`,
    );
  }

  const sheetName = workbook.SheetNames && workbook.SheetNames[0];
  if (!sheetName) {
    throw new ErroLeituraExportClientes('planilha_vazia', 'A planilha nao contem nenhuma aba com dados.');
  }

  const ws = workbook.Sheets[sheetName];
  const linhasBrutas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  if (!linhasBrutas.length) {
    throw new ErroLeituraExportClientes('planilha_vazia', 'A planilha nao contem nenhum registro.');
  }

  const headers = linhasBrutas[0];
  if (headers.indexOf('Código') === -1 || headers.indexOf('Nome') === -1) {
    throw new ErroLeituraExportClientes(
      'colunas_inesperadas',
      'A planilha nao contem as colunas "Nome"/"Código" esperadas do export de clientes do NEX.',
    );
  }

  const linhas = linhasBrutas
    .slice(1)
    .filter((linha) => !ehLinhaVazia(linha))
    .map((linha) => mapearLinhaPorCabecalho(headers, linha, MAPA_CAMPOS));

  return { linhas };
}

module.exports = { lerExportClientes, ErroLeituraExportClientes };
