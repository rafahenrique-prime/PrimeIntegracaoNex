'use strict';

/**
 * Teste PERMANENTE do SERVICO/servico-sincronizacao.js (Fase 4C).
 * Executar com: node TESTES\teste-servico-sincronizacao.js
 *
 * Usa SERVICO/repositorio-clientes-fake.js (Fake, so para teste) para
 * validar o fluxo completo: buscarTodos -> comparar-clientes ->
 * executar-plano-importacao -> salvarLote.
 *
 * Ajuste (revisao critica da Fase 5, antes da aprovacao final):
 * sincronizar() passou a revalidar novaImportacao com
 * SRC/validar-normalizados.js antes de sincronizar. Isso expos 3
 * fixtures desta suite que sempre foram inconsistentes (saldo_debito_nex
 * > 0 sem status_cobranca = "em_aberto" correspondente) mas nunca eram
 * checadas porque sincronizar() nao validava nada antes. Corrigidas para
 * refletir dados realmente validos - nenhuma asserção foi enfraquecida.
 */

const path = require('path');

const PROJETO = path.join(__dirname, '..');
const { RepositorioClientesFake } = require(path.join(PROJETO, 'SERVICO', 'repositorio-clientes-fake'));
const { sincronizar } = require(path.join(PROJETO, 'SERVICO', 'servico-sincronizacao'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

function contexto(overrides) {
  return Object.assign({
    dataExecucao: '2026-07-30T18:00:00.000Z',
    geradorPrimeId: (nexCodigo) => `PRIME-${nexCodigo}`,
  }, overrides);
}

function clientePrime(overrides) {
  return Object.assign({
    prime_id: null, nex_codigo: 1, origem_sistema: 'NEX', nome: 'Cliente Teste',
    cpf_cnpj: null, telefone: null, celular: '11999990000', email: null,
    canal_preferido: null, whatsapp_validado: false,
    endereco_logradouro: 'Rua A', endereco_numero: '1', endereco_complemento: null,
    endereco_bairro: 'Centro', endereco_cidade: 'Cidade X', endereco_uf: 'SP', endereco_cep: '00000-000',
    saldo_debito_nex: 0, saldo_credito_nex: 0, saldo_debito_anterior: null, saldo_credito_anterior: null,
    variacao_saldo: null, valor_liquido_nex: 0, data_snapshot_nex: '2026-07-01',
    observacao_original_nex: '', observacao_categoria: 'vazia', vencimento_sugerido: null,
    parcelamento_sugerido: null, confianca_extracao: null,
    vencimento_confirmado: null, parcelamento_confirmado: null, status_cobranca: 'sem_debito',
    observacao_prime: null, historico: [],
    ultima_cobranca_enviada_em: null, proxima_cobranca_agendada_em: null, tentativas_cobranca: 0,
    risco_inadimplencia: null, resumo_ia: null, sentimento_ultima_resposta: null,
    consentimento_contato: 'nao_solicitado', consentimento_registrado_em: null,
    cadastro_score: null, criado_em: null, atualizado_em: null,
    fonte_arquivo_origem: 'clientes-nex.xls', tipo_ultima_operacao: null, hash_registro_nex: null,
  }, overrides);
}

async function main() {
  // ---------- 1. Primeira sincronizacao (base vazia) ----------
  console.log('\n=== 1. Primeira sincronizacao (base vazia) ===');
  const repo1 = new RepositorioClientesFake();
  const nova1 = [clientePrime({ nex_codigo: 100, saldo_debito_nex: 50, valor_liquido_nex: 50, status_cobranca: 'em_aberto' }), clientePrime({ nex_codigo: 101 })];
  const r1 = await sincronizar(repo1, nova1, contexto());
  todosPassaram &= check('primeira sync: 2 criados', r1.execucao.resumo_execucao.criados === 2);
  todosPassaram &= check('primeira sync: 0 atualizados/quitados/sem_alteracao/nao_aplicados', r1.execucao.resumo_execucao.atualizados === 0 && r1.execucao.resumo_execucao.quitados === 0 && r1.execucao.resumo_execucao.sem_alteracao === 0 && r1.execucao.resumo_execucao.nao_aplicados === 0);
  const posRepo1 = await repo1.buscarTodos();
  todosPassaram &= check('repository ficou com os 2 clientes apos sincronizar', posRepo1.length === 2);
  todosPassaram &= check('cliente novo recebeu prime_id gerado', (await repo1.buscarPorNexCodigo(100)).prime_id === 'PRIME-100');

  // ---------- 2. Clientes novos (em meio a base ja existente) ----------
  console.log('\n=== 2. Clientes novos em base ja existente ===');
  const repo2 = new RepositorioClientesFake([clientePrime({ nex_codigo: 1, prime_id: 'PRIME-1' })]);
  const nova2 = [clientePrime({ nex_codigo: 1 }), clientePrime({ nex_codigo: 2 })]; // 1 existente (sem alteracao), 2 novo
  const r2 = await sincronizar(repo2, nova2, contexto());
  todosPassaram &= check('1 criado (codigo 2)', r2.execucao.resumo_execucao.criados === 1);
  todosPassaram &= check('cliente novo tem prime_id gerado corretamente', (await repo2.buscarPorNexCodigo(2)).prime_id === 'PRIME-2');

  // ---------- 3/4. Clientes ja existentes / inalterados ----------
  console.log('\n=== 3/4. Clientes existentes e inalterados ===');
  const clienteExistente = clientePrime({ nex_codigo: 5, prime_id: 'PRIME-5', atualizado_em: '2026-01-01T00:00:00.000Z', historico: [{ tipo: 'nota_manual' }] });
  const repo3 = new RepositorioClientesFake([clienteExistente]);
  const nova3 = [clientePrime({ nex_codigo: 5 })]; // identico
  const r3 = await sincronizar(repo3, nova3, contexto());
  todosPassaram &= check('sem_alteracao = 1', r3.execucao.resumo_execucao.sem_alteracao === 1);
  const pos3 = await repo3.buscarPorNexCodigo(5);
  todosPassaram &= check('atualizado_em NAO mudou (inalterado)', pos3.atualizado_em === '2026-01-01T00:00:00.000Z');
  todosPassaram &= check('historico nao ganhou evento novo', pos3.historico.length === 1);

  // ---------- 5. Atualizacao de registros ----------
  console.log('\n=== 5. Atualizacao de registros (saldo mudou) ===');
  const repo4 = new RepositorioClientesFake([clientePrime({ nex_codigo: 10, prime_id: 'PRIME-10', saldo_debito_nex: 100, valor_liquido_nex: 100, status_cobranca: 'em_aberto' })]);
  const nova4 = [clientePrime({ nex_codigo: 10, saldo_debito_nex: 250, valor_liquido_nex: 250, status_cobranca: 'em_aberto' })];
  const r4 = await sincronizar(repo4, nova4, contexto());
  todosPassaram &= check('atualizados = 1', r4.execucao.resumo_execucao.atualizados === 1);
  const pos4 = await repo4.buscarPorNexCodigo(10);
  todosPassaram &= check('saldo_debito_nex atualizado para 250', pos4.saldo_debito_nex === 250);
  todosPassaram &= check('saldo_debito_anterior = 100', pos4.saldo_debito_anterior === 100);
  todosPassaram &= check('historico ganhou 1 evento cliente_atualizado', pos4.historico.some((e) => e.tipo === 'cliente_atualizado'));

  // ---------- 6. Preservacao dos IDs existentes ----------
  console.log('\n=== 6. Preservacao dos IDs existentes ===');
  todosPassaram &= check('prime_id do cliente atualizado continua PRIME-10 (nao foi regerado)', pos4.prime_id === 'PRIME-10');
  todosPassaram &= check('prime_id do cliente inalterado (teste 3/4) continua PRIME-5', pos3.prime_id === 'PRIME-5');

  // ---------- 7. Lote vazio ----------
  console.log('\n=== 7. Lote vazio (base e importacao vazias) ===');
  const repo5 = new RepositorioClientesFake();
  const r5 = await sincronizar(repo5, [], contexto());
  todosPassaram &= check('nenhum erro, resumo todo zerado', Object.values(r5.execucao.resumo_execucao).every((v) => v === 0));
  todosPassaram &= check('repository continua vazio', (await repo5.buscarTodos()).length === 0);

  // ---------- 8. Falha simulada em salvarLote() ----------
  console.log('\n=== 8. Falha simulada em salvarLote() ===');
  const repo6 = new RepositorioClientesFake([clientePrime({ nex_codigo: 1, prime_id: 'PRIME-1' })]);
  repo6.simularFalhaNaProximaGravacao(new Error('falha proposital no repository'));
  let erroSync = null;
  try { await sincronizar(repo6, [clientePrime({ nex_codigo: 1 }), clientePrime({ nex_codigo: 2 })], contexto()); } catch (e) { erroSync = e; }
  todosPassaram &= check('sincronizar() propaga o erro do repository', erroSync && erroSync.message === 'falha proposital no repository');

  // ---------- 9. Comportamento do servico diante de erro do Repository ----------
  console.log('\n=== 9. Estado do repository apos erro (sem corrupcao parcial) ===');
  const posErro = await repo6.buscarTodos();
  todosPassaram &= check('repository manteve o estado ANTERIOR (nao foi parcialmente alterado)', posErro.length === 1 && posErro[0].nex_codigo === 1);
  // confirma que uma nova tentativa (sem falha armada) funciona normalmente
  const r9b = await sincronizar(repo6, [clientePrime({ nex_codigo: 1 }), clientePrime({ nex_codigo: 2 })], contexto());
  todosPassaram &= check('nova tentativa apos o erro funciona normalmente', r9b.execucao.resumo_execucao.criados === 1 && (await repo6.buscarTodos()).length === 2);

  // ---------- 9b. Repository invalido (nao implementa o contrato) ----------
  console.log('\n=== 9b. Repository que nao implementa o contrato ===');
  let erroContrato = null;
  try { await sincronizar({ buscarTodos: async () => [] }, [], contexto()); } catch (e) { erroContrato = e; }
  todosPassaram &= check('sincronizar rejeita Repository sem salvarLote/buscarPorNexCodigo', erroContrato && /Repository invalido/.test(erroContrato.message));

  // ---------- 10. Execucao completa do fluxo (misto: novo+atualizado+quitado+sem_alteracao+removido) ----------
  console.log('\n=== 10. Execucao completa do fluxo (cenario misto) ===');
  const baseCompleta = [
    clientePrime({ nex_codigo: 201, prime_id: 'PRIME-201', saldo_debito_nex: 100, valor_liquido_nex: 100, status_cobranca: 'em_aberto' }), // sera atualizado
    clientePrime({ nex_codigo: 202, prime_id: 'PRIME-202', saldo_debito_nex: 300, valor_liquido_nex: 300, status_cobranca: 'em_aberto' }), // sera quitado
    clientePrime({ nex_codigo: 203, prime_id: 'PRIME-203' }), // sem alteracao
    clientePrime({ nex_codigo: 204, prime_id: 'PRIME-204' }), // removido da exportacao
  ];
  const novaCompleta = [
    clientePrime({ nex_codigo: 201, saldo_debito_nex: 400, valor_liquido_nex: 400, status_cobranca: 'em_aberto' }),
    clientePrime({ nex_codigo: 202, saldo_debito_nex: 0, valor_liquido_nex: 0 }),
    clientePrime({ nex_codigo: 203 }),
    clientePrime({ nex_codigo: 205 }), // novo
  ];
  const repo7 = new RepositorioClientesFake(baseCompleta);
  const r10 = await sincronizar(repo7, novaCompleta, contexto());
  const resumo10 = r10.execucao.resumo_execucao;
  todosPassaram &= check('cenario misto: 1 criado, 1 atualizado, 1 quitado, 1 sem_alteracao, 1 nao_aplicado', resumo10.criados === 1 && resumo10.atualizados === 1 && resumo10.quitados === 1 && resumo10.sem_alteracao === 1 && resumo10.nao_aplicados === 1);

  const baseFinal = await repo7.buscarTodos();
  todosPassaram &= check('repository final tem 5 clientes (204 nao foi excluido)', baseFinal.length === 5);
  todosPassaram &= check('cliente 204 (removido da exportacao) continua no repository', baseFinal.some((c) => c.nex_codigo === 204));
  todosPassaram &= check('cliente 202 (quitado) esta com status_cobranca = pago', (await repo7.buscarPorNexCodigo(202)).status_cobranca === 'pago');
  todosPassaram &= check('repository.buscarTodos() bate exatamente com execucao.nova_base (mesmo conteudo persistido)', JSON.stringify(baseFinal.sort((a, b) => a.nex_codigo - b.nex_codigo)) === JSON.stringify(JSON.parse(JSON.stringify(r10.execucao.nova_base)).sort((a, b) => a.nex_codigo - b.nex_codigo)));

  console.log('\nResultado geral servico-sincronizacao.js (Fase 4C):', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((e) => { console.error('ERRO NO TESTE:', e); process.exitCode = 1; });
