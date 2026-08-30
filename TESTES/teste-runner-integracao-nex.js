'use strict';

/**
 * Teste de SERVICO/runner-integracao-nex.js (Fase F4.1). 100% OFFLINE:
 * NENHUM teste deste arquivo faz rede real, le secret real, usa
 * OUTPUT/f4-piloto.db real, aponta para EXPORTADOS/ real, ou toca
 * Base44/.nx1/NEX. Todo diretorio observado e todo banco SQLite sao
 * temporarios (novoDiretorioTemp()), o transporte HTTP e sempre um fake
 * controlavel, e o secret/endpoint/origin usados sao literais
 * inventados ("fake-secret-nao-real" etc.), nunca lidos de .env.
 *
 * Executar com: node TESTES\teste-runner-integracao-nex.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));

const { iniciarRunner } = require('../SERVICO/runner-integracao-nex');
const { EstadoBootstrapSqlite } = require('../SERVICO/estado-bootstrap-sqlite');
const { OutboxLocal, ESTADOS } = require('../SERVICO/outbox-local');
const { CheckpointSqlite } = require('../SERVICO/checkpoint-sqlite');
const { OrquestradorIntegracaoNex } = require('../SERVICO/orquestrador-integracao-nex');
const { BootstrapIntegracaoNex, BootstrapNaoAprovadoError, IndiceClientesIndisponivelError } = require('../SERVICO/bootstrap-integracao-nex');

function check(desc, cond) {
  const booleano = !!cond;
  console.log((booleano ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return booleano;
}

function novoDiretorioTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teste-runner-'));
}

const VENDAS_HEADER = [
  '', 'Ação', 'Número', 'Resumo', 'Tipo', 'Data', 'Hora', 'Origem', 'Itens', 'Cliente',
  'Observações', 'Vendedor', 'Desconto', 'Subtotal', 'Entrega', 'Valor Pago', 'Meio Pagto',
  'Crédito Usado', 'Debitado', 'Troco', 'Tx.Ent/Frete', 'Transp/Entregador', 'Cancelado',
  'Cancelado por', 'Cancelado Em', 'Creditado', 'Funcionário',
];
const CLIENTES_HEADER = [
  '', 'Ação', 'Nome', 'Débito / Crédito', 'Código', 'Observações', 'Sexo', 'Telefone',
  'Celular', 'Incluído Em', 'Alterado Em', 'Status',
];
function linhaDe(header, valores) {
  return header.map((h) => (Object.prototype.hasOwnProperty.call(valores, h) ? valores[h] : ''));
}
function construirXlsBuffer(linhas) {
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}
function escrever(dir, nome, buffer) {
  const caminho = path.join(dir, nome);
  fs.writeFileSync(caminho, buffer);
  return caminho;
}
function bufferClientesFixture() {
  return construirXlsBuffer([
    CLIENTES_HEADER,
    linhaDe(CLIENTES_HEADER, { Nome: 'CANELINHA', Código: '316', Status: 'Ativo' }),
  ]);
}
function bufferVenda({ numero, data, hora, cliente = 'CANELINHA', valorPago = 'R$ 10.00 ' }) {
  return construirXlsBuffer([
    VENDAS_HEADER,
    linhaDe(VENDAS_HEADER, { Número: numero, Tipo: 'Venda', Data: data, Hora: hora, Cliente: cliente, 'Valor Pago': valorPago }),
  ]);
}

/** Sleep injetavel "instantaneo" (via setImmediate) - deixa os testes rapidos e deterministicos. */
function sleepInstantaneo() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function criarLoggerFake() {
  const chamadas = [];
  const registrar = (nivel) => (component, evento, dados) => { chamadas.push({ nivel, component, evento, dados }); };
  return {
    chamadas,
    debug: registrar('DEBUG'),
    info: registrar('INFO'),
    warn: registrar('WARN'),
    error: registrar('ERROR'),
  };
}

function criarTransportarFake(respostaPadrao) {
  const chamadas = [];
  let resposta = respostaPadrao || null;
  const fn = async (item) => {
    chamadas.push(item);
    if (typeof resposta === 'function') return resposta(item);
    if (resposta) return resposta;
    return { eventId: item.eventId, result: 'CREATED', httpStatus: 200, correlationId: 'fake-correlation-' + item.eventId, erro: null };
  };
  fn.chamadas = chamadas;
  fn.definirResposta = (r) => { resposta = r; };
  return fn;
}

/**
 * Monta um piloto BASELINED+APPROVED de verdade (mesmo mecanismo real de
 * F4.0), usando um diretorio de setup separado (`dirBaseline`) e
 * devolvendo um `dirRunner` NOVO (so com o export de Clientes), para que
 * o runner sob teste comece com um diretorio observado limpo - qualquer
 * arquivo de Vendas (historico ou novo) e escrito nesse `dirRunner` pelo
 * proprio teste, DEPOIS do startup, e processado via chamada explicita a
 * `detector.varrerAgora()` (mesmo padrao ja usado em
 * TESTES/teste-detector-exports-nex.js) - nunca dependendo do timing do
 * fs.watch real, o que manteria os testes deterministicos.
 */
async function prepararPilotoAprovado({ cutoff, eventosHistoricosBuffer }) {
  const dirBaseline = novoDiretorioTemp();
  escrever(dirBaseline, 'clientes.xls', bufferClientesFixture());
  if (eventosHistoricosBuffer) {
    escrever(dirBaseline, 'vendas-historico.xls', eventosHistoricosBuffer);
  }
  const dbPath = path.join(dirBaseline, 'piloto.db');
  const estado = new EstadoBootstrapSqlite(dbPath);
  const outbox = new OutboxLocal(dbPath);
  const checkpoint = new CheckpointSqlite(dbPath);
  const orq = new OrquestradorIntegracaoNex({ outbox, checkpoint });
  const boot = new BootstrapIntegracaoNex({ estado, orquestrador: orq, diretorioExports: dirBaseline });
  await boot.executarDryRun(cutoff);
  await boot.confirmarBaseline(cutoff);
  await boot.aprovar();
  estado.fechar(); outbox.fechar(); checkpoint.fechar();

  const dirRunner = novoDiretorioTemp();
  escrever(dirRunner, 'clientes.xls', bufferClientesFixture());

  return { dbPath, dirBaseline, dirRunner };
}

const CONFIG_FAKE_BASE = { endpoint: 'https://fake.invalido/webhookNex', origin: 'teste-runner-f4', secret: 'fake-secret-nao-real' };

async function main() {
  let todosPassaram = true;

  // ---------- A. Startup com APPROVED -> PASS ----------
  console.log('\n=== A. Startup com bootstrap APPROVED -> runner inicia sem erro ===');
  {
    const { dbPath, dirRunner } = await prepararPilotoAprovado({ cutoff: '2026-01-01T00:00:00' });
    const logger = criarLoggerFake();
    const transportar = criarTransportarFake();
    const runner = await iniciarRunner({
      dbPath, diretorioExports: dirRunner, transportar, logger,
      sleepImpl: sleepInstantaneo, intervaloEstabilidadeMs: 1, processadorIntervaloMs: 3600000,
    });
    todosPassaram &= check('A. runner iniciou sem lancar excecao', runner && typeof runner.parar === 'function');
    todosPassaram &= check('A. RUNNER_INICIADO foi logado', logger.chamadas.some((c) => c.evento === 'RUNNER_INICIADO'));
    await runner.parar('FIM_TESTE_A');
  }

  // ---------- B. Startup sem APPROVED -> fail-closed ----------
  console.log('\n=== B. Startup sem APPROVED -> BootstrapNaoAprovadoError, nada iniciado ===');
  {
    const dir = novoDiretorioTemp();
    escrever(dir, 'clientes.xls', bufferClientesFixture());
    const dbPath = path.join(dir, 'piloto.db');
    // NUNCA roda executarDryRun/confirmarBaseline/aprovar - fica NOT_STARTED.
    let erroCapturado = null;
    try {
      await iniciarRunner({ dbPath, diretorioExports: dir, transportar: criarTransportarFake() });
    } catch (erro) {
      erroCapturado = erro;
    }
    todosPassaram &= check('B. iniciarRunner rejeita com BootstrapNaoAprovadoError', erroCapturado instanceof BootstrapNaoAprovadoError);
    todosPassaram &= check('B. statusAtual reportado = NOT_STARTED', erroCapturado && erroCapturado.statusAtual === 'NOT_STARTED');
  }

  // ---------- C. Historico baselinado -> ZERO transporte ----------
  console.log('\n=== C. Evento historico (baselinado) presente no diretorio observado -> ZERO chamadas ao transporte fake ===');
  {
    const cutoff = '2026-01-01T00:00:00';
    const bufferHistorico = bufferVenda({ numero: '10001', data: '12/20/25', hora: '10:00' }); // occurredAt < cutoff
    const { dbPath, dirRunner } = await prepararPilotoAprovado({ cutoff, eventosHistoricosBuffer: bufferHistorico });
    const transportar = criarTransportarFake();
    const runner = await iniciarRunner({
      dbPath, diretorioExports: dirRunner, transportar, logger: criarLoggerFake(),
      sleepImpl: sleepInstantaneo, intervaloEstabilidadeMs: 1, processadorIntervaloMs: 3600000,
    });

    // Mesmo conteudo EXATO usado para baselinar (garante mesmo contentHash),
    // escrito no diretorio observado SOMENTE apos o startup, e processado
    // por uma chamada explicita e deterministica a varrerAgora().
    escrever(dirRunner, 'vendas-historico-reexportado.xls', bufferHistorico);
    await runner._internoParaTeste.detector.varrerAgora();

    const pendentes = await runner._internoParaTeste.outbox.listarPorStatus(ESTADOS.PENDING);
    const enviados = await runner._internoParaTeste.outbox.listarPorStatus(ESTADOS.SENT);
    todosPassaram &= check('C. outbox PENDING = 0 apos processar historico', pendentes.length === 0);
    todosPassaram &= check('C. outbox SENT = 0 apos processar historico', enviados.length === 0);
    todosPassaram &= check('C. ZERO chamadas ao transporte fake (prova arquitetural anti-replay)', transportar.chamadas.length === 0);

    await runner.parar('FIM_TESTE_C');
  }

  // ---------- D. SALE_PAID novo pos-cutoff -> enqueue -> fake CREATED -> SENT + checkpoint ----------
  console.log('\n=== D. Evento novo pos-cutoff -> enqueue -> transporte fake CREATED -> SENT + checkpoint confirmado ===');
  let ambienteD;
  {
    const cutoff = '2026-01-01T00:00:00';
    const { dbPath, dirRunner } = await prepararPilotoAprovado({ cutoff });
    const transportar = criarTransportarFake({ result: 'CREATED', httpStatus: 200, correlationId: 'corr-90010', erro: null });
    const logger = criarLoggerFake();
    const runner = await iniciarRunner({
      dbPath, diretorioExports: dirRunner, transportar, logger,
      sleepImpl: sleepInstantaneo, intervaloEstabilidadeMs: 1, processadorIntervaloMs: 3600000,
    });

    const bufferNovo = bufferVenda({ numero: '90010', data: '1/2/26', hora: '10:00' }); // occurredAt > cutoff
    const caminhoNovo = escrever(dirRunner, 'vendas-novo.xls', bufferNovo);
    await runner._internoParaTeste.detector.varrerAgora();

    const eventId = 'SALE_PAID:NEX:90010';
    const item = await runner._internoParaTeste.outbox.buscarPorEventId(eventId);
    todosPassaram &= check('D. item existe na outbox', item != null);
    todosPassaram &= check('D. status final = SENT', item && item.status === ESTADOS.SENT);
    todosPassaram &= check('D. transporte fake chamado exatamente 1 vez', transportar.chamadas.length === 1);
    const confirmado = await runner._internoParaTeste.checkpoint.eventoJaConfirmado(eventId, item.contentHash);
    todosPassaram &= check('D. checkpoint confirma o evento (CREATED)', confirmado === true);

    ambienteD = { runner, dirRunner, dbPath, eventId, caminhoNovo, transportar };
  }

  // ---------- E. Mesmo evento novamente -> zero duplicacao ----------
  console.log('\n=== E. Reprocessar o MESMO evento (mesmo eventId/contentHash) -> zero duplicacao, zero novo transporte ===');
  {
    const { runner, caminhoNovo, eventId, transportar } = ambienteD;
    const relatorio2 = await runner._internoParaTeste.bootstrap.processarArquivoOperacional(caminhoNovo);
    todosPassaram &= check('E. segundo processamento nao enfileira de novo', relatorio2.enfileirados.length === 0);
    const itensComEsseEventId = await runner._internoParaTeste.outbox.listarPorNexTransactionId('90010');
    todosPassaram &= check('E. exatamente 1 linha na outbox para este evento (zero duplicacao)', itensComEsseEventId.length === 1);
    todosPassaram &= check('E. nenhuma chamada ADICIONAL ao transporte fake', transportar.chamadas.length === 1);

    await runner.parar('FIM_TESTE_E');
    void eventId;
  }

  // ---------- F/G. Transporte 500 -> RETRY; retry elegivel -> SENT ----------
  console.log('\n=== F. Transporte retorna ERROR/500 -> item termina RETRY com next_attempt_at futuro ===');
  let ambienteFG;
  {
    const cutoff = '2026-01-01T00:00:00';
    const { dbPath, dirRunner } = await prepararPilotoAprovado({ cutoff });
    const relogio = { agora: new Date('2026-01-02T10:00:00.000Z') };
    const transportar = criarTransportarFake({ result: 'ERROR', httpStatus: 500, correlationId: null, erro: 'fake 500' });
    const runner = await iniciarRunner({
      dbPath,
      diretorioExports: dirRunner,
      transportar,
      logger: criarLoggerFake(),
      sleepImpl: sleepInstantaneo,
      intervaloEstabilidadeMs: 1,
      processadorIntervaloMs: 3600000,
      nowImpl: () => relogio.agora,
    });

    const bufferNovo = bufferVenda({ numero: '90020', data: '1/2/26', hora: '11:00' });
    escrever(dirRunner, 'vendas-novo-retry.xls', bufferNovo);
    await runner._internoParaTeste.detector.varrerAgora();

    const eventId = 'SALE_PAID:NEX:90020';
    const item = await runner._internoParaTeste.outbox.buscarPorEventId(eventId);
    todosPassaram &= check('F. status = RETRY', item && item.status === ESTADOS.RETRY);
    todosPassaram &= check('F. next_attempt_at no futuro', item && item.nextAttemptAt && new Date(item.nextAttemptAt).getTime() > relogio.agora.getTime());
    todosPassaram &= check('F. transporte chamado exatamente 1 vez', transportar.chamadas.length === 1);

    ambienteFG = { runner, relogio, transportar, eventId };
  }

  console.log('\n=== G. Avancar o relogio ate next_attempt_at + reprocessar -> SENT ===');
  {
    const { runner, relogio, transportar, eventId } = ambienteFG;
    const itemAntes = await runner._internoParaTeste.outbox.buscarPorEventId(eventId);
    relogio.agora = new Date(new Date(itemAntes.nextAttemptAt).getTime() + 1000); // 1s depois do next_attempt_at
    transportar.definirResposta({ result: 'CREATED', httpStatus: 200, correlationId: 'corr-retry-ok', erro: null });

    await runner._internoParaTeste.processador.processarAteEsvaziar();

    const itemDepois = await runner._internoParaTeste.outbox.buscarPorEventId(eventId);
    todosPassaram &= check('G. status final = SENT apos retry elegivel', itemDepois && itemDepois.status === ESTADOS.SENT);
    todosPassaram &= check('G. transporte chamado uma 2a vez (total 2)', transportar.chamadas.length === 2);

    await runner.parar('FIM_TESTE_FG');
  }

  // ---------- H. Restart com SENDING orfao -> recovery ----------
  console.log('\n=== H. Item deixado em SENDING (simulando queda) -> recuperado como RETRY no startup -> processado sem duplicar ===');
  {
    const cutoff = '2026-01-01T00:00:00';
    const { dbPath, dirRunner } = await prepararPilotoAprovado({ cutoff });

    // Enfileira um evento real via o caminho operacional oficial (conexao temporaria, fechada em seguida).
    const estadoTmp = new EstadoBootstrapSqlite(dbPath);
    const outboxTmp = new OutboxLocal(dbPath);
    const checkpointTmp = new CheckpointSqlite(dbPath);
    const orqTmp = new OrquestradorIntegracaoNex({ outbox: outboxTmp, checkpoint: checkpointTmp });
    const bootTmp = new BootstrapIntegracaoNex({ estado: estadoTmp, orquestrador: orqTmp, diretorioExports: dirRunner });
    const caminhoOrfao = escrever(dirRunner, 'vendas-orfao.xls', bufferVenda({ numero: '90030', data: '1/2/26', hora: '12:00' }));
    await bootTmp.processarArquivoOperacional(caminhoOrfao);
    const eventId = 'SALE_PAID:NEX:90030';
    // Simula uma queda EXATAMENTE apos o claim (SENDING), antes de qualquer resposta do transporte.
    await outboxTmp.transicionar(eventId, ESTADOS.SENDING, { incrementarTentativa: true });
    estadoTmp.fechar(); outboxTmp.fechar(); checkpointTmp.fechar();

    const transportar = criarTransportarFake({ result: 'CREATED', httpStatus: 200, correlationId: 'corr-recovery', erro: null });
    const runner = await iniciarRunner({
      dbPath, diretorioExports: dirRunner, transportar, logger: criarLoggerFake(),
      sleepImpl: sleepInstantaneo, intervaloEstabilidadeMs: 1, processadorIntervaloMs: 3600000,
    });

    // O proprio startup do runner (recuperarPendencias + drenagem inicial da
    // outbox) ja deveria ter recuperado E processado o orfao ate SENT.
    const itemFinal = await runner._internoParaTeste.outbox.buscarPorEventId(eventId);
    todosPassaram &= check('H. item recuperado e processado ate SENT no startup', itemFinal && itemFinal.status === ESTADOS.SENT);
    todosPassaram &= check('H. transporte chamado exatamente 1 vez (a recuperacao em si nao conta como tentativa)', transportar.chamadas.length === 1);
    const todasLinhas = await runner._internoParaTeste.outbox.listarPorNexTransactionId('90030');
    todosPassaram &= check('H. exatamente 1 linha na outbox (sem duplicacao pela recuperacao)', todasLinhas.length === 1);

    await runner.parar('FIM_TESTE_H');
  }

  // ---------- I. Sem Clients export -> fail-closed ----------
  console.log('\n=== I. Diretorio sem NENHUM export de Clientes -> IndiceClientesIndisponivelError, runner recusa iniciar ===');
  {
    const dirBaseline = novoDiretorioTemp();
    // NENHUM arquivo de clientes.xls e escrito aqui - so o de vendas.
    const cutoff = '2026-01-01T00:00:00';
    const dbPath = path.join(dirBaseline, 'piloto.db');
    const estado = new EstadoBootstrapSqlite(dbPath);
    const outbox = new OutboxLocal(dbPath);
    const checkpoint = new CheckpointSqlite(dbPath);
    const orq = new OrquestradorIntegracaoNex({ outbox, checkpoint });
    const boot = new BootstrapIntegracaoNex({ estado, orquestrador: orq, diretorioExports: dirBaseline });
    await boot.executarDryRun(cutoff);
    await boot.confirmarBaseline(cutoff);
    await boot.aprovar();
    estado.fechar(); outbox.fechar(); checkpoint.fechar();

    const dirRunner = novoDiretorioTemp(); // tambem vazio de Clientes

    let erroCapturado = null;
    try {
      await iniciarRunner({ dbPath, diretorioExports: dirRunner, transportar: criarTransportarFake() });
    } catch (erro) {
      erroCapturado = erro;
    }
    todosPassaram &= check('I. iniciarRunner rejeita com IndiceClientesIndisponivelError', erroCapturado instanceof IndiceClientesIndisponivelError);
  }

  // ---------- J. Config obrigatoria ausente -> fail-fast antes de abrir DB ----------
  console.log('\n=== J. Config incompleta -> falha ANTES de qualquer banco ser aberto ===');
  {
    const dirTmp = novoDiretorioTemp();
    const dbPathNuncaCriado = path.join(dirTmp, 'nunca-criado.db');

    let erro1 = null;
    try {
      await iniciarRunner({ diretorioExports: dirTmp, ...CONFIG_FAKE_BASE }); // falta dbPath
    } catch (erro) { erro1 = erro; }
    todosPassaram &= check('J. falta dbPath -> rejeita', erro1 instanceof Error);

    let erro2 = null;
    try {
      await iniciarRunner({ dbPath: dbPathNuncaCriado, ...CONFIG_FAKE_BASE }); // falta diretorioExports
    } catch (erro) { erro2 = erro; }
    todosPassaram &= check('J. falta diretorioExports -> rejeita', erro2 instanceof Error);
    todosPassaram &= check('J. banco NUNCA foi criado no disco (fail-fast antes de abrir SQLite)', !fs.existsSync(dbPathNuncaCriado));

    let erro3 = null;
    try {
      await iniciarRunner({ dbPath: dbPathNuncaCriado, diretorioExports: dirTmp }); // falta endpoint/origin/secret/transportar
    } catch (erro) { erro3 = erro; }
    todosPassaram &= check('J. falta endpoint/origin/secret/transportar -> rejeita', erro3 instanceof Error);
    todosPassaram &= check('J. banco ainda nao foi criado apos a 3a tentativa invalida', !fs.existsSync(dbPathNuncaCriado));
  }

  // ---------- K. CHECKPOINT_AUSENTE -> WARN, continua, nenhuma auto-correcao ----------
  console.log('\n=== K. outbox SENT sem checkpoint correspondente -> auditarConsistencia loga WARN, runner inicia normalmente, nada e corrigido ===');
  {
    const cutoff = '2026-01-01T00:00:00';
    const { dbPath, dirRunner } = await prepararPilotoAprovado({ cutoff });

    // Simula a divergencia diretamente: leva um item ate SENT via
    // transicoes de baixo nivel, SEM nunca escrever no checkpoint (o que
    // normalmente sempre acompanha SENT via ProcessadorOutboxNex).
    const estadoTmp = new EstadoBootstrapSqlite(dbPath);
    const outboxTmp = new OutboxLocal(dbPath);
    const checkpointTmp = new CheckpointSqlite(dbPath);
    const orqTmp = new OrquestradorIntegracaoNex({ outbox: outboxTmp, checkpoint: checkpointTmp });
    const bootTmp = new BootstrapIntegracaoNex({ estado: estadoTmp, orquestrador: orqTmp, diretorioExports: dirRunner });
    const caminhoDesync = escrever(dirRunner, 'vendas-desync.xls', bufferVenda({ numero: '90040', data: '1/2/26', hora: '13:00' }));
    await bootTmp.processarArquivoOperacional(caminhoDesync);
    const eventId = 'SALE_PAID:NEX:90040';
    await outboxTmp.transicionar(eventId, ESTADOS.SENDING, { incrementarTentativa: true });
    await outboxTmp.transicionar(eventId, ESTADOS.SENT, { httpStatus: 200, result: 'CREATED', correlationId: 'corr-desync' });
    estadoTmp.fechar(); outboxTmp.fechar(); checkpointTmp.fechar();

    const logger = criarLoggerFake();
    const runner = await iniciarRunner({
      dbPath, diretorioExports: dirRunner, transportar: criarTransportarFake(), logger,
      sleepImpl: sleepInstantaneo, intervaloEstabilidadeMs: 1, processadorIntervaloMs: 3600000,
    });

    todosPassaram &= check('K. runner iniciou normalmente apesar da divergencia', runner != null);
    const warnCheckpointInconsistente = logger.chamadas.find((c) => c.evento === 'CHECKPOINT_INCONSISTENTE' && c.nivel === 'WARN');
    todosPassaram &= check('K. CHECKPOINT_INCONSISTENTE foi logado como WARN', warnCheckpointInconsistente != null && warnCheckpointInconsistente.dados.eventId === eventId);
    const resumoAuditoria = logger.chamadas.find((c) => c.evento === 'AUDITORIA_CONSISTENCIA_CONCLUIDA');
    todosPassaram &= check('K. resumo da auditoria reporta 1 divergencia', resumoAuditoria && resumoAuditoria.dados.divergencias === 1);

    const itemAposStartup = await runner._internoParaTeste.outbox.buscarPorEventId(eventId);
    todosPassaram &= check('K. outbox NAO foi alterada automaticamente (continua SENT)', itemAposStartup && itemAposStartup.status === ESTADOS.SENT);
    const checkpointAposStartup = await runner._internoParaTeste.checkpoint.buscarEvento(eventId);
    todosPassaram &= check('K. checkpoint continua ausente (nenhuma auto-correcao)', checkpointAposStartup === null);

    await runner.parar('FIM_TESTE_K');
  }

  // ---------- L. parar() idempotente ----------
  console.log('\n=== L. parar(): detector parado, timer limpo, SQLite fechado, chamada dupla segura ===');
  {
    const cutoff = '2026-01-01T00:00:00';
    const { dbPath, dirRunner } = await prepararPilotoAprovado({ cutoff });
    const logger = criarLoggerFake();
    const runner = await iniciarRunner({
      dbPath, diretorioExports: dirRunner, transportar: criarTransportarFake(), logger,
      sleepImpl: sleepInstantaneo, intervaloEstabilidadeMs: 1, processadorIntervaloMs: 3600000,
    });

    await runner.parar('PRIMEIRA_CHAMADA');
    todosPassaram &= check('L. detector marcado como parado', runner._internoParaTeste.detector._parado === true);
    const chamadasRunnerParado1 = logger.chamadas.filter((c) => c.evento === 'RUNNER_PARADO').length;
    todosPassaram &= check('L. RUNNER_PARADO logado exatamente 1 vez', chamadasRunnerParado1 === 1);

    let segundaChamadaLancou = false;
    try {
      await runner.parar('SEGUNDA_CHAMADA');
    } catch (erro) {
      segundaChamadaLancou = true;
    }
    todosPassaram &= check('L. segunda chamada a parar() nao lanca excecao (idempotente)', segundaChamadaLancou === false);
    const chamadasRunnerParado2 = logger.chamadas.filter((c) => c.evento === 'RUNNER_PARADO').length;
    todosPassaram &= check('L. RUNNER_PARADO NAO foi logado de novo na segunda chamada', chamadasRunnerParado2 === 1);
  }

  console.log(
    '\nResultado geral teste-runner-integracao-nex.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((erro) => {
  console.error('Erro inesperado no teste:', erro);
  process.exitCode = 1;
});
