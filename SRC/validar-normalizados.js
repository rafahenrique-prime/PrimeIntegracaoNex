'use strict';

/**
 * Camada de validacao dos objetos PRIME produzidos pela normalizacao.
 * Opera inteiramente em memoria - nao acessa banco, nao grava arquivo,
 * nao importa nem sincroniza.
 *
 * Nota de design: campos do schema reservados a camada de IMPORTACAO
 * (prime_id, criado_em, atualizado_em, tipo_ultima_operacao) ainda estao
 * null neste estagio do pipeline - isso e o estado esperado de um objeto
 * pos-normalizacao/pre-importacao, entao NAO e tratado como erro nem aviso
 * aqui. So sao avaliados campos que ja deveriam estar presentes apos a
 * normalizacao (origem NEX/Derivado/PRIME-inicializado).
 */

const STATUS_COBRANCA_VALIDOS = [
  'sem_debito', 'em_aberto', 'em_negociacao', 'cobranca_enviada',
  'promessa_pagamento', 'pago', 'inadimplente_recorrente',
];
const CONSENTIMENTO_VALIDOS = ['concedido', 'negado', 'nao_solicitado'];

function isNumero(v) {
  return typeof v === 'number' && !Number.isNaN(v);
}

function isVazio(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function validarRegistro(obj) {
  const erros = [];
  const avisos = [];

  if (!obj || typeof obj !== 'object') {
    return { status: 'invalido', erros: ['registro nao e um objeto valido'], avisos: [] };
  }

  // --- Campos obrigatorios nesta etapa (exclui os reservados a importacao) ---
  if (isVazio(obj.nome)) erros.push('campo obrigatorio "nome" ausente ou vazio');
  if (isVazio(obj.nex_codigo)) erros.push('campo obrigatorio "nex_codigo" ausente');
  if (isVazio(obj.origem_sistema)) erros.push('campo obrigatorio "origem_sistema" ausente');
  if (isVazio(obj.data_snapshot_nex)) erros.push('campo obrigatorio "data_snapshot_nex" ausente');
  if (isVazio(obj.fonte_arquivo_origem)) erros.push('campo obrigatorio "fonte_arquivo_origem" ausente');
  if (isVazio(obj.consentimento_contato)) erros.push('campo obrigatorio "consentimento_contato" ausente');
  if (isVazio(obj.status_cobranca)) erros.push('campo obrigatorio "status_cobranca" ausente');
  if (!Array.isArray(obj.historico)) erros.push('campo obrigatorio "historico" nao e um array');
  if (!isNumero(obj.tentativas_cobranca)) erros.push('campo obrigatorio "tentativas_cobranca" nao e numero');

  // --- Tipos ---
  if (!isNumero(obj.saldo_debito_nex)) erros.push('"saldo_debito_nex" nao e numero');
  if (!isNumero(obj.saldo_credito_nex)) erros.push('"saldo_credito_nex" nao e numero');
  if (!isNumero(obj.valor_liquido_nex)) erros.push('"valor_liquido_nex" nao e numero');

  // --- Consistencia de valores ---
  if (isNumero(obj.saldo_debito_nex) && obj.saldo_debito_nex < 0) erros.push('"saldo_debito_nex" negativo');
  if (isNumero(obj.saldo_credito_nex) && obj.saldo_credito_nex < 0) erros.push('"saldo_credito_nex" negativo');

  if (isNumero(obj.saldo_debito_nex) && isNumero(obj.saldo_credito_nex) && isNumero(obj.valor_liquido_nex)) {
    const esperado = obj.saldo_debito_nex - obj.saldo_credito_nex;
    if (Math.abs(esperado - obj.valor_liquido_nex) > 0.01) {
      erros.push(`"valor_liquido_nex" (${obj.valor_liquido_nex}) nao bate com debito-credito (${esperado.toFixed(2)})`);
    }
  }

  if (!isVazio(obj.status_cobranca) && !STATUS_COBRANCA_VALIDOS.includes(obj.status_cobranca)) {
    erros.push(`"status_cobranca" fora do enum permitido: "${obj.status_cobranca}"`);
  }
  if (!isVazio(obj.consentimento_contato) && !CONSENTIMENTO_VALIDOS.includes(obj.consentimento_contato)) {
    erros.push(`"consentimento_contato" fora do enum permitido: "${obj.consentimento_contato}"`);
  }

  if (isNumero(obj.saldo_debito_nex) && !isVazio(obj.status_cobranca)) {
    if (obj.saldo_debito_nex > 0 && obj.status_cobranca === 'sem_debito') {
      erros.push('status_cobranca = "sem_debito" mas saldo_debito_nex > 0');
    }
    if (obj.saldo_debito_nex === 0 && obj.status_cobranca === 'em_aberto') {
      erros.push('status_cobranca = "em_aberto" mas saldo_debito_nex = 0');
    }
  }

  // --- Avisos (nao invalidam o registro) ---
  const temDebito = isNumero(obj.saldo_debito_nex) && obj.saldo_debito_nex > 0;
  const temContato = !isVazio(obj.celular) || !isVazio(obj.telefone);
  if (temDebito && !temContato) avisos.push('cliente com debito em aberto mas sem celular nem telefone cadastrado');
  if (temDebito && isVazio(obj.cpf_cnpj)) avisos.push('cliente com debito em aberto mas sem CPF/CNPJ cadastrado');

  if (obj.observacao_categoria === 'ambigua' && temDebito) {
    avisos.push('observacao ambigua (dias conflitantes) em cliente com debito - revisar antes de qualquer cobranca automatica');
  }
  if (!isVazio(obj.vencimento_sugerido) && obj.confianca_extracao === 'baixa') {
    avisos.push('vencimento_sugerido existe mas com confianca_extracao baixa - nao usar sem confirmacao humana');
  }
  if (obj.parcelamento_sugerido && isVazio(obj.parcelamento_sugerido.valor)) {
    avisos.push('parcelamento_sugerido incompleto (sem valor de parcela reconhecido)');
  }

  let status = 'valido';
  if (erros.length) status = 'invalido';
  else if (avisos.length) status = 'valido_com_aviso';

  return { status, erros, avisos };
}

function validarLote(objetos) {
  const detalhes = objetos.map((obj) => ({
    nex_codigo: obj ? obj.nex_codigo : undefined,
    ...validarRegistro(obj),
  }));
  const resumo = {
    total: detalhes.length,
    validos: detalhes.filter((d) => d.status === 'valido').length,
    validos_com_aviso: detalhes.filter((d) => d.status === 'valido_com_aviso').length,
    invalidos: detalhes.filter((d) => d.status === 'invalido').length,
  };
  return { resumo, detalhes };
}

module.exports = { validarRegistro, validarLote, STATUS_COBRANCA_VALIDOS, CONSENTIMENTO_VALIDOS };
