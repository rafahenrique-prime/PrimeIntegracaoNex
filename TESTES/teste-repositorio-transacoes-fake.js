'use strict';

/**
 * Teste de SERVICO/repositorio-transacoes-fake.js (Fase EXPORT-FIRST -
 * Fase D). Executar com: node TESTES\teste-repositorio-transacoes-fake.js
 */

const path = require('path');
const PROJETO = path.join(__dirname, '..');
const { RepositorioTransacoesFake } = require(path.join(PROJETO, 'SERVICO', 'repositorio-transacoes-fake'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

async function main() {
  let todosPassaram = true;

  console.log('\n=== Contrato: construtor vazio ===');
  const repoVazio = new RepositorioTransacoesFake();
  todosPassaram &= check('listar() = [] quando construido sem dados', (await repoVazio.listar()).length === 0);

  console.log('\n=== Contrato: buscarPorNexTransactionId ===');
  const repo = new RepositorioTransacoesFake();
  await repo.salvar({ nexTransactionId: '15751', registro: { nexTransactionId: '15751' }, fingerprint: 'abc' });
  todosPassaram &= check('encontra existente', (await repo.buscarPorNexTransactionId('15751')) !== null);
  todosPassaram &= check('retorna null para inexistente', (await repo.buscarPorNexTransactionId('99999')) === null);
  todosPassaram &= check(
    'aceita numero ou string equivalentes (chave sempre string)',
    JSON.stringify(await repo.buscarPorNexTransactionId(15751)) === JSON.stringify(await repo.buscarPorNexTransactionId('15751')),
  );

  console.log('\n=== Contrato: salvar (upsert) ===');
  await repo.salvar({ nexTransactionId: '15756', registro: { nexTransactionId: '15756', amountDebt: 89 }, fingerprint: 'f1' });
  todosPassaram &= check('total apos 2 salvamentos = 2', (await repo.listar()).length === 2);
  await repo.salvar({ nexTransactionId: '15751', registro: { nexTransactionId: '15751', amountPaid: 99 }, fingerprint: 'novo' });
  const atualizado = await repo.buscarPorNexTransactionId('15751');
  todosPassaram &= check('upsert substitui o registro existente (nao duplica)', (await repo.listar()).length === 2);
  todosPassaram &= check('upsert reflete o novo fingerprint', atualizado.fingerprint === 'novo');
  todosPassaram &= check('upsert reflete o novo registro', atualizado.registro.amountPaid === 99);

  console.log('\n=== Contrato: salvar ignora item sem nexTransactionId ===');
  await repo.salvar({ registro: { foo: 'bar' } });
  await repo.salvar(null);
  todosPassaram &= check('total permanece 2 apos tentar salvar lixo', (await repo.listar()).length === 2);

  console.log('\n=== Isolamento: buscarPorNexTransactionId retorna copia, nao referencia interna ===');
  const item = await repo.buscarPorNexTransactionId('15756');
  item.registro.amountDebt = 999999;
  const itemDeNovo = await repo.buscarPorNexTransactionId('15756');
  todosPassaram &= check('mutar o item retornado nao afeta o estado interno', itemDeNovo.registro.amountDebt === 89);

  console.log('\n=== Isolamento: dados iniciais tambem sao clonados no construtor ===');
  const original = { nexTransactionId: '1', registro: { nexTransactionId: '1', x: 1 }, fingerprint: 'z' };
  const repoComSeed = new RepositorioTransacoesFake([original]);
  original.registro.x = 2;
  const doRepo = await repoComSeed.buscarPorNexTransactionId('1');
  todosPassaram &= check('mutar o objeto original fora nao afeta o que esta no Fake', doRepo.registro.x === 1);

  console.log('\n=== Nao toca disco (checagem estrutural) ===');
  const fs = require('fs');
  const codigoFonte = fs.readFileSync(path.join(PROJETO, 'SERVICO', 'repositorio-transacoes-fake.js'), 'utf8');
  todosPassaram &= check('nao importa "fs"', !/require\(['"]fs['"]\)/.test(codigoFonte));
  todosPassaram &= check('nao importa nenhum SDK de backend (http/base44/supabase/sqlite)', !/require\(['"](http|base44|supabase|sqlite)/.test(codigoFonte));

  console.log('\nResultado geral repositorio-transacoes-fake.js:', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
  process.exitCode = todosPassaram ? 0 : 1;
}

main();
