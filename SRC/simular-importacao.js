'use strict';

/**
 * Simulacao de importacao. NENHUM efeito colateral: nao grava arquivo,
 * nao acessa banco, nao chama API, nao importa nem sincroniza.
 *
 * Como ainda nao existe banco/Base44 nesta fase, nao ha como comparar
 * contra um cadastro existente - por isso, conforme instruido, TODO
 * registro valido/valido_com_aviso e tratado como "novo cliente" e
 * "atualizacoes" e sempre 0. Isso e uma limitacao explicita da simulacao,
 * nao um resultado real de importacao.
 */

const REGEX_REVISAO_MANUAL = /ambigua|confianca_extracao baixa|incompleto|sem celular nem telefone/;

function precisaRevisaoManual(avisos) {
  return (avisos || []).some((a) => REGEX_REVISAO_MANUAL.test(a));
}

function contarComAvisoQueExigeRevisao(detalhes) {
  return detalhes.filter((d) => precisaRevisaoManual(d.avisos)).length;
}

function simularImportacao(normalizados, validacao, contexto) {
  const ctx = contexto || {};
  const lista = normalizados || [];
  const resumo = (validacao && validacao.resumo) || { total: 0, validos: 0, validos_com_aviso: 0, invalidos: 0 };
  const detalhes = (validacao && validacao.detalhes) || [];

  const comDebito = lista.filter((n) => n.saldo_debito_nex > 0).length;
  const semDebito = lista.length - comDebito;
  const totalDebito = lista.reduce((s, n) => s + (n.saldo_debito_nex || 0), 0);
  const totalCredito = lista.reduce((s, n) => s + (n.saldo_credito_nex || 0), 0);
  const comCelular = lista.filter((n) => n.celular).length;
  const semCelular = lista.length - comCelular;
  const comCpf = lista.filter((n) => n.cpf_cnpj).length;
  const semCpf = lista.length - comCpf;
  const obsEstruturada = lista.filter((n) => n.observacao_categoria === 'estruturada').length;
  const obsVazia = lista.filter((n) => n.observacao_categoria === 'vazia').length;

  const previsao = {
    novos: resumo.validos + resumo.validos_com_aviso,
    atualizacoes: 0,
    ignorados: resumo.invalidos,
    revisao_manual: contarComAvisoQueExigeRevisao(detalhes),
  };

  return {
    simulacao: true,
    aviso_geral: 'SIMULACAO - nenhum dado foi gravado, nenhum banco foi acessado, nenhuma importacao real ocorreu.',
    arquivo: ctx.fonteArquivo || null,
    totais: {
      total_registros: lista.length,
      validos: resumo.validos,
      validos_com_aviso: resumo.validos_com_aviso,
      invalidos: resumo.invalidos,
      clientes_com_debito: comDebito,
      clientes_sem_debito: semDebito,
      total_debito: Number(totalDebito.toFixed(2)),
      total_credito: Number(totalCredito.toFixed(2)),
      com_celular: comCelular,
      sem_celular: semCelular,
      com_cpf: comCpf,
      sem_cpf: semCpf,
      observacoes_estruturadas: obsEstruturada,
      observacoes_vazias: obsVazia,
    },
    previsao_importacao: previsao,
  };
}

function formatarRelatorioTexto(relatorio) {
  const t = relatorio.totais;
  const p = relatorio.previsao_importacao;
  const linhas = [];
  linhas.push('=====================================');
  linhas.push('PREVIA DA IMPORTACAO (SIMULACAO - NADA FOI GRAVADO)');
  linhas.push('=====================================');
  linhas.push('');
  linhas.push('Arquivo: ' + (relatorio.arquivo || '(nao informado)'));
  linhas.push('');
  linhas.push('Total de registros: ' + t.total_registros);
  linhas.push('Registros validos: ' + t.validos);
  linhas.push('Registros com aviso: ' + t.validos_com_aviso);
  linhas.push('Registros invalidos: ' + t.invalidos);
  linhas.push('');
  linhas.push('Clientes com debito: ' + t.clientes_com_debito);
  linhas.push('Clientes sem debito: ' + t.clientes_sem_debito);
  linhas.push('Total do debito: R$ ' + t.total_debito.toFixed(2));
  linhas.push('Total do credito: R$ ' + t.total_credito.toFixed(2));
  linhas.push('');
  linhas.push('Com celular: ' + t.com_celular);
  linhas.push('Sem celular: ' + t.sem_celular);
  linhas.push('Com CPF: ' + t.com_cpf);
  linhas.push('Sem CPF: ' + t.sem_cpf);
  linhas.push('');
  linhas.push('Observacoes estruturadas: ' + t.observacoes_estruturadas);
  linhas.push('Observacoes vazias: ' + t.observacoes_vazias);
  linhas.push('');
  linhas.push('Resultado previsto:');
  linhas.push('  Novos clientes: ' + p.novos + ' (nesta simulacao, TODOS os validos/com aviso contam como novos - ainda nao existe banco para comparar)');
  linhas.push('  Atualizacoes: ' + p.atualizacoes + ' (sempre 0 nesta fase, pelo mesmo motivo)');
  linhas.push('  Ignorados: ' + p.ignorados + ' (registros invalidos, nao seriam importados)');
  linhas.push('  Revisao manual: ' + p.revisao_manual + ' (subconjunto que seria importado, mas marcado para revisao humana antes de qualquer cobranca automatica)');
  linhas.push('=====================================');
  return linhas.join('\n');
}

module.exports = { simularImportacao, formatarRelatorioTexto, precisaRevisaoManual };
