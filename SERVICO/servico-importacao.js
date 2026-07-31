'use strict';

/**
 * Servico de importacao/analise: orquestra o pipeline completo (leitura do
 * XLS -> normalizacao -> validacao -> simulacao -> preparo do resultado
 * para a tela de revisao), SEM depender de HTTP. Pode ser chamado por
 * qualquer adaptador (servidor local, CLI futuro, testes) e sempre devolve
 * o mesmo resultado logico para a mesma entrada.
 *
 * Nao contem regra de negocio - isso continua 100% em SRC/. Este arquivo
 * so orquestra a sequencia de chamadas aos modulos de dominio.
 */

const path = require('path');
const XLSX = require('xlsx');

const SRC_DIR = path.join(__dirname, '..', 'SRC');
const { normalizarCliente } = require(path.join(SRC_DIR, 'normalizar-clientes'));
const { validarLote } = require(path.join(SRC_DIR, 'validar-normalizados'));
const { simularImportacao, precisaRevisaoManual } = require(path.join(SRC_DIR, 'simular-importacao'));

class ErroImportacao extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroImportacao';
    this.codigo = codigo;
  }
}

function dataAtualISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @param {Buffer} buffer - conteudo bruto do arquivo .xls
 * @param {Object} [opcoes]
 * @param {string} [opcoes.nomeArquivo] - nome do arquivo (metadado: fonte_arquivo_origem)
 * @param {string} [opcoes.dataSnapshot] - data (YYYY-MM-DD) do snapshot; default = hoje
 * @returns {{ relatorio: Object, registros_com_aviso: Object[], registros: Object[] }}
 * @throws {ErroImportacao} quando o arquivo/planilha nao e valido para o pipeline
 */
function analisarArquivoXls(buffer, opcoes) {
  const op = opcoes || {};
  const nomeArquivo = op.nomeArquivo || 'arquivo.xls';
  const dataSnapshot = op.dataSnapshot || dataAtualISO();

  if (!/\.xls$/i.test(nomeArquivo)) {
    throw new ErroImportacao('formato_invalido', 'Formato invalido. Envie um arquivo .xls exportado pelo NEX.');
  }

  if (!buffer || !buffer.length) {
    throw new ErroImportacao('arquivo_vazio', 'Nenhum arquivo foi enviado.');
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    throw new ErroImportacao('erro_leitura', 'Nao foi possivel ler o arquivo. Verifique se e um .xls valido exportado pelo NEX.');
  }

  const sheetName = workbook.SheetNames && workbook.SheetNames[0];
  if (!sheetName) {
    throw new ErroImportacao('planilha_vazia', 'A planilha nao contem nenhuma aba com dados.');
  }

  const ws = workbook.Sheets[sheetName];
  const linhas = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!linhas.length) {
    throw new ErroImportacao('planilha_vazia', 'A planilha nao contem nenhum registro.');
  }

  const contexto = { fonteArquivo: nomeArquivo, dataSnapshot };

  let normalizados;
  try {
    normalizados = linhas.map((l) => normalizarCliente(l, contexto));
  } catch (e) {
    throw new ErroImportacao('estrutura_incompativel', 'A estrutura da planilha nao e compativel com a exportacao esperada do NEX.');
  }

  const validacao = validarLote(normalizados);
  const relatorio = simularImportacao(normalizados, validacao, contexto);

  // Mapa nex_codigo -> detalhe de validacao (status/erros/avisos), para juntar com o registro normalizado.
  const detalhesPorCodigo = new Map();
  validacao.detalhes.forEach((d) => detalhesPorCodigo.set(String(d.nex_codigo), d));

  // Fase 3A: lista compacta so dos registros com aviso.
  const registrosComAviso = validacao.detalhes
    .filter((d) => d.status === 'valido_com_aviso')
    .map((d) => {
      const original = normalizados.find((n) => n.nex_codigo === d.nex_codigo);
      return {
        nex_codigo: d.nex_codigo,
        nome: original ? original.nome : '',
        saldo_debito: original ? original.saldo_debito_nex : 0,
        tem_celular: !!(original && original.celular),
        tem_cpf: !!(original && original.cpf_cnpj),
        qtd_avisos: d.avisos.length,
        avisos: d.avisos,
      };
    });

  // Fase 3B: lista completa de todos os registros, para a tela de revisao visual.
  const registros = normalizados.map((n) => {
    const detalhe = detalhesPorCodigo.get(String(n.nex_codigo)) || { status: 'invalido', erros: [], avisos: [] };
    return {
      nex_codigo: n.nex_codigo,
      nome: n.nome,
      celular: n.celular,
      telefone: n.telefone,
      email: n.email,
      cpf_cnpj: n.cpf_cnpj,
      endereco_logradouro: n.endereco_logradouro,
      endereco_numero: n.endereco_numero,
      endereco_complemento: n.endereco_complemento,
      endereco_bairro: n.endereco_bairro,
      endereco_cidade: n.endereco_cidade,
      endereco_uf: n.endereco_uf,
      endereco_cep: n.endereco_cep,
      saldo_debito_nex: n.saldo_debito_nex,
      saldo_credito_nex: n.saldo_credito_nex,
      valor_liquido_nex: n.valor_liquido_nex,
      status_cobranca: n.status_cobranca,
      observacao_original_nex: n.observacao_original_nex,
      observacao_categoria: n.observacao_categoria,
      vencimento_sugerido: n.vencimento_sugerido,
      parcelamento_sugerido: n.parcelamento_sugerido,
      confianca_extracao: n.confianca_extracao,
      tem_celular: !!n.celular,
      tem_cpf: !!n.cpf_cnpj,
      validacao_status: detalhe.status,
      erros: detalhe.erros,
      avisos: detalhe.avisos,
      qtd_avisos: detalhe.avisos.length,
      revisao_manual: precisaRevisaoManual(detalhe.avisos),
    };
  });

  return { relatorio, registros_com_aviso: registrosComAviso, registros };
}

module.exports = { analisarArquivoXls, ErroImportacao };
