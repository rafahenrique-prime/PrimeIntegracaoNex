'use strict';

/**
 * Teste de SERVICO/repositorio-eventos-http.js (Fase F1A.2).
 * TODOS os testes usam fetch MOCKADO (fetchImpl injetado) - NENHUMA
 * chamada de rede real ocorre neste arquivo, em nenhum cenario.
 * Executar com: node TESTES\teste-repositorio-eventos-http.js
 */

const path = require('path');
const PROJETO = path.join(__dirname, '..');
const {
  criarRepositorioEventosHttp,
  carregarConfiguracaoDeEnv,
  construirCorpoRequisicao,
  construirEventoParaEnvio,
  calcularAssinatura,
} = require(path.join(PROJETO, 'SERVICO', 'repositorio-eventos-http'));
const { normalizarVendaNex } = require(path.join(PROJETO, 'SRC', 'normalizar-venda-nex'));
const { normalizarClienteNex } = require(path.join(PROJETO, 'SRC', 'normalizar-cliente-nex'));
const { criarIndiceClientes } = require(path.join(PROJETO, 'SRC', 'customer-resolver-nex'));
const { gerarEventosDeVenda } = require(path.join(PROJETO, 'SERVICO', 'gerador-eventos-nex'));
const { avaliarGateEnvio } = require(path.join(PROJETO, 'SRC', 'gate-envio-evento-nex'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

const CONFIG_TESTE = {
  endpoint: 'https://exemplo-fake.invalido/functions/webhookNex',
  origin: 'prime-store-udi-nex-01',
  secret: 'segredo-de-teste-nao-e-o-secret-real-jamais-usar-em-producao',
};

function respostaFake(status, corpo) {
  return { status, json: async () => corpo };
}

/**
 * Fabrica um fetchImpl fake que nunca toca a rede. `comportamentos` e uma
 * fila: cada chamada consome o proximo comportamento.
 * Tambem rastreia quantas chamadas ficaram "em voo" simultaneamente.
 */
function criarFetchFake(comportamentos) {
  const fila = comportamentos.slice();
  const chamadas = [];
  let emVoo = 0;
  let maxEmVoo = 0;

  const fake = async (url, opcoes) => {
    emVoo += 1;
    maxEmVoo = Math.max(maxEmVoo, emVoo);
    chamadas.push({ url, opcoes });
    const comportamento = fila.shift() || { tipo: 'erro-rede' };
    try {
      if (comportamento.tipo === 'resposta') {
        return respostaFake(comportamento.status, comportamento.corpo);
      }
      if (comportamento.tipo === 'erro-rede') {
        throw new Error('ECONNREFUSED (simulado - fetch fake, nunca rede real)');
      }
      if (comportamento.tipo === 'timeout') {
        return new Promise((resolve, reject) => {
          if (opcoes.signal) {
            opcoes.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
          // nunca resolve por si so - so via abort do timeout do repository
        });
      }
      throw new Error('comportamento de teste desconhecido');
    } finally {
      emVoo -= 1;
    }
  };

  fake.chamadas = chamadas;
  fake.maxEmVoo = () => maxEmVoo;
  return fake;
}

async function main() {
  let todosPassaram = true;

  // ---------- Fixture real: #15751 SALE_PAID (construcao de payload, SEM ENVIO) ----------
  console.log('\n=== FIXTURE #15751 - construcao de payload (ZERO chamadas HTTP) ===');
  const indice = criarIndiceClientes([normalizarClienteNex({ nome: 'CANELINHA', codigo: '316' })]);
  const v15751 = normalizarVendaNex({
    numero: '15751', tipo: 'Venda', data: '8/28/26', hora: '14:17',
    cliente: 'CANELINHA', valorPago: 'R$ 97.00 ', meioPagto: 'Cartão de Crédito',
  });
  const evento15751 = gerarEventosDeVenda(v15751, indice)[0];
  const gate15751 = avaliarGateEnvio(evento15751);
  todosPassaram &= check('#15751 chega READY_TO_SEND ao gate (pre-condicao da fixture)', gate15751.status === 'READY_TO_SEND');

  const { corpo: corpoFixture, rawBody: rawBodyFixture } = construirCorpoRequisicao(CONFIG_TESTE.origin, gate15751);
  console.log('JSON que SERIA enviado (nenhum POST real foi feito):');
  console.log(rawBodyFixture);
  todosPassaram &= check('origin correto no payload', corpoFixture.origin === 'prime-store-udi-nex-01');
  todosPassaram &= check('batch = 1 (events tem exatamente 1 item)', corpoFixture.events.length === 1);
  todosPassaram &= check('eventId = "SALE_PAID:NEX:15751"', corpoFixture.events[0].eventId === 'SALE_PAID:NEX:15751');
  todosPassaram &= check('occurredAt preservado sem Z artificial', corpoFixture.events[0].occurredAt === '2026-08-28T14:17:00');
  todosPassaram &= check('occurredAtTimezone = America/Sao_Paulo', corpoFixture.events[0].occurredAtTimezone === 'America/Sao_Paulo');
  todosPassaram &= check('nexCustomerCode = "316"', corpoFixture.events[0].nexCustomerCode === '316');
  todosPassaram &= check('sourceStatus = READY_TO_SEND', corpoFixture.events[0].sourceStatus === 'READY_TO_SEND');
  todosPassaram &= check('contentHash presente (sha256 hex)', /^[0-9a-f]{64}$/.test(corpoFixture.events[0].contentHash));
  todosPassaram &= check('payload contem o evento factual completo', corpoFixture.events[0].payload.amount === 97);

  // ---------- 1-8: request/headers/HMAC/rawBody ----------
  console.log('\n=== 1-8. Request correto, headers, HMAC, rawBody ===');
  {
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 200, corpo: { origin: CONFIG_TESTE.origin, correlationId: 'corr-1', results: [{ eventId: evento15751.eventId, result: 'CREATED' }] } }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1 });
    const resultado = await repo.enviarEvento(gate15751);

    todosPassaram &= check('exatamente 1 chamada HTTP feita', fetchFake.chamadas.length === 1);
    const chamada = fetchFake.chamadas[0];
    todosPassaram &= check('endpoint configuravel respeitado', chamada.url === CONFIG_TESTE.endpoint);
    todosPassaram &= check('metodo = POST', chamada.opcoes.method === 'POST');
    todosPassaram &= check('Content-Type = application/json', chamada.opcoes.headers['Content-Type'] === 'application/json');
    todosPassaram &= check('X-Nex-Timestamp presente e numerico', /^\d+$/.test(chamada.opcoes.headers['X-Nex-Timestamp']));
    todosPassaram &= check('X-Nex-Signature presente (hex)', /^[0-9a-f]{64}$/.test(chamada.opcoes.headers['X-Nex-Signature']));

    const rawBodyEnviado = chamada.opcoes.body;
    const timestampEnviado = chamada.opcoes.headers['X-Nex-Timestamp'];
    const assinaturaRecalculada = calcularAssinatura(CONFIG_TESTE.secret, timestampEnviado, rawBodyEnviado);
    todosPassaram &= check('rawBody enviado = rawBody assinado (HMAC recalculado bate)', assinaturaRecalculada === chamada.opcoes.headers['X-Nex-Signature']);
    todosPassaram &= check('rawBody e um JSON parseavel identico ao corpo logico', JSON.parse(rawBodyEnviado).events[0].eventId === evento15751.eventId);

    todosPassaram &= check('CREATED interpretado corretamente', resultado.result === 'CREATED');
    todosPassaram &= check('correlationId preservado da resposta', resultado.correlationId === 'corr-1');
    todosPassaram &= check('httpStatus preservado', resultado.httpStatus === 200);
  }

  // ---------- 9-11: fail-fast ----------
  console.log('\n=== 9-11. Fail-fast de configuracao ===');
  let lancouSemSecret = false, lancouSemOrigin = false, lancouSemEndpoint = false;
  try { criarRepositorioEventosHttp({ endpoint: 'x', origin: 'y' }, { fetchImpl: async () => {} }); } catch (e) { lancouSemSecret = true; }
  try { criarRepositorioEventosHttp({ endpoint: 'x', secret: 'z' }, { fetchImpl: async () => {} }); } catch (e) { lancouSemOrigin = true; }
  try { criarRepositorioEventosHttp({ origin: 'y', secret: 'z' }, { fetchImpl: async () => {} }); } catch (e) { lancouSemEndpoint = true; }
  todosPassaram &= check('secret ausente -> lanca fail-fast', lancouSemSecret);
  todosPassaram &= check('origin ausente -> lanca fail-fast', lancouSemOrigin);
  todosPassaram &= check('endpoint ausente -> lanca fail-fast', lancouSemEndpoint);

  // ---------- 12-15: interpretacao de resultados ----------
  console.log('\n=== 12-15. Interpretacao de result (contrato real do backend) ===');
  for (const status of ['CREATED', 'UNCHANGED', 'UPDATED', 'REVIEW_STORED']) {
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 200, corpo: { correlationId: 'c', results: [{ eventId: evento15751.eventId, result: status }] } }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check(`${status} interpretado corretamente`, r.result === status);
  }

  // ---------- 16-18: sem retry para REJECTED/400/401 ----------
  console.log('\n=== 16-18. Sem retry para REJECTED/400/401 ===');
  {
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 400, corpo: { error: 'payload invalido' } }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1, maxRetries: 3 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check('400 -> result REJECTED', r.result === 'REJECTED');
    todosPassaram &= check('400 -> apenas 1 chamada (sem retry)', fetchFake.chamadas.length === 1);
  }
  {
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 401, corpo: {} }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1, maxRetries: 3 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check('401 -> result ERROR', r.result === 'ERROR');
    todosPassaram &= check('401 -> apenas 1 chamada (sem retry)', fetchFake.chamadas.length === 1);
    todosPassaram &= check('401 -> erro nao expoe secret', !String(r.erro).includes(CONFIG_TESTE.secret));
  }

  // ---------- 19-20: retry limitado para 5xx e timeout ----------
  console.log('\n=== 19-20. Retry limitado (5xx e timeout) ===');
  {
    const fetchFake = criarFetchFake([
      { tipo: 'resposta', status: 503, corpo: {} },
      { tipo: 'resposta', status: 503, corpo: {} },
      { tipo: 'resposta', status: 200, corpo: { correlationId: 'c2', results: [{ eventId: evento15751.eventId, result: 'CREATED' }] } },
    ]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1, maxRetries: 2 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check('5xx com retry -> eventualmente sucesso apos 3 tentativas', r.result === 'CREATED' && fetchFake.chamadas.length === 3);
  }
  {
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 500, corpo: {} }, { tipo: 'resposta', status: 500, corpo: {} }, { tipo: 'resposta', status: 500, corpo: {} }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1, maxRetries: 2 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check('5xx persistente -> ERROR apos esgotar retries (maxRetries=2 -> 3 tentativas)', r.result === 'ERROR' && fetchFake.chamadas.length === 3);
    todosPassaram &= check('retry NAO e ilimitado (parou em 3, nao ficou em loop)', fetchFake.chamadas.length === 3);
  }
  {
    const fetchFake = criarFetchFake([{ tipo: 'timeout' }, { tipo: 'resposta', status: 200, corpo: { correlationId: 'c3', results: [{ eventId: evento15751.eventId, result: 'CREATED' }] } }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, timeoutMs: 10, retryDelayMs: 1, maxRetries: 2 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check('timeout com retry -> sucesso na 2a tentativa', r.result === 'CREATED' && fetchFake.chamadas.length === 2);
  }

  // ---------- 21: erro de rede com retry limitado ----------
  console.log('\n=== 21. Erro de rede com retry limitado ===');
  {
    const fetchFake = criarFetchFake([{ tipo: 'erro-rede' }, { tipo: 'erro-rede' }, { tipo: 'erro-rede' }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1, maxRetries: 2 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check('erro de rede persistente -> ERROR apos retries limitados', r.result === 'ERROR' && fetchFake.chamadas.length === 3);
  }

  // ---------- 22: correlationId preservado mesmo em falha (gerado localmente) ----------
  console.log('\n=== 22. correlationId preservado mesmo sem resposta do servidor ===');
  {
    const fetchFake = criarFetchFake([{ tipo: 'erro-rede' }, { tipo: 'erro-rede' }, { tipo: 'erro-rede' }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1, maxRetries: 2 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check('correlationId presente mesmo em falha total (gerado localmente)', typeof r.correlationId === 'string' && r.correlationId.length > 0);
  }

  // ---------- 23: no maximo 1 request em voo ----------
  console.log('\n=== 23. No maximo 1 request em voo ===');
  {
    const fetchFake = criarFetchFake([
      { tipo: 'resposta', status: 503, corpo: {} },
      { tipo: 'resposta', status: 200, corpo: { correlationId: 'c4', results: [{ eventId: evento15751.eventId, result: 'CREATED' }] } },
    ]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1, maxRetries: 1 });
    await repo.enviarEvento(gate15751);
    todosPassaram &= check('nunca mais de 1 chamada simultanea', fetchFake.maxEmVoo() === 1);
  }

  // ---------- 24-25: nexTransactionId/nexCustomerCode nullable ----------
  console.log('\n=== 24-25. nexTransactionId/nexCustomerCode nullable ===');
  const vSemCliente = normalizarVendaNex({ numero: '999', tipo: 'Venda', data: '1/1/26', hora: '10:00', valorPago: 'R$ 10.00 ' });
  const eventoSemCliente = gerarEventosDeVenda(vSemCliente, indice)[0];
  const gateSemCliente = avaliarGateEnvio(eventoSemCliente); // REVIEW_REQUIRED, cliente nao resolvido
  const eventoConstruido = construirEventoParaEnvio(gateSemCliente);
  todosPassaram &= check('nexCustomerCode = null quando cliente nao resolvido', eventoConstruido.nexCustomerCode === null);
  todosPassaram &= check('nexTransactionId presente quando existe ("999")', eventoConstruido.nexTransactionId === '999');

  // ---------- 26-27: occurredAt/timezone (ja cobertos na fixture, reforcando aqui) ----------
  console.log('\n=== 26-27. occurredAt sem Z, timezone explicito (reforco) ===');
  todosPassaram &= check('occurredAt sem sufixo Z', !String(eventoConstruido.occurredAt || '').endsWith('Z'));
  todosPassaram &= check('occurredAtTimezone = America/Sao_Paulo', eventoConstruido.occurredAtTimezone === 'America/Sao_Paulo');

  // ---------- 9. REVIEW_REQUIRED transportavel (secao 9 da F1A) ----------
  console.log('\n=== REVIEW_REQUIRED e transportado, mas nao aplica financeiro ===');
  todosPassaram &= check('evento sem cliente resolvido chega REVIEW_REQUIRED ao gate', gateSemCliente.status === 'REVIEW_REQUIRED');
  {
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 200, corpo: { correlationId: 'c5', results: [{ eventId: eventoSemCliente.eventId, result: 'REVIEW_STORED' }] } }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1 });
    const r = await repo.enviarEvento(gateSemCliente);
    const corpoEnviado = JSON.parse(fetchFake.chamadas[0].opcoes.body);
    todosPassaram &= check('sourceStatus = REVIEW_REQUIRED no payload transportado', corpoEnviado.events[0].sourceStatus === 'REVIEW_REQUIRED');
    todosPassaram &= check('resposta REVIEW_STORED interpretada corretamente', r.result === 'REVIEW_STORED');
  }

  // ---------- 28: secret nunca aparece em erro/log ----------
  console.log('\n=== 28. Secret nunca aparece em nenhum erro/resultado ===');
  {
    let mensagensDeErro = [];
    try { criarRepositorioEventosHttp({ endpoint: 'x', origin: 'y' }, { fetchImpl: async () => {} }); } catch (e) { mensagensDeErro.push(e.message); }
    const fetchFake = criarFetchFake([{ tipo: 'erro-rede' }, { tipo: 'erro-rede' }, { tipo: 'erro-rede' }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1, maxRetries: 2 });
    const r = await repo.enviarEvento(gate15751);
    mensagensDeErro.push(String(r.erro));
    todosPassaram &= check('nenhuma mensagem de erro contem o secret', mensagensDeErro.every((m) => !m.includes(CONFIG_TESTE.secret)));
  }

  // ---------- CONTRATO REAL DO BACKEND: results[].result (NAO processingStatus) ----------
  // Confirmado pelo relatorio oficial da Fase F1A.1 do PRIME COBRANCAS:
  // { correlationId, results: [ { eventId, result: "CREATED|UNCHANGED|UPDATED|REVIEW_STORED|REJECTED" } ] }
  // Este bloco prova que o Repository consome EXATAMENTE esse campo, sem
  // alias silencioso (result || processingStatus).
  console.log('\n=== CONTRATO REAL: results[].result para os 5 valores oficiais ===');
  for (const valor of ['CREATED', 'UNCHANGED', 'UPDATED', 'REVIEW_STORED', 'REJECTED']) {
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 200, corpo: { correlationId: 'contrato-1', results: [{ eventId: evento15751.eventId, result: valor }] } }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check(`results[0].result="${valor}" -> interpretado como "${valor}"`, r.result === valor);
  }

  console.log('\n=== CONTRATO REAL: defesa contra desvios do contrato (nunca assume sucesso) ===');
  {
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 200, corpo: { correlationId: 'c-sem-results' } }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check('"results" ausente -> ERROR (nao assume sucesso)', r.result === 'ERROR');
    todosPassaram &= check('"results" ausente -> erro sanitizado e descritivo', typeof r.erro === 'string' && r.erro.length > 0);
  }
  {
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 200, corpo: { correlationId: 'c-results-vazio', results: [] } }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check('"results" vazio -> ERROR (nao assume sucesso)', r.result === 'ERROR');
  }
  {
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 200, corpo: { correlationId: 'c-sem-result', results: [{ eventId: evento15751.eventId }] } }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check('item sem campo "result" -> ERROR (nao assume sucesso)', r.result === 'ERROR');
  }
  {
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 200, corpo: { correlationId: 'c-result-desconhecido', results: [{ eventId: evento15751.eventId, result: 'SUCESSO_TOTAL_INVENTADO' }] } }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check('"result" com valor desconhecido -> ERROR (nao aceita valor nao mapeado)', r.result === 'ERROR');
    todosPassaram &= check('erro menciona o valor desconhecido para diagnostico', String(r.erro).includes('SUCESSO_TOTAL_INVENTADO'));
  }
  {
    // Confirma explicitamente a AUSENCIA de alias silencioso: um corpo que
    // usa APENAS o campo antigo/errado "processingStatus" (sem "result")
    // deve ser tratado como contrato invalido, NUNCA interpretado com sucesso.
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 200, corpo: { correlationId: 'c-so-processingStatus', results: [{ eventId: evento15751.eventId, processingStatus: 'CREATED' }] } }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1 });
    const r = await repo.enviarEvento(gate15751);
    todosPassaram &= check('corpo com SOMENTE "processingStatus" (sem "result") -> ERROR, nunca aceito como alias', r.result === 'ERROR');
  }

  // ---------- carregarConfiguracaoDeEnv ----------
  console.log('\n=== carregarConfiguracaoDeEnv - leitura pura de variaveis ===');
  const cfgDeEnvFake = carregarConfiguracaoDeEnv({
    NEX_PRIME_ENDPOINT: 'https://x.invalido/functions/webhookNex',
    NEX_PRIME_ORIGIN: 'prime-store-udi-nex-01',
    NEX_PRIME_INTEGRATION_SECRET: 'abc',
  });
  todosPassaram &= check('le endpoint/origin/secret de um objeto de ambiente injetado', cfgDeEnvFake.endpoint.includes('webhookNex') && cfgDeEnvFake.origin === 'prime-store-udi-nex-01' && cfgDeEnvFake.secret === 'abc');
  const cfgDeEnvVazio = carregarConfiguracaoDeEnv({});
  todosPassaram &= check('objeto de ambiente vazio -> campos undefined (nao inventa valor)', cfgDeEnvVazio.endpoint === undefined && cfgDeEnvVazio.origin === undefined && cfgDeEnvVazio.secret === undefined);

  // ---------- REGRESSAO: X-Nex-Timestamp em MILISSEGUNDOS (bug corrigido) ----------
  // Bug real do primeiro E2E: client enviava epoch em SEGUNDOS
  // (String(Math.floor(now()/1000))), backend espera e compara em
  // MILISSEGUNDOS (String(Date.now())), causando 401 timestamp_out_of_window.
  // Este bloco usa um `now` injetado FIXO para provar, sem ambiguidade, que
  // o timestamp enviado e exatamente em ms - nao dividido por 1000.
  console.log('\n=== REGRESSAO: X-Nex-Timestamp em milissegundos (nao em segundos) ===');
  {
    const NOW_FIXO_MS = 1788016148071;
    const fetchFake = criarFetchFake([{ tipo: 'resposta', status: 200, corpo: { correlationId: 'c-ts-ms', results: [{ eventId: evento15751.eventId, result: 'CREATED' }] } }]);
    const repo = criarRepositorioEventosHttp(CONFIG_TESTE, { fetchImpl: fetchFake, retryDelayMs: 1, now: () => NOW_FIXO_MS });
    await repo.enviarEvento(gate15751);

    const chamada = fetchFake.chamadas[0];
    const timestampEnviado = chamada.opcoes.headers['X-Nex-Timestamp'];
    const rawBodyEnviado = chamada.opcoes.body;

    todosPassaram &= check('X-Nex-Timestamp = String(now()) exato, em milissegundos', timestampEnviado === '1788016148071');
    todosPassaram &= check('X-Nex-Timestamp NAO foi dividido por 1000 (nao e epoch em segundos)', timestampEnviado !== '1788016148');
    todosPassaram &= check('X-Nex-Timestamp tem 13 digitos (epoch ms para datas atuais)', timestampEnviado.length === 13);

    const assinaturaEsperada = calcularAssinatura(CONFIG_TESTE.secret, '1788016148071', rawBodyEnviado);
    todosPassaram &= check('HMAC calculado sobre "1788016148071." + rawBody (timestamp em ms)', assinaturaEsperada === chamada.opcoes.headers['X-Nex-Signature']);
    todosPassaram &= check('rawBody assinado = rawBody efetivamente enviado (mesmo objeto logico)', JSON.parse(rawBodyEnviado).events[0].eventId === evento15751.eventId);
  }

  // ---------- 30: garantia estrutural de zero chamada real ----------
  console.log('\n=== 30. Garantia estrutural: nenhum teste deste arquivo usa fetch global real ===');
  const fs = require('fs');
  const codigoDoTeste = fs.readFileSync(__filename, 'utf8');
  todosPassaram &= check('este arquivo de teste nunca invoca fetch sem fetchImpl explicito', !/[^.]\bfetch\(/.test(codigoDoTeste.replace(/fetchImpl|fetchFake/g, '')));

  console.log(
    '\nResultado geral repositorio-eventos-http.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main();
