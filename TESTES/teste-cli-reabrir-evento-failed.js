'use strict';

/**
 * Teste de SCRIPTS/reabrir-evento-failed.js (Fases F5.5-FIX3/FIX11).
 * NENHUM teste deste arquivo faz rede real, le stdin real, ou toca o
 * banco real de producao (OUTPUT/integracao-nex.db) - tudo roda sobre
 * arquivos de banco TEMPORARIOS (os.tmpdir()), com a funcao
 * `confirmar` injetada (fake, sem readline real).
 *
 * Executar com: node TESTES\teste-cli-reabrir-evento-failed.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { OutboxLocal, ESTADOS } = require('../SERVICO/outbox-local');
const { executarReabertura, EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO, AVISO_FORTE } = require('../SCRIPTS/reabrir-evento-failed');

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

function fixtureEvento(eventId, sufixo, eventType, sourceStatus) {
  return {
    eventId,
    identityKey: `NEX:${sufixo}`,
    contentHash: `hash-${sufixo}-original`,
    eventType: eventType || 'SALE_PAID',
    occurredAt: '2026-08-31T12:31:00',
    occurredAtTimezone: 'America/Sao_Paulo',
    sourceStatus: sourceStatus || 'READY_TO_SEND',
    nexTransactionId: String(sufixo),
    nexCustomerCode: sourceStatus === 'REVIEW_REQUIRED' ? null : '298',
    payload: { eventId, eventType: eventType || 'SALE_PAID', nexTransactionId: String(sufixo), amount: 10 },
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

  // --- A-E. cada eventType liberado, FAILED valido -> reabertura permitida ---
  const eventTypesParaTestar = [
    ['A', 'SALE_PAID', 'SALE_PAID:NEX:20001', '20001'],
    ['B', 'DEBT_CREATED', 'DEBT_CREATED:NEX:20002', '20002'],
    ['C', 'SALE_PARTIALLY_PAID', 'SALE_PARTIALLY_PAID:NEX:20003', '20003'],
    ['D', 'DEBT_PAYMENT', 'DEBT_PAYMENT:NEX:20004', '20004'],
    ['E', 'SALE_CANCELLED', 'SALE_CANCELLED:NEX:20005', '20005'],
  ];
  for (const [letra, eventType, eventId, sufixo] of eventTypesParaTestar) {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEvento(eventId, sufixo, eventType);
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    outbox.fechar();

    const resultado = await executarReabertura({
      eventId, motivo: 'teste', dbPath: caminho, confirmar: confirmarFixo('REABRIR'),
    });
    marcar(check(`${letra}. ${eventType} FAILED valido -> reabertura permitida`, resultado.sucesso === true && resultado.depois.status === ESTADOS.PENDING));

    limparArquivosDb(caminho);
  }

  // --- F. eventType desconhecido bloqueado ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEvento('UNCLASSIFIED:NEX:20006', '20006', 'UNCLASSIFIED');
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    outbox.fechar();

    const resultado = await executarReabertura({
      eventId: 'UNCLASSIFIED:NEX:20006', motivo: 'teste', dbPath: caminho, confirmar: confirmarFixo('REABRIR'),
    });
    marcar(check('F. eventType desconhecido bloqueado (EVENT_TYPE_NAO_PERMITIDO)', resultado.sucesso === false && resultado.motivoFalha === 'EVENT_TYPE_NAO_PERMITIDO'));

    const itemDepois = await new OutboxLocal(caminho).buscarPorEventId('UNCLASSIFIED:NEX:20006');
    marcar(check('F. item de eventType desconhecido permanece FAILED (nenhuma mutacao)', itemDepois.status === ESTADOS.FAILED));

    limparArquivosDb(caminho);
  }

  // --- G-L. cada estado nao-FAILED bloqueado ---
  const estadosBloqueados = [
    ['G', ESTADOS.SENT, { httpStatus: 200, result: 'CREATED' }],
    ['H', ESTADOS.REVIEW_STORED, { httpStatus: 200, result: 'REVIEW_STORED' }],
    ['I', ESTADOS.REJECTED, { httpStatus: 400, result: 'REJECTED' }],
  ];
  for (const [letra, estado, opcoes] of estadosBloqueados) {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const eventId = `SALE_PAID:NEX:2010${letra}`;
    const evento = fixtureEvento(eventId, `2010${letra}`);
    await criarItemNoEstado(outbox, evento, estado, opcoes);
    outbox.fechar();

    const resultado = await executarReabertura({ eventId, motivo: 'teste', dbPath: caminho, confirmar: confirmarFixo('REABRIR') });
    marcar(check(`${letra}. ${estado} bloqueado (STATUS_NAO_FAILED)`, resultado.sucesso === false && resultado.motivoFalha === 'STATUS_NAO_FAILED'));

    limparArquivosDb(caminho);
  }
  // J/K/L: PENDING, SENDING, RETRY bloqueados (nao sao terminais nem FAILED)
  {
    // Bancos SEPARADOS por caso: claimNext() reclama o item PENDING/RETRY
    // mais antigo GLOBALMENTE no arquivo - deixar um item propositalmente
    // em PENDING (caso J) contaminaria o claimNext() usado por
    // criarItemNoEstado() para os casos seguintes (K/L) se compartilhassem
    // o mesmo arquivo.
    const caminhoJ = novoCaminhoTemporario();
    const outboxJ = new OutboxLocal(caminhoJ);
    const eventoPending = fixtureEvento('SALE_PAID:NEX:20111', '20111');
    await outboxJ.enqueue(eventoPending); // fica em PENDING
    const resultadoPending = await executarReabertura({ eventId: eventoPending.eventId, motivo: 'teste', dbPath: caminhoJ, confirmar: confirmarFixo('REABRIR') });
    marcar(check('J. PENDING bloqueado (STATUS_NAO_FAILED)', resultadoPending.sucesso === false && resultadoPending.motivoFalha === 'STATUS_NAO_FAILED'));
    outboxJ.fechar();
    limparArquivosDb(caminhoJ);

    const caminhoK = novoCaminhoTemporario();
    const outboxK = new OutboxLocal(caminhoK);
    const eventoSending = fixtureEvento('SALE_PAID:NEX:20112', '20112');
    await criarItemNoEstado(outboxK, eventoSending, ESTADOS.SENDING);
    const resultadoSending = await executarReabertura({ eventId: eventoSending.eventId, motivo: 'teste', dbPath: caminhoK, confirmar: confirmarFixo('REABRIR') });
    marcar(check('K. SENDING bloqueado (STATUS_NAO_FAILED)', resultadoSending.sucesso === false && resultadoSending.motivoFalha === 'STATUS_NAO_FAILED'));
    outboxK.fechar();
    limparArquivosDb(caminhoK);

    const caminhoL = novoCaminhoTemporario();
    const outboxL = new OutboxLocal(caminhoL);
    const eventoRetry = fixtureEvento('SALE_PAID:NEX:20113', '20113');
    await criarItemNoEstado(outboxL, eventoRetry, ESTADOS.RETRY, { httpStatus: null, result: 'ERROR' });
    const resultadoRetry = await executarReabertura({ eventId: eventoRetry.eventId, motivo: 'teste', dbPath: caminhoL, confirmar: confirmarFixo('REABRIR') });
    marcar(check('L. RETRY bloqueado (STATUS_NAO_FAILED)', resultadoRetry.sucesso === false && resultadoRetry.motivoFalha === 'STATUS_NAO_FAILED'));
    outboxL.fechar();
    limparArquivosDb(caminhoL);
  }

  // --- M/N. motivo ausente/vazio bloqueado ---
  {
    const resultadoAusente = await executarReabertura({ eventId: 'SALE_PAID:NEX:99999' });
    marcar(check('M. motivo ausente bloqueado (MOTIVO_OBRIGATORIO)', resultadoAusente.sucesso === false && resultadoAusente.motivoFalha === 'MOTIVO_OBRIGATORIO'));

    const resultadoVazio = await executarReabertura({ eventId: 'SALE_PAID:NEX:99999', motivo: '   ' });
    marcar(check('N. motivo vazio bloqueado (MOTIVO_OBRIGATORIO)', resultadoVazio.sucesso === false && resultadoVazio.motivoFalha === 'MOTIVO_OBRIGATORIO'));
  }

  // --- O/P. eventId ausente/inexistente bloqueado ---
  {
    const resultadoAusente = await executarReabertura({ motivo: 'teste' });
    marcar(check('O. eventId ausente bloqueado (EVENT_ID_OBRIGATORIO)', resultadoAusente.sucesso === false && resultadoAusente.motivoFalha === 'EVENT_ID_OBRIGATORIO'));

    const caminho = novoCaminhoTemporario();
    new OutboxLocal(caminho).fechar();
    const resultadoInexistente = await executarReabertura({ eventId: 'SALE_PAID:NEX:INEXISTENTE', motivo: 'teste', dbPath: caminho, confirmar: confirmarFixo('REABRIR') });
    marcar(check('P. eventId inexistente bloqueado (EVENT_ID_NAO_ENCONTRADO)', resultadoInexistente.sucesso === false && resultadoInexistente.motivoFalha === 'EVENT_ID_NAO_ENCONTRADO'));
    limparArquivosDb(caminho);
  }

  // --- Q/R/S. confirmacao errada cancela; confirmacao correta altera so 1 item ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const eventoAlvo = fixtureEvento('SALE_PAID:NEX:20201', '20201');
    const eventoOutro = fixtureEvento('DEBT_CREATED:NEX:20202', '20202', 'DEBT_CREATED');
    await criarItemNoEstado(outbox, eventoAlvo, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    await criarItemNoEstado(outbox, eventoOutro, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    const outroAntes = await outbox.buscarPorEventId(eventoOutro.eventId);
    outbox.fechar();

    const resultadoCancelado = await executarReabertura({ eventId: eventoAlvo.eventId, motivo: 'teste', dbPath: caminho, confirmar: confirmarFixo('nao') });
    marcar(check('Q. confirmacao errada cancela sem mutacao', resultadoCancelado.sucesso === false && resultadoCancelado.cancelado === true));
    const alvoAposCancelar = await new OutboxLocal(caminho).buscarPorEventId(eventoAlvo.eventId);
    marcar(check('Q. item permanece FAILED apos cancelamento', alvoAposCancelar.status === ESTADOS.FAILED));

    const resultadoOk = await executarReabertura({ eventId: eventoAlvo.eventId, motivo: 'teste', dbPath: caminho, confirmar: confirmarFixo('REABRIR') });
    marcar(check('R. confirmacao correta altera exatamente esse item', resultadoOk.sucesso === true && resultadoOk.depois.status === ESTADOS.PENDING));

    const outroDepois = await new OutboxLocal(caminho).buscarPorEventId(eventoOutro.eventId);
    marcar(check('S. outro item permanece intocado', JSON.stringify(outroDepois) === JSON.stringify(outroAntes)));

    limparArquivosDb(caminho);
  }

  // --- T/U/V/W. preservacao total ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:20301', '20301');
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    const antes = await outbox.buscarPorEventId(evento.eventId);
    outbox.fechar();

    const resultado = await executarReabertura({ eventId: evento.eventId, motivo: 'teste', dbPath: caminho, confirmar: confirmarFixo('REABRIR') });
    marcar(check('T. eventId preservado', resultado.depois.eventId === antes.eventId));
    marcar(check('U. contentHash preservado', resultado.depois.contentHash === antes.contentHash));
    marcar(check('W. tentativas preservadas ate claimNext', resultado.depois.tentativas === antes.tentativas));

    const outboxDepois = new OutboxLocal(caminho);
    const itemCompleto = await outboxDepois.buscarPorEventId(evento.eventId);
    marcar(check('V. payload preservado', JSON.stringify(itemCompleto.payload) === JSON.stringify(antes.payload)));

    const reclamado = await outboxDepois.claimNext();
    marcar(check('W. claimNext incrementa tentativas ao reclamar (nao antes)', reclamado.tentativas === antes.tentativas + 1));
    outboxDepois.fechar();

    limparArquivosDb(caminho);
  }

  // --- X/Y. sourceStatus REVIEW_REQUIRED preservado e exibido ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:20401', '20401', 'SALE_PAID', 'REVIEW_REQUIRED');
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    outbox.fechar();

    const logs = [];
    const resultado = await executarReabertura({
      eventId: evento.eventId, motivo: 'teste', dbPath: caminho, confirmar: confirmarFixo('REABRIR'), log: (...a) => logs.push(a.join(' ')),
    });
    marcar(check('X. sourceStatus REVIEW_REQUIRED preservado apos reabertura', resultado.depois.sourceStatus === 'REVIEW_REQUIRED'));
    marcar(check('Y. sourceStatus aparece no BEFORE quando presente', logs.some((l) => l.includes('REVIEW_REQUIRED'))));

    limparArquivosDb(caminho);
  }

  // --- Z. eventType aparece no BEFORE ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEvento('DEBT_PAYMENT:NEX:20501', '20501', 'DEBT_PAYMENT');
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    outbox.fechar();

    const logs = [];
    await executarReabertura({
      eventId: evento.eventId, motivo: 'teste', dbPath: caminho, confirmar: confirmarFixo('REABRIR'), log: (...a) => logs.push(a.join(' ')),
    });
    marcar(check('Z. eventType aparece no BEFORE', logs.some((l) => l.includes('DEBT_PAYMENT'))));

    limparArquivosDb(caminho);
  }

  // --- AA. aviso forte aparece antes da confirmacao ---
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);
    const evento = fixtureEvento('SALE_PAID:NEX:20601', '20601');
    await criarItemNoEstado(outbox, evento, ESTADOS.FAILED, { httpStatus: 401, result: 'ERROR' });
    outbox.fechar();

    const logs = [];
    await executarReabertura({
      eventId: evento.eventId, motivo: 'teste', dbPath: caminho, confirmar: confirmarFixo('REABRIR'), log: (...a) => logs.push(a.join(' ')),
    });
    marcar(check('AA. aviso forte aparece antes da confirmacao', logs.some((l) => l.includes(AVISO_FORTE))));

    limparArquivosDb(caminho);
  }

  // --- AB/AC. zero rede, zero referencia direta a checkpoint ---
  {
    const codigoFonte = fs.readFileSync(path.join(__dirname, '..', 'SCRIPTS', 'reabrir-evento-failed.js'), 'utf8');
    marcar(check('AB. CLI nao referencia fetch/http/https em nenhuma linha (zero rede)', !/\bfetch\(|require\(['"]https?['"]\)/.test(codigoFonte)));
    marcar(check('AC. CLI nunca importa/chama CheckpointSqlite diretamente', !/CheckpointSqlite|checkpoint-sqlite/.test(codigoFonte)));
    marcar(check('AB/AC. CLI nunca imprime "payload" bruto (so resumoSemPayload)', !/console\.log\([^)]*payload[^)]*JSON\.stringify\(item/.test(codigoFonte)));
    marcar(check('CLI reutiliza EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO do orquestrador (nao duplica a lista)', /require\(path\.join\(__dirname, '\.\.', 'SERVICO', 'orquestrador-integracao-nex'\)\)/.test(codigoFonte)));
    marcar(check('Allowlist contem exatamente os 5 eventTypes esperados', JSON.stringify([...EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO].sort()) === JSON.stringify(['DEBT_CREATED', 'DEBT_PAYMENT', 'SALE_CANCELLED', 'SALE_PAID', 'SALE_PARTIALLY_PAID'])));
  }

  console.log('');
  console.log('Resultado geral teste-cli-reabrir-evento-failed.js: ' + (totalFalhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${totalFalhas} FALHA(S)`));
  if (totalFalhas > 0) process.exitCode = 1;
}

main().catch((erro) => {
  console.error('Erro inesperado no teste:', erro);
  process.exitCode = 1;
});
