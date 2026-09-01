'use strict';

/**
 * Testes de SCRIPTS/reconciliar-consistencia.js (Fase F5.7.1) - REPARO
 * LOCAL ADMINISTRATIVO da consistencia outbox<->checkpoint. NENHUM teste
 * deste arquivo faz rede real, usa secret real, ou toca o banco real de
 * producao (OUTPUT/integracao-nex.db). Usa SOMENTE arquivos de banco
 * TEMPORARIOS (criados sob os.tmpdir(), apagados ao final).
 *
 * Executar com: node TESTES\teste-reconciliar-consistencia.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  executarReconciliacao,
  classificarDivergencia,
  CONFIRMACAO_ESPERADA,
} = require('../SCRIPTS/reconciliar-consistencia');
const { OutboxLocal, ESTADOS } = require('../SERVICO/outbox-local');
const { CheckpointSqlite } = require('../SERVICO/checkpoint-sqlite');

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

function novoCaminhoTemporario() {
  return path.join(os.tmpdir(), `teste-reconciliar-consistencia-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function limparArquivosDb(caminho) {
  for (const sufixo of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(caminho + sufixo); } catch (e) { /* pode nao existir - ok */ }
  }
}

function fixtureEvento(eventId, sufixo) {
  return {
    eventId,
    identityKey: `NEX:${sufixo}`,
    contentHash: `hash-${sufixo}`,
    eventType: 'SALE_PAID',
    occurredAt: '2026-09-01T10:00:00',
    occurredAtTimezone: 'America/Sao_Paulo',
    sourceStatus: 'READY_TO_SEND',
    nexTransactionId: String(sufixo),
    nexCustomerCode: '316',
    payload: { eventId, eventType: 'SALE_PAID', nexTransactionId: String(sufixo), amount: 10 },
  };
}

async function criarItemTerminalNaOutbox(outbox, evento, resultado) {
  await outbox.enqueue(evento);
  await outbox.claimNext();
  await outbox.registrarResultado(evento.eventId, resultado);
}

function confirmarFixo(resposta) {
  return async () => resposta;
}

async function main() {
  let totalFalhas = 0;
  const marcar = (ok) => { if (!ok) totalFalhas++; };

  // --- A. SENT + checkpoint ausente -> reparavel ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:A1', 'A1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'CREATED', httpStatus: 200, correlationId: 'corrA1' });

    const logs = [];
    const r1 = await executarReconciliacao({ dbPath: caminho, aplicar: false, log: (s) => logs.push(s) });
    marcar(check('A. dry-run detecta A1 como REPARAVEL_AUSENTE', r1.reparaveis.some((d) => d.eventId === evento.eventId && d.classificacao === 'REPARAVEL_AUSENTE')));
    marcar(check('A. dry-run nao grava nada (checkpoint continua ausente)', (await checkpoint.buscarEvento(evento.eventId)) === null));

    const r2 = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('A. --aplicar + confirmacao correta repara A1', r2.aplicados.includes(evento.eventId)));
    const cp1 = await checkpoint.buscarEvento(evento.eventId);
    marcar(check('A. checkpoint criado com result CREATED', cp1 && cp1.result === 'CREATED'));
    marcar(check('A. checkpoint com contentHash identico ao da outbox', cp1 && cp1.contentHash === evento.contentHash));
    marcar(check('A. tentativas do checkpoint = 1 (registrarEvento 0 + atualizarEvento +1, igual ao fluxo normal)', cp1 && cp1.tentativas === 1));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- B. REVIEW_STORED + checkpoint ausente -> reparavel ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:B1', 'B1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'REVIEW_STORED', httpStatus: 200, correlationId: 'corrB1' });

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('B. REVIEW_STORED reparado', r.aplicados.includes(evento.eventId)));
    const cp = await checkpoint.buscarEvento(evento.eventId);
    marcar(check('B. checkpoint com result REVIEW_STORED', cp && cp.result === 'REVIEW_STORED'));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- C. SENT + checkpoint incompleto (result:null) -> reparavel ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:C1', 'C1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'UNCHANGED', httpStatus: 200, correlationId: 'corrC1' });
    // simula crash entre registrarEvento() e atualizarEvento() - so a 1a chamada aconteceu
    await checkpoint.registrarEvento({ eventId: evento.eventId, identityKey: evento.identityKey, nexTransactionId: evento.nexTransactionId, contentHash: evento.contentHash, status: 'PROCESSADO_LOCALMENTE' });

    const antes = await checkpoint.buscarEvento(evento.eventId);
    marcar(check('C. fixture: checkpoint incompleto (result null, tentativas 0)', antes.result === null && antes.tentativas === 0));

    const r1 = await executarReconciliacao({ dbPath: caminho, aplicar: false, log: () => {} });
    marcar(check('C. dry-run classifica C1 como REPARAVEL_INCOMPLETO', r1.reparaveis.some((d) => d.eventId === evento.eventId && d.classificacao === 'REPARAVEL_INCOMPLETO')));

    const r2 = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('C. --aplicar repara C1', r2.aplicados.includes(evento.eventId)));
    const depois = await checkpoint.buscarEvento(evento.eventId);
    marcar(check('C. checkpoint completado com result UNCHANGED', depois.result === 'UNCHANGED'));
    marcar(check('C. tentativas incrementou de 0 para 1 (sem distorcao - so atualizarEvento(), nunca registrarEvento() de novo)', depois.tentativas === 1));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- D. REVIEW_STORED + checkpoint incompleto -> reparavel ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:D1', 'D1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'REVIEW_STORED', httpStatus: 200, correlationId: 'corrD1' });
    await checkpoint.registrarEvento({ eventId: evento.eventId, contentHash: evento.contentHash, status: 'PROCESSADO_LOCALMENTE' });

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('D. REVIEW_STORED incompleto reparado', r.aplicados.includes(evento.eventId)));
    const cp = await checkpoint.buscarEvento(evento.eventId);
    marcar(check('D. checkpoint completado com result REVIEW_STORED', cp.result === 'REVIEW_STORED'));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- E. item ja consistente -> no-op ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:E1', 'E1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'CREATED', httpStatus: 200, correlationId: 'corrE1' });
    await checkpoint.registrarEvento({ eventId: evento.eventId, contentHash: evento.contentHash, status: 'PENDING' });
    await checkpoint.atualizarEvento(evento.eventId, { status: 'SENT', result: 'CREATED', httpStatus: 200, correlationId: 'corrE1' });
    const tentativasAntes = (await checkpoint.buscarEvento(evento.eventId)).tentativas;

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('E. item consistente nao aparece como reparavel', !r.reparaveis.some((d) => d.eventId === evento.eventId)));
    marcar(check('E. item consistente nao e "aplicado"', !r.aplicados.includes(evento.eventId)));
    const cpDepois = await checkpoint.buscarEvento(evento.eventId);
    marcar(check('E. tentativas do checkpoint inalteradas (no-op real)', cpDepois.tentativas === tentativasAntes));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- F. REJECTED + checkpoint ausente -> detecta, NAO repara ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:F1', 'F1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'REJECTED', httpStatus: 400 });

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('F. REJECTED detectado (SOMENTE_AUDITORIA)', r.divergencias.some((d) => d.eventId === evento.eventId && d.classificacao === 'SOMENTE_AUDITORIA')));
    marcar(check('F. REJECTED nunca entra em reparaveis', !r.reparaveis.some((d) => d.eventId === evento.eventId)));
    marcar(check('F. REJECTED nunca e aplicado', !r.aplicados.includes(evento.eventId)));
    marcar(check('F. checkpoint continua ausente (nada foi criado)', (await checkpoint.buscarEvento(evento.eventId)) === null));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- G. FAILED + checkpoint ausente -> detecta, NAO repara ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:G1', 'G1');
    await outbox.enqueue(evento);
    await outbox.claimNext();
    await outbox.transicionar(evento.eventId, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR', ultimoErro: 'Autenticacao rejeitada (401).' });

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('G. FAILED detectado (SOMENTE_AUDITORIA)', r.divergencias.some((d) => d.eventId === evento.eventId && d.classificacao === 'SOMENTE_AUDITORIA')));
    marcar(check('G. FAILED nunca reparado por este CLI', !r.aplicados.includes(evento.eventId)));
    marcar(check('G. checkpoint continua ausente', (await checkpoint.buscarEvento(evento.eventId)) === null));
    const itemOutboxDepois = await outbox.buscarPorEventId(evento.eventId);
    marcar(check('G. outbox continua FAILED (nunca tocada por este CLI)', itemOutboxDepois.status === ESTADOS.FAILED));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- H. checkpoint result ERROR contradiz SENT -> BLOQUEIA ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:H1', 'H1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'CREATED', httpStatus: 200, correlationId: 'corrH1' });
    await checkpoint.registrarEvento({ eventId: evento.eventId, contentHash: evento.contentHash, status: 'PROCESSADO_LOCALMENTE' });
    await checkpoint.atualizarEvento(evento.eventId, { status: 'PROCESSADO_LOCALMENTE', result: 'ERROR', httpStatus: 401, erro: 'Autenticacao rejeitada (401) - registro antigo.' });

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('H. divergencia classificada NAO_REPARAVEL_CONTRADITORIO', r.divergencias.some((d) => d.eventId === evento.eventId && d.classificacao === 'NAO_REPARAVEL_CONTRADITORIO')));
    marcar(check('H. nunca aparece em reparaveis', !r.reparaveis.some((d) => d.eventId === evento.eventId)));
    marcar(check('H. nunca aplicado/sobrescrito', !r.aplicados.includes(evento.eventId)));
    const cpDepois = await checkpoint.buscarEvento(evento.eventId);
    marcar(check('H. checkpoint preserva o result ERROR original (nunca sobrescrito)', cpDepois.result === 'ERROR'));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- I. checkpoint result REJECTED contradiz SENT -> BLOQUEIA ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:I1', 'I1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'CREATED', httpStatus: 200, correlationId: 'corrI1' });
    await checkpoint.registrarEvento({ eventId: evento.eventId, contentHash: evento.contentHash, status: 'PROCESSADO_LOCALMENTE' });
    await checkpoint.atualizarEvento(evento.eventId, { status: 'PROCESSADO_LOCALMENTE', result: 'REJECTED', httpStatus: 400 });

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('I. divergencia classificada NAO_REPARAVEL_CONTRADITORIO', r.divergencias.some((d) => d.eventId === evento.eventId && d.classificacao === 'NAO_REPARAVEL_CONTRADITORIO')));
    marcar(check('I. nunca aplicado', !r.aplicados.includes(evento.eventId)));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- J. contentHash divergente -> BLOQUEIA ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:J1', 'J1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'CREATED', httpStatus: 200, correlationId: 'corrJ1' });
    // registro de checkpoint com hash DIFERENTE (simulando corrupcao/tamper)
    await checkpoint.registrarEvento({ eventId: evento.eventId, contentHash: 'hash-completamente-diferente', status: 'PROCESSADO_LOCALMENTE' });
    await checkpoint.atualizarEvento(evento.eventId, { status: 'PROCESSADO_LOCALMENTE', result: 'CREATED', httpStatus: 200 });

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    const divJ = r.divergencias.find((d) => d.eventId === evento.eventId);
    marcar(check('J. contentHash divergente classificado NAO_REPARAVEL_CONTRADITORIO', divJ && divJ.classificacao === 'NAO_REPARAVEL_CONTRADITORIO' && divJ.motivoContradicao === 'CONTENT_HASH_DIVERGENTE'));
    marcar(check('J. nunca aplicado', !r.aplicados.includes(evento.eventId)));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- K. httpStatus/result contraditorio (campos parciais inesperados) -> BLOQUEIA ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:K1', 'K1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'CREATED', httpStatus: 200, correlationId: 'corrK1' });
    // result ainda null, mas ja tem httpStatus preenchido - sinal parcial inesperado, nao bate com "incompleto puro"
    await checkpoint.registrarEvento({ eventId: evento.eventId, contentHash: evento.contentHash, status: 'PROCESSADO_LOCALMENTE', httpStatus: 500 });

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    const divK = r.divergencias.find((d) => d.eventId === evento.eventId);
    marcar(check('K. sinal parcial inesperado classificado NAO_REPARAVEL_CONTRADITORIO', divK && divK.classificacao === 'NAO_REPARAVEL_CONTRADITORIO' && divK.motivoContradicao === 'CAMPOS_PARCIAIS_INESPERADOS'));
    marcar(check('K. nunca aplicado', !r.aplicados.includes(evento.eventId)));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- L. checkpoint terminal + outbox ausente -> alerta critico, NAO repara ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    // checkpoint com um eventId que NUNCA existiu na outbox (simulando corrupcao/delecao manual)
    await checkpoint.registrarEvento({ eventId: 'SALE_PAID:NEX:L1', contentHash: 'hash-L1', status: 'PROCESSADO_LOCALMENTE' });
    await checkpoint.atualizarEvento('SALE_PAID:NEX:L1', { status: 'PROCESSADO_LOCALMENTE', result: 'CREATED', httpStatus: 200 });

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('L. detectado como CRITICO_CHECKPOINT_SEM_OUTBOX', r.divergencias.some((d) => d.eventId === 'SALE_PAID:NEX:L1' && d.classificacao === 'CRITICO_CHECKPOINT_SEM_OUTBOX')));
    marcar(check('L. nunca entra em reparaveis', !r.reparaveis.some((d) => d.eventId === 'SALE_PAID:NEX:L1')));
    marcar(check('L. nunca aplicado', !r.aplicados.includes('SALE_PAID:NEX:L1')));
    marcar(check('L. nenhuma linha de outbox foi criada para L1', (await outbox.buscarPorEventId('SALE_PAID:NEX:L1')) === null));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- M. tentativas diferentes nao e tratado como inconsistencia por si so ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:M1', 'M1');
    // forca varias tentativas na outbox antes do sucesso (RETRY x2, depois SENT)
    await outbox.enqueue(evento);
    await outbox.claimNext();
    await outbox.transicionar(evento.eventId, ESTADOS.RETRY, { httpStatus: 500, result: 'ERROR', nextAttemptAt: null });
    await outbox.claimNext();
    await outbox.transicionar(evento.eventId, ESTADOS.RETRY, { httpStatus: 500, result: 'ERROR', nextAttemptAt: null });
    await outbox.claimNext();
    await outbox.registrarResultado(evento.eventId, { result: 'CREATED', httpStatus: 200, correlationId: 'corrM1' });
    const itemOutbox = await outbox.buscarPorEventId(evento.eventId);
    marcar(check('M. fixture: outbox.tentativas=3 (varias tentativas reais)', itemOutbox.tentativas === 3));

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('M. M1 reparado normalmente (tentativas divergentes nao bloqueiam)', r.aplicados.includes(evento.eventId)));
    const cp = await checkpoint.buscarEvento(evento.eventId);
    marcar(check('M. checkpoint.tentativas=1 (semantica propria, diferente da outbox, nao e erro)', cp.tentativas === 1));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- N. correlationId diferente nao e usado isoladamente como gate ---
  {
    // classificarDivergencia() nunca consulta correlationId para decidir
    // REPARAVEL/CONTRADITORIO quando o restante do registro esta "incompleto puro"
    // (result null, httpStatus null, erro null) - so o preenchimento de
    // correlationId sozinho (com os outros nulos) e tratado como sinal parcial.
    const item = { eventId: 'X', contentHash: 'h', result: 'CREATED' };
    const registroComCorrelationIdApenas = { contentHash: 'h', result: null, httpStatus: null, correlationId: 'algum-id', erro: null };
    const cls = classificarDivergencia(item, registroComCorrelationIdApenas);
    marcar(check('N. correlationId sozinho preenchido (result/httpStatus/erro null) e tratado como sinal parcial -> NAO_REPARAVEL_CONTRADITORIO (conservador)', cls.classificacao === 'NAO_REPARAVEL_CONTRADITORIO'));
    const registroTotalmenteLimpo = { contentHash: 'h', result: null, httpStatus: null, correlationId: null, erro: null };
    const cls2 = classificarDivergencia(item, registroTotalmenteLimpo);
    marcar(check('N. sem nenhum sinal preenchido -> REPARAVEL_INCOMPLETO', cls2.classificacao === 'REPARAVEL_INCOMPLETO'));
  }

  // --- O. dry-run padrao -> zero writes ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:O1', 'O1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'CREATED', httpStatus: 200 });

    await executarReconciliacao({ dbPath: caminho, log: () => {} }); // aplicar omitido = false
    marcar(check('O. dry-run (aplicar omitido) nao grava nada', (await checkpoint.buscarEvento(evento.eventId)) === null));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- P. --aplicar sem confirmacao correta -> zero writes ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:P1', 'P1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'CREATED', httpStatus: 200 });

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo('sim'), log: () => {} });
    marcar(check('P. confirmacao errada -> cancelado:true', r.cancelado === true));
    marcar(check('P. confirmacao errada -> nenhum item aplicado', r.aplicados.length === 0));
    marcar(check('P. confirmacao errada -> checkpoint continua ausente', (await checkpoint.buscarEvento(evento.eventId)) === null));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- Q/R/S. confirmacao RECONCILIAR altera SOMENTE o(s) reparavel(is), outro evento intocado, outbox nunca alterada ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const eventoReparavel = fixtureEvento('SALE_PAID:NEX:Q1', 'Q1');
    const eventoConsistente = fixtureEvento('SALE_PAID:NEX:Q2', 'Q2');
    await criarItemTerminalNaOutbox(outbox, eventoReparavel, { result: 'CREATED', httpStatus: 200, correlationId: 'corrQ1' });
    await criarItemTerminalNaOutbox(outbox, eventoConsistente, { result: 'CREATED', httpStatus: 200, correlationId: 'corrQ2' });
    await checkpoint.registrarEvento({ eventId: eventoConsistente.eventId, contentHash: eventoConsistente.contentHash, status: 'PENDING' });
    await checkpoint.atualizarEvento(eventoConsistente.eventId, { status: 'SENT', result: 'CREATED', httpStatus: 200, correlationId: 'corrQ2' });
    const statusOutboxAntes = (await outbox.buscarPorEventId(eventoReparavel.eventId)).status;
    const statusOutboxQ2Antes = (await outbox.buscarPorEventId(eventoConsistente.eventId)).status;
    const cpQ2Antes = await checkpoint.buscarEvento(eventoConsistente.eventId);

    const r = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('Q. Q1 (reparavel) foi aplicado', r.aplicados.includes(eventoReparavel.eventId)));
    marcar(check('R. Q2 (ja consistente) nao foi tocado (nao aparece em aplicados)', !r.aplicados.includes(eventoConsistente.eventId)));
    const cpQ2Depois = await checkpoint.buscarEvento(eventoConsistente.eventId);
    marcar(check('R. checkpoint de Q2 byte-a-byte identico (tentativas/result/httpStatus inalterados)', cpQ2Depois.tentativas === cpQ2Antes.tentativas && cpQ2Depois.result === cpQ2Antes.result && cpQ2Depois.httpStatus === cpQ2Antes.httpStatus));
    const statusOutboxDepois = (await outbox.buscarPorEventId(eventoReparavel.eventId)).status;
    const statusOutboxQ2Depois = (await outbox.buscarPorEventId(eventoConsistente.eventId)).status;
    marcar(check('S. outbox de Q1 nunca alterada (mesmo status SENT antes/depois)', statusOutboxAntes === statusOutboxDepois));
    marcar(check('S. outbox de Q2 nunca alterada', statusOutboxQ2Antes === statusOutboxQ2Depois));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- T. zero HTTP/rede (garantia estrutural do modulo) ---
  // Analisa somente CODIGO EXECUTAVEL (remove comentarios /* */ e // antes
  // de checar) - os comentarios do arquivo DELIBERADAMENTE explicam, em
  // prosa, o que o modulo NAO faz (por isso citam esses termos), o que e
  // exatamente a documentacao correta - a garantia real e sobre imports/
  // chamadas reais, nunca sobre palavras em comentarios explicativos.
  {
    const codigoBruto = fs.readFileSync(path.join(__dirname, '..', 'SCRIPTS', 'reconciliar-consistencia.js'), 'utf8');
    const codigoSemComentarios = codigoBruto
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    marcar(check('T. nao importa repositorio-eventos-http (fora de comentarios)', !codigoSemComentarios.includes('repositorio-eventos-http')));
    marcar(check('T. nao usa fetch', !/\bfetch\s*\(/.test(codigoSemComentarios)));
    marcar(check('T. nao referencia "transportar" (fora de comentarios)', !codigoSemComentarios.includes('transportar')));
    marcar(check('T. nao referencia secret/HMAC/webhook (fora de comentarios)', !/secret|hmac|webhook/i.test(codigoSemComentarios)));
  }

  // --- U. segunda execucao depois do reparo -> no-op/idempotente ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:U1', 'U1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'CREATED', httpStatus: 200, correlationId: 'corrU1' });

    const r1 = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('U. primeira execucao repara U1', r1.aplicados.includes(evento.eventId)));
    const cpAposPrimeira = await checkpoint.buscarEvento(evento.eventId);

    const r2 = await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });
    marcar(check('U. segunda execucao nao encontra mais nada reparavel para U1', !r2.reparaveis.some((d) => d.eventId === evento.eventId)));
    marcar(check('U. segunda execucao nao altera nada (idempotente)', !r2.aplicados.includes(evento.eventId)));
    const cpAposSegunda = await checkpoint.buscarEvento(evento.eventId);
    marcar(check('U. checkpoint byte-a-byte identico entre as duas leituras', cpAposPrimeira.tentativas === cpAposSegunda.tentativas && cpAposPrimeira.result === cpAposSegunda.result));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- V. restart/detector nao reprocessa o evento reconciliado ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:V1', 'V1');
    await criarItemTerminalNaOutbox(outbox, evento, { result: 'CREATED', httpStatus: 200, correlationId: 'corrV1' });
    await executarReconciliacao({ dbPath: caminho, aplicar: true, confirmar: confirmarFixo(CONFIRMACAO_ESPERADA), log: () => {} });

    // simula o detector tentando reenfileirar o MESMO evento (arquivo reexportado com mesmo conteudo)
    const resultadoEnqueue = await outbox.enqueue(evento);
    marcar(check('V. reenfileirar o mesmo eventId+hash apos a reconciliacao e no-op (protecao da propria outbox, independente do checkpoint)', resultadoEnqueue.criado === false && resultadoEnqueue.motivo === 'JA_ENFILEIRADO_MESMO_HASH'));
    const itemDepois = await outbox.buscarPorEventId(evento.eventId);
    marcar(check('V. outbox continua SENT (nunca voltou a PENDING)', itemDepois.status === ESTADOS.SENT));

    outbox.fechar(); checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  console.log(`\nTotal de falhas: ${totalFalhas}`);
  process.exitCode = totalFalhas > 0 ? 1 : 0;
}

main().catch((erro) => {
  console.error('Erro inesperado nos testes:', erro);
  process.exitCode = 1;
});
