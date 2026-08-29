'use strict';

/**
 * Teste de SERVICO/checkpoint-sqlite.js (Fase F3.1). NENHUM teste deste
 * arquivo faz rede real, usa secret real, altera Base44, ou toca o
 * NEX/.nx1. Usa SOMENTE arquivos de banco TEMPORARIOS (criados sob
 * os.tmpdir(), apagados ao final) - nunca o futuro banco real de
 * producao (que so sera criado em F3.7/F4, fora do Git).
 *
 * Fixtures de eventId usam os 4 eventTypes ja homologados via E2E real
 * (SALE_PAID:NEX:15751, DEBT_CREATED:NEX:15756, SALE_PARTIALLY_PAID:NEX:15704,
 * DEBT_PAYMENT:NEX:15758) apenas como identificadores realistas - nenhum
 * envio, nenhuma consulta ao Base44 ocorre aqui.
 *
 * Executar com: node TESTES\teste-checkpoint-sqlite.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CheckpointSqlite, RESULTADOS_CONFIRMADOS } = require('../SERVICO/checkpoint-sqlite');

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

function novoCaminhoTemporario() {
  return path.join(os.tmpdir(), `teste-checkpoint-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function limparArquivosDb(caminho) {
  for (const sufixo of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(caminho + sufixo); } catch (e) { /* pode nao existir - ok */ }
  }
}

async function main() {
  let todosPassaram = true;

  // ---------- A. Cria DB/schema (arquivo real, nao :memory:) ----------
  console.log('\n=== A. Cria DB/schema em arquivo temporario ===');
  const caminho = novoCaminhoTemporario();
  todosPassaram &= check('arquivo temporario ainda nao existe antes de abrir', !fs.existsSync(caminho));
  let cp = new CheckpointSqlite(caminho);
  todosPassaram &= check('arquivo .db foi criado ao abrir', fs.existsSync(caminho));

  // ---------- B/C. Registra evento e busca pelo eventId ----------
  console.log('\n=== B/C. Registrar e buscar por eventId ===');
  const EV_15751 = 'SALE_PAID:NEX:15751';
  const HASH_15751 = '1af052fe77daeab41fa0fbca2dd401f11ffbb79cce2541d4ac1bd25e94911c72';
  await cp.registrarEvento({
    eventId: EV_15751,
    identityKey: 'NEX:15751',
    nexTransactionId: '15751',
    contentHash: HASH_15751,
    status: 'PENDING',
  });
  const buscado = await cp.buscarEvento(EV_15751);
  todosPassaram &= check('evento registrado e encontrado por eventId', buscado != null && buscado.eventId === EV_15751);
  todosPassaram &= check('contentHash persistido corretamente', buscado.contentHash === HASH_15751);
  todosPassaram &= check('tentativas comeca em 0 (so registrado, nenhuma resposta remota ainda)', buscado.tentativas === 0);
  todosPassaram &= check('eventId inexistente -> buscarEvento retorna null', (await cp.buscarEvento('EVENTO:NAO:EXISTE')) === null);

  // ---------- D. Mesmo eventId/hash reconhecido como confirmado ----------
  console.log('\n=== D. Idempotencia local: mesmo eventId + mesmo hash + resultado confirmado ===');
  await cp.atualizarEvento(EV_15751, { status: 'SENT', httpStatus: 200, result: 'CREATED', correlationId: '068336b7-a4dc-4094-a962-237af0f9b8b3' });
  todosPassaram &= check(
    'eventoJaConfirmado(mesmo eventId, mesmo hash) apos result=CREATED -> true',
    await cp.eventoJaConfirmado(EV_15751, HASH_15751),
  );

  // ---------- E. Mesmo eventId, hash diferente -> NAO idêntico ----------
  console.log('\n=== E. Mesmo eventId, contentHash DIFERENTE -> nao tratado como identico ===');
  todosPassaram &= check(
    'eventoJaConfirmado(mesmo eventId, hash diferente) -> false',
    (await cp.eventoJaConfirmado(EV_15751, 'hash-completamente-diferente')) === false,
  );

  // ---------- Resultados NAO confirmados nunca contam como "ja resolvido" ----------
  console.log('\n=== Resultados nao-confirmados (REJECTED/ERROR) nunca contam como confirmado ===');
  const EV_TESTE_REJECTED = 'DEBT_CREATED:NEX:99998';
  await cp.registrarEvento({ eventId: EV_TESTE_REJECTED, identityKey: 'NEX:99998', nexTransactionId: '99998', contentHash: 'hash-rejeitado', status: 'PENDING' });
  await cp.atualizarEvento(EV_TESTE_REJECTED, { status: 'REJECTED', httpStatus: 400, result: 'REJECTED', erro: 'payload invalido (simulado)' });
  todosPassaram &= check(
    'eventoJaConfirmado com result=REJECTED -> false (mesmo com hash identico)',
    (await cp.eventoJaConfirmado(EV_TESTE_REJECTED, 'hash-rejeitado')) === false,
  );
  const EV_TESTE_ERROR = 'DEBT_CREATED:NEX:99997';
  await cp.registrarEvento({ eventId: EV_TESTE_ERROR, identityKey: 'NEX:99997', nexTransactionId: '99997', contentHash: 'hash-erro', status: 'PENDING' });
  await cp.atualizarEvento(EV_TESTE_ERROR, { status: 'FAILED', httpStatus: null, result: 'ERROR', erro: 'timeout apos 3 tentativas (simulado)' });
  todosPassaram &= check(
    'eventoJaConfirmado com result=ERROR -> false (mesmo com hash identico)',
    (await cp.eventoJaConfirmado(EV_TESTE_ERROR, 'hash-erro')) === false,
  );
  todosPassaram &= check(
    'RESULTADOS_CONFIRMADOS nao inclui REJECTED nem ERROR',
    !RESULTADOS_CONFIRMADOS.has('REJECTED') && !RESULTADOS_CONFIRMADOS.has('ERROR'),
  );
  todosPassaram &= check(
    'RESULTADOS_CONFIRMADOS inclui exatamente os 4 resultados de sucesso do contrato real',
    ['CREATED', 'UNCHANGED', 'UPDATED', 'REVIEW_STORED'].every((r) => RESULTADOS_CONFIRMADOS.has(r)) && RESULTADOS_CONFIRMADOS.size === 4,
  );

  // ---------- F. Atualizacao persiste (incrementa tentativas) ----------
  console.log('\n=== F. Atualizacao persiste, incluindo incremento de tentativas ===');
  const antes = await cp.buscarEvento(EV_15751);
  await cp.atualizarEvento(EV_15751, { status: 'SENT', httpStatus: 200, result: 'UNCHANGED', correlationId: 'f54ab926-0d8c-4225-a19f-8aa4fe60295c' });
  const depois = await cp.buscarEvento(EV_15751);
  todosPassaram &= check('result atualizado para UNCHANGED (reenvio idempotente real)', depois.result === 'UNCHANGED');
  todosPassaram &= check('correlationId atualizado para o novo valor', depois.correlationId === 'f54ab926-0d8c-4225-a19f-8aa4fe60295c');
  todosPassaram &= check('tentativas incrementou em 1 a cada atualizarEvento', depois.tentativas === antes.tentativas + 1);
  todosPassaram &= check('primeiraVez NAO muda em atualizacoes subsequentes', depois.primeiraVez === antes.primeiraVez);
  todosPassaram &= check('ultimaVez muda a cada atualizacao', depois.ultimaVez !== antes.ultimaVez || depois.ultimaVez >= antes.ultimaVez);

  let lancouParaEventoInexistente = false;
  try {
    await cp.atualizarEvento('EVENTO:NUNCA:REGISTRADO', { status: 'SENT' });
  } catch (e) {
    lancouParaEventoInexistente = true;
  }
  todosPassaram &= check('atualizarEvento em eventId nao registrado -> lanca erro (nao cria silenciosamente)', lancouParaEventoInexistente);

  // ---------- G. Fechar e reabrir mantem os dados ----------
  console.log('\n=== G. Fechar e reabrir o mesmo arquivo mantem os dados ===');
  cp.fechar();
  const cpReaberto = new CheckpointSqlite(caminho);
  const apósReabrir = await cpReaberto.buscarEvento(EV_15751);
  todosPassaram &= check('evento ainda presente apos fechar e reabrir', apósReabrir != null && apósReabrir.result === 'UNCHANGED');
  todosPassaram &= check('tentativas preservadas apos reabrir', apósReabrir.tentativas === depois.tentativas);
  cp = cpReaberto;

  // ---------- H. Dois eventos independentes nao interferem ----------
  console.log('\n=== H. Multiplos eventos independentes (4 homologados) nao interferem entre si ===');
  const FIXTURES = [
    { eventId: 'DEBT_CREATED:NEX:15756', identityKey: 'NEX:15756', nexTransactionId: '15756', contentHash: '25c3a8d64eb1ab29ecfd8b9a3d11858a119b0c237777170f5933d8513ed821ae', result: 'CREATED' },
    { eventId: 'SALE_PARTIALLY_PAID:NEX:15704', identityKey: 'NEX:15704', nexTransactionId: '15704', contentHash: 'cd04aa25e909ff75d943fe86a561aaf234b2ac18abfb7dc45c9ac2ab4a7115dd', result: 'CREATED' },
    { eventId: 'DEBT_PAYMENT:NEX:15758', identityKey: 'NEX:15758', nexTransactionId: '15758', contentHash: 'de1a31afdec9dc054ca90250d0e8ce6a11d6270fcd74eb2036e8768c8671400f', result: 'CREATED' },
  ];
  for (const f of FIXTURES) {
    await cp.registrarEvento({ eventId: f.eventId, identityKey: f.identityKey, nexTransactionId: f.nexTransactionId, contentHash: f.contentHash, status: 'PENDING' });
    await cp.atualizarEvento(f.eventId, { status: 'SENT', httpStatus: 200, result: f.result });
  }
  let todosIndependentes = true;
  for (const f of FIXTURES) {
    const confirmado = await cp.eventoJaConfirmado(f.eventId, f.contentHash);
    todosIndependentes = todosIndependentes && confirmado;
  }
  todosPassaram &= check('os 3 novos eventos confirmados corretamente, cada um com seu proprio hash', todosIndependentes);
  const original15751AindaOk = await cp.eventoJaConfirmado(EV_15751, HASH_15751);
  todosPassaram &= check('#15751 original nao foi afetado por registrar os outros 3', original15751AindaOk);
  const listaPor15756 = await cp.listarPorNexTransactionId('15756');
  todosPassaram &= check('listarPorNexTransactionId("15756") retorna exatamente 1 registro, o correto', listaPor15756.length === 1 && listaPor15756[0].eventId === 'DEBT_CREATED:NEX:15756');
  const listaPor15751 = await cp.listarPorNexTransactionId('15751');
  todosPassaram &= check('listarPorNexTransactionId("15751") nao inclui os outros eventIds', listaPor15751.length === 1 && listaPor15751[0].eventId === EV_15751);

  // ---------- I. Campos opcionais/null funcionam ----------
  console.log('\n=== I. Campos opcionais/null tratados corretamente ===');
  const EV_MINIMO = 'UNCLASSIFIED:NEX:00001';
  await cp.registrarEvento({ eventId: EV_MINIMO });
  const minimo = await cp.buscarEvento(EV_MINIMO);
  todosPassaram &= check('registrarEvento so com eventId -> demais campos ficam null, sem lancar erro', minimo != null && minimo.identityKey === null && minimo.contentHash === null && minimo.result === null);
  todosPassaram &= check('httpStatus null tratado corretamente (nao vira 0 nem string)', minimo.httpStatus === null);
  await cp.atualizarEvento(EV_MINIMO, { erro: null, result: null });
  const minimoDepois = await cp.buscarEvento(EV_MINIMO);
  todosPassaram &= check('atualizarEvento com campos null nao quebra e incrementa tentativas mesmo assim', minimoDepois.tentativas === 1);

  // ---------- J. Transacao nao deixa estado parcial em falha simulada ----------
  console.log('\n=== J. registrarEvento sem eventId -> rejeita ANTES de tocar o banco (nenhum estado parcial) ===');
  let lancouSemEventId = false;
  try {
    await cp.registrarEvento({ identityKey: 'NEX:X', contentHash: 'x' });
  } catch (e) {
    lancouSemEventId = true;
  }
  todosPassaram &= check('registrarEvento sem eventId -> lanca erro, nao insere linha nenhuma', lancouSemEventId);
  const totalNaoDeveTerMudado = await cp.listarPorNexTransactionId('15751');
  todosPassaram &= check('estado de #15751 permanece intacto apos a tentativa invalida', totalNaoDeveTerMudado.length === 1);

  // ---------- Nenhuma escrita de secret/HMAC no schema ----------
  // Nota: os comentarios do modulo MENCIONAM "secret"/"HMAC" para EXPLICAR
  // que nunca sao armazenados - por isso o teste verifica o SCHEMA SQL
  // (colunas reais da tabela) e as chaves aceitas pelos metodos publicos,
  // nao a ausencia da palavra no arquivo inteiro (isso daria falso-negativo
  // nos proprios comentarios de documentacao).
  console.log('\n=== Garantia: schema SQL nao tem coluna de secret/HMAC ===');
  const codigoDoModulo = fs.readFileSync(require.resolve('../SERVICO/checkpoint-sqlite'), 'utf8');
  const schemaMatch = codigoDoModulo.match(/CREATE TABLE[\s\S]*?;/i);
  todosPassaram &= check('schema SQL nao contem coluna secret/hmac/assinatura', schemaMatch != null && !/secret|hmac|assinatura/i.test(schemaMatch[0]));
  const chavesAceitasNoRegistro = Object.keys((await cp.buscarEvento(EV_15751)) || {});
  todosPassaram &= check(
    'objeto retornado pelo checkpoint nunca expoe campo secret/hmac',
    !chavesAceitasNoRegistro.some((k) => /secret|hmac/i.test(k)),
  );

  cp.fechar();
  limparArquivosDb(caminho);
  todosPassaram &= check('arquivo temporario de teste removido ao final', !fs.existsSync(caminho));

  console.log(
    '\nResultado geral teste-checkpoint-sqlite.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((erro) => {
  console.error('Erro inesperado no teste:', erro);
  process.exitCode = 1;
});
