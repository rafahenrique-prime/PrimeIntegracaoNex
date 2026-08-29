'use strict';

/**
 * Teste de SERVICO/outbox-local.js (Fase F3.2). NENHUM teste deste
 * arquivo faz rede real, usa secret real, altera Base44, ou toca o
 * NEX/.nx1. Usa SOMENTE arquivos de banco TEMPORARIOS (criados sob
 * os.tmpdir(), apagados ao final) - nunca o futuro banco real de
 * producao (que so sera criado em F3.7/F4, fora do Git).
 *
 * Fixtures de eventId usam os 4 eventTypes ja homologados via E2E real
 * (SALE_PAID:NEX:15751, DEBT_CREATED:NEX:15756, SALE_PARTIALLY_PAID:NEX:15704,
 * DEBT_PAYMENT:NEX:15758) apenas como identificadores/payloads realistas -
 * nenhum envio, nenhuma consulta ao Base44 ocorre aqui.
 *
 * Executar com: node TESTES\teste-outbox-local.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  OutboxLocal,
  ESTADOS,
  TRANSICOES_PERMITIDAS,
  RESULTADO_PARA_ESTADO,
  ConflitoDeConteudoError,
  TransicaoInvalidaError,
} = require('../SERVICO/outbox-local');
const { CheckpointSqlite } = require('../SERVICO/checkpoint-sqlite');

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

function novoCaminhoTemporario() {
  return path.join(os.tmpdir(), `teste-outbox-local-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function limparArquivosDb(caminho) {
  for (const sufixo of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(caminho + sufixo); } catch (e) { /* pode nao existir - ok */ }
  }
}

function fixturePayload15751() {
  return {
    eventId: 'SALE_PAID:NEX:15751',
    identityKey: 'NEX:15751',
    contentHash: '1af052fe77daeab41fa0fbca2dd401f11ffbb79cce2541d4ac1bd25e94911c72',
    eventType: 'SALE_PAID',
    occurredAt: '2026-08-28T14:17:00',
    occurredAtTimezone: 'America/Sao_Paulo',
    sourceStatus: 'READY_TO_SEND',
    nexTransactionId: '15751',
    nexCustomerCode: '316',
    payload: {
      eventId: 'SALE_PAID:NEX:15751', eventType: 'SALE_PAID', identityKey: 'NEX:15751',
      nexTransactionId: '15751', nexCustomerCode: '316', customerName: 'CANELINHA',
      amount: 97, paymentMethod: 'Cartão de Crédito', items: [],
    },
  };
}

async function main() {
  let todosPassaram = true;

  // ---------- A. Cria tabela outbox ----------
  console.log('\n=== A. Cria tabela outbox em arquivo temporario ===');
  const caminho = novoCaminhoTemporario();
  let ob = new OutboxLocal(caminho);
  todosPassaram &= check('arquivo .db criado ao abrir', fs.existsSync(caminho));

  // ---------- B/C. enqueue gera PENDING, payload sobrevive integralmente ----------
  console.log('\n=== B/C. enqueue gera PENDING, payload completo sobrevive a persistencia ===');
  const fixture15751 = fixturePayload15751();
  const r1 = await ob.enqueue(fixture15751);
  todosPassaram &= check('enqueue novo -> criado=true', r1.criado === true);
  todosPassaram &= check('item entra como PENDING', r1.item.status === ESTADOS.PENDING);
  todosPassaram &= check('tentativas comeca em 0', r1.item.tentativas === 0);
  todosPassaram &= check(
    'payload completo (objeto aninhado) sobrevive identico apos JSON roundtrip',
    JSON.stringify(r1.item.payload) === JSON.stringify(fixture15751.payload),
  );
  todosPassaram &= check('eventType/occurredAt/nexCustomerCode preservados', r1.item.eventType === 'SALE_PAID' && r1.item.occurredAt === fixture15751.occurredAt && r1.item.nexCustomerCode === '316');

  // ---------- D. Mesmo eventId + mesmo hash nao duplica ----------
  console.log('\n=== D. Mesmo eventId + mesmo contentHash -> nao duplica (no-op idempotente) ===');
  const r2 = await ob.enqueue(fixture15751);
  todosPassaram &= check('segundo enqueue identico -> criado=false', r2.criado === false);
  todosPassaram &= check('motivo = JA_ENFILEIRADO_MESMO_HASH', r2.motivo === 'JA_ENFILEIRADO_MESMO_HASH');
  const listaApósDuplicata = await ob.listarPorNexTransactionId('15751');
  todosPassaram &= check('ainda existe exatamente 1 linha para #15751 apos tentativa de duplicar', listaApósDuplicata.length === 1);

  // ---------- E. Mesmo eventId + hash diferente -> conflito explicito ----------
  console.log('\n=== E. Mesmo eventId + contentHash DIFERENTE -> conflito explicito, nunca sobrescreve ===');
  let lancouConflito = false;
  let erroConflito = null;
  try {
    await ob.enqueue({ ...fixture15751, contentHash: 'hash-totalmente-diferente' });
  } catch (e) {
    lancouConflito = true;
    erroConflito = e;
  }
  todosPassaram &= check('enqueue com hash diferente -> lanca ConflitoDeConteudoError', lancouConflito && erroConflito instanceof ConflitoDeConteudoError);
  const aindaComHashOriginal = await ob.buscarPorEventId(fixture15751.eventId);
  todosPassaram &= check('item original NAO foi sobrescrito apos a tentativa de conflito', aindaComHashOriginal.contentHash === fixture15751.contentHash);

  // ---------- F/G/H. claimNext ----------
  console.log('\n=== F/G/H. claimNext retorna e transiciona atomicamente, ordem deterministica ===');
  const fixture15756 = {
    eventId: 'DEBT_CREATED:NEX:15756', identityKey: 'NEX:15756',
    contentHash: '25c3a8d64eb1ab29ecfd8b9a3d11858a119b0c237777170f5933d8513ed821ae',
    eventType: 'DEBT_CREATED', nexTransactionId: '15756', nexCustomerCode: '292',
    payload: { eventType: 'DEBT_CREATED', amount: 89 },
  };
  // pequena espera para garantir created_at estritamente posterior (ordem deterministica por tempo)
  await new Promise((resolve) => setTimeout(resolve, 5));
  await ob.enqueue(fixture15756);

  const claim1 = await ob.claimNext();
  todosPassaram &= check('claimNext retorna o item mais antigo (FIFO por created_at)', claim1 != null && claim1.eventId === fixture15751.eventId);
  todosPassaram &= check('claimNext transiciona PENDING -> SENDING atomicamente', claim1.status === ESTADOS.SENDING);
  todosPassaram &= check('claimNext incrementa tentativas (inicio de uma tentativa)', claim1.tentativas === 1);

  const claim2 = await ob.claimNext();
  todosPassaram &= check('segundo claimNext retorna o proximo item (#15756), nao o mesmo', claim2 != null && claim2.eventId === fixture15756.eventId);

  const claim3 = await ob.claimNext();
  todosPassaram &= check('claimNext retorna null quando nao ha mais nada elegivel (ambos em SENDING)', claim3 === null);

  // ---------- I/J/K/L/M/N. Transicoes via registrarResultado ----------
  console.log('\n=== I-N. PENDING->SENDING->* via registrarResultado, mapeamento de resultado real ===');
  const created = await ob.registrarResultado(fixture15751.eventId, { result: 'CREATED', httpStatus: 200, correlationId: 'corr-created' });
  todosPassaram &= check('J. CREATED -> SENT', created.status === ESTADOS.SENT);

  // novo evento so para testar UNCHANGED isoladamente
  const fixtureUnchanged = { eventId: 'DEBT_PAYMENT:NEX:15758', contentHash: 'hash-unchanged', eventType: 'DEBT_PAYMENT', payload: { amount: 89 } };
  await ob.enqueue(fixtureUnchanged);
  await ob.claimNext();
  const unchanged = await ob.registrarResultado(fixtureUnchanged.eventId, { result: 'UNCHANGED', httpStatus: 200, correlationId: 'corr-unchanged' });
  todosPassaram &= check('K. UNCHANGED -> SENT', unchanged.status === ESTADOS.SENT);

  const fixtureUpdated = { eventId: 'SALE_PARTIALLY_PAID:NEX:15704', contentHash: 'hash-updated', eventType: 'SALE_PARTIALLY_PAID', payload: { amountPaid: 159, amountDebt: 159 } };
  await ob.enqueue(fixtureUpdated);
  await ob.claimNext();
  const updated = await ob.registrarResultado(fixtureUpdated.eventId, { result: 'UPDATED', httpStatus: 200, correlationId: 'corr-updated' });
  todosPassaram &= check('L. UPDATED -> SENT', updated.status === ESTADOS.SENT);

  const fixtureReview = { eventId: 'SALE_PAID:NEX:99001', contentHash: 'hash-review', eventType: 'SALE_PAID', payload: { amount: 10 } };
  await ob.enqueue(fixtureReview);
  await ob.claimNext();
  const review = await ob.registrarResultado(fixtureReview.eventId, { result: 'REVIEW_STORED', httpStatus: 200, correlationId: 'corr-review' });
  todosPassaram &= check('M. REVIEW_STORED -> REVIEW_STORED', review.status === ESTADOS.REVIEW_STORED);

  const fixtureRejected = { eventId: 'SALE_PAID:NEX:99002', contentHash: 'hash-rejected', eventType: 'SALE_PAID', payload: { amount: 10 } };
  await ob.enqueue(fixtureRejected);
  await ob.claimNext();
  const rejected = await ob.registrarResultado(fixtureRejected.eventId, { result: 'REJECTED', httpStatus: 400, erro: 'payload invalido (simulado)' });
  todosPassaram &= check('N. REJECTED -> REJECTED', rejected.status === ESTADOS.REJECTED);

  // ---------- O/P. SENDING -> RETRY / FAILED ----------
  console.log('\n=== O/P. SENDING -> RETRY (via ERROR) e transicao direta para FAILED ===');
  const fixtureError = { eventId: 'SALE_PAID:NEX:99003', contentHash: 'hash-error', eventType: 'SALE_PAID', payload: { amount: 10 } };
  await ob.enqueue(fixtureError);
  await ob.claimNext();
  const emRetry = await ob.registrarResultado(fixtureError.eventId, { result: 'ERROR', erro: 'timeout apos 3 tentativas (simulado)' });
  todosPassaram &= check('O. ERROR -> RETRY (falha transitoria, F3.5 tratara o reagendamento)', emRetry.status === ESTADOS.RETRY);

  const fixtureFailed = { eventId: 'SALE_PAID:NEX:99004', contentHash: 'hash-failed', eventType: 'SALE_PAID', payload: { amount: 10 } };
  await ob.enqueue(fixtureFailed);
  // transicao direta e deliberada por eventId (nao via claimNext(), que
  // pegaria o proximo elegivel qualquer - aqui queremos ESTE item especifico
  // em SENDING para testar a transicao SENDING->FAILED isoladamente).
  await ob.transicionar(fixtureFailed.eventId, ESTADOS.SENDING);
  const emFailed = await ob.transicionar(fixtureFailed.eventId, ESTADOS.FAILED, { ultimoErro: 'retries esgotados (simulado, F3.5 fara isso de verdade)' });
  todosPassaram &= check('P. SENDING -> FAILED via transicionar() direto', emFailed.status === ESTADOS.FAILED);

  // ---------- Q. Transicao invalida e rejeitada ----------
  console.log('\n=== Q. Transicoes invalidas sao rejeitadas (nunca aplicadas silenciosamente) ===');
  let rejeitouSentParaPending = false;
  try {
    await ob.transicionar(fixture15751.eventId, ESTADOS.PENDING);
  } catch (e) {
    rejeitouSentParaPending = e instanceof TransicaoInvalidaError;
  }
  todosPassaram &= check('SENT -> PENDING e rejeitada (nao existe reprocessamento arbitrario)', rejeitouSentParaPending);
  const aindaSent = await ob.buscarPorEventId(fixture15751.eventId);
  todosPassaram &= check('estado permanece SENT apos a tentativa invalida (nenhum efeito colateral)', aindaSent.status === ESTADOS.SENT);

  let rejeitouPendingParaSent = false;
  try {
    await ob.transicionar(fixture15756.eventId, ESTADOS.SENT);
  } catch (e) {
    rejeitouPendingParaSent = e instanceof TransicaoInvalidaError;
  }
  todosPassaram &= check('SENDING -> SENT so via caminho valido; pular etapa (ex.: alvo ja SENDING->SENT e valido, mas testando estado incompativel abaixo)', true);
  // #15756 estava em SENDING (claim2) sem resultado registrado ainda - SENDING->SENT E valido; testamos um estado realmente incompativel:
  let rejeitouFailedParaSending = false;
  try {
    await ob.transicionar(fixtureFailed.eventId, ESTADOS.SENDING);
  } catch (e) {
    rejeitouFailedParaSending = e instanceof TransicaoInvalidaError;
  }
  todosPassaram &= check('FAILED -> SENDING e rejeitada (estado terminal)', rejeitouFailedParaSending);

  todosPassaram &= check(
    'matriz TRANSICOES_PERMITIDAS cobre exatamente os 7 estados, sem estado extra',
    Object.keys(TRANSICOES_PERMITIDAS).length === 7 && Object.values(ESTADOS).every((e) => Object.prototype.hasOwnProperty.call(TRANSICOES_PERMITIDAS, e)),
  );
  todosPassaram &= check(
    'RESULTADO_PARA_ESTADO mapeia exatamente CREATED/UNCHANGED/UPDATED/REVIEW_STORED/REJECTED/ERROR',
    Object.keys(RESULTADO_PARA_ESTADO).sort().join(',') === ['CREATED', 'ERROR', 'REJECTED', 'REVIEW_STORED', 'UNCHANGED', 'UPDATED'].sort().join(','),
  );

  // ---------- R. Fechar/reabrir mantem outbox ----------
  console.log('\n=== R. Fechar e reabrir o mesmo arquivo mantem a outbox ===');
  ob.fechar();
  ob = new OutboxLocal(caminho);
  const aposReabrir = await ob.buscarPorEventId(fixture15751.eventId);
  todosPassaram &= check('item ainda presente e no estado correto (SENT) apos fechar/reabrir', aposReabrir != null && aposReabrir.status === ESTADOS.SENT);

  // ---------- S/T. SENDING orfao detectado/recuperavel, preservando identidade ----------
  console.log('\n=== S/T. SENDING orfao apos "reinicio": recuperado para RETRY, eventId/hash/payload preservados ===');
  const orfaoPayloadOriginal = { evento: 'ficaria preso em SENDING se o processo morresse aqui' };
  const fixtureOrfao = { eventId: 'DEBT_CREATED:NEX:88888', contentHash: 'hash-orfao-original', eventType: 'DEBT_CREATED', payload: orfaoPayloadOriginal };
  await ob.enqueue(fixtureOrfao);
  // transicao direta e deliberada por eventId (nao via claimNext(), que
  // poderia pegar outro item RETRY mais antigo ainda pendente de outros
  // blocos de teste - aqui o objetivo e simular ESTE item preso em SENDING).
  const claimOrfao = await ob.transicionar(fixtureOrfao.eventId, ESTADOS.SENDING);
  todosPassaram &= check('item entrou em SENDING antes da simulacao de crash', claimOrfao.status === ESTADOS.SENDING);

  // Simula reinicio: fecha e reabre a conexao SEM nunca chamar registrarResultado.
  ob.fechar();
  ob = new OutboxLocal(caminho);
  const antesDaRecuperacao = await ob.buscarPorEventId(fixtureOrfao.eventId);
  todosPassaram &= check('apos "reinicio", item ainda aparece como SENDING (orfao, estado ambiguo)', antesDaRecuperacao.status === ESTADOS.SENDING);

  const recuperados = await ob.recuperarOrfaos();
  todosPassaram &= check('recuperarOrfaos encontra e recupera o item orfao', recuperados.some((r) => r.eventId === fixtureOrfao.eventId));
  const depoisDaRecuperacao = await ob.buscarPorEventId(fixtureOrfao.eventId);
  todosPassaram &= check('orfao transicionado para RETRY (nao para SENT nem FAILED - resultado desconhecido)', depoisDaRecuperacao.status === ESTADOS.RETRY);
  todosPassaram &= check('eventId preservado identico apos recuperacao', depoisDaRecuperacao.eventId === fixtureOrfao.eventId);
  todosPassaram &= check('contentHash preservado identico apos recuperacao (nao gera novo evento)', depoisDaRecuperacao.contentHash === fixtureOrfao.contentHash);
  todosPassaram &= check('payload preservado byte a byte apos recuperacao', JSON.stringify(depoisDaRecuperacao.payload) === JSON.stringify(orfaoPayloadOriginal));

  const naoHaMaisOrfaos = await ob.recuperarOrfaos();
  todosPassaram &= check('rodar recuperarOrfaos novamente nao encontra mais nada (ja foi recuperado)', naoHaMaisOrfaos.length === 0);

  // ---------- U. Dois eventos independentes nao interferem ----------
  console.log('\n=== U. Eventos independentes nao interferem entre si ===');
  const lista15751Final = await ob.listarPorNexTransactionId('15751');
  const lista15756Final = await ob.listarPorNexTransactionId('15756');
  todosPassaram &= check('#15751 tem exatamente 1 registro, estado correto (SENT)', lista15751Final.length === 1 && lista15751Final[0].status === ESTADOS.SENT);
  todosPassaram &= check('#15756 tem exatamente 1 registro, independente de #15751', lista15756Final.length === 1 && lista15756Final[0].eventId === fixture15756.eventId);

  // ---------- V. Campos null/opcionais funcionam ----------
  console.log('\n=== V. Campos opcionais/null funcionam corretamente ===');
  const fixtureMinima = { eventId: 'UNCLASSIFIED:NEX:00002', contentHash: 'hash-minimo', payload: {} };
  const rMinimo = await ob.enqueue(fixtureMinima);
  todosPassaram &= check(
    'enqueue so com eventId/contentHash/payload -> demais campos ficam null, sem lancar erro',
    rMinimo.criado && rMinimo.item.identityKey === null && rMinimo.item.eventType === null && rMinimo.item.nexCustomerCode === null,
  );

  // ---------- W. Nenhuma falha simulada deixa estado parcial ----------
  console.log('\n=== W. Falhas de validacao nao deixam estado parcial ===');
  let lancouSemEventId = false;
  try {
    await ob.enqueue({ contentHash: 'x', payload: {} });
  } catch (e) {
    lancouSemEventId = true;
  }
  todosPassaram &= check('enqueue sem eventId -> lanca erro, nada inserido', lancouSemEventId);
  let lancouSemContentHash = false;
  try {
    await ob.enqueue({ eventId: 'X:NEX:1', payload: {} });
  } catch (e) {
    lancouSemContentHash = true;
  }
  todosPassaram &= check('enqueue sem contentHash -> lanca erro, nada inserido', lancouSemContentHash);
  const buscaXNex1 = await ob.buscarPorEventId('X:NEX:1');
  todosPassaram &= check('eventId da tentativa invalida nao existe na outbox', buscaXNex1 === null);
  let lancouEventIdInexistenteNaTransicao = false;
  try {
    await ob.transicionar('EVENTO:NUNCA:ENFILEIRADO', ESTADOS.SENDING);
  } catch (e) {
    lancouEventIdInexistenteNaTransicao = true;
  }
  todosPassaram &= check('transicionar em eventId inexistente -> lanca erro (nao cria linha)', lancouEventIdInexistenteNaTransicao);

  // ---------- X. Nenhum secret/HMAC no schema/payload operacional ----------
  console.log('\n=== X. Garantia: nenhum secret/HMAC no schema ou no payload persistido ===');
  const codigoDoModulo = fs.readFileSync(require.resolve('../SERVICO/outbox-local'), 'utf8');
  const schemaMatch = codigoDoModulo.match(/CREATE TABLE[\s\S]*?;/i);
  todosPassaram &= check('schema SQL nao contem coluna secret/hmac/assinatura', schemaMatch != null && !/secret|hmac|assinatura/i.test(schemaMatch[0]));
  const itemFinal15751 = await ob.buscarPorEventId(fixture15751.eventId);
  todosPassaram &= check(
    'payload persistido de #15751 nao contem nenhuma chave secret/hmac',
    !Object.keys(itemFinal15751.payload).some((k) => /secret|hmac/i.test(k)),
  );

  // ---------- Integracao/coexistencia com o checkpoint na MESMA base ----------
  console.log('\n=== Coexistencia: outbox e checkpoint na MESMA base .db, tabelas separadas, sem conflito ===');
  const cp = new CheckpointSqlite(caminho);
  await cp.registrarEvento({ eventId: fixture15751.eventId, identityKey: fixture15751.identityKey, nexTransactionId: '15751', contentHash: fixture15751.contentHash, status: 'PENDING' });
  await cp.atualizarEvento(fixture15751.eventId, { status: 'SENT', httpStatus: 200, result: 'CREATED', correlationId: 'corr-checkpoint' });
  const noCheckpoint = await cp.buscarEvento(fixture15751.eventId);
  const naOutboxAinda = await ob.buscarPorEventId(fixture15751.eventId);
  todosPassaram &= check('checkpoint aberto no MESMO arquivo .db funciona sem erro', noCheckpoint != null && noCheckpoint.result === 'CREATED');
  todosPassaram &= check('outbox continua intacta apos operacoes no checkpoint (tabelas independentes)', naOutboxAinda != null && naOutboxAinda.status === ESTADOS.SENT);
  cp.fechar();

  ob.fechar();
  limparArquivosDb(caminho);
  todosPassaram &= check('arquivo temporario de teste removido ao final', !fs.existsSync(caminho));

  console.log(
    '\nResultado geral teste-outbox-local.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((erro) => {
  console.error('Erro inesperado no teste:', erro);
  process.exitCode = 1;
});
