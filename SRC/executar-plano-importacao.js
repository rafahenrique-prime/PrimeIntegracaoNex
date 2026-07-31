'use strict';

/**
 * Executor do plano de sincronizacao, inteiramente em memoria.
 * NENHUM efeito colateral: nao grava arquivo, nao acessa banco, nao chama
 * API. Recebe BASE_ATUAL, NOVA_IMPORTACAO e o PLANO_DE_SINCRONIZACAO
 * (saida de SRC/comparar-clientes.js) e retorna uma NOVA base calculada,
 * sem alterar nenhuma das entradas originais.
 *
 * dataExecucao e geradorPrimeId sao injetados via contexto para manter a
 * execucao deterministica - a regra principal nunca chama Date.now() nem
 * geracao aleatoria diretamente.
 *
 * Decisao de design (rule 4 - divida quitada): status_cobranca e definido
 * como "pago" (nao "sem_debito"), pois o enum do schema-prime.js distingue
 * um cliente que nunca deveu ("sem_debito") de um que devia e quitou
 * ("pago") - mais preciso para o historico de cobranca.
 *
 * Decisao de design (rule 2 - atualizacao de saldo): status_cobranca so e
 * recalculado automaticamente se o valor atual for um dos estados
 * auto-gerenciados ("sem_debito"/"em_aberto"). Estados definidos por um
 * humano (em_negociacao, cobranca_enviada, promessa_pagamento, pago,
 * inadimplente_recorrente) nao sao sobrescritos pela sincronizacao.
 */

const STATUS_AUTO_GERENCIADOS = ['sem_debito', 'em_aberto'];

function clonar(obj) {
  return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function indexarPorCodigo(lista) {
  const mapa = new Map();
  (lista || []).forEach((c) => {
    if (c && c.nex_codigo !== null && c.nex_codigo !== undefined) {
      mapa.set(String(c.nex_codigo), c);
    }
  });
  return mapa;
}

function statusAutoDerivado(saldoDebito) {
  return saldoDebito > 0 ? 'em_aberto' : 'sem_debito';
}

function copiarCamposContato(destino, origemNex, alteracoes) {
  if (alteracoes.telefoneMudou) destino.telefone = origemNex.telefone;
  if (alteracoes.celularMudou) destino.celular = origemNex.celular;
  if (alteracoes.emailMudou) destino.email = origemNex.email;
  if (alteracoes.enderecoMudou) {
    destino.endereco_logradouro = origemNex.endereco_logradouro;
    destino.endereco_numero = origemNex.endereco_numero;
    destino.endereco_complemento = origemNex.endereco_complemento;
    destino.endereco_bairro = origemNex.endereco_bairro;
    destino.endereco_cidade = origemNex.endereco_cidade;
    destino.endereco_uf = origemNex.endereco_uf;
    destino.endereco_cep = origemNex.endereco_cep;
  }
  if (alteracoes.observacaoMudou) {
    destino.observacao_original_nex = origemNex.observacao_original_nex;
    destino.observacao_categoria = origemNex.observacao_categoria;
    destino.vencimento_sugerido = origemNex.vencimento_sugerido;
    destino.parcelamento_sugerido = clonar(origemNex.parcelamento_sugerido);
    destino.confianca_extracao = origemNex.confianca_extracao;
  }
}

function aplicarClienteNovo(nexCodigo, novaOrig, contexto, eventosGerados) {
  const novo = clonar(novaOrig);

  novo.prime_id = contexto.geradorPrimeId(nexCodigo, novo);
  novo.criado_em = contexto.dataExecucao;
  novo.atualizado_em = contexto.dataExecucao;
  novo.tipo_ultima_operacao = 'importacao_inicial';
  novo.saldo_debito_anterior = null;
  novo.saldo_credito_anterior = null;
  novo.variacao_saldo = null;

  const evento = {
    tipo: 'cliente_importado',
    origem: 'NEX',
    data: contexto.dataExecucao,
    saldo_inicial: round2((novo.saldo_debito_nex || 0) - (novo.saldo_credito_nex || 0)),
  };
  novo.historico = (novo.historico || []).concat([evento]);
  eventosGerados.push(Object.assign({ nex_codigo: nexCodigo }, evento));

  return novo;
}

function aplicarClienteAtualizado(item, baseOrig, novaOrig, contexto, eventosGerados) {
  const atualizado = clonar(baseOrig);

  atualizado.saldo_debito_anterior = baseOrig.saldo_debito_nex;
  atualizado.saldo_credito_anterior = baseOrig.saldo_credito_nex;
  atualizado.variacao_saldo = item.diferenca_saldo;

  if (item.alteracoes.saldoMudou) {
    atualizado.saldo_debito_nex = novaOrig.saldo_debito_nex;
    atualizado.saldo_credito_nex = novaOrig.saldo_credito_nex;
    atualizado.valor_liquido_nex = round2(novaOrig.saldo_debito_nex - novaOrig.saldo_credito_nex);
    if (STATUS_AUTO_GERENCIADOS.includes(atualizado.status_cobranca)) {
      atualizado.status_cobranca = statusAutoDerivado(atualizado.saldo_debito_nex);
    }
  }

  copiarCamposContato(atualizado, novaOrig, item.alteracoes);

  atualizado.prime_id = baseOrig.prime_id;
  atualizado.criado_em = baseOrig.criado_em;
  atualizado.atualizado_em = contexto.dataExecucao;
  atualizado.tipo_ultima_operacao = 'sincronizacao';

  const camposAlterados = Object.keys(item.alteracoes).filter((k) => item.alteracoes[k]);
  const evento = {
    tipo: 'cliente_atualizado',
    campos_alterados: camposAlterados,
    saldo_anterior: item.saldo_anterior,
    saldo_novo: item.saldo_atual,
    diferenca: item.diferenca_saldo,
    classificacao_saldo: item.classificacao_saldo,
    data: contexto.dataExecucao,
  };
  atualizado.historico = (atualizado.historico || []).concat([evento]);
  eventosGerados.push(Object.assign({ nex_codigo: item.nex_codigo }, evento));

  return atualizado;
}

function aplicarDividaQuitada(item, baseOrig, novaOrig, contexto, eventosGerados) {
  const atualizado = clonar(baseOrig);

  atualizado.saldo_debito_anterior = baseOrig.saldo_debito_nex;
  atualizado.saldo_credito_anterior = baseOrig.saldo_credito_nex;
  atualizado.variacao_saldo = item.diferenca_saldo;

  atualizado.saldo_debito_nex = novaOrig.saldo_debito_nex;
  atualizado.saldo_credito_nex = novaOrig.saldo_credito_nex;
  atualizado.valor_liquido_nex = round2(novaOrig.saldo_debito_nex - novaOrig.saldo_credito_nex);
  atualizado.status_cobranca = 'pago';

  copiarCamposContato(atualizado, novaOrig, item.alteracoes);

  atualizado.prime_id = baseOrig.prime_id;
  atualizado.criado_em = baseOrig.criado_em;
  atualizado.atualizado_em = contexto.dataExecucao;
  atualizado.tipo_ultima_operacao = 'sincronizacao';

  const evento = {
    tipo: 'divida_quitada',
    saldo_anterior: item.saldo_anterior,
    saldo_atual: 0,
    data: contexto.dataExecucao,
  };
  atualizado.historico = (atualizado.historico || []).concat([evento]);
  eventosGerados.push(Object.assign({ nex_codigo: item.nex_codigo }, evento));

  return atualizado;
}

function executarPlanoImportacao(baseAtual, novaImportacao, planoSincronizacao, contexto) {
  if (!contexto || typeof contexto.dataExecucao === 'undefined' || typeof contexto.geradorPrimeId !== 'function') {
    throw new Error('contexto.dataExecucao e contexto.geradorPrimeId sao obrigatorios (execucao deterministica)');
  }

  const mapaBase = indexarPorCodigo(baseAtual);
  const mapaNova = indexarPorCodigo(novaImportacao);
  const plano = planoSincronizacao && Array.isArray(planoSincronizacao.plano) ? planoSincronizacao.plano : [];

  const novaBase = [];
  const eventosGerados = [];
  const registrosNaoAplicados = [];
  const avisos = [];
  const resumo = { criados: 0, atualizados: 0, quitados: 0, sem_alteracao: 0, nao_aplicados: 0 };

  plano.forEach((item) => {
    const codigo = String(item.nex_codigo);
    switch (item.tipo) {
      case 'cliente_novo': {
        const novaOrig = mapaNova.get(codigo);
        if (!novaOrig) { avisos.push(`cliente_novo ${item.nex_codigo} sem correspondente em NOVA_IMPORTACAO - ignorado`); break; }
        novaBase.push(aplicarClienteNovo(item.nex_codigo, novaOrig, contexto, eventosGerados));
        resumo.criados++;
        break;
      }
      case 'cliente_existente_sem_alteracao': {
        const baseOrig = mapaBase.get(codigo);
        if (!baseOrig) { avisos.push(`sem_alteracao ${item.nex_codigo} sem correspondente em BASE_ATUAL - ignorado`); break; }
        novaBase.push(clonar(baseOrig));
        resumo.sem_alteracao++;
        break;
      }
      case 'cliente_existente_com_alteracao': {
        const baseOrig = mapaBase.get(codigo);
        const novaOrig = mapaNova.get(codigo);
        if (!baseOrig || !novaOrig) { avisos.push(`com_alteracao ${item.nex_codigo} sem correspondente completo - ignorado`); break; }
        if (item.classificacao_saldo === 'divida_quitada') {
          novaBase.push(aplicarDividaQuitada(item, baseOrig, novaOrig, contexto, eventosGerados));
          resumo.quitados++;
        } else {
          novaBase.push(aplicarClienteAtualizado(item, baseOrig, novaOrig, contexto, eventosGerados));
          resumo.atualizados++;
        }
        break;
      }
      case 'cliente_removido_da_exportacao': {
        const baseOrig = mapaBase.get(codigo);
        if (baseOrig) novaBase.push(clonar(baseOrig)); // nao excluir o cadastro
        registrosNaoAplicados.push({ nex_codigo: item.nex_codigo, motivo: 'cliente_removido_da_exportacao' });
        avisos.push(`cliente ${item.nex_codigo} nao consta na nova exportacao - revisar manualmente antes de qualquer acao`);
        resumo.nao_aplicados++;
        break;
      }
      default:
        avisos.push(`tipo de plano desconhecido para cliente ${item.nex_codigo}: "${item.tipo}"`);
    }
  });

  return {
    simulacao: true,
    nova_base: novaBase,
    resumo_execucao: resumo,
    eventos_gerados: eventosGerados,
    registros_nao_aplicados: registrosNaoAplicados,
    avisos,
  };
}

module.exports = { executarPlanoImportacao };
