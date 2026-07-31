'use strict';

(function () {
  const L = window.AppLogico;
  const estado = { arquivo: null, ultimoResultado: null, filtroAtivo: 'todos', termoBusca: '', registrosPorCodigo: new Map() };

  const el = (id) => document.getElementById(id);

  const secoes = {
    upload: el('secao-upload'),
    arquivo_selecionado: el('secao-arquivo-selecionado'),
    processando: el('secao-processando'),
    previa: el('secao-previa'),
    avisos: el('secao-avisos'),
    revisao: el('secao-revisao'),
  };
  const bannerErro = el('banner-erro');
  const modalDetalhes = el('modal-detalhes');

  function mostrarSecao(nome) {
    if (!nome) return;
    Object.keys(secoes).forEach((k) => secoes[k].classList.add('oculto'));
    secoes[nome].classList.remove('oculto');
  }

  function mostrarErro(mensagem) {
    bannerErro.textContent = mensagem;
    bannerErro.classList.remove('oculto');
  }

  function limparErro() {
    bannerErro.classList.add('oculto');
    bannerErro.textContent = '';
  }

  function escaparHtml(s) {
    const d = document.createElement('div');
    d.textContent = s === undefined || s === null ? '' : String(s);
    return d.innerHTML;
  }

  function selecionarArquivo(arquivo, listaArquivos) {
    limparErro();
    const validacao = L.validarArquivoSelecionado(arquivo, listaArquivos);
    if (!validacao.ok) {
      mostrarErro(validacao.mensagem);
      return;
    }
    estado.arquivo = arquivo;
    el('nome-arquivo').textContent = arquivo.name;
    el('tamanho-arquivo').textContent = ' - ' + L.formatarTamanho(arquivo.size);
    mostrarSecao('arquivo_selecionado');
  }

  el('btn-selecionar').addEventListener('click', () => el('input-arquivo').click());

  el('input-arquivo').addEventListener('change', (ev) => {
    const arquivos = ev.target.files;
    selecionarArquivo(arquivos[0], arquivos);
    if (arquivos.length > 1) ev.target.value = '';
  });

  const areaDrop = el('area-drop');
  areaDrop.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    areaDrop.classList.add('arrastando');
  });
  areaDrop.addEventListener('dragleave', () => areaDrop.classList.remove('arrastando'));
  areaDrop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    areaDrop.classList.remove('arrastando');
    const arquivos = ev.dataTransfer.files;
    selecionarArquivo(arquivos[0], arquivos);
  });

  function resetarParaUpload() {
    estado.arquivo = null;
    estado.ultimoResultado = null;
    estado.filtroAtivo = 'todos';
    estado.termoBusca = '';
    estado.registrosPorCodigo = new Map();
    el('input-arquivo').value = '';
    el('campo-busca').value = '';
    limparErro();
    mostrarSecao(L.proximaSecaoAoTrocarArquivo());
  }

  el('btn-remover').addEventListener('click', resetarParaUpload);
  el('btn-outro-arquivo').addEventListener('click', resetarParaUpload);
  el('btn-finalizar').addEventListener('click', resetarParaUpload);

  el('btn-fechar-avisos').addEventListener('click', () => mostrarSecao(L.proximaSecaoAoFecharAvisos()));

  function preencherCards(containerId, pares) {
    const container = el(containerId);
    container.innerHTML = '';
    pares.forEach((par) => {
      const rotulo = par[0];
      const valor = par[1];
      const div = document.createElement('div');
      div.className = 'cartao';
      div.innerHTML = '<div class="cartao-valor">' + escaparHtml(valor) + '</div><div class="cartao-rotulo">' + escaparHtml(rotulo) + '</div>';
      container.appendChild(div);
    });
  }

  el('btn-analisar').addEventListener('click', async () => {
    if (!estado.arquivo) {
      mostrarErro('Nenhum arquivo selecionado.');
      return;
    }
    limparErro();
    mostrarSecao('processando');
    try {
      const resposta = await fetch('/api/analisar', {
        method: 'POST',
        headers: { 'X-Nome-Arquivo': encodeURIComponent(estado.arquivo.name) },
        body: estado.arquivo,
      });
      const dados = await resposta.json();
      if (!resposta.ok) {
        mostrarErro(dados.mensagem || 'Nao foi possivel processar o arquivo.');
        mostrarSecao('arquivo_selecionado');
        return;
      }
      estado.ultimoResultado = dados;
      estado.registrosPorCodigo = new Map((dados.registros || []).map((r) => [String(r.nex_codigo), r]));
      estado.filtroAtivo = 'todos';
      estado.termoBusca = '';
      el('campo-busca').value = '';
      preencherCards('grid-cards', L.cartoesDaPrevia(dados.relatorio));
      preencherCards('grid-previsao', L.cartoesDaPrevisao(dados.relatorio));
      mostrarSecao('previa');
    } catch (e) {
      mostrarErro('Erro de comunicacao com o servidor local. Verifique se o servidor esta rodando.');
      mostrarSecao('arquivo_selecionado');
    }
  });

  el('btn-ver-avisos').addEventListener('click', () => {
    const proxima = L.proximaSecaoAoAbrirAvisos(!!estado.ultimoResultado);
    if (!proxima) return;
    const corpo = el('corpo-tabela-avisos');
    corpo.innerHTML = '';
    L.linhasTabelaAvisos(estado.ultimoResultado.registros_com_aviso).forEach((linha) => {
      const tr = document.createElement('tr');
      tr.innerHTML = linha.map((v) => '<td>' + escaparHtml(v) + '</td>').join('');
      corpo.appendChild(tr);
    });
    mostrarSecao(proxima);
  });

  // ---------- Fase 3B: revisao visual dos registros ----------

  const ROTULOS_FILTRO = {
    todos: 'Todos',
    com_debito: 'Com débito',
    sem_debito: 'Sem débito',
    com_aviso: 'Com aviso',
    invalidos: 'Inválidos',
    revisao_manual: 'Revisão manual',
    com_celular: 'Com celular',
    sem_celular: 'Sem celular',
  };

  function renderizarFiltros() {
    const grupo = el('grupo-filtros');
    grupo.innerHTML = '';
    L.FILTROS.forEach((filtro) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = ROTULOS_FILTRO[filtro] || filtro;
      btn.className = 'btn-filtro' + (filtro === estado.filtroAtivo ? ' ativo' : '');
      btn.addEventListener('click', () => {
        estado.filtroAtivo = filtro;
        renderizarFiltros();
        renderizarTabelaRegistros();
      });
      grupo.appendChild(btn);
    });
  }

  function renderizarTabelaRegistros() {
    const todosRegistros = (estado.ultimoResultado && estado.ultimoResultado.registros) || [];
    const filtrados = L.filtrarRegistros(todosRegistros, estado.filtroAtivo, estado.termoBusca);

    el('contador-resultados').textContent = filtrados.length + ' de ' + todosRegistros.length + ' registro(s) exibido(s)';

    const corpo = el('corpo-tabela-registros');
    corpo.innerHTML = '';
    const linhas = L.linhasTabelaRegistros(filtrados);
    linhas.forEach((linha, i) => {
      const registro = filtrados[i];
      const tr = document.createElement('tr');
      tr.className = 'linha-registro';
      tr.innerHTML = linha.map((v) => '<td>' + escaparHtml(v) + '</td>').join('');
      tr.addEventListener('click', () => abrirDetalhes(registro));
      corpo.appendChild(tr);
    });
  }

  el('btn-revisar-registros').addEventListener('click', () => {
    const proxima = L.proximaSecaoAoAbrirRevisao(!!estado.ultimoResultado);
    if (!proxima) return;
    preencherCards('grid-resumo-revisao', L.resumoSuperior(estado.ultimoResultado.relatorio));
    estado.filtroAtivo = 'todos';
    estado.termoBusca = '';
    el('campo-busca').value = '';
    renderizarFiltros();
    renderizarTabelaRegistros();
    mostrarSecao(proxima);
  });

  el('btn-fechar-revisao').addEventListener('click', () => mostrarSecao(L.proximaSecaoAoFecharRevisao()));

  el('campo-busca').addEventListener('input', (ev) => {
    estado.termoBusca = ev.target.value;
    renderizarTabelaRegistros();
  });

  function linhaDetalhe(rotulo, valor) {
    return '<div class="linha-detalhe"><span class="rotulo-detalhe">' + escaparHtml(rotulo) + '</span><span class="valor-detalhe">' + escaparHtml(valor) + '</span></div>';
  }

  function abrirDetalhes(registro) {
    if (!registro) return;
    const d = L.detalhesDoRegistro(registro);

    el('detalhes-titulo').textContent = 'Cliente ' + registro.nex_codigo + ' — ' + registro.nome;

    const partes = [];
    partes.push('<h3>Dados do NEX</h3>');
    d.dadosNex.forEach(([r, v]) => partes.push(linhaDetalhe(r, v)));

    partes.push('<h3>Dados normalizados</h3>');
    d.dadosNormalizados.forEach(([r, v]) => partes.push(linhaDetalhe(r, v)));

    partes.push('<h3>Sugestões extraídas da observação</h3>');
    d.sugestoes.forEach(([r, v]) => partes.push(linhaDetalhe(r, v)));

    partes.push('<h3>Classificação financeira</h3>');
    partes.push('<p>' + escaparHtml(d.classificacaoFinanceira) + '</p>');

    partes.push('<h3>Avisos (' + d.avisos.length + ')</h3>');
    partes.push(d.avisos.length ? ('<ul>' + d.avisos.map((a) => '<li>' + escaparHtml(a) + '</li>').join('') + '</ul>') : '<p>Nenhum aviso.</p>');

    if (d.erros.length) {
      partes.push('<h3>Erros (' + d.erros.length + ')</h3>');
      partes.push('<ul>' + d.erros.map((a) => '<li>' + escaparHtml(a) + '</li>').join('') + '</ul>');
    }

    partes.push('<h3>Explicação resumida da normalização</h3>');
    partes.push('<p>' + escaparHtml(d.explicacao) + '</p>');

    el('detalhes-corpo').innerHTML = partes.join('');
    modalDetalhes.classList.remove('oculto');
  }

  el('btn-fechar-detalhes').addEventListener('click', () => modalDetalhes.classList.add('oculto'));
  modalDetalhes.addEventListener('click', (ev) => {
    if (ev.target === modalDetalhes) modalDetalhes.classList.add('oculto');
  });
})();
