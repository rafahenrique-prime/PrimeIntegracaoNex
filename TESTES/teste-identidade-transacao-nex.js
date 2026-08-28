'use strict';

/**
 * Teste de SRC/identidade-transacao-nex.js (Fase EXPORT-FIRST - Fase D.2).
 * Executar com: node TESTES\teste-identidade-transacao-nex.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { gerarChaveIdentidadeTransacaoNex, ehIdPuramenteNumerico } = require(path.join(SRC, 'identidade-transacao-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

// ---------- 1. Deteccao de ID puramente numerico ----------
console.log('\n=== 1. ehIdPuramenteNumerico ===');
todosPassaram &= check('"15751" -> numerico', ehIdPuramenteNumerico('15751') === true);
todosPassaram &= check('"5595" -> numerico', ehIdPuramenteNumerico('5595') === true);
todosPassaram &= check('"0001-W" -> NAO numerico', ehIdPuramenteNumerico('0001-W') === false);
todosPassaram &= check('"0001-C" -> NAO numerico', ehIdPuramenteNumerico('0001-C') === false);
todosPassaram &= check('"0001-7" -> NAO numerico (contem hifen, mesmo com sufixo numerico)', ehIdPuramenteNumerico('0001-7') === false);
todosPassaram &= check('"0001-2" -> NAO numerico', ehIdPuramenteNumerico('0001-2') === false);
todosPassaram &= check('null -> NAO numerico', ehIdPuramenteNumerico(null) === false);

// ---------- 2. IDs numericos: identidade = NEX:{id}, sem depender de occurredAt ----------
console.log('\n=== 2. IDs numericos (casos ja aprovados nas Fases A-D) ===');
['15751', '15753', '15755', '15756', '15757', '15758', '15759', '9999', '5595'].forEach((id) => {
  const r = gerarChaveIdentidadeTransacaoNex({ nexTransactionId: id, occurredAt: null });
  todosPassaram &= check(`#${id}: status OK mesmo com occurredAt null (identidade nao depende dele)`, r.status === 'OK');
  todosPassaram &= check(`#${id}: identityKey = "NEX:${id}"`, r.identityKey === `NEX:${id}`);
  todosPassaram &= check(`#${id}: numeric = true`, r.numeric === true);
});

// ---------- 3. IDs nao numericos: identidade = NEX:{id}:{occurredAt} ----------
console.log('\n=== 3. IDs nao numericos reais (0001-W, 0001-C, 0001-7, 0001-2) ===');
const casosNaoNumericos = [
  { id: '0001-W', occurredAt: '2026-05-15T15:14:00' },
  { id: '0001-C', occurredAt: '2025-01-25T10:35:00' },
  { id: '0001-7', occurredAt: '2026-01-31T12:37:00' },
  { id: '0001-2', occurredAt: '2024-09-10T06:22:00' },
];
casosNaoNumericos.forEach(({ id, occurredAt }) => {
  const r = gerarChaveIdentidadeTransacaoNex({ nexTransactionId: id, occurredAt });
  todosPassaram &= check(`${id}: status OK`, r.status === 'OK');
  todosPassaram &= check(`${id}: identityKey inclui id e occurredAt`, r.identityKey === `NEX:${id}:${occurredAt}`);
  todosPassaram &= check(`${id}: numeric = false`, r.numeric === false);
});

// ---------- 4. Duas ocorrencias reais do MESMO "0001-W" com datas diferentes -> identityKeys distintas ----------
console.log('\n=== 4. 0001-W com duas datas reais distintas -> identityKeys diferentes ===');
const w1 = gerarChaveIdentidadeTransacaoNex({ nexTransactionId: '0001-W', occurredAt: '2026-05-15T15:14:00' });
const w2 = gerarChaveIdentidadeTransacaoNex({ nexTransactionId: '0001-W', occurredAt: '2023-09-14T16:24:00' });
todosPassaram &= check('identityKeys diferentes para as duas ocorrencias reais de "0001-W"', w1.identityKey !== w2.identityKey);

// ---------- 5. occurredAt ausente para ID nao-numerico -> INVALID_IDENTITY (nao inventa) ----------
console.log('\n=== 5. occurredAt ausente/invalido para ID nao-numerico ===');
const semOccurredAt = gerarChaveIdentidadeTransacaoNex({ nexTransactionId: '0001-W', occurredAt: null });
todosPassaram &= check('status = INVALID_IDENTITY', semOccurredAt.status === 'INVALID_IDENTITY');
todosPassaram &= check('motivo = OCCURRED_AT_REQUIRED_FOR_NON_NUMERIC_ID', semOccurredAt.motivo === 'OCCURRED_AT_REQUIRED_FOR_NON_NUMERIC_ID');
todosPassaram &= check('NAO inventou identityKey', !('identityKey' in semOccurredAt));

const occurredAtVazio = gerarChaveIdentidadeTransacaoNex({ nexTransactionId: '0005-W', occurredAt: '' });
todosPassaram &= check('occurredAt string vazia -> INVALID_IDENTITY tambem', occurredAtVazio.status === 'INVALID_IDENTITY');

// ---------- 6. nexTransactionId ausente -> INVALID_IDENTITY ----------
console.log('\n=== 6. nexTransactionId ausente ===');
const semId = gerarChaveIdentidadeTransacaoNex({ occurredAt: '2026-01-01T10:00:00' });
todosPassaram &= check('status = INVALID_IDENTITY', semId.status === 'INVALID_IDENTITY');
todosPassaram &= check('motivo = NEX_TRANSACTION_ID_REQUIRED', semId.motivo === 'NEX_TRANSACTION_ID_REQUIRED');

// ---------- 7. Registro vazio/null nao lanca excecao ----------
console.log('\n=== 7. Registro vazio/null ===');
let lancouExcecao = false;
try {
  gerarChaveIdentidadeTransacaoNex({});
  gerarChaveIdentidadeTransacaoNex(null);
} catch (e) {
  lancouExcecao = true;
}
todosPassaram &= check('nao lanca excecao com entrada vazia/null', !lancouExcecao);

// ---------- 8. source e campos mutaveis NAO influenciam a identidade ----------
console.log('\n=== 8. Campos mutaveis (source, amountPaid, cancelled) nao influenciam a identidade ===');
const idComExtras1 = gerarChaveIdentidadeTransacaoNex({ nexTransactionId: '15751', occurredAt: '2026-08-28T14:17:00', source: 'export_vendas_historico', amountPaid: 97, cancelled: false });
const idComExtras2 = gerarChaveIdentidadeTransacaoNex({ nexTransactionId: '15751', occurredAt: '2026-08-28T14:17:00', source: 'export_extrato_cliente_individual', amountPaid: 999, cancelled: true });
todosPassaram &= check('mesma identityKey independente de source/amountPaid/cancelled', idComExtras1.identityKey === idComExtras2.identityKey);

console.log(
  '\nResultado geral identidade-transacao-nex.js:',
  todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
);
process.exitCode = todosPassaram ? 0 : 1;
