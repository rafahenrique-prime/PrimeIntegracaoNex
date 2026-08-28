'use strict';

/**
 * Teste de integracao da Fase D.2: dedupe usando identidade composta
 * (nexTransactionId + occurredAt) para IDs nao-numericos, via
 * SERVICO/dedupe-transacoes-nex.js + SERVICO/repositorio-transacoes-fake.js.
 * Executar com: node TESTES\teste-dedupe-identidade-composta-nex.js
 */

const path = require('path');
const PROJETO = path.join(__dirname, '..');
const { normalizarVendaNex } = require(path.join(PROJETO, 'SRC', 'normalizar-venda-nex'));
const { RepositorioTransacoesFake } = require(path.join(PROJETO, 'SERVICO', 'repositorio-transacoes-fake'));
const { processarVenda } = require(path.join(PROJETO, 'SERVICO', 'dedupe-transacoes-nex'));
const { gerarChaveIdentidadeTransacaoNex } = require(path.join(PROJETO, 'SRC', 'identidade-transacao-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

// Fixtures baseadas nas duas ocorrencias REAIS de "0001-W" (Checkpoint D.1)
const linhaW1_ocorrenciaA = {
  numero: '0001-W', tipo: 'Venda', data: '5/15/26', hora: '15:14', origem: 'Web',
  subtotal: 'R$ 678.00 ', desconto: 'R$ 78.00 ', valorPago: 'R$ 600.00 ', meioPagto: 'Dinheiro', cancelado: 'Não',
};
const linhaW1_ocorrenciaB = {
  numero: '0001-W', tipo: 'Venda', data: '9/14/23', hora: '16:24', origem: 'Web',
  subtotal: 'R$ 398.00 ', valorPago: 'R$ 398.00 ', meioPagto: 'Cartão de Débito', cancelado: 'Sim',
};

async function main() {
  let todosPassaram = true;

  // ---------- 1. Duas ocorrencias reais de "0001-W" -> 2 identidades distintas, ambas NEW ----------
  console.log('\n=== 1. Duas ocorrencias reais de "0001-W" (datas diferentes) ===');
  const repo1 = new RepositorioTransacoesFake();
  const rA = await processarVenda(normalizarVendaNex(linhaW1_ocorrenciaA), repo1);
  todosPassaram &= check('ocorrencia A (15/05/2026) -> NEW', rA.status === 'NEW');
  const rB = await processarVenda(normalizarVendaNex(linhaW1_ocorrenciaB), repo1);
  todosPassaram &= check('ocorrencia B (14/09/2023) -> NEW (identidade diferente, mesmo nexTransactionId)', rB.status === 'NEW');
  todosPassaram &= check('identityKeys diferentes entre as duas ocorrencias', rA.identityKey !== rB.identityKey);
  todosPassaram &= check('repository armazenou 2 transacoes distintas para o mesmo nexTransactionId "0001-W"', (await repo1.listar()).length === 2);

  // ---------- 2. Reimportar as duas -> 2 UNCHANGED, 0 NEW ----------
  console.log('\n=== 2. Reimportacao das duas ocorrencias -> UNCHANGED ===');
  const rA2 = await processarVenda(normalizarVendaNex(linhaW1_ocorrenciaA), repo1);
  const rB2 = await processarVenda(normalizarVendaNex(linhaW1_ocorrenciaB), repo1);
  todosPassaram &= check('ocorrencia A reimportada -> UNCHANGED', rA2.status === 'UNCHANGED');
  todosPassaram &= check('ocorrencia B reimportada -> UNCHANGED', rB2.status === 'UNCHANGED');
  todosPassaram &= check('repository continua com exatamente 2 transacoes (nao duplicou)', (await repo1.listar()).length === 2);

  // ---------- 3. Mesmo ID nao-numerico, MESMO occurredAt, mesmos fatos -> UNCHANGED ----------
  console.log('\n=== 3. "0001-W" mesmo occurredAt, mesmos fatos -> UNCHANGED ===');
  const repo2 = new RepositorioTransacoesFake();
  await processarVenda(normalizarVendaNex(linhaW1_ocorrenciaA), repo2);
  const rMesmosFatos = await processarVenda(normalizarVendaNex(linhaW1_ocorrenciaA), repo2);
  todosPassaram &= check('reimportacao identica (mesmo occurredAt, mesmos fatos) -> UNCHANGED', rMesmosFatos.status === 'UNCHANGED');

  // ---------- 4. Mesmo ID nao-numerico, MESMO occurredAt, cancelled false->true -> CHANGED (nao NEW) ----------
  console.log('\n=== 4. "0001-W" mesmo occurredAt, cancelled muda -> CHANGED (prova occurredAt=identidade, cancelled=fingerprint) ===');
  const linhaWCancelada = Object.assign({}, linhaW1_ocorrenciaA, { cancelado: 'Sim', canceladoEm: '15/05/2026 16:00:00' });
  const rCancelada = await processarVenda(normalizarVendaNex(linhaWCancelada), repo2);
  todosPassaram &= check('status = CHANGED (NAO NEW)', rCancelada.status === 'CHANGED');
  const identidadeOriginal = gerarChaveIdentidadeTransacaoNex(normalizarVendaNex(linhaW1_ocorrenciaA)).identityKey;
  todosPassaram &= check('identityKey identica antes/depois do cancelamento (so o fingerprint mudou)', rCancelada.identityKey === identidadeOriginal);
  todosPassaram &= check('changedFields inclui cancelled', rCancelada.changedFields.some((c) => c.field === 'cancelled'));
  todosPassaram &= check('repository continua com 1 transacao (nao virou NEW)', (await repo2.listar()).length === 1);

  // ---------- 5. Outros formatos nao-numericos: 0001-C, 0001-7, 0001-2 ----------
  console.log('\n=== 5. Outros sufixos nao-numericos (0001-C, 0001-7, 0001-2) ===');
  const repo3 = new RepositorioTransacoesFake();
  const linhaC = { numero: '0001-C', tipo: 'Venda', data: '1/25/25', hora: '10:35', origem: 'Catálogo Online', subtotal: 'R$ 100.00 ' };
  const linha7 = { numero: '0001-7', tipo: 'Venda', data: '1/31/26', hora: '12:37', origem: 'App', subtotal: 'R$ 200.00 ' };
  const linha2 = { numero: '0001-2', tipo: 'Venda', data: '9/10/24', hora: '6:22', origem: 'App', subtotal: 'R$ 300.00 ' };
  const rC = await processarVenda(normalizarVendaNex(linhaC), repo3);
  const r7 = await processarVenda(normalizarVendaNex(linha7), repo3);
  const r2 = await processarVenda(normalizarVendaNex(linha2), repo3);
  todosPassaram &= check('0001-C -> NEW, identityKey inclui occurredAt', rC.status === 'NEW' && rC.identityKey.includes('2025-01-25'));
  todosPassaram &= check('0001-7 -> NEW, identityKey inclui occurredAt', r7.status === 'NEW' && r7.identityKey.includes('2026-01-31'));
  todosPassaram &= check('0001-2 -> NEW, identityKey inclui occurredAt', r2.status === 'NEW' && r2.identityKey.includes('2024-09-10'));
  const rCIgual = await processarVenda(normalizarVendaNex(linhaC), repo3);
  todosPassaram &= check('0001-C reimportado -> UNCHANGED', rCIgual.status === 'UNCHANGED');

  // ---------- 6. Regressao: IDs numericos continuam usando so nexTransactionId ----------
  console.log('\n=== 6. Regressao - IDs numericos preservam identidade simples ===');
  const repo4 = new RepositorioTransacoesFake();
  const linha15751 = { numero: '15751', tipo: 'Venda', data: '8/28/26', hora: '14:17', cliente: 'CANELINHA', valorPago: 'R$ 97.00 ', meioPagto: 'Cartão de Crédito' };
  const r15751a = await processarVenda(normalizarVendaNex(linha15751), repo4);
  todosPassaram &= check('#15751: identityKey = "NEX:15751" (sem occurredAt)', r15751a.identityKey === 'NEX:15751');
  const r15751b = await processarVenda(normalizarVendaNex(linha15751), repo4);
  todosPassaram &= check('#15751: reimportacao -> UNCHANGED', r15751b.status === 'UNCHANGED');

  // #5595: mesma identityKey antes/depois do cancelamento (numerico)
  const linha5595 = { numero: '5595', tipo: 'Venda', data: '12/16/21', hora: '15:36', cancelado: 'Não' };
  const r5595a = await processarVenda(normalizarVendaNex(linha5595), repo4);
  const linha5595Cancelada = Object.assign({}, linha5595, { cancelado: 'Sim', canceladoEm: '16/12/2021 15:42:00' });
  const r5595b = await processarVenda(normalizarVendaNex(linha5595Cancelada), repo4);
  todosPassaram &= check('#5595: identityKey identica antes/depois (numerico, sem occurredAt na chave)', r5595a.identityKey === r5595b.identityKey && r5595a.identityKey === 'NEX:5595');
  todosPassaram &= check('#5595: status = CHANGED (nao NEW)', r5595b.status === 'CHANGED');

  console.log(
    '\nResultado geral dedupe-identidade-composta-nex.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main();
