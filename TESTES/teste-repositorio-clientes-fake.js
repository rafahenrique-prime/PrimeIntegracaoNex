'use strict';

/**
 * Teste PERMANENTE do SERVICO/repositorio-clientes-fake.js (Fase 4C).
 * Executar com: node TESTES\teste-repositorio-clientes-fake.js
 */

const fs = require('fs');
const path = require('path');

const PROJETO = path.join(__dirname, '..');
const { RepositorioClientesFake } = require(path.join(PROJETO, 'SERVICO', 'repositorio-clientes-fake'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

function cliente(overrides) {
  return Object.assign({
    prime_id: 'P-1', nex_codigo: 1, nome: 'Cliente Teste',
    saldo_debito_nex: 0, saldo_credito_nex: 0,
  }, overrides);
}

async function main() {
  // ---------- Contrato basico ----------
  console.log('\n=== Contrato: construtor vazio ===');
  const repoVazio = new RepositorioClientesFake();
  todosPassaram &= check('buscarTodos() = [] quando construido sem dados', (await repoVazio.buscarTodos()).length === 0);

  console.log('\n=== Contrato: construtor com dados iniciais ===');
  const repo = new RepositorioClientesFake([cliente({ nex_codigo: 1 }), cliente({ nex_codigo: 2, prime_id: 'P-2' })]);
  const todos = await repo.buscarTodos();
  todosPassaram &= check('buscarTodos() retorna os 2 iniciais', todos.length === 2);

  console.log('\n=== Contrato: buscarPorNexCodigo ===');
  const encontrado = await repo.buscarPorNexCodigo(1);
  const naoEncontrado = await repo.buscarPorNexCodigo(999);
  todosPassaram &= check('buscarPorNexCodigo encontra existente', encontrado && encontrado.prime_id === 'P-1');
  todosPassaram &= check('buscarPorNexCodigo retorna null para inexistente', naoEncontrado === null);
  todosPassaram &= check('buscarPorNexCodigo aceita numero ou string equivalentes', (await repo.buscarPorNexCodigo('1')).prime_id === 'P-1');

  console.log('\n=== Contrato: salvarLote (upsert) ===');
  await repo.salvarLote([cliente({ nex_codigo: 3, prime_id: 'P-3' }), cliente({ nex_codigo: 1, prime_id: 'P-1', saldo_debito_nex: 999 })]);
  const aposSalvar = await repo.buscarTodos();
  todosPassaram &= check('salvarLote insere novo (nex_codigo 3)', aposSalvar.some((c) => c.nex_codigo === 3));
  todosPassaram &= check('salvarLote atualiza existente (nex_codigo 1, saldo 999)', (await repo.buscarPorNexCodigo(1)).saldo_debito_nex === 999);
  todosPassaram &= check('total apos upsert = 3 (1,2,3)', aposSalvar.length === 3);

  console.log('\n=== Contrato: salvarLote ignora entradas sem nex_codigo (integridade, nao regra de negocio) ===');
  await repo.salvarLote([{ nome: 'sem codigo' }, null, undefined]);
  todosPassaram &= check('total permanece 3 apos tentar salvar lixo sem nex_codigo', (await repo.buscarTodos()).length === 3);

  // ---------- Isolamento por clone (nao vaza referencia) ----------
  console.log('\n=== Isolamento: buscarTodos() retorna copias, nao referencias internas ===');
  const lista1 = await repo.buscarTodos();
  lista1[0].nome = 'MUTADO EXTERNAMENTE';
  const lista2 = await repo.buscarTodos();
  todosPassaram &= check('mutar o array retornado nao afeta o estado interno', lista2.every((c) => c.nome !== 'MUTADO EXTERNAMENTE'));

  console.log('\n=== Isolamento: dados iniciais tambem sao clonados no construtor ===');
  const original = cliente({ nex_codigo: 50 });
  const repo2 = new RepositorioClientesFake([original]);
  original.nome = 'MUTADO NO OBJETO ORIGINAL';
  const doRepo = await repo2.buscarPorNexCodigo(50);
  todosPassaram &= check('mutar o objeto original (fora) nao afeta o que esta no Fake', doRepo.nome !== 'MUTADO NO OBJETO ORIGINAL');

  // ---------- Falha simulada ----------
  console.log('\n=== Falha simulada em salvarLote ===');
  const repo3 = new RepositorioClientesFake([cliente({ nex_codigo: 1 })]);
  repo3.simularFalhaNaProximaGravacao(new Error('falha proposital'));
  let erroCapturado = null;
  try { await repo3.salvarLote([cliente({ nex_codigo: 2 })]); } catch (e) { erroCapturado = e; }
  todosPassaram &= check('salvarLote rejeita quando falha esta armada', erroCapturado && erroCapturado.message === 'falha proposital');
  todosPassaram &= check('estado interno nao foi alterado pela chamada que falhou', (await repo3.buscarTodos()).length === 1);

  let segundaChamadaOk = true;
  try { await repo3.salvarLote([cliente({ nex_codigo: 2 })]); } catch (e) { segundaChamadaOk = false; }
  todosPassaram &= check('a falha e "consumida" - segunda chamada funciona normalmente', segundaChamadaOk && (await repo3.buscarTodos()).length === 2);

  // ---------- Nao toca disco ----------
  console.log('\n=== Nao toca disco (checagem estrutural) ===');
  const textoFake = fs.readFileSync(path.join(PROJETO, 'SERVICO', 'repositorio-clientes-fake.js'), 'utf-8');
  todosPassaram &= check('nao importa "fs"', !/require\(\s*['"]fs['"]\s*\)/.test(textoFake));
  todosPassaram &= check('nao importa nenhum SDK de backend (base44/supabase/sqlite)', !/require\([^)]*(base44|supabase|sqlite)[^)]*\)/i.test(textoFake));

  console.log('\nResultado geral repositorio-clientes-fake.js (Fase 4C):', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((e) => { console.error('ERRO NO TESTE:', e); process.exitCode = 1; });
