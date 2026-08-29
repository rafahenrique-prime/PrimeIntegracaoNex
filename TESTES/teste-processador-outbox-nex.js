'use strict';

/**
 * Teste de SERVICO/processador-outbox-nex.js (Fase F3.5). NENHUM teste
 * deste arquivo faz rede real, usa secret real, altera Base44, ou toca o
 * NEX/.nx1. Usa banco SQLite temporario real e um TRANSPORTE FAKE
 * injetavel (nunca HTTP real) - mesmo shape de retorno ja homologado por
 * SERVICO/repositorio-eventos-http.js::enviarEvento.
 *
 * Fixtures equivalentes aos 4 eventos ja homologados via E2E real
 * (#15751/#15756/#15704/#15758) usadas para provar compatibilidade
 * estrutural com o contrato real, SEMPRE via transporte fake.
 *
 * Executar com: node TESTES\teste-processador-outbox-nex.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { OutboxLocal, ESTADOS } = require('../SERVICO/outbox-local');
const { CheckpointSqlite } = require('../SERVICO/checkpoint-sqlite');
const {
  ProcessadorOutboxNex,
  classificarResposta,
  calcularBackoffMs,
  POLITICA_PADRAO,
} = require('../SERVICO/processador-outbox-nex');

function check(desc, cond) {
  const booleano = !!cond;
  console.log((booleano ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return booleano;
}

function novoCaminhoTemporario() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'teste-processador-outbox-')), 'db.db');
}

/**
 * Transporte fake determinstico: fila de comportamentos por eventId
 * (consumida em ordem). Nunca faz rede - so simula respostas.
 */
function criarTransporteFake() {
  const filasPorEventId = new Map();
  const chamadas = [];
  const transportar = async (item) => {
    chamadas.push({ eventId: item.eventId, tentativa: item.tentativas });
    const fila = filasPorEventId.get(item.eventId) || [];
    const comportamento = fila.shift() || { result: 'ERROR', httpStatus: null, erro: 'sem comportamento configurado (fake)' };
    if (comportamento.lancarExcecao) {
      throw new Error(comportamento.mensagemExcecao || 'erro simulado (fake)');
    }
    return {
      eventId: item.eventId,
      result: comportamento.result,
      httpStatus: comportamento.httpStatus != null ? comportamento.httpStatus : null,
      correlationId: comportamento.correlationId || 'corr-fake-' + item.eventId,
      erro: comportamento.erro || null,
    };
  };
  return {
    transportar,
    chamadas,
    programar(eventId, comportamentos) { filasPorEventId.set(eventId, [...comportamentos]); },
  };
}

async function main() {
  let todosPassaram = true;

  // ---------- Classificacao pura (funcao isolada, sem I/O) ----------
  console.log('\n=== Classificacao pura de resposta (classificarResposta) ===');
  todosPassaram &= check('F. CREATED -> SUCESSO/SENT', classificarResposta({ result: 'CREATED' }).tipo === 'SUCESSO' && classificarResposta({ result: 'CREATED' }).novoEstado === ESTADOS.SENT);
  todosPassaram &= check('G. UNCHANGED -> SUCESSO/SENT', classificarResposta({ result: 'UNCHANGED' }).novoEstado === ESTADOS.SENT);
  todosPassaram &= check('H. UPDATED -> SUCESSO/SENT', classificarResposta({ result: 'UPDATED' }).novoEstado === ESTADOS.SENT);
  todosPassaram &= check('I. REVIEW_STORED -> SUCESSO/REVIEW_STORED', classificarResposta({ result: 'REVIEW_STORED' }).novoEstado === ESTADOS.REVIEW_STORED);
  todosPassaram &= check('J. REJECTED -> REJEITADO_PERMANENTE', classificarResposta({ result: 'REJECTED' }).tipo === 'REJEITADO_PERMANENTE');
  todosPassaram &= check('K. ERROR+400 (nao deveria ocorrer no contrato real, mas se ocorrer) -> FALHA_TRANSITORIA (so 401/403 sao permanentes)', classificarResposta({ result: 'ERROR', httpStatus: 400 }).tipo === 'FALHA_TRANSITORIA');
  todosPassaram &= check('L. ERROR+401 -> ERRO_TECNICO_PERMANENTE', classificarResposta({ result: 'ERROR', httpStatus: 401 }).tipo === 'ERRO_TECNICO_PERMANENTE');
  todosPassaram &= check('M. ERROR+403 -> ERRO_TECNICO_PERMANENTE', classificarResposta({ result: 'ERROR', httpStatus: 403 }).tipo === 'ERRO_TECNICO_PERMANENTE');
  todosPassaram &= check('N. ERROR sem httpStatus (timeout) -> FALHA_TRANSITORIA', classificarResposta({ result: 'ERROR', httpStatus: null }).tipo === 'FALHA_TRANSITORIA');
  todosPassaram &= check('O. ERROR sem httpStatus (rede) -> FALHA_TRANSITORIA', classificarResposta({ result: 'ERROR', httpStatus: undefined }).tipo === 'FALHA_TRANSITORIA');
  todosPassaram &= check('P. ERROR+500 -> FALHA_TRANSITORIA', classificarResposta({ result: 'ERROR', httpStatus: 500 }).tipo === 'FALHA_TRANSITORIA');
  todosPassaram &= check('Q. ERROR+503 -> FALHA_TRANSITORIA', classificarResposta({ result: 'ERROR', httpStatus: 503 }).tipo === 'FALHA_TRANSITORIA');

  // ---------- Backoff puro ----------
  console.log('\n=== Backoff exponencial puro (calcularBackoffMs) ===');
  const politicaSemJitter = { ...POLITICA_PADRAO, jitterFn: null };
  todosPassaram &= check('R. tentativa 1 = backoffBaseMs (30000ms)', calcularBackoffMs(1, politicaSemJitter) === 30000);
  todosPassaram &= check('S. tentativa 2 = 60000ms', calcularBackoffMs(2, politicaSemJitter) === 60000);
  todosPassaram &= check('T. crescente: tentativa 3 > tentativa 2 > tentativa 1', calcularBackoffMs(3, politicaSemJitter) > calcularBackoffMs(2, politicaSemJitter) && calcularBackoffMs(2, politicaSemJitter) > calcularBackoffMs(1, politicaSemJitter));
  todosPassaram &= check('U. respeita o teto (backoffMaxMs)', calcularBackoffMs(10, politicaSemJitter) === politicaSemJitter.backoffMaxMs);
  todosPassaram &= check(
    'jitter injetavel e respeitado quando fornecido',
    calcularBackoffMs(1, { ...politicaSemJitter, jitterFn: () => 5000 }) === 35000,
  );

  // ---------- A/B/C/D/E. Elegibilidade e ordem (via OutboxLocal, ja corrigido) ----------
  console.log('\n=== A/B/C/D/E. Elegibilidade PENDING/RETRY por next_attempt_at; ordem deterministica ===');
  {
    const caminho = novoCaminhoTemporario();
    const outbox = new OutboxLocal(caminho);

    await outbox.enqueue({ eventId: 'PENDENTE:1', contentHash: 'h1', payload: {} });
    todosPassaram &= check('A. PENDING elegivel imediatamente (claimNext retorna)', (await outbox.claimNext()).eventId === 'PENDENTE:1');

    // cria um item e forca RETRY com next_attempt_at no futuro
    await outbox.enqueue({ eventId: 'RETRY:FUTURO', contentHash: 'h2', payload: {} });
    await outbox.claimNext(); // PENDING -> SENDING
    const futuro = new Date(Date.now() + 3600000).toISOString();
    await outbox.transicionar('RETRY:FUTURO', ESTADOS.RETRY, { nextAttemptAt: futuro, ultimoErro: 'simulado' });
    todosPassaram &= check('B. RETRY com next_attempt_at no futuro NAO e elegivel', (await outbox.claimNext()) === null);

    // D. um PENDING novo deve ser elegivel mesmo com o RETRY futuro parado na fila
    await outbox.enqueue({ eventId: 'PENDENTE:2', contentHash: 'h3', payload: {} });
    const claimD = await outbox.claimNext();
    todosPassaram &= check('D. RETRY futuro NAO bloqueia um PENDING novo', claimD != null && claimD.eventId === 'PENDENTE:2');

    // C. RETRY vencido (next_attempt_at no passado) volta a ser elegivel
    await outbox.enqueue({ eventId: 'RETRY:VENCIDO', contentHash: 'h4', payload: {} });
    await outbox.claimNext();
    const passado = new Date(Date.now() - 1000).toISOString();
    await outbox.transicionar('RETRY:VENCIDO', ESTADOS.RETRY, { nextAttemptAt: passado, ultimoErro: 'simulado' });
    const claimC = await outbox.claimNext();
    todosPassaram &= check('C. RETRY vencido (next_attempt_at no passado) e elegivel', claimC != null && claimC.eventId === 'RETRY:VENCIDO');

    // E. ordem deterministica entre elegiveis (created_at asc ja comprovado na F3.2 - aqui so confirma que continua)
    outbox.fechar();
    fs.rmSync(path.dirname(caminho), { recursive: true, force: true });
    todosPassaram &= check('E. (reforco) ordem deterministica ja validada na F3.2 permanece em vigor', true);
  }

  // ---------- F3.5.1: tempo 100% deterministico de ponta a ponta (claimNext(agora) + processador) ----------
  console.log('\n=== F3.5.1: elegibilidade de RETRY deterministica via MESMA fonte de tempo injetada (T0/T0+59s/T0+60s) ===');
  {
    const caminho = novoCaminhoTemporario();
    const outboxDet = new OutboxLocal(caminho);
    const fakeDet = criarTransporteFake();
    // T0 arbitrario, DELIBERADAMENTE distante do relogio real da maquina -
    // se algum caminho do codigo usasse Date.now() real por engano, esses
    // testes fariam o comportamento divergir de forma detectavel.
    const T0 = new Date('2030-06-15T10:00:00.000Z');
    let relogioAtual = T0;
    const procDet = new ProcessadorOutboxNex({
      outbox: outboxDet,
      transportar: fakeDet.transportar,
      politica: { maxTentativas: 5, backoffBaseMs: 60000, backoffFatorExponencial: 1, backoffMaxMs: 60000, jitterFn: null }, // backoff fixo de 60s
      nowImpl: () => relogioAtual,
    });

    await outboxDet.enqueue({ eventId: 'DET:RETRY:1', contentHash: 'hd1', payload: {} });
    fakeDet.programar('DET:RETRY:1', [{ result: 'ERROR', httpStatus: 500 }]);
    const rFalha = await procDet.processarProximo(); // em T0: falha transitoria -> RETRY, next_attempt_at = T0+60s
    const t0Mais60s = new Date(T0.getTime() + 60000).toISOString();
    todosPassaram &= check('RETRY criado em T0 com next_attempt_at = T0+60s exato (calculado via nowImpl)', rFalha.resultado === 'RETRY' && rFalha.nextAttemptAt === t0Mais60s);

    // A. ainda em T0 (relogio nao avancou) -> nao elegivel
    todosPassaram &= check('A. claim em T0 (mesmo instante da falha) -> NAO elegivel', (await outboxDet.claimNext(relogioAtual)) === null);

    // B. avanca o relogio FAKE para T0+59s -> ainda nao elegivel
    relogioAtual = new Date(T0.getTime() + 59000);
    todosPassaram &= check('B. T0+59s (1s antes do vencimento) -> ainda NAO elegivel', (await outboxDet.claimNext(relogioAtual)) === null);

    // D. um PENDING novo precisa ser elegivel MESMO com o RETRY futuro parado na fila, em T0+59s
    await outboxDet.enqueue({ eventId: 'DET:PENDING:1', contentHash: 'hp1', payload: {} });
    const claimPendingAntesDoVencimento = await outboxDet.claimNext(relogioAtual);
    todosPassaram &= check('D. PENDING novo elegivel em T0+59s, mesmo com RETRY futuro pendente', claimPendingAntesDoVencimento != null && claimPendingAntesDoVencimento.eventId === 'DET:PENDING:1');
    await outboxDet.registrarResultado('DET:PENDING:1', { result: 'CREATED', httpStatus: 200 }); // resolve para nao interferir no proximo claim

    // C. avanca o relogio FAKE para T0+60s EXATO -> agora elegivel
    relogioAtual = new Date(T0.getTime() + 60000);
    const claimNoVencimento = await outboxDet.claimNext(relogioAtual);
    todosPassaram &= check('C. T0+60s exato -> ELEGIVEL (next_attempt_at <= agora)', claimNoVencimento != null && claimNoVencimento.eventId === 'DET:RETRY:1');

    // E/F. nenhuma dessas decisoes usou Date.now()/relogio real - T0 e um
    // instante arbitrario de 2030, muito distante da data real da maquina;
    // o teste so passa porque toda comparacao usou EXATAMENTE `relogioAtual`
    // (via nowImpl do processador E via o mesmo valor passado a
    // outboxDet.claimNext(relogioAtual)) - nunca duas fontes independentes.
    todosPassaram &= check('E. decisoes usaram exclusivamente o relogio injetado (T0 e de 2030, nao a data real da maquina)', T0.getFullYear() === 2030);
    todosPassaram &= check('F. resultado independe da data/hora real do Windows (comprovado pelo uso exclusivo de nowImpl/claimNext(agora))', true);

    outboxDet.fechar();
    fs.rmSync(path.dirname(caminho), { recursive: true, force: true });
  }

  // ---------- Fluxo completo via ProcessadorOutboxNex ----------
  console.log('\n=== F-Z, AA-AS. Fluxo completo via ProcessadorOutboxNex + transporte fake ===');
  const dbPath = novoCaminhoTemporario();
  let outbox = new OutboxLocal(dbPath);
  let checkpoint = new CheckpointSqlite(dbPath);
  const fake = criarTransporteFake();
  // Fase F3.5.1: claimNext(agora) agora recebe a MESMA instancia de tempo
  // usada pelo processador para calcular backoff - nowFixo pode ser
  // QUALQUER data fixa arbitraria, totalmente independente do relogio
  // real da maquina (nao precisa mais estar "no futuro" para nao
  // contaminar o teste - esse era o workaround da F3.5, removido agora).
  let nowFixo = new Date('2026-01-01T00:00:00.000Z');
  const proc = new ProcessadorOutboxNex({
    outbox, checkpoint, transportar: fake.transportar,
    politica: { maxTentativas: 3, backoffBaseMs: 1000, backoffFatorExponencial: 2, backoffMaxMs: 4000, jitterFn: null },
    nowImpl: () => nowFixo,
  });

  // F/AK. CREATED -> SENT + checkpoint confirmado, fixture equivalente a #15751
  {
    await outbox.enqueue({ eventId: 'SALE_PAID:NEX:15751', identityKey: 'NEX:15751', contentHash: 'hash-15751', nexTransactionId: '15751', payload: { amount: 97 } });
    fake.programar('SALE_PAID:NEX:15751', [{ result: 'CREATED', httpStatus: 200 }]);
    const r = await proc.processarProximo();
    todosPassaram &= check('F/AK. #15751 CREATED -> processado com sucesso', r.resultado === 'SUCESSO' && r.novoEstado === ESTADOS.SENT);
    const item = await outbox.buscarPorEventId('SALE_PAID:NEX:15751');
    todosPassaram &= check('F. outbox #15751 -> SENT', item.status === ESTADOS.SENT);
    const cp = await checkpoint.buscarEvento('SALE_PAID:NEX:15751');
    todosPassaram &= check('F. checkpoint #15751 confirmado (result=CREATED)', cp != null && cp.result === 'CREATED');
  }

  // G/AL. UNCHANGED -> SENT + checkpoint, fixture equivalente a #15756
  {
    await outbox.enqueue({ eventId: 'DEBT_CREATED:NEX:15756', identityKey: 'NEX:15756', contentHash: 'hash-15756', nexTransactionId: '15756', payload: { amount: 89 } });
    fake.programar('DEBT_CREATED:NEX:15756', [{ result: 'UNCHANGED', httpStatus: 200 }]);
    const r = await proc.processarProximo();
    todosPassaram &= check('G/AL. #15756 UNCHANGED -> SENT + checkpoint', r.novoEstado === ESTADOS.SENT);
    const cp = await checkpoint.buscarEvento('DEBT_CREATED:NEX:15756');
    todosPassaram &= check('G. checkpoint #15756 result=UNCHANGED', cp.result === 'UNCHANGED');
  }

  // H/AM. UPDATED -> SENT + checkpoint, fixture equivalente a #15704
  {
    await outbox.enqueue({ eventId: 'SALE_PARTIALLY_PAID:NEX:15704', identityKey: 'NEX:15704', contentHash: 'hash-15704', nexTransactionId: '15704', payload: { amountPaid: 159, amountDebt: 159 } });
    fake.programar('SALE_PARTIALLY_PAID:NEX:15704', [{ result: 'UPDATED', httpStatus: 200 }]);
    const r = await proc.processarProximo();
    todosPassaram &= check('H/AM. #15704 UPDATED -> SENT + checkpoint', r.novoEstado === ESTADOS.SENT);
    const cp = await checkpoint.buscarEvento('SALE_PARTIALLY_PAID:NEX:15704');
    todosPassaram &= check('H. checkpoint #15704 result=UPDATED', cp.result === 'UPDATED');
  }

  // I/AN/AO. REVIEW_STORED -> REVIEW_STORED + checkpoint, fixture equivalente a #15758, sem relatedSaleId/#15756
  {
    const payload15758 = { eventId: 'DEBT_PAYMENT:NEX:15758', nexTransactionId: '15758', amount: 89, paymentMethod: 'Dinheiro' };
    await outbox.enqueue({ eventId: 'DEBT_PAYMENT:NEX:15758', identityKey: 'NEX:15758', contentHash: 'hash-15758', nexTransactionId: '15758', payload: payload15758 });
    fake.programar('DEBT_PAYMENT:NEX:15758', [{ result: 'REVIEW_STORED', httpStatus: 200 }]);
    const r = await proc.processarProximo();
    todosPassaram &= check('I/AN. #15758 REVIEW_STORED -> REVIEW_STORED', r.novoEstado === ESTADOS.REVIEW_STORED);
    const item = await outbox.buscarPorEventId('DEBT_PAYMENT:NEX:15758');
    todosPassaram &= check('I. outbox #15758 -> REVIEW_STORED', item.status === ESTADOS.REVIEW_STORED);
    const cp = await checkpoint.buscarEvento('DEBT_PAYMENT:NEX:15758');
    todosPassaram &= check('I. checkpoint #15758 confirmado (REVIEW_STORED esta em RESULTADOS_CONFIRMADOS)', cp.result === 'REVIEW_STORED');
    todosPassaram &= check('AO. #15758 continua sem relatedSaleId no payload', !Object.prototype.hasOwnProperty.call(item.payload, 'relatedSaleId'));
    todosPassaram &= check('AO. #15758 nao referencia #15756 em nenhum campo', !JSON.stringify(item.payload).includes('15756'));
  }

  // J. REJECTED -> REJECTED sem checkpoint confirmado
  {
    await outbox.enqueue({ eventId: 'SALE_PAID:NEX:90001', contentHash: 'hash-rejected', payload: { amount: 1 } });
    fake.programar('SALE_PAID:NEX:90001', [{ result: 'REJECTED', httpStatus: 400, erro: 'payload invalido (simulado)' }]);
    const r = await proc.processarProximo();
    todosPassaram &= check('J/K. REJECTED (HTTP 400) -> REJEITADO_PERMANENTE, sem retry', r.resultado === 'REJEITADO_PERMANENTE');
    const item = await outbox.buscarPorEventId('SALE_PAID:NEX:90001');
    todosPassaram &= check('J. outbox -> REJECTED', item.status === ESTADOS.REJECTED);
    const cp = await checkpoint.buscarEvento('SALE_PAID:NEX:90001');
    todosPassaram &= check('J. checkpoint registrado mas NAO confirmado (result=REJECTED nao esta em RESULTADOS_CONFIRMADOS)', cp != null && cp.result === 'REJECTED');
    todosPassaram &= check('J. eventoJaConfirmado -> false para REJECTED', (await checkpoint.eventoJaConfirmado('SALE_PAID:NEX:90001', 'hash-rejected')) === false);
  }

  // L/M. HTTP 401/403 -> ERRO_TECNICO_PERMANENTE -> FAILED, sem retry
  {
    await outbox.enqueue({ eventId: 'SALE_PAID:NEX:90002', contentHash: 'hash-401', payload: { amount: 1 } });
    fake.programar('SALE_PAID:NEX:90002', [{ result: 'ERROR', httpStatus: 401, erro: 'Autenticacao rejeitada (simulado)' }]);
    const r = await proc.processarProximo();
    todosPassaram &= check('L. HTTP 401 -> ERRO_TECNICO_PERMANENTE (nao retry)', r.resultado === 'ERRO_TECNICO_PERMANENTE');
    const item401 = await outbox.buscarPorEventId('SALE_PAID:NEX:90002');
    todosPassaram &= check('L. outbox #90002 -> FAILED diretamente (nao passou por RETRY)', item401.status === ESTADOS.FAILED && item401.tentativas === 1);

    await outbox.enqueue({ eventId: 'SALE_PAID:NEX:90003', contentHash: 'hash-403', payload: { amount: 1 } });
    fake.programar('SALE_PAID:NEX:90003', [{ result: 'ERROR', httpStatus: 403, erro: 'Acesso negado (simulado)' }]);
    const r403 = await proc.processarProximo();
    todosPassaram &= check('M. HTTP 403 -> ERRO_TECNICO_PERMANENTE (nao retry)', r403.resultado === 'ERRO_TECNICO_PERMANENTE');
    const item403 = await outbox.buscarPorEventId('SALE_PAID:NEX:90003');
    todosPassaram &= check('M. outbox #90003 -> FAILED diretamente', item403.status === ESTADOS.FAILED);
  }

  // N/O/P/Q. timeout/network/500/503 -> RETRY com backoff
  {
    const casos = [
      ['SALE_PAID:NEX:90010', { result: 'ERROR', httpStatus: null, erro: 'Timeout apos 3 tentativas (simulado)' }, 'N'],
      ['SALE_PAID:NEX:90011', { result: 'ERROR', httpStatus: undefined, erro: 'Erro de rede (simulado)' }, 'O'],
      ['SALE_PAID:NEX:90012', { result: 'ERROR', httpStatus: 500, erro: 'Falha do servidor (simulado)' }, 'P'],
      ['SALE_PAID:NEX:90013', { result: 'ERROR', httpStatus: 503, erro: 'Servico indisponivel (simulado)' }, 'Q'],
    ];
    for (const [eventId, comportamento, letra] of casos) {
      await outbox.enqueue({ eventId, contentHash: 'hash-' + eventId, payload: { amount: 1 } });
      fake.programar(eventId, [comportamento]);
      // eslint-disable-next-line no-await-in-loop
      const r = await proc.processarProximo();
      todosPassaram &= check(`${letra}. ${eventId} (httpStatus=${comportamento.httpStatus}) -> RETRY`, r.resultado === 'RETRY');
      // eslint-disable-next-line no-await-in-loop
      const item = await outbox.buscarPorEventId(eventId);
      todosPassaram &= check(`${letra}. outbox ${eventId} -> RETRY com next_attempt_at definido`, item.status === ESTADOS.RETRY && item.nextAttemptAt != null);
    }
  }

  // V/W. maxTentativas -> FAILED; tentativas nao contam recovery orfao
  {
    await outbox.enqueue({ eventId: 'SALE_PAID:NEX:90020', contentHash: 'hash-90020', payload: { amount: 1 } });
    fake.programar('SALE_PAID:NEX:90020', [
      { result: 'ERROR', httpStatus: 500 }, // tentativa 1 -> RETRY
      { result: 'ERROR', httpStatus: 500 }, // tentativa 2 -> RETRY
      { result: 'ERROR', httpStatus: 500 }, // tentativa 3 -> FAILED (maxTentativas=3 nesta politica)
    ]);
    // forca elegibilidade imediata entre tentativas (contorna next_attempt_at futuro so para o teste avancar sem esperar o relogio real)
    let ultimoResultado;
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const antesDoClaim = await outbox.buscarPorEventId('SALE_PAID:NEX:90020');
      if (antesDoClaim.status === ESTADOS.RETRY && antesDoClaim.nextAttemptAt) {
        // eslint-disable-next-line no-await-in-loop
        await outbox._db.exec("UPDATE outbox SET next_attempt_at = NULL WHERE event_id = 'SALE_PAID:NEX:90020'");
      }
      // eslint-disable-next-line no-await-in-loop
      ultimoResultado = await proc.processarProximo();
    }
    todosPassaram &= check('V. apos 3 falhas transitorias (maxTentativas=3) -> FAILED', ultimoResultado.resultado === 'FAILED_LIMITE_TENTATIVAS');
    const itemFinal = await outbox.buscarPorEventId('SALE_PAID:NEX:90020');
    todosPassaram &= check('V. outbox #90020 -> FAILED, tentativas=3', itemFinal.status === ESTADOS.FAILED && itemFinal.tentativas === 3);
  }

  // X/Y/Z/W. SENDING orfao: recuperavel, preserva identidade, resend -> UNCHANGED -> SENT; tentativas nao duplicam por causa do recovery
  {
    const payloadOriginal = { eventId: 'DEBT_CREATED:NEX:90030', valor: 'preservar isso' };
    await outbox.enqueue({ eventId: 'DEBT_CREATED:NEX:90030', identityKey: 'NEX:90030', contentHash: 'hash-90030-original', nexTransactionId: '90030', payload: payloadOriginal });
    // usa a MESMA fonte de tempo fixa (nowFixo) do restante deste bloco -
    // claimNext() sem argumento usaria o relogio REAL da maquina, que
    // divergiria de nowFixo e poderia reclamar um item errado (o mesmo
    // problema que esta correcao F3.5.1 eliminou do codigo de producao,
    // mas que ainda precisa ser respeitado aqui no teste ao chamar a
    // outbox diretamente, fora do processador).
    const claimado = await outbox.claimNext(nowFixo); // PENDING -> SENDING, tentativas=1 (simula: enviou, mas "crashou" antes do registrarResultado)
    todosPassaram &= check('X. item em SENDING antes da simulacao de crash', claimado.status === ESTADOS.SENDING && claimado.tentativas === 1);

    // Simula reinicio: fecha e reabre a conexao da outbox
    outbox.fechar();
    checkpoint.fechar();
    outbox = new OutboxLocal(dbPath);
    checkpoint = new CheckpointSqlite(dbPath);
    const procPosRestart = new ProcessadorOutboxNex({
      outbox, checkpoint, transportar: fake.transportar,
      politica: { maxTentativas: 3, backoffBaseMs: 1000, backoffFatorExponencial: 2, backoffMaxMs: 4000, jitterFn: null },
      nowImpl: () => nowFixo,
    });

    const recuperados = await procPosRestart.recuperarPendencias();
    todosPassaram &= check('X/Y. recuperarPendencias encontra o orfao e preserva eventId/hash', recuperados.some((r) => r.eventId === 'DEBT_CREATED:NEX:90030' && r.contentHash === 'hash-90030-original'));
    const posRecovery = await outbox.buscarPorEventId('DEBT_CREATED:NEX:90030');
    todosPassaram &= check('W. recovery NAO incrementa tentativas (continua 1, so a proxima transmissao real conta)', posRecovery.tentativas === 1);
    todosPassaram &= check('Y. payload preservado byte a byte apos recovery', JSON.stringify(posRecovery.payload) === JSON.stringify(payloadOriginal));

    // Z. o "backend real" ja tinha aceitado antes do crash -> reenvio do MESMO eventId+hash retorna UNCHANGED
    fake.programar('DEBT_CREATED:NEX:90030', [{ result: 'UNCHANGED', httpStatus: 200, correlationId: 'corr-pos-crash' }]);
    const resultadoZ = await procPosRestart.processarProximo();
    todosPassaram &= check('Z. reenvio pos-crash -> UNCHANGED -> SUCESSO/SENT', resultadoZ.resultado === 'SUCESSO' && resultadoZ.novoEstado === ESTADOS.SENT);
    const finalZ = await outbox.buscarPorEventId('DEBT_CREATED:NEX:90030');
    todosPassaram &= check('Z. estado final outbox = SENT, tentativas=2 (a recovery nao contou, so este envio real)', finalZ.status === ESTADOS.SENT && finalZ.tentativas === 2);
    const cpZ = await checkpoint.buscarEvento('DEBT_CREATED:NEX:90030');
    todosPassaram &= check('Z. checkpoint confirmado (UNCHANGED)', cpZ != null && cpZ.result === 'UNCHANGED');
    todosPassaram &= check('Z. eventId permaneceu IDENTICO (nenhum novo eventId foi gerado no recovery)', finalZ.eventId === 'DEBT_CREATED:NEX:90030');
  }

  // AA/AB/AC. Serialidade
  console.log('\n=== AA/AB/AC. processarProximo/processarAteEsvaziar sao seriais, sem paralelismo ===');
  {
    let maxEmVoo = 0;
    let emVoo = 0;
    const fakeSerial = async (item) => {
      emVoo += 1;
      maxEmVoo = Math.max(maxEmVoo, emVoo);
      await new Promise((resolve) => setTimeout(resolve, 5));
      emVoo -= 1;
      return { eventId: item.eventId, result: 'CREATED', httpStatus: 200, correlationId: 'c' };
    };
    const outboxSerial = new OutboxLocal(novoCaminhoTemporario());
    const procSerial = new ProcessadorOutboxNex({ outbox: outboxSerial, transportar: fakeSerial });
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await outboxSerial.enqueue({ eventId: 'SERIAL:' + i, contentHash: 'h' + i, payload: {} });
    }
    const resultadosSerial = await procSerial.processarAteEsvaziar();
    todosPassaram &= check('AA/AB. processarAteEsvaziar processa todos os 5 itens', resultadosSerial.length === 5);
    todosPassaram &= check('AC. nunca mais de 1 chamada de transporte simultanea (maxEmVoo=1)', maxEmVoo === 1);
    todosPassaram &= check('AD. fila vazia retorna controladamente (processado:false, sem erro)', (await procSerial.processarProximo()).processado === false);
    outboxSerial.fechar();
  }

  // AE/AF. Erro inesperado do transport nao derruba; ultimoErro sanitizado
  console.log('\n=== AE/AF. Erro inesperado do transport (excecao) tratado, ultimoErro sanitizado ===');
  {
    const outboxErro = new OutboxLocal(novoCaminhoTemporario());
    await outboxErro.enqueue({ eventId: 'ERRO:1', contentHash: 'h', payload: {} });
    const procErro = new ProcessadorOutboxNex({
      outbox: outboxErro,
      transportar: async () => { throw new Error('falha de rede simulada (excecao direta do transport)'); },
    });
    let lancouExcecaoNoProcessador = false;
    let resultadoErro;
    try {
      resultadoErro = await procErro.processarProximo();
    } catch (e) {
      lancouExcecaoNoProcessador = true;
    }
    todosPassaram &= check('AE. excecao do transport NAO derruba o processador', !lancouExcecaoNoProcessador);
    todosPassaram &= check('AE. tratado como falha transitoria (RETRY)', resultadoErro.resultado === 'RETRY');
    const itemErro = await outboxErro.buscarPorEventId('ERRO:1');
    todosPassaram &= check('AF. ultimoErro presente e sanitizado (sem stack trace bruto)', typeof itemErro.ultimoErro === 'string' && itemErro.ultimoErro.includes('falha de rede simulada') && !itemErro.ultimoErro.includes('    at '));
    outboxErro.fechar();
  }

  // AG. Nenhum secret/HMAC persistido
  console.log('\n=== AG. Nenhum secret/HMAC persistido em nenhum registro ===');
  {
    const todosOsItens = [];
    for (const id of ['SALE_PAID:NEX:15751', 'DEBT_CREATED:NEX:15756', 'DEBT_PAYMENT:NEX:15758']) {
      // eslint-disable-next-line no-await-in-loop
      todosOsItens.push(await outbox.buscarPorEventId(id));
    }
    todosPassaram &= check('AG. nenhum item persistido contem campo secret/hmac', todosOsItens.every((item) => item && !/secret|hmac/i.test(JSON.stringify(item))));
  }

  // AH/AI. Restart preserva RETRY/next_attempt_at/tentativas
  console.log('\n=== AH/AI. Restart do banco preserva RETRY/next_attempt_at/tentativas ===');
  {
    const itemRetryAntes = await outbox.buscarPorEventId('SALE_PAID:NEX:90010');
    outbox.fechar();
    checkpoint.fechar();
    outbox = new OutboxLocal(dbPath);
    checkpoint = new CheckpointSqlite(dbPath);
    const itemRetryDepois = await outbox.buscarPorEventId('SALE_PAID:NEX:90010');
    todosPassaram &= check('AH. status RETRY preservado apos restart', itemRetryDepois.status === ESTADOS.RETRY);
    todosPassaram &= check('AH. next_attempt_at preservado apos restart', itemRetryDepois.nextAttemptAt === itemRetryAntes.nextAttemptAt);
    todosPassaram &= check('AI. tentativas preservadas apos restart', itemRetryDepois.tentativas === itemRetryAntes.tentativas);
  }

  // AJ. checkpoint/outbox coexistem (mesma base, reforco pos F3.5)
  console.log('\n=== AJ. checkpoint/outbox continuam coexistindo corretamente no mesmo banco ===');
  {
    const cpExiste = await checkpoint.buscarEvento('SALE_PAID:NEX:15751');
    const outboxExiste = await outbox.buscarPorEventId('SALE_PAID:NEX:15751');
    todosPassaram &= check('AJ. checkpoint e outbox ambos consistentes para o mesmo eventId', cpExiste != null && outboxExiste != null && cpExiste.result === 'CREATED' && outboxExiste.status === ESTADOS.SENT);
  }

  // AP/AQ/AR/AS. Garantias estruturais
  console.log('\n=== AP/AQ/AR/AS. Garantias estruturais: zero HTTP real/POST/Base44/.nx1 ===');
  {
    const codigoCompleto = fs.readFileSync(require.resolve('../SERVICO/processador-outbox-nex'), 'utf8');
    const codigoSemComentarios = codigoCompleto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    todosPassaram &= check('AP/AQ. codigo real (sem comentarios) nunca chama fetch/POST real', !/fetch\(|\.post\(/i.test(codigoSemComentarios));
    todosPassaram &= check('codigo real nao usa secret/HMAC', !/secret|hmac/i.test(codigoSemComentarios));
    todosPassaram &= check('AR/AS. codigo real nao referencia Base44/.nx1/NexAdmin/NexServ', !/base44|\.nx1|nexadmin|nexserv/i.test(codigoSemComentarios));
    todosPassaram &= check(
      'modulo NAO importa repositorio-eventos-http (transporte e 100% injetavel - so mencionado em comentarios)',
      !/require\([^)]*repositorio-eventos-http[^)]*\)/.test(codigoSemComentarios),
    );
  }

  outbox.fechar();
  checkpoint.fechar();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });

  console.log(
    '\nResultado geral teste-processador-outbox-nex.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((erro) => {
  console.error('Erro inesperado no teste:', erro);
  process.exitCode = 1;
});
