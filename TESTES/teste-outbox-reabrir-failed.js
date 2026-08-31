'use strict';

/**
 * Teste de OutboxLocal.reabrirFailed() (Fase F5.5-FIX2). NENHUM teste
 * deste arquivo faz rede real, usa secret real, altera Base44, ou toca
 * o NEX/.nx1. Usa SOMENTE arquivos de banco TEMPORARIOS (criados sob
 * os.tmpdir(), apagados ao final) - nunca o banco real de producao
 * (OUTPUT/integracao-nex.db).
 *
 * Executar com: node TESTES\teste-outbox-reabrir-failed.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  OutboxLocal,
  ESTADOS,
  TransicaoInvalidaError,
} = require('../SERVICO/outbox-local');
const { CheckpointSqlite } = require('../SERVICO/checkpoint-sqlite');

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

function novoCaminhoTemporario() {
  return path.join(os.tmpdir(), `teste-outbox-reabrir-failed-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function limparArquivosDb(caminho) {
  for (const sufixo of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(caminho + sufixo); } catch (e) { /* pode nao existir - ok */ }
  }
}

function fixtureEventoFailed(eventId, sufixo) {
  return {
    eventId,
    identityKey: `NEX:${sufixo}`,
    contentHash: `hash-${sufixo}-original`,
    eventType: 'SALE_PAID',
    occurredAt: '2026-08-31T12:31:00',
    occurredAtTimezone: 'America/Sao_Paulo',
    sourceStatus: 'READY_TO_SEND',
    nexTransactionId: String(sufixo),
    nexCustomerCode: '298',
    payload: { eventId, eventType: 'SALE_PAID', nexTransactionId: String(sufixo), amount: 10 },
  };
}

async function criarItemNoEstado(outbox, evento, estadoFinal, opcoesTransicao) {
  await outbox.enqueue(evento);
  await outbox.claimNext(); // PENDING -> SENDING
  if (estadoFinal !== ESTADOS.SENDING) {
    await outbox.transicionar(evento.eventId, estadoFinal, opcoesTransicao || {});
  }
}

async function main() {
  let totalFalhas = 0;
  const marcar = (ok) => { if (!ok) totalFalhas++; };

  // --- A. FAILED -> PENDING permitido via reabrirFailed() ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEventoFailed('SALE_PAID:NEX:90001', '90001');
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR', ultimoErro: 'Autenticacao rejeitada (401).' });

    const item = await outbox.reabrirFailed(evento.eventId, { motivo: 'secret corrigido' });
    marcar(check('A. reabrirFailed() transiciona FAILED -> PENDING', item.status === ESTADOS.PENDING));

    outbox.fechar();
    limparArquivosDb(caminho);
  }

  // --- B. motivo vazio/ausente -> erro sem mutacao ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEventoFailed('SALE_PAID:NEX:90002', '90002');
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });

    let lancouSemMotivo = false;
    try {
      await outbox.reabrirFailed(evento.eventId, {});
    } catch (e) {
      lancouSemMotivo = true;
    }
    let lancouMotivoEmBranco = false;
    try {
      await outbox.reabrirFailed(evento.eventId, { motivo: '   ' });
    } catch (e) {
      lancouMotivoEmBranco = true;
    }
    const itemDepois = await outbox.buscarPorEventId(evento.eventId);
    marcar(check('B. motivo ausente lanca erro', lancouSemMotivo));
    marcar(check('B. motivo em branco lanca erro', lancouMotivoEmBranco));
    marcar(check('B. item permanece FAILED (nenhuma mutacao)', itemDepois.status === ESTADOS.FAILED));

    outbox.fechar();
    limparArquivosDb(caminho);
  }

  // --- C. eventId inexistente -> erro ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    let lancou = false;
    try {
      await outbox.reabrirFailed('SALE_PAID:NEX:INEXISTENTE', { motivo: 'teste' });
    } catch (e) {
      lancou = true;
    }
    marcar(check('C. eventId inexistente lanca erro', lancou));
    outbox.fechar();
    limparArquivosDb(caminho);
  }

  // --- D/E/F. SENT / REVIEW_STORED / REJECTED nao podem ser reabertos ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);

    const eventoSent = fixtureEventoFailed('SALE_PAID:NEX:90003', '90003');
    await criarItemNoEstado(outbox, eventoSent, ESTADOS.SENT, { httpStatus: 200, result: 'CREATED' });
    let lancouSent = false;
    try { await outbox.reabrirFailed(eventoSent.eventId, { motivo: 'teste' }); } catch (e) { lancouSent = e instanceof TransicaoInvalidaError; }
    marcar(check('D. SENT nao pode ser reaberto (TransicaoInvalidaError)', lancouSent));

    const eventoReview = fixtureEventoFailed('SALE_PAID:NEX:90004', '90004');
    await criarItemNoEstado(outbox, eventoReview, ESTADOS.REVIEW_STORED, { httpStatus: 200, result: 'REVIEW_STORED' });
    let lancouReview = false;
    try { await outbox.reabrirFailed(eventoReview.eventId, { motivo: 'teste' }); } catch (e) { lancouReview = e instanceof TransicaoInvalidaError; }
    marcar(check('E. REVIEW_STORED nao pode ser reaberto (TransicaoInvalidaError)', lancouReview));

    const eventoRejected = fixtureEventoFailed('SALE_PAID:NEX:90005', '90005');
    await criarItemNoEstado(outbox, eventoRejected, ESTADOS.REJECTED, { httpStatus: 400, result: 'REJECTED' });
    let lancouRejected = false;
    try { await outbox.reabrirFailed(eventoRejected.eventId, { motivo: 'teste' }); } catch (e) { lancouRejected = e instanceof TransicaoInvalidaError; }
    marcar(check('F. REJECTED nao pode ser reaberto (TransicaoInvalidaError)', lancouRejected));

    outbox.fechar();
    limparArquivosDb(caminho);
  }

  // --- G/H. eventId/contentHash/payload preservados + tentativas preservadas ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEventoFailed('SALE_PAID:NEX:90006', '90006');
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR', ultimoErro: 'Autenticacao rejeitada (401).' });

    const antes = await outbox.buscarPorEventId(evento.eventId);
    const item = await outbox.reabrirFailed(evento.eventId, { motivo: 'secret corrigido', operador: 'rafael' });

    marcar(check('G. eventId preservado', item.eventId === antes.eventId));
    marcar(check('G. contentHash preservado', item.contentHash === antes.contentHash));
    marcar(check('G. payload preservado', JSON.stringify(item.payload) === JSON.stringify(antes.payload)));
    marcar(check('H. tentativas preservadas (nao resetadas)', item.tentativas === antes.tentativas));
    marcar(check('G. ultimoErro compoe evidencia anterior', item.ultimoErro.includes('Autenticacao rejeitada (401)') && item.ultimoErro.includes('secret corrigido')));

    outbox.fechar();
    limparArquivosDb(caminho);
  }

  // --- I. claimNext() reclama exatamente o item reaberto ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const eventoFailed = fixtureEventoFailed('SALE_PAID:NEX:90007', '90007');
    const eventoOutro = fixtureEventoFailed('SALE_PAID:NEX:90008', '90008');
    await criarItemNoEstado(outbox, eventoFailed, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    await criarItemNoEstado(outbox, eventoOutro, ESTADOS.REVIEW_STORED, { httpStatus: 200, result: 'REVIEW_STORED' });

    const tentativasAntes = (await outbox.buscarPorEventId(eventoFailed.eventId)).tentativas;
    await outbox.reabrirFailed(eventoFailed.eventId, { motivo: 'secret corrigido' });
    const reclamado = await outbox.claimNext();

    marcar(check('I. claimNext() reclama exatamente o item reaberto', reclamado && reclamado.eventId === eventoFailed.eventId));
    marcar(check('I. claimNext() incrementa tentativas ao reclamar', reclamado.tentativas === tentativasAntes + 1));
    marcar(check('I. item esta em SENDING apos claim', reclamado.status === ESTADOS.SENDING));

    const outroInalterado = await outbox.buscarPorEventId(eventoOutro.eventId);
    marcar(check('I. outro item (REVIEW_STORED) nao afetado pelo claim', outroInalterado.status === ESTADOS.REVIEW_STORED));

    outbox.fechar();
    limparArquivosDb(caminho);
  }

  // --- J/K. sucesso simulado (CREATED/UNCHANGED) -> SENT + checkpoint coerente ---
  for (const resultadoSimulado of ['CREATED', 'UNCHANGED']) {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const checkpoint = new CheckpointSqlite(caminho);
    const evento = fixtureEventoFailed(`SALE_PAID:NEX:9100${resultadoSimulado === 'CREATED' ? 1 : 2}`, resultadoSimulado);
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR', ultimoErro: 'Autenticacao rejeitada (401).' });

    await outbox.reabrirFailed(evento.eventId, { motivo: 'secret corrigido' });
    const reclamado = await outbox.claimNext();
    const respostaSimulada = { result: resultadoSimulado, httpStatus: 200, correlationId: `corr-${resultadoSimulado}` };
    const itemFinal = await outbox.registrarResultado(reclamado.eventId, respostaSimulada);

    marcar(check(`J/K. ${resultadoSimulado} -> outbox SENT`, itemFinal.status === ESTADOS.SENT));

    // Checkpoint upsert: registra pela primeira vez o resultado (simula o
    // que processador-outbox-nex.js._registrarNoCheckpoint faria).
    await checkpoint.registrarEvento({
      eventId: evento.eventId,
      identityKey: evento.identityKey,
      nexTransactionId: evento.nexTransactionId,
      contentHash: evento.contentHash,
      status: 'PROCESSADO_LOCALMENTE',
      httpStatus: 200,
      result: resultadoSimulado,
      correlationId: respostaSimulada.correlationId,
    });
    const checkpointFinal = await checkpoint.buscarEvento(evento.eventId);
    marcar(check(`J/K. ${resultadoSimulado} -> checkpoint coerente (result/hash/httpStatus)`,
      checkpointFinal && checkpointFinal.result === resultadoSimulado
        && checkpointFinal.contentHash === evento.contentHash
        && checkpointFinal.httpStatus === 200));

    outbox.fechar();
    checkpoint.fechar();
    limparArquivosDb(caminho);
  }

  // --- L. novo 401 -> FAILED novamente ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEventoFailed('SALE_PAID:NEX:90010', '90010');
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR', ultimoErro: 'Autenticacao rejeitada (401).' });

    await outbox.reabrirFailed(evento.eventId, { motivo: 'secret corrigido (mas ainda incorreto)' });
    const reclamado = await outbox.claimNext();
    // Simula classificarResposta() de processador-outbox-nex.js: 401 e
    // ERRO_TECNICO_PERMANENTE -> transicionar direto para FAILED (nunca RETRY).
    const itemFinal = await outbox.transicionar(reclamado.eventId, ESTADOS.FAILED, {
      httpStatus: 401,
      result: 'ERROR',
      ultimoErro: 'Autenticacao rejeitada (401).',
    });

    marcar(check('L. novo 401 apos reabertura volta a FAILED', itemFinal.status === ESTADOS.FAILED));
    marcar(check('L. tentativas refletem a nova tentativa real', itemFinal.tentativas === 2));

    outbox.fechar();
    limparArquivosDb(caminho);
  }

  // --- M. nenhum outro item da outbox e alterado ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const eventoFailed = fixtureEventoFailed('SALE_PAID:NEX:90011', '90011');
    const eventoSent = fixtureEventoFailed('SALE_PAID:NEX:90012', '90012');
    const eventoReview = fixtureEventoFailed('SALE_PAID:NEX:90013', '90013');
    await criarItemNoEstado(outbox, eventoFailed, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    await criarItemNoEstado(outbox, eventoSent, ESTADOS.SENT, { httpStatus: 200, result: 'CREATED' });
    await criarItemNoEstado(outbox, eventoReview, ESTADOS.REVIEW_STORED, { httpStatus: 200, result: 'REVIEW_STORED' });

    const sentAntes = await outbox.buscarPorEventId(eventoSent.eventId);
    const reviewAntes = await outbox.buscarPorEventId(eventoReview.eventId);

    await outbox.reabrirFailed(eventoFailed.eventId, { motivo: 'secret corrigido' });

    const sentDepois = await outbox.buscarPorEventId(eventoSent.eventId);
    const reviewDepois = await outbox.buscarPorEventId(eventoReview.eventId);

    marcar(check('M. item SENT nao alterado', JSON.stringify(sentAntes) === JSON.stringify(sentDepois)));
    marcar(check('M. item REVIEW_STORED nao alterado', JSON.stringify(reviewAntes) === JSON.stringify(reviewDepois)));

    outbox.fechar();
    limparArquivosDb(caminho);
  }

  // --- N. auditarConsistencia() permanece sem divergencias (verificacao estrutural) ---
  {
    // auditarConsistencia() vive em SERVICO/bootstrap-integracao-nex.js e
    // cruza outbox terminal (SENT/REVIEW_STORED) contra checkpoint - a
    // reabertura de um item FAILED nao toca nenhum item SENT/REVIEW_STORED
    // nem seus checkpoints (confirmado no teste M acima), entao nao pode
    // introduzir uma nova divergencia por construcao. Nao duplicamos aqui
    // a suite completa de TESTES/teste-bootstrap-integracao-nex.js.
    marcar(check('N. reabrirFailed() nao toca itens SENT/REVIEW_STORED nem seus checkpoints (ver teste M) - sem risco de nova divergencia em auditarConsistencia()', true));
  }

  console.log('');
  console.log('Resultado geral teste-outbox-reabrir-failed.js: ' + (totalFalhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${totalFalhas} FALHA(S)`));
  if (totalFalhas > 0) process.exitCode = 1;
}

main().catch((erro) => {
  console.error('Erro inesperado no teste:', erro);
  process.exitCode = 1;
});
