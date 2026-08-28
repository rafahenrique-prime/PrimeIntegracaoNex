'use strict';

/**
 * Utilitarios puros e pequenos, compartilhados pelos leitores/normalizadores
 * de export oficiais do NEX (Fase EXPORT-FIRST). Mantidos coesos num unico
 * arquivo por serem funcoes de poucas linhas sem estado - evita fragmentacao
 * excessiva de modulos triviais, seguindo o estilo ja usado no projeto
 * (ex.: parser-financeiro.js concentra parseValorBR + parseFinanceiro).
 */

function parseBooleanoSimNao(str) {
  if (str == null) return null;
  const s = String(str).trim().toLowerCase();
  if (!s) return null;
  if (s === 'sim') return true;
  if (s === 'não' || s === 'nao') return false;
  return null;
}

/**
 * Uma linha (array de celulas, no formato retornado por
 * XLSX.utils.sheet_to_json(ws, {header:1})) e considerada vazia quando
 * todas as celulas, apos trim, sao string vazia.
 */
function ehLinhaVazia(linha) {
  if (!Array.isArray(linha) || linha.length === 0) return true;
  return linha.every((celula) => String(celula == null ? '' : celula).trim() === '');
}

/**
 * Detecta a linha de totalizacao final do extrato individual de transacoes
 * do cliente (auditada: ultima linha da planilha, sem No.Tran nem Data, mas
 * com valores agregados em Total Final/Vl.Produtos).
 *
 * @param {Object} camposLinha - objeto ja mapeado por nome de campo
 *   (No.Tran/Data/Total Final/Vl.Produtos - chaves conforme MAPA_CAMPOS do
 *   leitor de transacoes).
 */
function ehLinhaDeTotalizacaoTransacoes(camposLinha) {
  if (!camposLinha) return false;
  const noTranVazio = String(camposLinha.noTran || '').trim() === '';
  const dataVazia = String(camposLinha.data || '').trim() === '';
  const temTotal =
    String(camposLinha.totalFinal || '').trim() !== '' || String(camposLinha.vlProdutos || '').trim() !== '';
  return noTranVazio && dataVazia && temTotal;
}

/**
 * Normalizacao de nome de cliente para fins de COMPARACAO determinística
 * (ex.: futuro CustomerResolver, fora do escopo desta fase). EXATAMENTE:
 * trim -> colapsar espacos -> uppercase -> remover acentos. Nada alem
 * disso - sem fuzzy matching, sem correcao ortografica, sem apelidos.
 *
 *   "  Matheus Henrique Depré  " -> "MATHEUS HENRIQUE DEPRE"
 */
function normalizarNomeClienteNex(nome) {
  if (nome == null) return '';
  return String(nome)
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Constroi um objeto {campoSaida: valor} a partir de uma linha bruta
 * (array de celulas) e do array de cabecalhos (linha 0 da planilha),
 * usando um mapa {"Nome do Cabecalho": "campoSaida"}. Colunas nao
 * mapeadas (incluindo cabecalhos vazios como a coluna "" ou "Ação",
 * sempre vazia nos exports auditados) sao simplesmente ignoradas na
 * saida tipada - mas todas ficam preservadas em `linhaBruta`.
 */
function mapearLinhaPorCabecalho(headers, linha, mapaCampos) {
  const camposTipados = {};
  const linhaBruta = {};

  headers.forEach((h, idx) => {
    const valor = linha[idx] == null ? '' : linha[idx];
    if (h) linhaBruta[h] = valor;
    const campoSaida = mapaCampos[h];
    if (campoSaida) camposTipados[campoSaida] = valor;
  });

  camposTipados.linhaBruta = linhaBruta;
  return camposTipados;
}

module.exports = {
  parseBooleanoSimNao,
  ehLinhaVazia,
  ehLinhaDeTotalizacaoTransacoes,
  normalizarNomeClienteNex,
  mapearLinhaPorCabecalho,
};
