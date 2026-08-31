'use strict';

/**
 * Teste de SCRIPTS/reabrir-evento-failed.js (Fase F5.5-FIX3). NENHUM
 * teste deste arquivo faz rede real, le stdin real, ou toca o banco
 * real de producao (OUTPUT/integracao-nex.db) - tudo roda sobre
 * arquivos de banco TEMPORARIOS (os.tmpdir()), com a funcao
 * `confirmar` injetada (fake, sem readline real).
 *
 * Executar com: node TESTES\teste-cli-reabrir-evento-failed.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { OutboxLocal, ESTADOS } = require('../SERVICO/outbox-local');
const { executarReabertura, EVENT_ID_PERMITIDO } = require('../SCRIPTS/reabrir-evento-failed');

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

function novoCaminhoTemporario() {
  return path.join(os.tmpdir(), `teste-cli-reabrir-failed-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
  await outbox.claimNext();
  if (estadoFinal !== ESTADOS.SENDING) {
    await outbox.transicionar(evento.eventId, estadoFinal, opcoesTransicao || {});
  }
}

function confirmarFixo(resposta) {
  return async () => resposta;
}

async function main() {
  let totalFalhas = 0;
  const marcar = (ok) => { if (!ok) totalFalhas++; };

  // --- sem eventId -> falha ---
  {
    const resultado = await executarReabertura({ motivo: 'teste' });
    marcar(check('sem eventId -> falha (EVENT_ID_OBRIGATORIO)', resultado.sucesso === false && resultado.motivoFalha === 'EVENT_ID_OBRIGATORIO'));
  }

  // --- sem motivo -> falha ---
  {
    const resultado = await executarReabertura({ eventId: EVENT_ID_PERMITIDO });
    marcar(check('sem motivo -> falha (MOTIVO_OBRIGATORIO)', resultado.sucesso === false && resultado.motivoFalha === 'MOTIVO_OBRIGATORIO'));
  }
  {
    const resultado = await executarReabertura({ eventId: EVENT_ID_PERMITIDO, motivo: '   ' });
    marcar(check('motivo em branco -> falha (MOTIVO_OBRIGATORIO)', resultado.sucesso === false && resultado.motivoFalha === 'MOTIVO_OBRIGATORIO'));
  }

  // --- eventId diferente de #15770 -> falha (trava especifica) ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEventoFailed('SALE_PAID:NEX:15768', '15768');
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    outbox.fechar();

    const resultado = await executarReabertura({
      eventId: 'SALE_PAID:NEX:15768',
      motivo: 'tentativa indevida',
      dbPath: caminho,
      confirmar: confirmarFixo('REABRIR'),
    });
    marcar(check('eventId diferente de #15770 -> falha (EVENT_ID_NAO_PERMITIDO), mesmo estando FAILED de verdade', resultado.sucesso === false && resultado.motivoFalha === 'EVENT_ID_NAO_PERMITIDO'));

    const item = await new OutboxLocal(caminho).buscarPorEventId('SALE_PAID:NEX:15768');
    marcar(check('#15768 continua FAILED (nao foi tocado pela trava)', item.status === ESTADOS.FAILED));

    limparArquivosDb(caminho);
  }

  // --- #15770 inexistente em DB de teste -> falha ---
  {
    const caminho = novoCaminhoTemporario();
    new OutboxLocal(caminho).fechar(); // cria schema, sem inserir nada

    const resultado = await executarReabertura({
      eventId: EVENT_ID_PERMITIDO,
      motivo: 'teste',
      dbPath: caminho,
      confirmar: confirmarFixo('REABRIR'),
    });
    marcar(check('#15770 inexistente -> falha (EVENT_ID_NAO_ENCONTRADO)', resultado.sucesso === false && resultado.motivoFalha === 'EVENT_ID_NAO_ENCONTRADO'));

    limparArquivosDb(caminho);
  }

  // --- item não FAILED -> falha ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEventoFailed(EVENT_ID_PERMITIDO, '15770');
    await criarItemNoEstado(outbox, evento, ESTADOS.SENT, { httpStatus: 200, result: 'CREATED' });
    outbox.fechar();

    const resultado = await executarReabertura({
      eventId: EVENT_ID_PERMITIDO,
      motivo: 'teste',
      dbPath: caminho,
      confirmar: confirmarFixo('REABRIR'),
    });
    marcar(check('item nao-FAILED (ex.: SENT) -> falha (STATUS_NAO_FAILED)', resultado.sucesso === false && resultado.motivoFalha === 'STATUS_NAO_FAILED'));

    limparArquivosDb(caminho);
  }

  // --- confirmação diferente de REABRIR -> cancela sem mutação ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEventoFailed(EVENT_ID_PERMITIDO, '15770');
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    outbox.fechar();

    const resultado = await executarReabertura({
      eventId: EVENT_ID_PERMITIDO,
      motivo: 'teste',
      dbPath: caminho,
      confirmar: confirmarFixo('nao tenho certeza'),
    });
    marcar(check('confirmacao incorreta -> cancelado, sem sucesso', resultado.sucesso === false && resultado.cancelado === true));

    const itemDepois = await new OutboxLocal(caminho).buscarPorEventId(EVENT_ID_PERMITIDO);
    marcar(check('item permanece FAILED apos cancelamento (nenhuma mutacao)', itemDepois.status === ESTADOS.FAILED));

    limparArquivosDb(caminho);
  }

  // --- confirmação correta -> exatamente FAILED->PENDING, preservando dados ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const eventoAlvo = fixtureEventoFailed(EVENT_ID_PERMITIDO, '15770');
    const eventoOutro = fixtureEventoFailed('SALE_PAID:NEX:15769', '15769');
    await criarItemNoEstado(outbox, eventoAlvo, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR', ultimoErro: 'Autenticacao rejeitada (401).' });
    await criarItemNoEstado(outbox, eventoOutro, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    const antesAlvo = await outbox.buscarPorEventId(EVENT_ID_PERMITIDO);
    const antesOutro = await outbox.buscarPorEventId('SALE_PAID:NEX:15769');
    outbox.fechar();

    const resultado = await executarReabertura({
      eventId: EVENT_ID_PERMITIDO,
      motivo: 'reprocessamento manual apos correcao do secret NSSM',
      operador: 'rafael',
      dbPath: caminho,
      confirmar: confirmarFixo('REABRIR'),
    });

    marcar(check('confirmacao correta -> sucesso', resultado.sucesso === true));
    marcar(check('confirmacao correta -> exatamente FAILED->PENDING', resultado.depois.status === ESTADOS.PENDING));
    marcar(check('eventId preservado', resultado.depois.eventId === antesAlvo.eventId));
    marcar(check('contentHash preservado', resultado.depois.contentHash === antesAlvo.contentHash));
    marcar(check('tentativas preservadas', resultado.depois.tentativas === antesAlvo.tentativas));

    const outboxDepois = new OutboxLocal(caminho);
    const alvoCompleto = await outboxDepois.buscarPorEventId(EVENT_ID_PERMITIDO);
    marcar(check('payload preservado (comparacao direta no banco)', JSON.stringify(alvoCompleto.payload) === JSON.stringify(antesAlvo.payload)));

    const outroDepois = await outboxDepois.buscarPorEventId('SALE_PAID:NEX:15769');
    marcar(check('nenhuma alteracao em outro item (#15769 simulado permanece FAILED)', JSON.stringify(outroDepois) === JSON.stringify(antesOutro)));
    outboxDepois.fechar();

    limparArquivosDb(caminho);
  }

  // --- zero rede: nenhuma dependencia de fetch/http em todo o arquivo do CLI ---
  {
    const codigoFonte = fs.readFileSync(path.join(__dirname, '..', 'SCRIPTS', 'reabrir-evento-failed.js'), 'utf8');
    marcar(check('CLI nao referencia fetch/http/https em nenhuma linha (zero rede)', !/\bfetch\(|require\(['"]https?['"]\)/.test(codigoFonte)));
    marcar(check('CLI nunca imprime "payload" bruto (so resumoSemPayload)', !/console\.log\([^)]*payload[^)]*JSON\.stringify\(item/.test(codigoFonte)));
  }

  console.log('');
  console.log('Resultado geral teste-cli-reabrir-evento-failed.js: ' + (totalFalhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${totalFalhas} FALHA(S)`));
  if (totalFalhas > 0) process.exitCode = 1;
}

main().catch((erro) => {
  console.error('Erro inesperado no teste:', erro);
  process.exitCode = 1;
});
