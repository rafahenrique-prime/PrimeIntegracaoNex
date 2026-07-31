(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AppLogico = factory();
  }
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /**
   * Funcoes puras da interface: sem acesso a DOM, sem fetch, sem I/O.
   * Isso permite testar as regras de navegacao/formatacao da tela
   * diretamente em Node, sem precisar de um navegador real.
   */

  function validarArquivoSelecionado(arquivo, listaArquivos) {
    if (listaArquivos && listaArquivos.length > 1) {
      return { ok: false, mensagem: 'Selecione apenas um arquivo por vez.' };
    }
    if (!arquivo) {
      return { ok: false, mensagem: 'Nenhum arquivo selecionado.' };
    }
    if (!/\.xls$/i.test(arquivo.name || '')) {
      return { ok: false, mensagem: 'Formato invalido. Selecione um arquivo .xls exportado pelo NEX.' };
    }
    return { ok: true };
  }

  function formatarTamanho(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function cartoesDaPrevia(relatorio) {
    const t = relatorio.totais;
    const p = relatorio.previsao_importacao;
    return [
      ['Total de registros', t.total_registros],
      ['Registros validos', t.validos],
      ['Registros com aviso', t.validos_com_aviso],
      ['Registros invalidos', t.invalidos],
      ['Clientes com debito', t.clientes_com_debito],
      ['Clientes sem debito', t.clientes_sem_debito],
      ['Total do debito', 'R$ ' + t.total_debito.toFixed(2)],
      ['Total do credito', 'R$ ' + t.total_credito.toFixed(2)],
      ['Com celular', t.com_celular],
      ['Sem celular', t.sem_celular],
      ['Com CPF', t.com_cpf],
      ['Sem CPF', t.sem_cpf],
      ['Observacoes estruturadas', t.observacoes_estruturadas],
      ['Observacoes vazias', t.observacoes_vazias],
      ['Revisao manual', p.revisao_manual],
    ];
  }

  function cartoesDaPrevisao(relatorio) {
    const p = relatorio.previsao_importacao;
    return [
      ['Novos clientes', p.novos],
      ['Atualizacoes', p.atualizacoes],
      ['Ignorados', p.ignorados],
      ['Revisao manual', p.revisao_manual],
    ];
  }

  function linhasTabelaAvisos(registrosComAviso) {
    return (registrosComAviso || []).map((r) => ([
      r.nex_codigo,
      r.nome,
      'R$ ' + Number(r.saldo_debito).toFixed(2),
      r.tem_celular ? 'Sim' : 'Nao',
      r.tem_cpf ? 'Sim' : 'Nao',
      r.qtd_avisos,
      (r.avisos || []).join('; '),
    ]));
  }

  const SECAO = {
    UPLOAD: 'upload',
    ARQUIVO_SELECIONADO: 'arquivo_selecionado',
    PROCESSANDO: 'processando',
    PREVIA: 'previa',
    AVISOS: 'avisos',
    REVISAO: 'revisao',
    IMPORTANDO: 'importando',
    RESULTADO_IMPORTACAO: 'resultado_importacao',
  };

  function proximaSecaoAoTrocarArquivo() {
    return SECAO.UPLOAD;
  }

  function proximaSecaoAoAbrirAvisos(temResultado) {
    return temResultado ? SECAO.AVISOS : null;
  }

  function proximaSecaoAoFecharAvisos() {
    return SECAO.PREVIA;
  }

  function proximaSecaoAoAbrirRevisao(temResultado) {
    return temResultado ? SECAO.REVISAO : null;
  }

  function proximaSecaoAoFecharRevisao() {
    return SECAO.PREVIA;
  }

  // ---------- Fase 3B: revisao visual dos registros ----------

  const FILTROS = ['todos', 'com_debito', 'sem_debito', 'com_aviso', 'invalidos', 'revisao_manual', 'com_celular', 'sem_celular'];

  function resumoSuperior(relatorio) {
    const t = relatorio.totais;
    const p = relatorio.previsao_importacao;
    return [
      ['Total de registros', t.total_registros],
      ['Total do débito', 'R$ ' + t.total_debito.toFixed(2)],
      ['Total do crédito', 'R$ ' + t.total_credito.toFixed(2)],
      ['Clientes com débito', t.clientes_com_debito],
      ['Revisão manual', p.revisao_manual],
      ['Válidos', t.validos],
      ['Avisos', t.validos_com_aviso],
      ['Inválidos', t.invalidos],
    ];
  }

  function normalizarTexto(v) {
    return v === undefined || v === null ? '' : String(v).toLowerCase();
  }

  function filtrarRegistros(registros, filtro, termoBusca) {
    let lista = registros || [];

    switch (filtro) {
      case 'com_debito': lista = lista.filter((r) => r.saldo_debito_nex > 0); break;
      case 'sem_debito': lista = lista.filter((r) => !(r.saldo_debito_nex > 0)); break;
      case 'com_aviso': lista = lista.filter((r) => r.validacao_status === 'valido_com_aviso'); break;
      case 'invalidos': lista = lista.filter((r) => r.validacao_status === 'invalido'); break;
      case 'revisao_manual': lista = lista.filter((r) => r.revisao_manual === true); break;
      case 'com_celular': lista = lista.filter((r) => r.tem_celular === true); break;
      case 'sem_celular': lista = lista.filter((r) => r.tem_celular === false); break;
      case 'todos':
      default: break;
    }

    const termo = normalizarTexto(termoBusca).trim();
    if (termo) {
      lista = lista.filter((r) => (
        normalizarTexto(r.nex_codigo).indexOf(termo) !== -1 ||
        normalizarTexto(r.nome).indexOf(termo) !== -1 ||
        normalizarTexto(r.telefone).indexOf(termo) !== -1 ||
        normalizarTexto(r.celular).indexOf(termo) !== -1
      ));
    }

    return lista;
  }

  function linhasTabelaRegistros(registros) {
    return (registros || []).map((r) => ([
      r.nex_codigo,
      r.nome,
      'R$ ' + Number(r.saldo_debito_nex || 0).toFixed(2),
      'R$ ' + Number(r.saldo_credito_nex || 0).toFixed(2),
      r.status_cobranca,
      r.tem_celular ? 'Sim' : 'Não',
      r.tem_cpf ? 'Sim' : 'Não',
      r.observacao_categoria,
      r.validacao_status,
      r.qtd_avisos,
    ]));
  }

  const ROTULOS_STATUS_COBRANCA = {
    sem_debito: 'Sem débito',
    em_aberto: 'Em aberto (devendo)',
    em_negociacao: 'Em negociação',
    cobranca_enviada: 'Cobrança já enviada',
    promessa_pagamento: 'Promessa de pagamento registrada',
    pago: 'Dívida quitada',
    inadimplente_recorrente: 'Inadimplente recorrente',
  };

  function classificacaoFinanceiraTexto(registro) {
    return ROTULOS_STATUS_COBRANCA[registro.status_cobranca] || registro.status_cobranca || '';
  }

  function explicacaoResumida(registro) {
    const partes = [];
    if (registro.saldo_debito_nex > 0) {
      partes.push('Cliente possui débito de R$ ' + Number(registro.saldo_debito_nex).toFixed(2) + ' extraído da coluna "Débito / Crédito" do NEX.');
    } else if (registro.saldo_credito_nex > 0) {
      partes.push('Cliente sem débito, mas com crédito de R$ ' + Number(registro.saldo_credito_nex).toFixed(2) + ' a favor.');
    } else {
      partes.push('Cliente sem débito na exportação do NEX.');
    }

    if (registro.observacao_categoria === 'vazia') {
      partes.push('Nenhuma observação registrada no NEX.');
    } else {
      partes.push('Observação classificada como "' + registro.observacao_categoria + '".');
      if (registro.vencimento_sugerido !== null && registro.vencimento_sugerido !== undefined) {
        partes.push('Sugestão de vencimento: dia ' + registro.vencimento_sugerido + ' (confiança ' + registro.confianca_extracao + ').');
      }
      if (registro.parcelamento_sugerido) {
        const valorParcela = registro.parcelamento_sugerido.valor;
        partes.push('Sugestão de parcelamento: ' + registro.parcelamento_sugerido.qtd + 'x' + (valorParcela !== null && valorParcela !== undefined ? (' de R$ ' + Number(valorParcela).toFixed(2)) : '') + '.');
      }
    }

    if (registro.avisos && registro.avisos.length) {
      partes.push(registro.avisos.length + ' aviso(s) de validação encontrado(s).');
    } else {
      partes.push('Nenhum aviso de validação.');
    }

    return partes.join(' ');
  }

  // ---------- Fase 5: confirmar importacao ----------

  /**
   * Decide se o botao "Confirmar importacao" pode ser acionado, a partir
   * do mesmo relatorio ja mostrado na previa. Nao decide nada sozinho -
   * so lê os totais ja calculados por SRC/simular-importacao.js.
   */
  function podeConfirmarImportacao(relatorio) {
    if (!relatorio || !relatorio.totais) {
      return { ok: false, mensagem: 'Nenhuma analise disponivel. Analise uma planilha primeiro.' };
    }
    const t = relatorio.totais;
    const importaveis = (t.validos || 0) + (t.validos_com_aviso || 0);
    if (importaveis === 0) {
      return { ok: false, mensagem: 'Nao ha nenhum registro valido ou com aviso para importar.' };
    }
    return { ok: true };
  }

  function mensagemConfirmacaoImportacao(relatorio) {
    const t = relatorio.totais;
    const importaveis = (t.validos || 0) + (t.validos_com_aviso || 0);
    return 'Confirmar a importacao de ' + importaveis + ' cliente(s) para o RepositorioClientesFake?\n\n' +
      'Os dados ficam apenas em memoria neste servidor local e serao perdidos se o servidor for reiniciado.';
  }

  /**
   * Monta os cartoes do relatorio final, a partir da resposta de
   * POST /api/importar somada ao numero de revisao_manual ja calculado
   * na analise original (essa contagem nao muda com a sincronizacao).
   */
  function cartoesResultadoImportacao(respostaImportar, revisaoManualDaAnalise) {
    const r = respostaImportar.resumo_execucao;
    return [
      ['Total processado', respostaImportar.total_processado],
      ['Novos clientes', r.criados],
      ['Atualizados', r.atualizados],
      ['Quitados', r.quitados],
      ['Sem alteração', r.sem_alteracao],
      ['Removidos/ausentes', r.nao_aplicados],
      ['Revisão manual (da análise)', revisaoManualDaAnalise || 0],
      ['Avisos na sincronização', (respostaImportar.avisos || []).length],
    ];
  }

  function detalhesDoRegistro(registro) {
    return {
      dadosNex: [
        ['Código NEX', registro.nex_codigo],
        ['Nome', registro.nome],
        ['Telefone', registro.telefone || '(vazio)'],
        ['Celular', registro.celular || '(vazio)'],
        ['E-mail', registro.email || '(vazio)'],
        ['CPF/CNPJ', registro.cpf_cnpj || '(vazio)'],
        ['Endereço', [registro.endereco_logradouro, registro.endereco_numero, registro.endereco_complemento].filter(Boolean).join(', ') || '(vazio)'],
        ['Bairro/Cidade/UF', [registro.endereco_bairro, registro.endereco_cidade, registro.endereco_uf].filter(Boolean).join(' / ') || '(vazio)'],
        ['CEP', registro.endereco_cep || '(vazio)'],
        ['Observação original', registro.observacao_original_nex || '(vazio)'],
      ],
      dadosNormalizados: [
        ['Débito (NEX)', 'R$ ' + Number(registro.saldo_debito_nex || 0).toFixed(2)],
        ['Crédito (NEX)', 'R$ ' + Number(registro.saldo_credito_nex || 0).toFixed(2)],
        ['Saldo líquido', 'R$ ' + Number(registro.valor_liquido_nex || 0).toFixed(2)],
        ['Situação (status_cobranca)', registro.status_cobranca],
      ],
      sugestoes: [
        ['Categoria da observação', registro.observacao_categoria],
        ['Vencimento sugerido', registro.vencimento_sugerido !== null && registro.vencimento_sugerido !== undefined ? ('dia ' + registro.vencimento_sugerido) : '(nenhum)'],
        ['Parcelamento sugerido', registro.parcelamento_sugerido ? (registro.parcelamento_sugerido.qtd + 'x de R$ ' + Number(registro.parcelamento_sugerido.valor || 0).toFixed(2)) : '(nenhum)'],
        ['Confiança da extração', registro.confianca_extracao || '(nenhuma)'],
      ],
      avisos: registro.avisos || [],
      erros: registro.erros || [],
      classificacaoFinanceira: classificacaoFinanceiraTexto(registro),
      explicacao: explicacaoResumida(registro),
    };
  }

  return {
    validarArquivoSelecionado,
    formatarTamanho,
    cartoesDaPrevia,
    cartoesDaPrevisao,
    linhasTabelaAvisos,
    SECAO,
    proximaSecaoAoTrocarArquivo,
    proximaSecaoAoAbrirAvisos,
    proximaSecaoAoFecharAvisos,
    proximaSecaoAoAbrirRevisao,
    proximaSecaoAoFecharRevisao,
    FILTROS,
    resumoSuperior,
    filtrarRegistros,
    linhasTabelaRegistros,
    detalhesDoRegistro,
    explicacaoResumida,
    classificacaoFinanceiraTexto,
    podeConfirmarImportacao,
    mensagemConfirmacaoImportacao,
    cartoesResultadoImportacao,
  };
}));
