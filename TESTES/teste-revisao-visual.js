'use strict';

/**
 * Teste PERMANENTE da revisao visual (Fase 3B: WEB/app-logico.js -
 * filtros, busca, detalhes).
 * Preservado a partir do scratchpad em 2026-07-30 (Fase 4D - preparacao
 * pre-commit): caminho absoluto trocado por relativo; teste com os
 * 1.386 registros reais (4/5) agora verifica a existencia do .xls antes
 * de rodar - ele e ignorado pelo Git de proposito. Fixture de registros
 * ficticios (Ana Silva, Bruno Costa etc.) mantida como estava - nomes
 * inventados para o teste, sem nenhum dado real.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJETO = path.join(__dirname, '..');
const { criarServidor } = require(path.join(PROJETO, 'SERVICO', 'servidor-local'));
const AppLogico = require(path.join(PROJETO, 'WEB', 'app-logico'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

function requisitar(porta, metodo, urlPath, headers, corpoBuffer) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: porta, path: urlPath, method: metodo, headers }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf-8');
        resolve({ status: res.statusCode, json: JSON.parse(texto) });
      });
    });
    req.on('error', reject);
    if (corpoBuffer) req.write(corpoBuffer);
    req.end();
  });
}

// ---------- Fixture de registros ficticios para testar filtros/busca em isolado (sem dado real) ----------
function registrosFicticios() {
  return [
    { nex_codigo: 1, nome: 'Ana Silva', telefone: '4733220000', celular: '', saldo_debito_nex: 100, saldo_credito_nex: 0, tem_celular: false, tem_cpf: true, validacao_status: 'valido_com_aviso', observacao_categoria: 'vazia', qtd_avisos: 1, revisao_manual: true, status_cobranca: 'em_aberto' },
    { nex_codigo: 2, nome: 'Bruno Costa', telefone: '', celular: '47999990000', saldo_debito_nex: 0, saldo_credito_nex: 0, tem_celular: true, tem_cpf: false, validacao_status: 'valido', observacao_categoria: 'vazia', qtd_avisos: 0, revisao_manual: false, status_cobranca: 'sem_debito' },
    { nex_codigo: 3, nome: 'Carla Dias', telefone: '', celular: '', saldo_debito_nex: 50, saldo_credito_nex: 0, tem_celular: false, tem_cpf: false, validacao_status: 'invalido', observacao_categoria: 'ambigua', qtd_avisos: 0, revisao_manual: false, status_cobranca: 'em_aberto' },
    { nex_codigo: 4, nome: 'Ana Paula', telefone: '', celular: '47988887777', saldo_debito_nex: 300, saldo_credito_nex: 0, tem_celular: true, tem_cpf: true, validacao_status: 'valido', observacao_categoria: 'estruturada', qtd_avisos: 0, revisao_manual: false, status_cobranca: 'em_aberto' },
  ];
}

async function main() {
  // ---------- 1. Filtros (logica pura) ----------
  console.log('\n=== 1. Filtros (app-logico.js, registros ficticios) ===');
  const regs = registrosFicticios();
  todosPassaram &= check('todos: 4 registros', AppLogico.filtrarRegistros(regs, 'todos', '').length === 4);
  todosPassaram &= check('com_debito: codigos 1,3,4', AppLogico.filtrarRegistros(regs, 'com_debito', '').map((r) => r.nex_codigo).join(',') === '1,3,4');
  todosPassaram &= check('sem_debito: codigo 2', AppLogico.filtrarRegistros(regs, 'sem_debito', '').map((r) => r.nex_codigo).join(',') === '2');
  todosPassaram &= check('com_aviso: codigo 1', AppLogico.filtrarRegistros(regs, 'com_aviso', '').map((r) => r.nex_codigo).join(',') === '1');
  todosPassaram &= check('invalidos: codigo 3', AppLogico.filtrarRegistros(regs, 'invalidos', '').map((r) => r.nex_codigo).join(',') === '3');
  todosPassaram &= check('revisao_manual: codigo 1', AppLogico.filtrarRegistros(regs, 'revisao_manual', '').map((r) => r.nex_codigo).join(',') === '1');
  todosPassaram &= check('com_celular: codigos 2,4', AppLogico.filtrarRegistros(regs, 'com_celular', '').map((r) => r.nex_codigo).join(',') === '2,4');
  todosPassaram &= check('sem_celular: codigos 1,3', AppLogico.filtrarRegistros(regs, 'sem_celular', '').map((r) => r.nex_codigo).join(',') === '1,3');

  // ---------- 2. Busca ----------
  console.log('\n=== 2. Busca ===');
  todosPassaram &= check('busca por nome parcial "ana": codigos 1,4', AppLogico.filtrarRegistros(regs, 'todos', 'ana').map((r) => r.nex_codigo).join(',') === '1,4');
  todosPassaram &= check('busca por "3": codigos 1 (telefone contem 3) e 3 (codigo)', AppLogico.filtrarRegistros(regs, 'todos', '3').map((r) => r.nex_codigo).join(',') === '1,3');
  todosPassaram &= check('busca por telefone "4733": codigo 1', AppLogico.filtrarRegistros(regs, 'todos', '4733').map((r) => r.nex_codigo).join(',') === '1');
  todosPassaram &= check('busca por celular "9999": codigo 2', AppLogico.filtrarRegistros(regs, 'todos', '9999').map((r) => r.nex_codigo).join(',') === '2');
  todosPassaram &= check('busca combinada com filtro (com_debito + "ana"): codigos 1 e 4', AppLogico.filtrarRegistros(regs, 'com_debito', 'ana').map((r) => r.nex_codigo).join(',') === '1,4');
  todosPassaram &= check('busca sem match: 0 resultados', AppLogico.filtrarRegistros(regs, 'todos', 'zzz-nao-existe').length === 0);

  // ---------- 3. Abertura de detalhes (logica pura) ----------
  console.log('\n=== 3. Abertura de detalhes ===');
  todosPassaram &= check('abrir com resultado -> secao revisao', AppLogico.proximaSecaoAoAbrirRevisao(true) === AppLogico.SECAO.REVISAO);
  todosPassaram &= check('abrir sem resultado -> null', AppLogico.proximaSecaoAoAbrirRevisao(false) === null);
  const registroTeste = {
    nex_codigo: 10, nome: 'Cliente Teste', telefone: null, celular: '11999998888', email: null, cpf_cnpj: null,
    endereco_logradouro: 'Rua X', endereco_numero: '1', endereco_complemento: null, endereco_bairro: 'B', endereco_cidade: 'C', endereco_uf: 'SC', endereco_cep: '00000-000',
    saldo_debito_nex: 200, saldo_credito_nex: 0, valor_liquido_nex: 200, status_cobranca: 'em_aberto',
    observacao_original_nex: '2x 100,00 dia 10', observacao_categoria: 'estruturada', vencimento_sugerido: 10,
    parcelamento_sugerido: { qtd: 2, valor: 100 }, confianca_extracao: 'alta',
    avisos: ['cliente com debito em aberto mas sem CPF/CNPJ cadastrado'], erros: [],
  };
  const detalhes = AppLogico.detalhesDoRegistro(registroTeste);
  todosPassaram &= check('detalhes: dadosNex tem Codigo NEX = 10', detalhes.dadosNex.some((p) => p[0] === 'Código NEX' && p[1] === 10));
  todosPassaram &= check('detalhes: dadosNormalizados tem saldo liquido R$ 200.00', detalhes.dadosNormalizados.some((p) => p[0] === 'Saldo líquido' && p[1] === 'R$ 200.00'));
  todosPassaram &= check('detalhes: sugestoes tem vencimento dia 10', detalhes.sugestoes.some((p) => p[0] === 'Vencimento sugerido' && p[1] === 'dia 10'));
  todosPassaram &= check('detalhes: avisos tem 1 item', detalhes.avisos.length === 1);
  todosPassaram &= check('detalhes: classificacaoFinanceira = Em aberto (devendo)', detalhes.classificacaoFinanceira === 'Em aberto (devendo)');
  todosPassaram &= check('detalhes: explicacao menciona o debito', detalhes.explicacao.indexOf('R$ 200.00') !== -1);
  todosPassaram &= check('detalhes: explicacao menciona a sugestao de parcelamento', detalhes.explicacao.indexOf('2x de R$ 100.00') !== -1);

  // ---------- 4/5. Consistencia dos totais + 1.386 registros reais (via servidor real), se o arquivo existir ----------
  console.log('\n=== 4/5. Consistencia dos totais com os 1.386 registros reais ===');
  const arquivoReal = path.join(PROJETO, 'EXPORTADOS', 'clientes-nex.xls');
  if (fs.existsSync(arquivoReal)) {
    const servidor = criarServidor();
    await new Promise((resolve) => servidor.listen(0, resolve));
    const porta = servidor.address().port;

    const bufferReal = fs.readFileSync(arquivoReal);
    const resp = await requisitar(porta, 'POST', '/api/analisar', { 'X-Nome-Arquivo': 'clientes-nex.xls', 'Content-Type': 'application/octet-stream' }, bufferReal);
    todosPassaram &= check('real: status 200', resp.status === 200);

    const dados = resp.json;
    todosPassaram &= check('real: registros.length = 1386', dados.registros.length === 1386);

    const t = dados.relatorio.totais;
    const p = dados.relatorio.previsao_importacao;

    const comDebito = AppLogico.filtrarRegistros(dados.registros, 'com_debito', '');
    const semDebito = AppLogico.filtrarRegistros(dados.registros, 'sem_debito', '');
    const comAviso = AppLogico.filtrarRegistros(dados.registros, 'com_aviso', '');
    const invalidos = AppLogico.filtrarRegistros(dados.registros, 'invalidos', '');
    const revisaoManual = AppLogico.filtrarRegistros(dados.registros, 'revisao_manual', '');
    const comCelular = AppLogico.filtrarRegistros(dados.registros, 'com_celular', '');
    const semCelular = AppLogico.filtrarRegistros(dados.registros, 'sem_celular', '');

    todosPassaram &= check('filtro com_debito bate com relatorio.totais.clientes_com_debito (36)', comDebito.length === t.clientes_com_debito && comDebito.length === 36);
    todosPassaram &= check('filtro sem_debito bate com relatorio.totais.clientes_sem_debito (1350)', semDebito.length === t.clientes_sem_debito);
    todosPassaram &= check('filtro com_aviso bate com relatorio.totais.validos_com_aviso (38)', comAviso.length === t.validos_com_aviso);
    todosPassaram &= check('filtro invalidos bate com relatorio.totais.invalidos (0)', invalidos.length === t.invalidos);
    todosPassaram &= check('filtro revisao_manual bate com previsao_importacao.revisao_manual (28)', revisaoManual.length === p.revisao_manual);
    todosPassaram &= check('filtro com_celular bate com relatorio.totais.com_celular (791)', comCelular.length === t.com_celular);
    todosPassaram &= check('filtro sem_celular bate com relatorio.totais.sem_celular (595)', semCelular.length === t.sem_celular);
    todosPassaram &= check('com_debito + sem_debito = total', comDebito.length + semDebito.length === t.total_registros);
    todosPassaram &= check('soma total_debito dos registros com_debito bate com relatorio.totais.total_debito', Math.abs(comDebito.reduce((s, r) => s + r.saldo_debito_nex, 0) - t.total_debito) < 0.01);

    const resumo = AppLogico.resumoSuperior(dados.relatorio);
    todosPassaram &= check('resumoSuperior tem 8 itens', resumo.length === 8);
    todosPassaram &= check('resumoSuperior[0] = Total de registros = 1386', resumo[0][0] === 'Total de registros' && resumo[0][1] === 1386);
    todosPassaram &= check('resumoSuperior contem Revisão manual = 28', resumo.some((p2) => p2[0] === 'Revisão manual' && p2[1] === 28));

    const exemploComDebito = comDebito[0];
    const detalhesReal = AppLogico.detalhesDoRegistro(exemploComDebito);
    todosPassaram &= check('detalhesDoRegistro funciona com registro real (tem explicacao nao vazia)', typeof detalhesReal.explicacao === 'string' && detalhesReal.explicacao.length > 0);

    servidor.close();
  } else {
    console.log('AVISO: EXPORTADOS/clientes-nex.xls nao encontrado neste ambiente (arquivo real, intencionalmente fora do Git) - pulando testes 4/5.');
  }

  console.log('\nResultado geral revisao visual (Fase 3B):', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((e) => { console.error('ERRO NO TESTE:', e); process.exitCode = 1; });
