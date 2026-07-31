'use strict';

/**
 * Planejador de sincronizacao: compara dois conjuntos de clientes em
 * memoria (BASE_ATUAL x NOVA_IMPORTACAO) e gera um plano de acoes.
 *
 * NENHUM efeito colateral: nao grava nada, nao acessa banco, nao chama
 * API, nao atualiza nada de fato. So calcula e retorna o plano.
 *
 * Chave de juncao: nex_codigo (mesma decisao ja usada nas fases
 * anteriores - prime_id ainda nao existe porque nao ha importacao real).
 */

const CAMPOS_ENDERECO = [
  'endereco_logradouro', 'endereco_numero', 'endereco_complemento',
  'endereco_bairro', 'endereco_cidade', 'endereco_uf', 'endereco_cep',
];

function normalizarComp(v) {
  return v === null || v === undefined ? '' : String(v).trim().toLowerCase();
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function saldoLiquido(cliente) {
  return round2((cliente.saldo_debito_nex || 0) - (cliente.saldo_credito_nex || 0));
}

function enderecoAlterado(a, b) {
  return CAMPOS_ENDERECO.some((c) => normalizarComp(a[c]) !== normalizarComp(b[c]));
}

function indexarPorCodigo(lista) {
  const mapa = new Map();
  const semIdentificador = [];
  (lista || []).forEach((c) => {
    if (c == null || c.nex_codigo === null || c.nex_codigo === undefined) {
      semIdentificador.push(c);
      return;
    }
    mapa.set(String(c.nex_codigo), c);
  });
  return { mapa, semIdentificador };
}

function compararCliente(clienteBase, clienteNovo) {
  // Caso 1: existe so na nova importacao -> cliente novo
  if (!clienteBase && clienteNovo) {
    return {
      nex_codigo: clienteNovo.nex_codigo,
      tipo: 'cliente_novo',
      acoes: ['criar novo cadastro'],
      saldo_anterior: null,
      saldo_atual: saldoLiquido(clienteNovo),
      diferenca_saldo: null,
      classificacao_saldo: null,
    };
  }

  // Caso 2: existe so na base atual -> nao esta mais na exportacao
  if (clienteBase && !clienteNovo) {
    return {
      nex_codigo: clienteBase.nex_codigo,
      tipo: 'cliente_removido_da_exportacao',
      acoes: ['cliente nao consta na nova exportacao - nao remover automaticamente, sinalizar para revisao manual'],
      saldo_anterior: saldoLiquido(clienteBase),
      saldo_atual: null,
      diferenca_saldo: null,
      classificacao_saldo: null,
    };
  }

  // Caso 3: existe nos dois -> comparar campo a campo
  const saldoAnterior = saldoLiquido(clienteBase);
  const saldoAtual = saldoLiquido(clienteNovo);
  const diferenca = round2(saldoAtual - saldoAnterior);

  let classificacaoSaldo = 'sem_alteracao';
  if (saldoAnterior > 0 && saldoAtual === 0) classificacaoSaldo = 'divida_quitada';
  else if (diferenca > 0) classificacaoSaldo = 'aumento_divida';
  else if (diferenca < 0) classificacaoSaldo = 'reducao_divida';

  const saldoMudou = classificacaoSaldo !== 'sem_alteracao';
  const telefoneMudou = normalizarComp(clienteBase.telefone) !== normalizarComp(clienteNovo.telefone);
  const celularMudou = normalizarComp(clienteBase.celular) !== normalizarComp(clienteNovo.celular);
  const emailMudou = normalizarComp(clienteBase.email) !== normalizarComp(clienteNovo.email);
  const enderecoMudou = enderecoAlterado(clienteBase, clienteNovo);
  const observacaoMudou = normalizarComp(clienteBase.observacao_original_nex) !== normalizarComp(clienteNovo.observacao_original_nex);

  const houveAlteracao = saldoMudou || telefoneMudou || celularMudou || emailMudou || enderecoMudou || observacaoMudou;

  let acoes;
  if (!houveAlteracao) {
    acoes = ['nenhuma alteracao'];
  } else {
    acoes = [];
    acoes.push(classificacaoSaldo === 'divida_quitada' ? 'marcar como quitado' : (saldoMudou ? 'atualizar saldo' : 'manter saldo'));
    acoes.push(telefoneMudou ? 'atualizar telefone' : 'manter telefone');
    acoes.push(celularMudou ? 'atualizar celular' : 'manter celular');
    acoes.push(emailMudou ? 'atualizar email' : 'manter email');
    acoes.push(enderecoMudou ? 'atualizar endereco' : 'manter endereco');
    acoes.push(observacaoMudou ? 'atualizar observacao' : 'manter observacao');
  }

  return {
    nex_codigo: clienteNovo.nex_codigo,
    tipo: houveAlteracao ? 'cliente_existente_com_alteracao' : 'cliente_existente_sem_alteracao',
    acoes,
    saldo_anterior: saldoAnterior,
    saldo_atual: saldoAtual,
    diferenca_saldo: diferenca,
    classificacao_saldo: classificacaoSaldo,
    alteracoes: { saldoMudou, telefoneMudou, celularMudou, emailMudou, enderecoMudou, observacaoMudou },
  };
}

function gerarPlanoSincronizacao(baseAtual, novaImportacao) {
  const { mapa: mapaBase, semIdentificador: baseSemId } = indexarPorCodigo(baseAtual);
  const { mapa: mapaNovo, semIdentificador: novoSemId } = indexarPorCodigo(novaImportacao);

  const todosCodigos = new Set([...mapaBase.keys(), ...mapaNovo.keys()]);
  const plano = [...todosCodigos].map((codigo) => compararCliente(mapaBase.get(codigo), mapaNovo.get(codigo)));

  const resumo = {
    total_base: (baseAtual || []).length,
    total_nova_importacao: (novaImportacao || []).length,
    total_comparados: plano.length,
    clientes_novos: plano.filter((p) => p.tipo === 'cliente_novo').length,
    clientes_sem_alteracao: plano.filter((p) => p.tipo === 'cliente_existente_sem_alteracao').length,
    clientes_com_alteracao: plano.filter((p) => p.tipo === 'cliente_existente_com_alteracao').length,
    clientes_removidos_da_exportacao: plano.filter((p) => p.tipo === 'cliente_removido_da_exportacao').length,
    dividas_quitadas: plano.filter((p) => p.classificacao_saldo === 'divida_quitada').length,
    dividas_aumentaram: plano.filter((p) => p.classificacao_saldo === 'aumento_divida').length,
    dividas_reduziram: plano.filter((p) => p.classificacao_saldo === 'reducao_divida').length,
    registros_sem_identificador_ignorados: baseSemId.length + novoSemId.length,
  };

  return { simulacao: true, resumo, plano };
}

function formatarPlanoTexto(resultado) {
  const linhas = [];
  resultado.plano.forEach((item) => {
    linhas.push(`Cliente ${item.nex_codigo}`);
    linhas.push('Ações:');
    item.acoes.forEach((a) => linhas.push(`  ✔ ${a}`));
    linhas.push('----------------------------------');
  });
  return linhas.join('\n');
}

module.exports = { gerarPlanoSincronizacao, compararCliente, formatarPlanoTexto };
