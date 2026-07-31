'use strict';

/**
 * Camada de normalizacao: transforma um registro bruto do NEX (objeto com
 * as chaves exatas do cabecalho exportado) em um objeto compativel com o
 * schema congelado do PRIME Cobrancas (schema-prime.js).
 *
 * Nao grava nada em disco, nao acessa banco, nao gera prime_id definitivo,
 * nao decide importacao_inicial vs sincronizacao - isso pertence a camada
 * de importacao (Fase 2B, ainda nao implementada).
 */

const { parseFinanceiro, parseValorBR } = require('./parser-financeiro');
const { classificarObservacao } = require('./parser-observacoes');

function isEmptyValue(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function calcularConfianca(obsInfo) {
  if (!obsInfo || obsInfo.categoria === 'vazia') return null;
  if (obsInfo.categoria === 'estruturada') return 'alta';
  if (obsInfo.categoria === 'parcialmente_estruturada') return 'media';
  return 'baixa'; // texto_operacional ou ambigua
}

/**
 * @param {Object} registroNex - registro bruto, chaves = cabecalhos do NEX
 *   (ex.: "Código", "Nome", "Débito / Crédito", "Observações", "Celular", ...)
 * @param {Object} contexto - { fonteArquivo, dataSnapshot }
 * @returns {Object} objeto no formato do schema congelado do PRIME
 */
function normalizarCliente(registroNex, contexto) {
  const ctx = contexto || {};
  const r = registroNex || {};

  const fin = parseFinanceiro(r['Débito / Crédito']);
  const debito = fin.tipo === 'reconhecido' || fin.tipo === 'zero' ? (fin.debito || 0) : 0;
  const credito = fin.tipo === 'reconhecido' || fin.tipo === 'zero' ? (fin.credito || 0) : 0;

  const obs = classificarObservacao(r['Observações']);
  const vencimentoSugerido = obs.dias && obs.dias.length === 1 ? obs.dias[0] : null;
  const parcelamentoSugerido = obs.parcelas && obs.parcelas.length
    ? { qtd: obs.parcelas[0], valor: obs.valores && obs.valores.length ? parseValorBR(obs.valores[0]) : null }
    : null;

  return {
    // A. Identificacao
    prime_id: null,
    nex_codigo: isEmptyValue(r['Código']) ? null : r['Código'],
    origem_sistema: 'NEX',

    // B. Identidade
    nome: isEmptyValue(r['Nome']) ? '' : String(r['Nome']).trim(),
    cpf_cnpj: isEmptyValue(r['CPF / CNPJ']) ? null : String(r['CPF / CNPJ']).trim(),

    // C. Contato
    telefone: isEmptyValue(r['Telefone']) ? null : String(r['Telefone']).trim(),
    celular: isEmptyValue(r['Celular']) ? null : String(r['Celular']).trim(),
    email: isEmptyValue(r['Email']) ? null : String(r['Email']).trim(),
    canal_preferido: null,
    whatsapp_validado: false,

    // D. Endereco
    endereco_logradouro: isEmptyValue(r['Endereço']) ? null : String(r['Endereço']).trim(),
    endereco_numero: isEmptyValue(r['Número']) ? null : String(r['Número']).trim(),
    endereco_complemento: isEmptyValue(r['Complemento']) ? null : String(r['Complemento']).trim(),
    endereco_bairro: isEmptyValue(r['Bairro']) ? null : String(r['Bairro']).trim(),
    endereco_cidade: isEmptyValue(r['Cidade']) ? null : String(r['Cidade']).trim(),
    endereco_uf: isEmptyValue(r['Estado']) ? null : String(r['Estado']).trim(),
    endereco_cep: isEmptyValue(r['CEP']) ? null : String(r['CEP']).trim(),

    // E. Situacao financeira (snapshot do NEX)
    saldo_debito_nex: debito,
    saldo_credito_nex: credito,
    saldo_debito_anterior: null,
    saldo_credito_anterior: null,
    variacao_saldo: null,
    valor_liquido_nex: debito - credito,
    data_snapshot_nex: ctx.dataSnapshot || null,

    // F. Sugestoes extraidas de Observacoes (nunca autoritativas)
    observacao_original_nex: isEmptyValue(r['Observações']) ? '' : String(r['Observações']),
    observacao_categoria: obs.categoria,
    vencimento_sugerido: vencimentoSugerido,
    parcelamento_sugerido: parcelamentoSugerido,
    confianca_extracao: calcularConfianca(obs),

    // G. Dados definitivos de cobranca (aguardam confirmacao humana futura)
    vencimento_confirmado: null,
    parcelamento_confirmado: null,
    status_cobranca: debito > 0 ? 'em_aberto' : 'sem_debito',
    observacao_prime: null,

    // H. Historico (populado pela camada de importacao)
    historico: [],

    // I. Automacao / IA
    ultima_cobranca_enviada_em: null,
    proxima_cobranca_agendada_em: null,
    tentativas_cobranca: 0,
    risco_inadimplencia: null,
    resumo_ia: null,
    sentimento_ultima_resposta: null,

    // J. Consentimento / LGPD
    consentimento_contato: 'nao_solicitado',
    consentimento_registrado_em: null,

    // K. Qualidade do cadastro (algoritmo ainda nao definido)
    cadastro_score: null,

    // L. Auditoria e controle (preenchido pela camada de importacao)
    criado_em: null,
    atualizado_em: null,
    fonte_arquivo_origem: ctx.fonteArquivo || null,
    tipo_ultima_operacao: null,
    hash_registro_nex: null,
  };
}

module.exports = { normalizarCliente };
