'use strict';

/**
 * Teste de SERVICO/dedupe-transacoes-nex.js (Fase EXPORT-FIRST - Fase D):
 * prova de idempotencia/reimportacao/lote usando RepositorioTransacoesFake.
 * Executar com: node TESTES\teste-dedupe-nex.js
 */

const path = require('path');
const PROJETO = path.join(__dirname, '..');
const { normalizarVendaNex } = require(path.join(PROJETO, 'SRC', 'normalizar-venda-nex'));
const { normalizarTransacaoClienteNex } = require(path.join(PROJETO, 'SRC', 'normalizar-transacao-cliente-nex'));
const { resolverCliente } = require(path.join(PROJETO, 'SRC', 'customer-resolver-nex'));
const { RepositorioTransacoesFake } = require(path.join(PROJETO, 'SERVICO', 'repositorio-transacoes-fake'));
const { processarVenda, processarTransacaoCliente, processarLoteVendas } = require(path.join(PROJETO, 'SERVICO', 'dedupe-transacoes-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

const linha15751 = { numero: '15751', tipo: 'Venda', data: '8/28/26', hora: '14:17', cliente: 'CANELINHA', subtotal: 'R$ 97.00 ', valorPago: 'R$ 97.00 ', meioPagto: 'Cartão de Crédito' };
const linha15753 = { numero: '15753', tipo: 'Venda', data: '8/28/26', hora: '14:38', cliente: 'CANELINHA', subtotal: 'R$ 98.00 ', valorPago: 'R$ 98.00 ', meioPagto: 'Dinheiro' };
const linha15755 = { numero: '15755', tipo: 'Venda', data: '8/28/26', hora: '16:28', cliente: 'CANELINHA', subtotal: 'R$ 95.00 ', valorPago: 'R$ 95.00 ', meioPagto: 'Cartão de Débito' };
const linha15756 = { numero: '15756', tipo: 'Venda', data: '8/28/26', hora: '16:37', cliente: 'MATHEUS HENRIQUE DEPRE', subtotal: 'R$ 89.00 ', debitado: 'R$ 89.00 ' };
const linha15757 = { numero: '15757', tipo: 'Venda', data: '8/28/26', hora: '16:43', cliente: 'MATHEUS HENRIQUE DEPRE', subtotal: 'R$ 87.00 ', debitado: 'R$ 87.00 ' };

async function main() {
  let todosPassaram = true;

  // ---------- 1. #15751: NEW -> UNCHANGED -> UNCHANGED ----------
  console.log('\n=== 1. #15751: primeira, segunda e terceira importacao ===');
  const repo1 = new RepositorioTransacoesFake();
  const r1a = await processarVenda(normalizarVendaNex(linha15751), repo1);
  todosPassaram &= check('primeira importacao -> NEW', r1a.status === 'NEW');
  const r1b = await processarVenda(normalizarVendaNex(linha15751), repo1);
  todosPassaram &= check('segunda importacao identica -> UNCHANGED', r1b.status === 'UNCHANGED');
  const r1c = await processarVenda(normalizarVendaNex(linha15751), repo1);
  todosPassaram &= check('terceira importacao identica -> UNCHANGED', r1c.status === 'UNCHANGED');
  todosPassaram &= check('apenas 1 registro armazenado (nao criou copias)', (await repo1.listar()).length === 1);

  // ---------- 2. #15756 (fiado): NEW -> UNCHANGED ----------
  console.log('\n=== 2. #15756 (fiado): NEW -> UNCHANGED ===');
  const repo2 = new RepositorioTransacoesFake();
  todosPassaram &= check('#15756 primeira vez -> NEW', (await processarVenda(normalizarVendaNex(linha15756), repo2)).status === 'NEW');
  todosPassaram &= check('#15756 identica -> UNCHANGED', (await processarVenda(normalizarVendaNex(linha15756), repo2)).status === 'UNCHANGED');

  // ---------- 3. #15758 (Pagamento Débito): NEW -> UNCHANGED ----------
  console.log('\n=== 3. #15758 (Pagamento Débito): NEW -> UNCHANGED ===');
  const repo3 = new RepositorioTransacoesFake();
  const t15758 = normalizarTransacaoClienteNex({ noTran: '15758', data: '8/28/26', hora: '17:08', totalFinal: 'R$ 89.00 ', tipo: 'Pagamento Débito', valorPago: 'R$ 89.00 ', meioPagto: 'Dinheiro' });
  todosPassaram &= check('#15758 primeira vez -> NEW', (await processarTransacaoCliente(t15758, repo3)).status === 'NEW');
  const t15758Igual = normalizarTransacaoClienteNex({ noTran: '15758', data: '8/28/26', hora: '17:08', totalFinal: 'R$ 89.00 ', tipo: 'Pagamento Débito', valorPago: 'R$ 89.00 ', meioPagto: 'Dinheiro' });
  todosPassaram &= check('#15758 identica -> UNCHANGED', (await processarTransacaoCliente(t15758Igual, repo3)).status === 'UNCHANGED');

  // ---------- 4. #9999 pagamento parcial: NEW -> UNCHANGED -> CHANGED ----------
  console.log('\n=== 4. #9999 pagamento parcial ===');
  const repo4 = new RepositorioTransacoesFake();
  const linha9999 = { numero: '9999', tipo: 'Venda', data: '10/19/23', hora: '17:23', valorPago: 'R$ 420.00 ', debitado: 'R$ 139.00 ', meioPagto: 'Cartão de Débito' };
  const r4a = await processarVenda(normalizarVendaNex(linha9999), repo4);
  todosPassaram &= check('#9999 primeira vez -> NEW (amountPaid=420, amountDebt=139 preservados)', r4a.status === 'NEW');
  const r4b = await processarVenda(normalizarVendaNex(linha9999), repo4);
  todosPassaram &= check('#9999 reimportacao identica -> UNCHANGED', r4b.status === 'UNCHANGED');
  const linha9999DebitoMudou = Object.assign({}, linha9999, { debitado: 'R$ 100.00 ' });
  const r4c = await processarVenda(normalizarVendaNex(linha9999DebitoMudou), repo4);
  todosPassaram &= check('#9999 com amountDebt mudado -> CHANGED', r4c.status === 'CHANGED');
  todosPassaram &= check('changedFields aponta amountDebt (139 -> 100)', r4c.changedFields.some((c) => c.field === 'amountDebt' && c.before === 139 && c.after === 100));

  // ---------- 5. #5595: nao cancelada -> cancelada (CHANGED) ----------
  console.log('\n=== 5. #5595: nao cancelada -> cancelada posteriormente ===');
  const repo5 = new RepositorioTransacoesFake();
  const linha5595 = { numero: '5595', tipo: 'Venda', data: '12/16/21', hora: '15:36', cancelado: 'Não' };
  todosPassaram &= check('#5595 primeira vez (nao cancelada) -> NEW', (await processarVenda(normalizarVendaNex(linha5595), repo5)).status === 'NEW');
  const linha5595Cancelada = Object.assign({}, linha5595, { cancelado: 'Sim', canceladoEm: '16/12/2021 15:42:00' });
  const r5b = await processarVenda(normalizarVendaNex(linha5595Cancelada), repo5);
  todosPassaram &= check('#5595 cancelada posteriormente -> CHANGED', r5b.status === 'CHANGED');
  todosPassaram &= check('changedFields inclui cancelled e cancelledAt', r5b.changedFields.some((c) => c.field === 'cancelled') && r5b.changedFields.some((c) => c.field === 'cancelledAt'));

  // ---------- 6. Venda sem cliente resolvido continua dedupavel ----------
  console.log('\n=== 6. Venda com cliente SEM_MATCH continua dedupavel normalmente ===');
  const repo6 = new RepositorioTransacoesFake();
  const linhaSemCliente = { numero: '77777', tipo: 'Venda', data: '1/1/26', hora: '10:00', cliente: 'GORDO PROZA', valorPago: 'R$ 10.00 ' };
  const vendaSemCliente = normalizarVendaNex(linhaSemCliente);
  const resolucao = resolverCliente(vendaSemCliente.customerName, new Map()); // indice vazio -> forcosamente SEM_MATCH
  todosPassaram &= check('resolucao de cliente = SEM_MATCH (pre-condicao do teste)', resolucao.status === 'REVIEW_REQUIRED' && resolucao.motivo === 'SEM_MATCH');
  const r6a = await processarVenda(vendaSemCliente, repo6);
  todosPassaram &= check('mesmo com cliente SEM_MATCH -> NEW normalmente (dedupe nao depende de resolucao)', r6a.status === 'NEW');
  const r6b = await processarVenda(normalizarVendaNex(linhaSemCliente), repo6);
  todosPassaram &= check('reimportacao identica -> UNCHANGED (dedupe independente de nexCustomerCode)', r6b.status === 'UNCHANGED');

  // ---------- 7. IDs permanecem STRING ----------
  // Ajuste Fase D.2: a busca passou a ser por identityKey (buscarPorIdentityKey),
  // nao mais por nexTransactionId direto - buscarPorNexTransactionId agora e
  // um metodo legado que so encontra itens salvos SEM identityKey (pre-D.2).
  console.log('\n=== 7. IDs permanecem string ===');
  todosPassaram &= check('nexTransactionId de #15751 e string', typeof (await repo1.buscarPorIdentityKey('NEX:15751')).nexTransactionId === 'string');

  // ---------- 8. TESTE DE LOTE ----------
  console.log('\n=== 8. Processamento de lote (idempotencia incremental) ===');
  const repoLote = new RepositorioTransacoesFake();

  const lote1 = [linha15751, linha15753, linha15755, linha15756, linha15757].map(normalizarVendaNex);
  const resultadosLote1 = await processarLoteVendas(lote1, repoLote);
  const new1 = resultadosLote1.filter((r) => r.status === 'NEW').length;
  todosPassaram &= check('LOTE 1: 5 NEW', new1 === 5);
  todosPassaram &= check('LOTE 1: repo tem 5 transacoes', (await repoLote.listar()).length === 5);

  const lote2 = [linha15751, linha15753, linha15755, linha15756, linha15757].map(normalizarVendaNex);
  const resultadosLote2 = await processarLoteVendas(lote2, repoLote);
  const unchanged2 = resultadosLote2.filter((r) => r.status === 'UNCHANGED').length;
  const new2 = resultadosLote2.filter((r) => r.status === 'NEW').length;
  todosPassaram &= check('LOTE 2 (mesmos 5): 5 UNCHANGED', unchanged2 === 5);
  todosPassaram &= check('LOTE 2 (mesmos 5): 0 NEW', new2 === 0);
  todosPassaram &= check('LOTE 2: repo continua com 5 transacoes (sem duplicar)', (await repoLote.listar()).length === 5);

  const t15758ParaLote = { numero: '15758', tipo: 'Pagamento Débito', data: '8/28/26', hora: '17:08', valorPago: 'R$ 89.00 ', meioPagto: 'Dinheiro' };
  const t15759ParaLote = { numero: '15759', tipo: 'Pagamento Débito', data: '8/28/26', hora: '17:18', valorPago: 'R$ 87.00 ', meioPagto: 'Dinheiro' };
  const lote3 = [linha15751, linha15753, linha15755, linha15756, linha15757, t15758ParaLote, t15759ParaLote].map(normalizarVendaNex);
  const resultadosLote3 = await processarLoteVendas(lote3, repoLote);
  const unchanged3 = resultadosLote3.filter((r) => r.status === 'UNCHANGED').length;
  const new3 = resultadosLote3.filter((r) => r.status === 'NEW').length;
  todosPassaram &= check('LOTE 3 (5 antigas + 2 novas): 5 UNCHANGED', unchanged3 === 5);
  todosPassaram &= check('LOTE 3 (5 antigas + 2 novas): 2 NEW', new3 === 2);
  todosPassaram &= check('quantidade armazenada final: 7 transacoes unicas', (await repoLote.listar()).length === 7);

  console.log(
    '\nResultado geral dedupe-transacoes-nex.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main();
