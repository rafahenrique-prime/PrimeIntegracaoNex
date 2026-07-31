'use strict';

/**
 * Teste PERMANENTE do fluxo completo de importacao pela interface (Fase 5):
 * POST /api/importar em SERVICO/servidor-local.js, usando a MESMA instancia
 * de RepositorioClientesFake do servidor, e as funcoes puras de UI
 * relacionadas em WEB/app-logico.js.
 *
 * Executar com: node TESTES\teste-fluxo-importacao.js
 *
 * Usa apenas dados ficticios. Nenhum dado real e lido neste arquivo.
 *
 * Testes 8c e 12b foram adicionados apos uma revisao critica da Fase 5
 * (antes da aprovacao final) que encontrou: (a) o filtro de registros
 * invalidos confiava em um campo vindo do navegador em vez de revalidar
 * no servidor, e (b) sincronizar() nao serializava chamadas concorrentes
 * ao mesmo repository, permitindo leitura desatualizada (stale read)
 * entre buscarTodos() e salvarLote(). Ambos foram corrigidos em
 * SERVICO/servico-sincronizacao.js e estes dois testes provam a correcao.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJETO = path.join(__dirname, '..');
const AppLogico = require(path.join(PROJETO, 'WEB', 'app-logico'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

function contextoRequisicao(porta, metodo, urlPath, corpoObjOrBuffer, headersExtra) {
  return new Promise((resolve, reject) => {
    const isJson = corpoObjOrBuffer && !Buffer.isBuffer(corpoObjOrBuffer);
    const corpo = isJson ? Buffer.from(JSON.stringify(corpoObjOrBuffer)) : (corpoObjOrBuffer || Buffer.alloc(0));
    const headers = Object.assign({ 'Content-Type': isJson ? 'application/json' : 'application/octet-stream' }, headersExtra || {});
    const req = http.request({ hostname: 'localhost', port: porta, path: urlPath, method: metodo, headers }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf-8');
        let json = null;
        try { json = JSON.parse(texto); } catch (e) { /* nem sempre e json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(corpo);
    req.end();
  });
}

// ---------- Fixture de cliente PRIME ficticio completo (formato devolvido por /api/analisar) ----------
function clientePrimeFicticio(overrides) {
  return Object.assign({
    prime_id: null, nex_codigo: 1, origem_sistema: 'NEX', nome: 'Cliente Ficticio',
    cpf_cnpj: null, telefone: null, celular: '11999990000', email: null,
    canal_preferido: null, whatsapp_validado: false,
    endereco_logradouro: 'Rua Ficticia', endereco_numero: '1', endereco_complemento: null,
    endereco_bairro: 'Centro', endereco_cidade: 'Cidade Ficticia', endereco_uf: 'SC', endereco_cep: '00000-000',
    saldo_debito_nex: 0, saldo_credito_nex: 0, saldo_debito_anterior: null, saldo_credito_anterior: null,
    variacao_saldo: null, valor_liquido_nex: 0, data_snapshot_nex: '2026-07-31',
    observacao_original_nex: '', observacao_categoria: 'vazia', vencimento_sugerido: null,
    parcelamento_sugerido: null, confianca_extracao: null,
    vencimento_confirmado: null, parcelamento_confirmado: null, status_cobranca: 'sem_debito',
    observacao_prime: null, historico: [],
    ultima_cobranca_enviada_em: null, proxima_cobranca_agendada_em: null, tentativas_cobranca: 0,
    risco_inadimplencia: null, resumo_ia: null, sentimento_ultima_resposta: null,
    consentimento_contato: 'nao_solicitado', consentimento_registrado_em: null,
    cadastro_score: null, criado_em: null, atualizado_em: null,
    fonte_arquivo_origem: 'teste.xls', tipo_ultima_operacao: null, hash_registro_nex: null,
    tem_celular: true, tem_cpf: false, validacao_status: 'valido', erros: [], avisos: [], qtd_avisos: 0, revisao_manual: false,
  }, overrides);
}

function novoServidor() {
  // require novo a cada chamada NAO cria instancia nova (Node cacheia o
  // modulo) - isso e proposital: precisamos da MESMA instancia entre
  // requisicoes para simular "o servidor continua rodando". O teste 13
  // usa uma tecnica separada (limpar o cache) para simular reinicio real.
  const { criarServidor, repository } = require(path.join(PROJETO, 'SERVICO', 'servidor-local'));
  return { criarServidor, repository };
}

async function main() {
  const { criarServidor, repository } = novoServidor();
  const servidor = criarServidor();
  await new Promise((resolve) => servidor.listen(0, resolve));
  const porta = servidor.address().port;
  console.log('Servidor de teste rodando em porta efemera:', porta, '| estado inicial do Fake:', (await repository.buscarTodos()).length, 'cliente(s)');

  // ---------- 1. Fluxo completo com base vazia ----------
  console.log('\n=== 1. Fluxo completo com base vazia ===');
  todosPassaram &= check('Fake comeca vazio', (await repository.buscarTodos()).length === 0);
  const r1 = await contextoRequisicao(porta, 'POST', '/api/importar', {
    registros: [clientePrimeFicticio({ nex_codigo: 101, nome: 'Cliente 101' }), clientePrimeFicticio({ nex_codigo: 102, nome: 'Cliente 102' })],
  });
  todosPassaram &= check('status 200', r1.status === 200);
  todosPassaram &= check('total_processado = 2', r1.json.total_processado === 2);
  todosPassaram &= check('resumo_execucao.criados = 2', r1.json.resumo_execucao.criados === 2);
  todosPassaram &= check('Fake agora tem 2 clientes', (await repository.buscarTodos()).length === 2);
  todosPassaram &= check('cliente 101 recebeu prime_id no formato PRIME-<uuid>', /^PRIME-[0-9a-f-]{36}$/.test((await repository.buscarPorNexCodigo(101)).prime_id));

  // ---------- 2. Importacao com clientes novos (adicional, mesma base) ----------
  console.log('\n=== 2. Clientes novos adicionais ===');
  const r2 = await contextoRequisicao(porta, 'POST', '/api/importar', {
    registros: [clientePrimeFicticio({ nex_codigo: 101 }), clientePrimeFicticio({ nex_codigo: 102 }), clientePrimeFicticio({ nex_codigo: 103, nome: 'Cliente 103' })],
  });
  todosPassaram &= check('status 200', r2.status === 200);
  todosPassaram &= check('resumo_execucao.criados = 1 (so o 103 e novo)', r2.json.resumo_execucao.criados === 1);
  todosPassaram &= check('resumo_execucao.sem_alteracao = 2 (101 e 102 identicos)', r2.json.resumo_execucao.sem_alteracao === 2);

  // ---------- 3. Segunda importacao usando a MESMA instancia do Fake ----------
  console.log('\n=== 3. Segunda importacao usa a mesma instancia (nao reseta) ===');
  todosPassaram &= check('Fake tem 3 clientes apos as 2 importacoes (nao voltou a 0)', (await repository.buscarTodos()).length === 3);

  // ---------- 4. Cliente atualizado ----------
  console.log('\n=== 4. Cliente atualizado (saldo mudou) ===');
  const r4 = await contextoRequisicao(porta, 'POST', '/api/importar', {
    registros: [clientePrimeFicticio({ nex_codigo: 101, saldo_debito_nex: 250, valor_liquido_nex: 250, status_cobranca: 'em_aberto' })],
  });
  todosPassaram &= check('status 200', r4.status === 200);
  todosPassaram &= check('resumo_execucao.atualizados = 1', r4.json.resumo_execucao.atualizados === 1);
  todosPassaram &= check('cliente 101 com saldo_debito_nex = 250 no Fake', (await repository.buscarPorNexCodigo(101)).saldo_debito_nex === 250);

  // ---------- 5. Cliente quitado ----------
  console.log('\n=== 5. Cliente quitado ===');
  const r5 = await contextoRequisicao(porta, 'POST', '/api/importar', {
    registros: [clientePrimeFicticio({ nex_codigo: 101, saldo_debito_nex: 0, valor_liquido_nex: 0 })],
  });
  todosPassaram &= check('status 200', r5.status === 200);
  todosPassaram &= check('resumo_execucao.quitados = 1', r5.json.resumo_execucao.quitados === 1);
  todosPassaram &= check('cliente 101 com status_cobranca = pago no Fake', (await repository.buscarPorNexCodigo(101)).status_cobranca === 'pago');

  // ---------- 6. Cliente sem alteracao ----------
  console.log('\n=== 6. Cliente sem alteracao ===');
  const clienteAtual101 = await repository.buscarPorNexCodigo(101);
  const r6 = await contextoRequisicao(porta, 'POST', '/api/importar', {
    registros: [clientePrimeFicticio({ nex_codigo: 101, saldo_debito_nex: 0, valor_liquido_nex: 0 })],
  });
  todosPassaram &= check('status 200', r6.status === 200);
  todosPassaram &= check('resumo_execucao.sem_alteracao = 1', r6.json.resumo_execucao.sem_alteracao === 1);
  todosPassaram &= check('prime_id do 101 nao mudou', (await repository.buscarPorNexCodigo(101)).prime_id === clienteAtual101.prime_id);

  // ---------- 7. Lote vazio (nao e erro) ----------
  // Neste ponto o Fake ja tem 3 clientes (101,102,103) dos testes 1-2.
  // Importar um lote vazio contra uma base NAO vazia e valido, mas nao
  // "zera tudo": os 3 clientes existentes ficam sem correspondencia na
  // nova importacao, entao comparar-clientes.js corretamente os marca
  // como "nao_aplicados" (removido da exportacao) - comportamento da
  // Fase 2D, nao um bug. criados/atualizados/quitados/sem_alteracao
  // continuam zerados porque nenhum registro novo foi enviado.
  console.log('\n=== 7. Lote vazio ===');
  const r7 = await contextoRequisicao(porta, 'POST', '/api/importar', { registros: [] });
  todosPassaram &= check('lote vazio: status 200 (nao e erro)', r7.status === 200);
  todosPassaram &= check('lote vazio: total_processado = 0', r7.json.total_processado === 0);
  todosPassaram &= check('lote vazio: criados/atualizados/quitados/sem_alteracao = 0', r7.json.resumo_execucao.criados === 0 && r7.json.resumo_execucao.atualizados === 0 && r7.json.resumo_execucao.quitados === 0 && r7.json.resumo_execucao.sem_alteracao === 0);
  todosPassaram &= check('lote vazio: os 3 clientes existentes ficam nao_aplicados (removidos da exportacao)', r7.json.resumo_execucao.nao_aplicados === 3);
  todosPassaram &= check('lote vazio: clientes existentes NAO foram excluidos do Fake', (await repository.buscarTodos()).length === 3);

  // ---------- 8. Erro de payload ----------
  console.log('\n=== 8. Erro de payload ===');
  const r8a = await contextoRequisicao(porta, 'POST', '/api/importar', Buffer.from('isto nao e json'));
  todosPassaram &= check('corpo nao-JSON: status 400', r8a.status === 400);
  todosPassaram &= check('corpo nao-JSON: erro = payload_invalido', r8a.json.erro === 'payload_invalido');

  const r8b = await contextoRequisicao(porta, 'POST', '/api/importar', { registros: 'nao e um array' });
  todosPassaram &= check('registros nao-array: status 400', r8b.status === 400);
  todosPassaram &= check('registros nao-array: erro = payload_invalido', r8b.json.erro === 'payload_invalido');

  const r8c = await contextoRequisicao(porta, 'POST', '/api/importar', {});
  todosPassaram &= check('sem campo registros: status 400', r8c.status === 400);

  // ---------- 8b. Registros invalidos sao filtrados, nao importados ----------
  console.log('\n=== 8b. Registro invalido (nome vazio) e ignorado ===');
  const r8d = await contextoRequisicao(porta, 'POST', '/api/importar', {
    registros: [clientePrimeFicticio({ nex_codigo: 900, nome: '', validacao_status: 'invalido' })],
  });
  todosPassaram &= check('registro invalido: status 200 (filtrado, nao e erro de payload)', r8d.status === 200);
  todosPassaram &= check('registro invalido: total_processado = 0 (foi descartado)', r8d.json.total_processado === 0);
  todosPassaram &= check('registro invalido: NAO foi parar no Fake', (await repository.buscarPorNexCodigo(900)) === null);

  // ---------- 8c. Resistencia a adulteracao: campo validacao_status mentiroso e ignorado ----------
  // O servidor NAO confia no validacao_status enviado pelo navegador -
  // revalida com SRC/validar-normalizados.js. Aqui o registro AFIRMA ser
  // "valido" mas tem nome vazio (realmente invalido) - deve ser
  // descartado mesmo assim.
  console.log('\n=== 8c. Registro que MENTE sobre ser valido e revalidado e descartado ===');
  const r8e = await contextoRequisicao(porta, 'POST', '/api/importar', {
    registros: [clientePrimeFicticio({ nex_codigo: 901, nome: '', validacao_status: 'valido', avisos: [], erros: [] })],
  });
  todosPassaram &= check('registro adulterado: status 200', r8e.status === 200);
  todosPassaram &= check('registro adulterado: total_processado = 0 (revalidado e descartado apesar de validacao_status=valido)', r8e.json.total_processado === 0);
  todosPassaram &= check('registro adulterado: NAO foi parar no Fake', (await repository.buscarPorNexCodigo(901)) === null);

  // ---------- 9. Tentativa de confirmacao sem previa valida (logica pura da UI) ----------
  console.log('\n=== 9. Confirmacao sem previa valida (app-logico.js) ===');
  todosPassaram &= check('sem relatorio -> bloqueado', AppLogico.podeConfirmarImportacao(null).ok === false);
  todosPassaram &= check('relatorio com 0 validos e 0 avisos -> bloqueado', AppLogico.podeConfirmarImportacao({ totais: { validos: 0, validos_com_aviso: 0 } }).ok === false);
  todosPassaram &= check('relatorio com pelo menos 1 valido -> permitido', AppLogico.podeConfirmarImportacao({ totais: { validos: 1, validos_com_aviso: 0 } }).ok === true);

  // ---------- 10/11. Falha simulada do Repository + sem corrupcao parcial ----------
  console.log('\n=== 10/11. Falha simulada do Repository ===');
  const antesDaFalha = await repository.buscarTodos();
  repository.simularFalhaNaProximaGravacao(new Error('falha proposital de teste'));
  const r10 = await contextoRequisicao(porta, 'POST', '/api/importar', {
    registros: [clientePrimeFicticio({ nex_codigo: 999, nome: 'Nao deveria entrar' })],
  });
  todosPassaram &= check('falha simulada: status 500', r10.status === 500);
  todosPassaram &= check('falha simulada: erro = erro_sincronizacao', r10.json.erro === 'erro_sincronizacao');
  todosPassaram &= check('falha simulada: mensagem nao expoe stack trace', !/at\s+\w+\s*\(/.test(r10.json.mensagem || ''));
  const depoisDaFalha = await repository.buscarTodos();
  todosPassaram &= check('sem corrupcao parcial: Fake identico antes/depois da falha', JSON.stringify(antesDaFalha) === JSON.stringify(depoisDaFalha));
  todosPassaram &= check('sem corrupcao parcial: cliente 999 NAO entrou no Fake', (await repository.buscarPorNexCodigo(999)) === null);

  // ---------- 12a. Requisicoes concorrentes com o MESMO payload (duplo clique simples) ----------
  console.log('\n=== 12a. Requisicoes concorrentes - mesmo payload (duplo clique) ===');
  const payloadDuplo = { registros: [clientePrimeFicticio({ nex_codigo: 500, nome: 'Cliente Duplo Clique', saldo_debito_nex: 10, valor_liquido_nex: 10, status_cobranca: 'em_aberto' })] };
  const [rDup1, rDup2] = await Promise.all([
    contextoRequisicao(porta, 'POST', '/api/importar', payloadDuplo),
    contextoRequisicao(porta, 'POST', '/api/importar', payloadDuplo),
  ]);
  todosPassaram &= check('ambas as requisicoes concorrentes respondem 200 (sem crash)', rDup1.status === 200 && rDup2.status === 200);
  const clientesComCodigo500 = (await repository.buscarTodos()).filter((c) => c.nex_codigo === 500);
  todosPassaram &= check('nao duplicou o cliente 500 no Fake (exatamente 1 registro)', clientesComCodigo500.length === 1);
  todosPassaram &= check('cliente 500 tem dados validos e completos (nao corrompidos)', clientesComCodigo500[0].nome === 'Cliente Duplo Clique' && clientesComCodigo500[0].saldo_debito_nex === 10);

  // ---------- 12b. Requisicoes concorrentes com payloads DIFERENTES (prova real da serializacao) ----------
  // Usar o mesmo payload nas duas chamadas (12a) mascara a corrida real,
  // porque o resultado seria o mesmo em qualquer ordem. Aqui forcamos uma
  // janela de sobreposicao real (atraso artificial na 1a chamada a
  // buscarTodos) e mandamos DUAS ATUALIZACOES DIFERENTES para o MESMO
  // cliente ja existente - se sincronizar() nao serializasse por
  // repository, a 2a chamada poderia ler um "antes" desatualizado
  // (stale read) e o historico registraria as duas com o mesmo
  // saldo_anterior, provando a corrida. Com a fila (Fase 5, correcao),
  // a 2a chamada so comeca depois que a 1a termina, entao sempre ve o
  // resultado real da anterior.
  console.log('\n=== 12b. Requisicoes concorrentes - payloads DIFERENTES no mesmo cliente (prova de serializacao) ===');
  await contextoRequisicao(porta, 'POST', '/api/importar', {
    registros: [clientePrimeFicticio({ nex_codigo: 650, saldo_debito_nex: 100, valor_liquido_nex: 100, status_cobranca: 'em_aberto' })],
  });

  const buscarTodosOriginal = repository.buscarTodos.bind(repository);
  let chamadasBuscarTodos = 0;
  repository.buscarTodos = async function () {
    chamadasBuscarTodos++;
    if (chamadasBuscarTodos === 1) await new Promise((resolve) => setTimeout(resolve, 60));
    return buscarTodosOriginal();
  };

  const [rConcA, rConcB] = await Promise.all([
    contextoRequisicao(porta, 'POST', '/api/importar', { registros: [clientePrimeFicticio({ nex_codigo: 650, saldo_debito_nex: 150, valor_liquido_nex: 150, status_cobranca: 'em_aberto' })] }),
    contextoRequisicao(porta, 'POST', '/api/importar', { registros: [clientePrimeFicticio({ nex_codigo: 650, saldo_debito_nex: 200, valor_liquido_nex: 200, status_cobranca: 'em_aberto' })] }),
  ]);
  repository.buscarTodos = buscarTodosOriginal; // restaura o metodo original

  todosPassaram &= check('ambas respondem 200', rConcA.status === 200 && rConcB.status === 200);
  const cliente650 = await repository.buscarPorNexCodigo(650);
  todosPassaram &= check('saldo final e um dos dois valores validos (150 ou 200), nunca outro (sem corrupcao)', cliente650.saldo_debito_nex === 150 || cliente650.saldo_debito_nex === 200);
  const eventosAtualizacao650 = cliente650.historico.filter((e) => e.tipo === 'cliente_atualizado');
  todosPassaram &= check('historico tem exatamente 2 eventos de atualizacao (nenhuma das duas sincronizacoes foi perdida)', eventosAtualizacao650.length === 2);
  todosPassaram &= check(
    'os 2 eventos formam sequencia coerente (saldo_anterior do 2o = saldo_novo do 1o) - prova que a fila serializou e a 2a chamada NAO leu um "antes" desatualizado',
    eventosAtualizacao650[1].saldo_anterior === eventosAtualizacao650[0].saldo_novo,
  );

  console.log('  Nota: a defesa de UX contra duplo clique continua no navegador (estado.importando + botao desabilitado). Este teste prova, na camada de servico, que chamadas concorrentes ao MESMO repository sao serializadas (fila em SERVICO/servico-sincronizacao.js), entao nao ha mais leitura desatualizada (stale read) entre buscarTodos() e salvarLote().');

  servidor.close();

  // ---------- 13. Reinicio do servidor zera a Fake ----------
  console.log('\n=== 13. Reinicio do servidor (novo processo/modulo) zera a Fake ===');
  const caminhoServidor = require.resolve(path.join(PROJETO, 'SERVICO', 'servidor-local'));
  delete require.cache[caminhoServidor];
  const modoNovo = require(caminhoServidor); // simula um "novo processo": modulo recarregado do zero
  todosPassaram &= check('nova instancia do modulo comeca com Fake vazio', (await modoNovo.repository.buscarTodos()).length === 0);
  todosPassaram &= check('nova instancia e DIFERENTE da anterior (nao e a mesma referencia)', modoNovo.repository !== repository);

  // ---------- 14. Regressao rapida da interface anterior (POST /api/analisar continua igual) ----------
  console.log('\n=== 14. Regressao: /api/analisar continua funcionando (Fase 3A/4B) ===');
  const servidor2 = modoNovo.criarServidor();
  await new Promise((resolve) => servidor2.listen(0, resolve));
  const porta2 = servidor2.address().port;
  const XLSX = require(path.join(PROJETO, 'node_modules', 'xlsx'));
  const ws = XLSX.utils.aoa_to_sheet([
    ['Código', 'Nome', 'Débito / Crédito', 'Celular', 'CPF / CNPJ', 'Observações'],
    [1, 'Cliente Regressao', 'Débito- R$ 50,00', '11999990000', '', ''],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const bufferTeste = XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
  const r14 = await contextoRequisicao(porta2, 'POST', '/api/analisar', bufferTeste, { 'X-Nome-Arquivo': 'teste.xls' });
  todosPassaram &= check('/api/analisar continua respondendo 200 normalmente', r14.status === 200);
  todosPassaram &= check('/api/analisar: total_debito = 50 (regra de negocio intacta)', r14.json.relatorio.totais.total_debito === 50);
  servidor2.close();

  // ---------- 15. Ausencia de persistencia em disco ----------
  console.log('\n=== 15. Ausencia de persistencia em disco ===');
  function snapshotProjeto() {
    const arquivos = [];
    function varrer(dir) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
        if (ent.name === 'node_modules') return;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) varrer(p);
        else arquivos.push(p + '|' + fs.statSync(p).size);
      });
    }
    varrer(PROJETO);
    return arquivos.sort().join('\n');
  }
  const antesDoDisco = snapshotProjeto();
  const servidor3 = modoNovo.criarServidor();
  await new Promise((resolve) => servidor3.listen(0, resolve));
  const porta3 = servidor3.address().port;
  await contextoRequisicao(porta3, 'POST', '/api/importar', { registros: [clientePrimeFicticio({ nex_codigo: 700 })] });
  const depoisDoDisco = snapshotProjeto();
  servidor3.close();
  todosPassaram &= check('nenhum arquivo criado/alterado no projeto apos importar', antesDoDisco === depoisDoDisco);

  // ---------- 16. Ausencia de integracao externa ----------
  console.log('\n=== 16. Ausencia de integracao externa ===');
  const arquivosServico = ['servidor-local.js', 'servico-importacao.js', 'servico-sincronizacao.js', 'repositorio-clientes-fake.js'].map((f) => fs.readFileSync(path.join(PROJETO, 'SERVICO', f), 'utf-8'));
  const textoTodosServicos = arquivosServico.join('\n');
  todosPassaram &= check('nenhum require de SDK de backend externo (base44/supabase/sqlite)', !/require\([^)]*(base44|supabase|sqlite)[^)]*\)/i.test(textoTodosServicos));
  todosPassaram &= check('nenhuma chamada de rede externa (http.request/fetch a outro host)', !/https?:\/\/(?!localhost)/i.test(textoTodosServicos));

  console.log('\nResultado geral fluxo de importacao (Fase 5):', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((e) => { console.error('ERRO NO TESTE:', e); process.exitCode = 1; });
