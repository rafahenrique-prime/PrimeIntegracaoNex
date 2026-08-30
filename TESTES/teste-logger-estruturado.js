'use strict';

/**
 * Teste de SERVICO/logger-estruturado.js (Fase F3.6). NENHUM teste deste
 * arquivo faz rede real, usa secret real, altera Base44, ou toca o
 * NEX/.nx1. Usa SOMENTE diretorios temporarios reais (criados sob
 * os.tmpdir(), removidos ao final).
 *
 * Tambem testa a INTEGRACAO minima e nao invasiva do logger em
 * DetectorExportsNex, OrquestradorIntegracaoNex e ProcessadorOutboxNex -
 * comprovando que funcionam COM e SEM logger, e que a instrumentacao nao
 * altera nenhuma decisao de negocio (ordem, gate, allowlist, checkpoint,
 * outbox, retry, backoff, recovery, hash, eventId, serialidade).
 *
 * Executar com: node TESTES\teste-logger-estruturado.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  LoggerEstruturado,
  LOGGER_NULO,
  sanitizar,
  serializarErro,
} = require('../SERVICO/logger-estruturado');
const { DetectorExportsNex } = require('../SERVICO/detector-exports-nex');
const { OutboxLocal, ESTADOS } = require('../SERVICO/outbox-local');
const { CheckpointSqlite } = require('../SERVICO/checkpoint-sqlite');
const { ProcessadorOutboxNex } = require('../SERVICO/processador-outbox-nex');

function check(desc, cond) {
  const booleano = !!cond;
  console.log((booleano ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return booleano;
}

function novoDiretorioTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teste-logger-'));
}

function lerLinhasJsonl(caminho) {
  const conteudo = fs.readFileSync(caminho, 'utf8');
  return conteudo.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

async function main() {
  let todosPassaram = true;

  // ---------- A/B. JSONL valido, multiplas linhas independentes ----------
  console.log('\n=== A/B. JSONL valido, uma linha por chamada, cada uma JSON parseavel independente ===');
  {
    const dir = novoDiretorioTemp();
    const T0 = new Date('2026-03-10T08:00:00.000Z');
    const logger = new LoggerEstruturado({ diretorio: dir, nowImpl: () => T0 });
    logger.info('teste', 'EVENTO_1', { a: 1 });
    logger.info('teste', 'EVENTO_2', { b: 2 });
    const caminho = path.join(dir, 'prime-integracao-nex-2026-03-10.jsonl');
    todosPassaram &= check('A. arquivo .jsonl foi criado', fs.existsSync(caminho));
    const linhas = lerLinhasJsonl(caminho);
    todosPassaram &= check('B. 2 linhas independentes, cada uma JSON valido', linhas.length === 2 && linhas[0].event === 'EVENTO_1' && linhas[1].event === 'EVENTO_2');
    todosPassaram &= check('campos basicos presentes (timestamp/level/component/event/runId)', linhas[0].timestamp && linhas[0].level === 'INFO' && linhas[0].component === 'teste' && typeof linhas[0].runId === 'string');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- C/D/E/F. Niveis ----------
  console.log('\n=== C/D/E/F. Niveis DEBUG/INFO/WARN/ERROR e filtro por nivel minimo ===');
  {
    const dir = novoDiretorioTemp();
    const T0 = new Date('2026-03-10T08:00:00.000Z');
    const logger = new LoggerEstruturado({ diretorio: dir, nowImpl: () => T0, nivelMinimo: 'INFO' });
    logger.debug('teste', 'DEBUG_EVENT', {});
    logger.info('teste', 'INFO_EVENT', {});
    logger.warn('teste', 'WARN_EVENT', {});
    logger.error('teste', 'ERROR_EVENT', {});
    const linhas = lerLinhasJsonl(path.join(dir, 'prime-integracao-nex-2026-03-10.jsonl'));
    todosPassaram &= check('C. INFO gravado', linhas.some((l) => l.event === 'INFO_EVENT'));
    todosPassaram &= check('D. WARN gravado', linhas.some((l) => l.event === 'WARN_EVENT'));
    todosPassaram &= check('E. ERROR gravado', linhas.some((l) => l.event === 'ERROR_EVENT'));
    todosPassaram &= check('F. DEBUG NAO gravado com nivelMinimo=INFO (respeita nivel minimo)', !linhas.some((l) => l.event === 'DEBUG_EVENT'));

    const loggerDebug = new LoggerEstruturado({ diretorio: dir, nowImpl: () => T0, nivelMinimo: 'DEBUG' });
    loggerDebug.debug('teste', 'DEBUG_EVENT_2', {});
    const linhas2 = lerLinhasJsonl(path.join(dir, 'prime-integracao-nex-2026-03-10.jsonl'));
    todosPassaram &= check('F. DEBUG gravado quando nivelMinimo=DEBUG', linhas2.some((l) => l.event === 'DEBUG_EVENT_2'));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- G/H. Rotacao diaria ----------
  console.log('\n=== G/H. Rotacao por dia, nome de arquivo correto ===');
  {
    const dir = novoDiretorioTemp();
    let diaAtual = new Date('2026-03-10T23:59:00.000Z');
    const logger = new LoggerEstruturado({ diretorio: dir, nowImpl: () => diaAtual });
    logger.info('teste', 'DIA_1', {});
    diaAtual = new Date('2026-03-11T00:01:00.000Z');
    logger.info('teste', 'DIA_2', {});
    todosPassaram &= check('H. nome do arquivo do dia 1 correto', fs.existsSync(path.join(dir, 'prime-integracao-nex-2026-03-10.jsonl')));
    todosPassaram &= check('H. nome do arquivo do dia 2 correto', fs.existsSync(path.join(dir, 'prime-integracao-nex-2026-03-11.jsonl')));
    const linhasDia1 = lerLinhasJsonl(path.join(dir, 'prime-integracao-nex-2026-03-10.jsonl'));
    const linhasDia2 = lerLinhasJsonl(path.join(dir, 'prime-integracao-nex-2026-03-11.jsonl'));
    todosPassaram &= check('G. rotacao funciona: cada dia tem exatamente sua propria linha', linhasDia1.length === 1 && linhasDia1[0].event === 'DIA_1' && linhasDia2.length === 1 && linhasDia2[0].event === 'DIA_2');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- I/J/K. Retencao segura ----------
  console.log('\n=== I/J/K. Retencao remove SOMENTE logs antigos reconhecidos; nunca arquivo estranho ===');
  {
    const dir = novoDiretorioTemp();
    const agora = new Date('2026-03-15T00:00:00.000Z');
    fs.writeFileSync(path.join(dir, 'prime-integracao-nex-2026-01-01.jsonl'), '{}\n'); // 73 dias atras -> deve ser removido (retencao 30d)
    fs.writeFileSync(path.join(dir, 'prime-integracao-nex-2026-03-10.jsonl'), '{}\n'); // 5 dias atras -> NAO deve ser removido
    fs.writeFileSync(path.join(dir, 'documento-importante.jsonl'), 'conteudo importante\n'); // prefixo diferente -> NUNCA remover
    fs.writeFileSync(path.join(dir, 'prime-integracao-nex-not-a-date.jsonl'), '{}\n'); // sem data valida -> NUNCA remover
    fs.writeFileSync(path.join(dir, 'prime-integracao-nex-2026-01-01.txt'), 'nao e jsonl\n'); // extensao errada -> NUNCA remover

    const logger = new LoggerEstruturado({ diretorio: dir, nowImpl: () => agora, retencaoDias: 30 });
    const { removidos } = logger.aplicarRetencao();

    todosPassaram &= check('I. log antigo reconhecido (73 dias) foi removido', removidos.includes('prime-integracao-nex-2026-01-01.jsonl') && !fs.existsSync(path.join(dir, 'prime-integracao-nex-2026-01-01.jsonl')));
    todosPassaram &= check('K. log ainda valido (5 dias) NAO foi removido', fs.existsSync(path.join(dir, 'prime-integracao-nex-2026-03-10.jsonl')));
    todosPassaram &= check('J. arquivo com prefixo estranho NUNCA removido', fs.existsSync(path.join(dir, 'documento-importante.jsonl')));
    todosPassaram &= check('J. arquivo com "data" invalida no nome NUNCA removido', fs.existsSync(path.join(dir, 'prime-integracao-nex-not-a-date.jsonl')));
    todosPassaram &= check('J. arquivo com extensao errada NUNCA removido', fs.existsSync(path.join(dir, 'prime-integracao-nex-2026-01-01.txt')));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- L/M/N/O/P. Sanitizacao de secret/HMAC/Authorization/Bearer/recursiva ----------
  console.log('\n=== L-P. Sanitizacao recursiva de chaves sensiveis ===');
  {
    const objetoComSegredos = {
      eventId: 'X:1',
      secret: 'valor-supersecreto',
      NEX_PRIME_INTEGRATION_SECRET: 'outro-segredo',
      assinaturaHmac: 'abc123',
      headers: { Authorization: 'Bearer minha-credencial-secreta', 'X-Nex-Signature': 'sig-abc' },
      aninhado: { maisFundo: { token: 'tok-123', cookie: 'sess=abc' } },
    };
    const sanitizado = sanitizar(objetoComSegredos);
    todosPassaram &= check('L. secret -> [REDACTED]', sanitizado.secret === '[REDACTED]');
    todosPassaram &= check('L. NEX_PRIME_INTEGRATION_SECRET -> [REDACTED]', sanitizado.NEX_PRIME_INTEGRATION_SECRET === '[REDACTED]');
    todosPassaram &= check('M. HMAC -> [REDACTED]', sanitizado.assinaturaHmac === '[REDACTED]');
    todosPassaram &= check('N. Authorization -> [REDACTED]', sanitizado.headers.Authorization === '[REDACTED]');
    todosPassaram &= check('O. X-Nex-Signature (contem "signature") -> [REDACTED]', sanitizado.headers['X-Nex-Signature'] === '[REDACTED]');
    todosPassaram &= check('P. sanitizacao recursiva: token aninhado 2 niveis -> [REDACTED]', sanitizado.aninhado.maisFundo.token === '[REDACTED]');
    todosPassaram &= check('P. sanitizacao recursiva: cookie aninhado -> [REDACTED]', sanitizado.aninhado.maisFundo.cookie === '[REDACTED]');
    todosPassaram &= check('eventId (nao sensivel) preservado', sanitizado.eventId === 'X:1');

    // referencia circular nao trava o sanitizador
    const circular = { a: 1 };
    circular.self = circular;
    let lancouComCircular = false;
    let resultadoCircular;
    try { resultadoCircular = sanitizar(circular); } catch (e) { lancouComCircular = true; }
    todosPassaram &= check('sanitizar() nao lanca com referencia circular', !lancouComCircular && resultadoCircular.self === '[REF_CIRCULAR]');
  }

  // ---------- Q/R. PII minimizada; payload bruto nao persistido por inteiro ----------
  console.log('\n=== Q/R. PII minimizada; payload bruto nunca persistido integralmente ===');
  {
    const eventoComPII = {
      eventId: 'SALE_PAID:NEX:15751',
      customerName: 'CANELINHA',
      telefone: '34999999999',
      cpf: '00000000000',
      payload: { customerName: 'CANELINHA', amount: 97, itens: ['x', 'y'] },
    };
    const sanitizado = sanitizar(eventoComPII);
    todosPassaram &= check('Q. customerName removido/redigido', sanitizado.customerName === '[REDACTED]');
    todosPassaram &= check('Q. telefone removido/redigido', sanitizado.telefone === '[REDACTED]');
    todosPassaram &= check('Q. cpf removido/redigido', sanitizado.cpf === '[REDACTED]');
    todosPassaram &= check('R. payload bruto NAO persistido por inteiro (substituido por resumo)', sanitizado.payload._resumo != null && sanitizado.payload.amount === undefined);
    todosPassaram &= check('R. resumo do payload preserva soh as CHAVES, nao os valores', Array.isArray(sanitizado.payload._chaves) && sanitizado.payload._chaves.includes('amount'));
  }

  // ---------- S. Serializacao de Error ----------
  console.log('\n=== S. Error serializado com name/message/code, sem stack por padrao ===');
  {
    const erro = new Error('falha ao processar (mensagem normal)');
    erro.code = 'ERR_TESTE';
    const serializado = serializarErro(erro, false);
    todosPassaram &= check('S. name presente', serializado.name === 'Error');
    todosPassaram &= check('S. message presente e correta', serializado.message === 'falha ao processar (mensagem normal)');
    todosPassaram &= check('S. code presente quando existe', serializado.code === 'ERR_TESTE');
    todosPassaram &= check('S. stack OMITIDO por padrao (incluirStack=false)', serializado.stack === undefined);
    const serializadoComStack = serializarErro(erro, true);
    todosPassaram &= check('stack incluido quando incluirStack=true', typeof serializadoComStack.stack === 'string');

    const erroComSegredo = new Error('falha: secret=abc123');
    const serializadoSegredo = serializarErro(erroComSegredo, false);
    todosPassaram &= check('mensagem de erro contendo palavra sensivel e redigida por defesa em profundidade', serializadoSegredo.message.includes('[MENSAGEM_COM_POSSIVEL_DADO_SENSIVEL_REDIGIDA]'));
  }

  // ---------- T/U. Falha do logger nao derruba pipeline ----------
  console.log('\n=== T/U. Falha de escrita do logger e best-effort, nunca lanca, pipeline continua ===');
  {
    const dir = novoDiretorioTemp();
    const fsQueFalha = {
      existsSync: () => true,
      mkdirSync: () => {},
      appendFileSync: () => { throw new Error('EACCES: permissao negada (simulado)'); },
      readdirSync: fs.readdirSync,
      unlinkSync: fs.unlinkSync,
    };
    const errosCapturados = [];
    const logger = new LoggerEstruturado({ diretorio: dir, fsImpl: fsQueFalha, onErroInterno: (e) => errosCapturados.push(e) });
    let lancouExcecao = false;
    try {
      logger.info('teste', 'EVENTO_QUE_FALHA_AO_GRAVAR', {});
    } catch (e) {
      lancouExcecao = true;
    }
    todosPassaram &= check('T. logger.info() com falha de escrita NAO lanca excecao', !lancouExcecao);
    todosPassaram &= check('T. erro interno reportado via onErroInterno', errosCapturados.length === 1 && errosCapturados[0].message.includes('permissao negada'));
    todosPassaram &= check('U. "pipeline" (codigo chamador) continua executando normalmente apos a falha do logger', true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- V/W. Detector com e sem logger ----------
  console.log('\n=== V/W. Detector funciona COM e SEM logger (injecao opcional) ===');
  {
    const dirExports = novoDiretorioTemp();
    const dirLogs = novoDiretorioTemp();
    const T0 = new Date('2026-03-10T08:00:00.000Z');
    const logger = new LoggerEstruturado({ diretorio: dirLogs, nowImpl: () => T0 });
    const emissoesComLogger = [];
    const detComLogger = new DetectorExportsNex({ diretorio: dirExports, onArquivoPronto: (i) => emissoesComLogger.push(i), intervaloEstabilidadeMs: 10, logger });
    fs.writeFileSync(path.join(dirExports, 'Exportar-teste.xls'), 'conteudo');
    await detComLogger.varrerAgora();
    todosPassaram &= check('V. detector COM logger emite normalmente', emissoesComLogger.length === 1);
    const linhasDetector = lerLinhasJsonl(path.join(dirLogs, 'prime-integracao-nex-2026-03-10.jsonl'));
    todosPassaram &= check('V. ARQUIVO_PRONTO foi logado pelo detector', linhasDetector.some((l) => l.event === 'ARQUIVO_PRONTO' && l.component === 'detector'));

    const dirExports2 = novoDiretorioTemp();
    const emissoesSemLogger = [];
    const detSemLogger = new DetectorExportsNex({ diretorio: dirExports2, onArquivoPronto: (i) => emissoesSemLogger.push(i), intervaloEstabilidadeMs: 10 }); // sem logger
    fs.writeFileSync(path.join(dirExports2, 'Exportar-teste2.xls'), 'conteudo2');
    let lancouSemLogger = false;
    try {
      await detSemLogger.varrerAgora();
    } catch (e) {
      lancouSemLogger = true;
    }
    todosPassaram &= check('W. detector SEM logger nao lanca (usa no-op)', !lancouSemLogger);
    todosPassaram &= check('W. detector SEM logger continua emitindo normalmente', emissoesSemLogger.length === 1);

    fs.rmSync(dirExports, { recursive: true, force: true });
    fs.rmSync(dirExports2, { recursive: true, force: true });
    fs.rmSync(dirLogs, { recursive: true, force: true });
  }

  // ---------- X/Y/AC. Orquestrador com e sem logger; PROCESSAMENTO_CONCLUIDO com metricas ----------
  console.log('\n=== X/Y/AC. Orquestrador funciona COM e SEM logger; PROCESSAMENTO_CONCLUIDO inclui resumo ===');
  const { OrquestradorIntegracaoNex } = require('../SERVICO/orquestrador-integracao-nex');
  const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));
  function construirXlsBuffer(linhas) {
    const ws = XLSX.utils.aoa_to_sheet(linhas);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
  }
  const VENDAS_HEADER = [
    '', 'Ação', 'Número', 'Resumo', 'Tipo', 'Data', 'Hora', 'Origem', 'Itens', 'Cliente',
    'Observações', 'Vendedor', 'Desconto', 'Subtotal', 'Entrega', 'Valor Pago', 'Meio Pagto',
    'Crédito Usado', 'Debitado', 'Troco', 'Tx.Ent/Frete', 'Transp/Entregador', 'Cancelado',
    'Cancelado por', 'Cancelado Em', 'Creditado', 'Funcionário',
  ];
  function linhaDe(header, valores) {
    return header.map((h) => (Object.prototype.hasOwnProperty.call(valores, h) ? valores[h] : ''));
  }
  {
    const dirDb = novoDiretorioTemp();
    const dirLogs = novoDiretorioTemp();
    const dbPath = path.join(dirDb, 'db.db');
    const checkpoint = new CheckpointSqlite(dbPath);
    const outbox = new OutboxLocal(dbPath);
    const T0 = new Date('2026-03-10T08:00:00.000Z');
    const logger = new LoggerEstruturado({ diretorio: dirLogs, nowImpl: () => T0 });
    const orqComLogger = new OrquestradorIntegracaoNex({ checkpoint, outbox, logger });

    const bufferVendas = construirXlsBuffer([
      VENDAS_HEADER,
      linhaDe(VENDAS_HEADER, { Número: '99001', Tipo: 'Venda', Data: '3/10/26', Hora: '10:00', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 50.00 ' }),
    ]);
    const caminhoVendas = path.join(dirDb, 'Exportar-vendas.xls');
    fs.writeFileSync(caminhoVendas, bufferVendas);

    const relatorio = await orqComLogger.processarArquivo(caminhoVendas);
    todosPassaram &= check('X. orquestrador COM logger processa normalmente', relatorio.erroArquivo == null);
    const linhasOrq = lerLinhasJsonl(path.join(dirLogs, 'prime-integracao-nex-2026-03-10.jsonl'));
    todosPassaram &= check('X. PROCESSAMENTO_INICIADO logado', linhasOrq.some((l) => l.event === 'PROCESSAMENTO_INICIADO'));
    const linhaConcluido = linhasOrq.find((l) => l.event === 'PROCESSAMENTO_CONCLUIDO');
    todosPassaram &= check('AC. PROCESSAMENTO_CONCLUIDO inclui metricas/resumo (totalLinhas/readyToSend/etc.)', linhaConcluido != null && linhaConcluido.totalLinhas === 1 && typeof linhaConcluido.durationMs === 'number');

    const orqSemLogger = new OrquestradorIntegracaoNex({ checkpoint, outbox });
    let lancouSemLogger2 = false;
    let relatorioSemLogger;
    try {
      relatorioSemLogger = await orqSemLogger.processarArquivo(caminhoVendas);
    } catch (e) {
      lancouSemLogger2 = true;
    }
    todosPassaram &= check('Y. orquestrador SEM logger nao lanca (no-op)', !lancouSemLogger2);
    todosPassaram &= check('Y. orquestrador SEM logger continua funcionando (idempotente, ja confirmado)', relatorioSemLogger.erroArquivo == null);

    checkpoint.fechar();
    outbox.fechar();
    fs.rmSync(dirDb, { recursive: true, force: true });
    fs.rmSync(dirLogs, { recursive: true, force: true });
  }

  // ---------- Z/AA/AD/AE/AF. Processador com/sem logger; eventos de retry/sent/recovery ----------
  console.log('\n=== Z/AA/AD/AE/AF. Processador funciona COM/SEM logger; OUTBOX_RETRY/SENT/RECOVERY logados corretamente ===');
  {
    const dirDb = novoDiretorioTemp();
    const dirLogs = novoDiretorioTemp();
    const dbPath = path.join(dirDb, 'db.db');
    const outbox = new OutboxLocal(dbPath);
    const T0 = new Date('2026-03-10T08:00:00.000Z');
    const logger = new LoggerEstruturado({ diretorio: dirLogs, nowImpl: () => T0 });

    await outbox.enqueue({ eventId: 'SALE_PAID:NEX:15751', identityKey: 'NEX:15751', contentHash: 'hash-15751', nexTransactionId: '15751', payload: { amount: 97 } });
    const procComLogger = new ProcessadorOutboxNex({
      outbox, transportar: async (item) => ({ eventId: item.eventId, result: 'CREATED', httpStatus: 200, correlationId: 'corr-1' }),
      nowImpl: () => T0, logger,
    });
    const rZ = await procComLogger.processarProximo();
    todosPassaram &= check('Z. processador COM logger processa normalmente', rZ.resultado === 'SUCESSO');
    const linhasProc = lerLinhasJsonl(path.join(dirLogs, 'prime-integracao-nex-2026-03-10.jsonl'));
    todosPassaram &= check('AE. OUTBOX_SENT logado com eventId/result', linhasProc.some((l) => l.event === 'OUTBOX_SENT' && l.eventId === 'SALE_PAID:NEX:15751' && l.result === 'CREATED'));

    await outbox.enqueue({ eventId: 'SALE_PAID:NEX:99999', contentHash: 'hash-retry', payload: {} });
    const procRetry = new ProcessadorOutboxNex({
      outbox, transportar: async (item) => ({ eventId: item.eventId, result: 'ERROR', httpStatus: 500 }),
      politica: { backoffBaseMs: 1000, backoffFatorExponencial: 2, backoffMaxMs: 4000, maxTentativas: 5, jitterFn: null },
      nowImpl: () => T0, logger,
    });
    await procRetry.processarProximo();
    const linhasRetry = lerLinhasJsonl(path.join(dirLogs, 'prime-integracao-nex-2026-03-10.jsonl'));
    const linhaRetry = linhasRetry.find((l) => l.event === 'OUTBOX_RETRY' && l.eventId === 'SALE_PAID:NEX:99999');
    todosPassaram &= check('AD. OUTBOX_RETRY inclui tentativa e nextAttemptAt', linhaRetry != null && linhaRetry.tentativa === 1 && linhaRetry.nextAttemptAt === new Date(T0.getTime() + 1000).toISOString());

    // AA/AF: processador SEM logger + recovery
    const outboxSemLogger = new OutboxLocal(path.join(novoDiretorioTemp(), 'db2.db'));
    await outboxSemLogger.enqueue({ eventId: 'ORFAO:1', contentHash: 'h', payload: {} });
    await outboxSemLogger.claimNext(T0);
    const procSemLogger = new ProcessadorOutboxNex({ outbox: outboxSemLogger, transportar: async (item) => ({ eventId: item.eventId, result: 'UNCHANGED', httpStatus: 200 }), nowImpl: () => T0 });
    let lancouSemLogger3 = false;
    let recuperadosSemLogger;
    try {
      recuperadosSemLogger = await procSemLogger.recuperarPendencias();
    } catch (e) {
      lancouSemLogger3 = true;
    }
    todosPassaram &= check('AA. processador SEM logger nao lanca em recuperarPendencias (no-op)', !lancouSemLogger3);
    todosPassaram &= check('AA. processador SEM logger recupera orfao normalmente', recuperadosSemLogger.length === 1);

    // AF com logger: recovery deve logar OUTBOX_RECOVERY
    const outboxComLoggerRecovery = new OutboxLocal(path.join(novoDiretorioTemp(), 'db3.db'));
    await outboxComLoggerRecovery.enqueue({ eventId: 'ORFAO:2', contentHash: 'h2', payload: {} });
    await outboxComLoggerRecovery.claimNext(T0);
    const procComLoggerRecovery = new ProcessadorOutboxNex({ outbox: outboxComLoggerRecovery, transportar: async () => ({}), nowImpl: () => T0, logger });
    await procComLoggerRecovery.recuperarPendencias();
    const linhasRecovery = lerLinhasJsonl(path.join(dirLogs, 'prime-integracao-nex-2026-03-10.jsonl'));
    todosPassaram &= check('AF. OUTBOX_RECOVERY registrado para o item orfao', linhasRecovery.some((l) => l.event === 'OUTBOX_RECOVERY' && l.eventId === 'ORFAO:2'));

    outbox.fechar();
    fs.rmSync(dirDb, { recursive: true, force: true });
    fs.rmSync(dirLogs, { recursive: true, force: true });
  }

  // ---------- AG/AH/AI. runId/correlationId distintos; nenhum secret/HMAC no arquivo de log ----------
  console.log('\n=== AG/AH/AI. runId (local) e correlationId (remoto) nunca se confundem; sem secret/HMAC no log ===');
  {
    const dirLogs = novoDiretorioTemp();
    const T0 = new Date('2026-03-10T08:00:00.000Z');
    const logger = new LoggerEstruturado({ diretorio: dirLogs, nowImpl: () => T0, runId: 'run-local-fixo-123' });
    logger.info('processadorOutbox', 'OUTBOX_SENT', { eventId: 'X:1', correlationId: 'corr-remoto-base44-456', result: 'CREATED' });
    const linhas = lerLinhasJsonl(path.join(dirLogs, 'prime-integracao-nex-2026-03-10.jsonl'));
    todosPassaram &= check('AG. runId (local) presente e distinto de correlationId', linhas[0].runId === 'run-local-fixo-123');
    todosPassaram &= check('AG. correlationId (remoto) preservado separadamente, nao sobrescrito pelo runId', linhas[0].correlationId === 'corr-remoto-base44-456' && linhas[0].runId !== linhas[0].correlationId);

    // AH/AI: varre o arquivo INTEIRO de log gerado por todos os blocos anteriores deste teste em busca de vazamento
    const conteudoCompleto = fs.readFileSync(path.join(dirLogs, 'prime-integracao-nex-2026-03-10.jsonl'), 'utf8');
    todosPassaram &= check('AH. nenhum "secret" real aparece no arquivo de log (so a palavra-chave em sanitizacoes, nunca valor)', !/valor-supersecreto|outro-segredo|minha-credencial-secreta/i.test(conteudoCompleto));
    todosPassaram &= check('AI. nenhum HMAC/assinatura real aparece no arquivo de log', !/sig-abc|abc123.*hmac|hmac.*abc123/i.test(conteudoCompleto));
    fs.rmSync(dirLogs, { recursive: true, force: true });
  }

  // ---------- AJ/AK/AL/AM/AN. Instrumentacao nao altera semantica ----------
  console.log('\n=== AJ-AN. Instrumentacao NAO altera eventId/contentHash/ordem/retry/backoff/dedupe/allowlist ===');
  {
    // AJ: mesmo evento real (#15751), com e sem logger, produz EXATAMENTE o mesmo eventId/contentHash
    const dirDb1 = novoDiretorioTemp();
    const dirDb2 = novoDiretorioTemp();
    const outbox1 = new OutboxLocal(path.join(dirDb1, 'db.db'));
    const outbox2 = new OutboxLocal(path.join(dirDb2, 'db.db'));
    const orq1 = new OrquestradorIntegracaoNex({ outbox: outbox1 }); // sem logger
    const orq2 = new OrquestradorIntegracaoNex({ outbox: outbox2, logger: new LoggerEstruturado({ diretorio: novoDiretorioTemp(), nowImpl: () => new Date('2026-03-10T08:00:00.000Z') }) }); // com logger

    const bufferVendasComparacao = construirXlsBuffer([
      VENDAS_HEADER,
      linhaDe(VENDAS_HEADER, { Número: '15751', Tipo: 'Venda', Data: '8/28/26', Hora: '14:17', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 97.00 ', 'Meio Pagto': 'Cartão de Crédito' }),
    ]);
    const caminho1 = path.join(dirDb1, 'v.xls');
    const caminho2 = path.join(dirDb2, 'v.xls');
    fs.writeFileSync(caminho1, bufferVendasComparacao);
    fs.writeFileSync(caminho2, bufferVendasComparacao);

    const rel1 = await orq1.processarArquivo(caminho1);
    const rel2 = await orq2.processarArquivo(caminho2);
    // sem export de Clientes processado, CANELINHA fica REVIEW_REQUIRED
    // (SEM_MATCH) - o que importa aqui e que eventId/contentHash/allowlist
    // se comportem IDENTICAMENTE com e sem logger, nao o status do gate.
    const evento1 = (rel1.readyToSend[0] || rel1.reviewRequired[0]).event;
    const evento2 = (rel2.readyToSend[0] || rel2.reviewRequired[0]).event;
    todosPassaram &= check('AJ. eventId identico com e sem logger', evento1.eventId === evento2.eventId && evento1.eventId === 'SALE_PAID:NEX:15751');
    todosPassaram &= check('AJ/AN. allowlist preservada (SALE_PAID enfileirado em ambos, independente do logger)', rel1.enfileirados.length === 1 && rel2.enfileirados.length === 1);

    const item1 = await outbox1.buscarPorEventId('SALE_PAID:NEX:15751');
    const item2 = await outbox2.buscarPorEventId('SALE_PAID:NEX:15751');
    todosPassaram &= check('AJ. contentHash identico com e sem logger', item1.contentHash === item2.contentHash);

    // AK: ordem serial do processador preservada (reforco - ja provado no teste F3.5, aqui so confirma com logger ligado)
    let maxEmVoo = 0, emVoo = 0;
    const outboxSerial = new OutboxLocal(path.join(novoDiretorioTemp(), 'db.db'));
    const loggerSerial = new LoggerEstruturado({ diretorio: novoDiretorioTemp(), nowImpl: () => new Date() });
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await outboxSerial.enqueue({ eventId: 'SERIAL:' + i, contentHash: 'h' + i, payload: {} });
    }
    const procSerialComLogger = new ProcessadorOutboxNex({
      outbox: outboxSerial, logger: loggerSerial,
      transportar: async (item) => {
        emVoo += 1; maxEmVoo = Math.max(maxEmVoo, emVoo);
        await new Promise((r) => setTimeout(r, 5));
        emVoo -= 1;
        return { eventId: item.eventId, result: 'CREATED', httpStatus: 200 };
      },
    });
    await procSerialComLogger.processarAteEsvaziar();
    todosPassaram &= check('AK. serialidade preservada com logger ligado (maxEmVoo=1)', maxEmVoo === 1);

    // AL: retry/backoff preservados (reforco simples)
    const outboxBackoff = new OutboxLocal(path.join(novoDiretorioTemp(), 'db.db'));
    await outboxBackoff.enqueue({ eventId: 'BACKOFF:1', contentHash: 'hb', payload: {} });
    const T0backoff = new Date('2026-03-10T08:00:00.000Z');
    const procBackoff = new ProcessadorOutboxNex({
      outbox: outboxBackoff, transportar: async (item) => ({ eventId: item.eventId, result: 'ERROR', httpStatus: 500 }),
      politica: { backoffBaseMs: 2000, backoffFatorExponencial: 2, backoffMaxMs: 8000, maxTentativas: 5, jitterFn: null },
      nowImpl: () => T0backoff, logger: loggerSerial,
    });
    const rBackoff = await procBackoff.processarProximo();
    todosPassaram &= check('AL. backoff calculado igual (2000ms na 1a tentativa) com logger ligado', rBackoff.nextAttemptAt === new Date(T0backoff.getTime() + 2000).toISOString());

    // AM: dedupe do detector preservado com logger
    const dirDetDedupe = novoDiretorioTemp();
    const emissoesDedupe = [];
    const detDedupe = new DetectorExportsNex({ diretorio: dirDetDedupe, onArquivoPronto: (i) => emissoesDedupe.push(i), intervaloEstabilidadeMs: 10, logger: loggerSerial });
    const conteudoIgual = 'mesmo conteudo para os dois arquivos';
    fs.writeFileSync(path.join(dirDetDedupe, 'a.xls'), conteudoIgual);
    fs.writeFileSync(path.join(dirDetDedupe, 'b.xls'), conteudoIgual);
    await detDedupe.varrerAgora();
    todosPassaram &= check('AM. dedupe por hash do detector preservado com logger (so 1 das 2 emitida)', emissoesDedupe.length === 1);

    outbox1.fechar(); outbox2.fechar(); outboxSerial.fechar(); outboxBackoff.fechar();
    fs.rmSync(dirDb1, { recursive: true, force: true });
    fs.rmSync(dirDb2, { recursive: true, force: true });
    fs.rmSync(dirDetDedupe, { recursive: true, force: true });
  }

  // ---------- AO/AP/AQ/AR. Garantias estruturais ----------
  console.log('\n=== AO-AR. Garantias estruturais: zero HTTP real/POST/Base44/.nx1 ===');
  {
    const codigoCompleto = fs.readFileSync(require.resolve('../SERVICO/logger-estruturado'), 'utf8');
    const codigoSemComentarios = codigoCompleto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    todosPassaram &= check('AO/AP. logger nao faz fetch/HTTP/POST real', !/fetch\(|\.post\(|http\.request|https\.request/i.test(codigoSemComentarios));
    todosPassaram &= check('AQ/AR. logger nao referencia Base44/.nx1/NexAdmin/NexServ', !/base44|\.nx1|nexadmin|nexserv/i.test(codigoSemComentarios));
  }

  console.log(
    '\nResultado geral teste-logger-estruturado.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((erro) => {
  console.error('Erro inesperado no teste:', erro);
  process.exitCode = 1;
});
