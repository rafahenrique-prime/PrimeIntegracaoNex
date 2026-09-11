'use strict';

/**
 * Teste de SERVICO/cleanup-exportados-nex.js (HARDENING 1A).
 * Executar com: node TESTES\teste-cleanup-exportados-nex.js
 *
 * Usa filesystem FAKE (nunca toca disco real) e CheckpointSqlite/OutboxLocal
 * reais apontando para ':memory:' (mesmo padrao ja usado pelos testes
 * originais desses modulos) - nunca abre o banco real de producao.
 */

const path = require('path');
const assert = require('assert');
const PROJETO = path.join(__dirname, '..');
const XLSX = require(path.join(PROJETO, 'node_modules', 'xlsx'));

const {
  nomeEhVendasAutoValido,
  avaliarArquivoVendasAuto,
  avaliarArquivoArchive,
} = require(path.join(PROJETO, 'SERVICO', 'cleanup-exportados-nex'));
const { CheckpointSqlite } = require(path.join(PROJETO, 'SERVICO', 'checkpoint-sqlite'));
const { OutboxLocal } = require(path.join(PROJETO, 'SERVICO', 'outbox-local'));
const { calcularContentHashEvento } = require(path.join(PROJETO, 'SERVICO', 'repositorio-eventos-http'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;
function registrar(cond) {
  if (!cond) todosPassaram = false;
}

const HEADER_VENDAS = [
  '', 'Ação', 'Número', 'Resumo', 'Tipo', 'Data', 'Hora', 'Origem', 'Itens',
  'Cliente', 'Observações', 'Vendedor', 'Desconto', 'Subtotal', 'Entrega',
  'Valor Pago', 'Meio Pagto', 'Crédito Usado', 'Debitado', 'Troco',
  'Tx.Ent/Frete', 'Transp/Entregador', 'Cancelado', 'Cancelado por',
  'Cancelado Em', 'Creditado', 'Funcionário',
];

/**
 * @param {{numero:string, debitado?:string, valorPago?:string}} venda
 * @returns {Buffer}
 */
function construirXlsVendasBuffer(vendas) {
  const linhas = [HEADER_VENDAS];
  for (const v of vendas) {
    linhas.push([
      '', 'Venda', v.numero, 'Resumo', 'Venda', v.data || '01/09/26', v.hora || '10:00', 'Local',
      'Item A x1', v.cliente || 'CLIENTE TESTE', '', 'Vendedor X', '', '100,00', '',
      v.valorPago || '', 'Dinheiro', '', v.debitado || '', '', '', '', 'Não', '', '', '', 'Func X',
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}

/** Fake fsImpl: mapa nomeArquivo -> {buffer, mtimeMs, size} */
function criarFakeFs(arquivos) {
  return {
    statSync(caminho) {
      const nome = path.basename(caminho);
      const info = arquivos[nome];
      if (!info) {
        const erro = new Error(`ENOENT: ${caminho}`);
        erro.code = 'ENOENT';
        throw erro;
      }
      return { size: info.buffer.length, mtimeMs: info.mtimeMs };
    },
    readFileSync(caminho) {
      const nome = path.basename(caminho);
      const info = arquivos[nome];
      if (!info) {
        const erro = new Error(`ENOENT: ${caminho}`);
        erro.code = 'ENOENT';
        throw erro;
      }
      return info.buffer;
    },
  };
}

function sleepImediato() {
  return Promise.resolve();
}

const AGORA_MS = Date.parse('2026-09-08T12:00:00Z');
const UM_DIA_MS = 24 * 60 * 60 * 1000;

async function main() {
  // ---- Grupo A: nomeEhVendasAutoValido ----
  registrar(check('A1 - nome valido vendas-auto-YYYYMMDD-HHMMSS.xls', nomeEhVendasAutoValido('vendas-auto-20260908-010503.xls')));
  registrar(check('A2 - nome invalido (Exportar-*.xls)', !nomeEhVendasAutoValido('Exportar-dia-31-08.xls')));
  registrar(check('A3 - nome invalido (clientes*.xls)', !nomeEhVendasAutoValido('clientes-nex.xls')));
  registrar(check('A4 - nome invalido (extrato*.xls)', !nomeEhVendasAutoValido('extrato-cliente-292-20260906-062553.xls')));
  registrar(check('A5 - nome invalido (extensao xlsx)', !nomeEhVendasAutoValido('vendas-auto-20260908-010503.xlsx')));

  // ---- T1: arquivo <7 dias -> KEEP ----
  {
    const checkpoint = new CheckpointSqlite(':memory:');
    const outbox = new OutboxLocal(':memory:');
    const buffer = construirXlsVendasBuffer([{ numero: '90001', debitado: '50,00' }]);
    const fsImpl = criarFakeFs({ 'vendas-auto-20260907-100000.xls': { buffer, mtimeMs: AGORA_MS - 2 * UM_DIA_MS } });
    const resultado = await avaliarArquivoVendasAuto({
      caminho: 'vendas-auto-20260907-100000.xls', nomeArquivo: 'vendas-auto-20260907-100000.xls',
      fsImpl, checkpoint, outbox, agoraMs: AGORA_MS, sleepImpl: sleepImediato,
    });
    registrar(check('T1 - arquivo <7 dias -> KEEP', resultado.action === 'KEEP' && resultado.reason === 'IDADE_INSUFICIENTE'));
    checkpoint.fechar();
    outbox.fechar();
  }

  // ---- T2: vendas-auto valido >=7d + checkpoint terminal correto -> WOULD_ARCHIVE ----
  {
    const checkpoint = new CheckpointSqlite(':memory:');
    const outbox = new OutboxLocal(':memory:');
    const buffer = construirXlsVendasBuffer([{ numero: '90002', debitado: '50,00' }]);
    const eventId = 'DEBT_CREATED:NEX:90002';
    // contentHash precisa bater exatamente com o que o modulo calcula -
    // usamos o proprio pipeline real (via avaliarArquivoVendasAuto) para
    // primeiro descobrir o contentHash esperado, registrando o checkpoint
    // so depois, com o hash correto extraido do resultado SKIP_UNSAFE
    // (CHECKPOINT_AUSENTE) da primeira chamada.
    const fsImpl = criarFakeFs({ 'vendas-auto-20260901-100000.xls': { buffer, mtimeMs: AGORA_MS - 10 * UM_DIA_MS } });
    const primeira = await avaliarArquivoVendasAuto({
      caminho: 'vendas-auto-20260901-100000.xls', nomeArquivo: 'vendas-auto-20260901-100000.xls',
      fsImpl, checkpoint, outbox, agoraMs: AGORA_MS, sleepImpl: sleepImediato,
    });
    registrar(check('T2-pre - sem checkpoint -> SKIP_UNSAFE/CHECKPOINT_AUSENTE', primeira.action === 'SKIP_UNSAFE' && primeira.reason === 'CHECKPOINT_AUSENTE'));

    // Descobre o contentHash real do jeito que o proprio orquestrador faria.
    const { lerExportVendas } = require(path.join(PROJETO, 'SERVICO', 'leitor-export-vendas'));
    const { normalizarVendaNex } = require(path.join(PROJETO, 'SRC', 'normalizar-venda-nex'));
    const { gerarChaveIdentidadeTransacaoNex } = require(path.join(PROJETO, 'SRC', 'identidade-transacao-nex'));
    const { classificarVenda } = require(path.join(PROJETO, 'SRC', 'classificador-evento-venda-nex'));
    const { gerarEventosVenda } = require(path.join(PROJETO, 'SRC', 'gerador-evento-venda-nex'));
    const { linhas } = lerExportVendas(buffer, { nomeArquivo: 'x.xls' });
    const vn = normalizarVendaNex(linhas[0]);
    const ident = gerarChaveIdentidadeTransacaoNex(vn);
    const classif = classificarVenda(vn);
    const eventos = gerarEventosVenda(vn, ident.identityKey, null, classif);
    const contentHash = calcularContentHashEvento(eventos[0]);
    registrar(check('T2 - eventId calculado bate com esperado', eventos[0].eventId === eventId));

    await checkpoint.registrarEvento({ eventId, contentHash, status: 'PROCESSADO_LOCALMENTE' });
    await checkpoint.atualizarEvento(eventId, { result: 'CREATED', httpStatus: 200 });

    const segunda = await avaliarArquivoVendasAuto({
      caminho: 'vendas-auto-20260901-100000.xls', nomeArquivo: 'vendas-auto-20260901-100000.xls',
      fsImpl, checkpoint, outbox, agoraMs: AGORA_MS, sleepImpl: sleepImediato,
    });
    registrar(check('T2 - checkpoint terminal confirmado -> WOULD_ARCHIVE', segunda.action === 'WOULD_ARCHIVE' && segunda.transactionCount === 1));
    checkpoint.fechar();
    outbox.fechar();
  }

  // ---- T3: checkpoint ausente -> SKIP_UNSAFE ---- (ja coberto acima como T2-pre, mas mantemos rotulo explicito)
  registrar(check('T3 - checkpoint ausente -> SKIP_UNSAFE (coberto por T2-pre)', true));

  // ---- T4/T5/T6: checkpoint terminal mas outbox nao-terminal -> SKIP_UNSAFE ----
  for (const statusOutbox of ['PENDING', 'RETRY', 'SENDING']) {
    const checkpoint = new CheckpointSqlite(':memory:');
    const outbox = new OutboxLocal(':memory:');
    const buffer = construirXlsVendasBuffer([{ numero: '90003', debitado: '50,00' }]);
    const fsImpl = criarFakeFs({ 'vendas-auto-20260901-100001.xls': { buffer, mtimeMs: AGORA_MS - 10 * UM_DIA_MS } });

    const { lerExportVendas } = require(path.join(PROJETO, 'SERVICO', 'leitor-export-vendas'));
    const { normalizarVendaNex } = require(path.join(PROJETO, 'SRC', 'normalizar-venda-nex'));
    const { gerarChaveIdentidadeTransacaoNex } = require(path.join(PROJETO, 'SRC', 'identidade-transacao-nex'));
    const { classificarVenda } = require(path.join(PROJETO, 'SRC', 'classificador-evento-venda-nex'));
    const { gerarEventosVenda } = require(path.join(PROJETO, 'SRC', 'gerador-evento-venda-nex'));
    const { linhas } = lerExportVendas(buffer, { nomeArquivo: 'x.xls' });
    const vn = normalizarVendaNex(linhas[0]);
    const ident = gerarChaveIdentidadeTransacaoNex(vn);
    const classif = classificarVenda(vn);
    const eventos = gerarEventosVenda(vn, ident.identityKey, null, classif);
    const eventId = eventos[0].eventId;
    const contentHash = calcularContentHashEvento(eventos[0]);

    await checkpoint.registrarEvento({ eventId, contentHash, status: 'PROCESSADO_LOCALMENTE' });
    await checkpoint.atualizarEvento(eventId, { result: 'CREATED', httpStatus: 200 });

    // Insere na outbox e forca o status desejado (PENDING e o estado
    // inicial do enqueue; para RETRY/SENDING, avanca via as transicoes
    // reais ja homologadas do proprio modulo, nunca escrevendo SQL cru).
    await outbox.enqueue({ eventId, contentHash, payload: { x: 1 } });
    if (statusOutbox === 'SENDING') {
      await outbox.claimNext(new Date(AGORA_MS));
    } else if (statusOutbox === 'RETRY') {
      await outbox.claimNext(new Date(AGORA_MS));
      await outbox.transicionar(eventId, 'RETRY', { ultimoErro: 'teste' });
    }

    const resultado = await avaliarArquivoVendasAuto({
      caminho: 'vendas-auto-20260901-100001.xls', nomeArquivo: 'vendas-auto-20260901-100001.xls',
      fsImpl, checkpoint, outbox, agoraMs: AGORA_MS, sleepImpl: sleepImediato,
    });
    registrar(check(`T4/5/6 - outbox ${statusOutbox} -> SKIP_UNSAFE/OUTBOX_NAO_TERMINAL`, resultado.action === 'SKIP_UNSAFE' && resultado.reason === 'OUTBOX_NAO_TERMINAL'));
    checkpoint.fechar();
    outbox.fechar();
  }

  // ---- T7: parse XLS falha -> SKIP_UNSAFE ----
  {
    const checkpoint = new CheckpointSqlite(':memory:');
    const outbox = new OutboxLocal(':memory:');
    const bufferInvalido = Buffer.from('nao e um xls valido');
    const fsImpl = criarFakeFs({ 'vendas-auto-20260901-100002.xls': { buffer: bufferInvalido, mtimeMs: AGORA_MS - 10 * UM_DIA_MS } });
    const resultado = await avaliarArquivoVendasAuto({
      caminho: 'vendas-auto-20260901-100002.xls', nomeArquivo: 'vendas-auto-20260901-100002.xls',
      fsImpl, checkpoint, outbox, agoraMs: AGORA_MS, sleepImpl: sleepImediato,
    });
    registrar(check('T7 - parse falha -> SKIP_UNSAFE', resultado.action === 'SKIP_UNSAFE'));
    checkpoint.fechar();
    outbox.fechar();
  }

  // ---- T8/T9/T10/T11: nomes fora do padrao -> IGNORE ----
  for (const nome of ['Exportar-dia-31-08.xls', 'clientes-nex.xls', 'extrato-cliente-292-20260906-062553.xls', 'Exportar-venda-30-08.xls']) {
    const checkpoint = new CheckpointSqlite(':memory:');
    const outbox = new OutboxLocal(':memory:');
    const fsImpl = criarFakeFs({});
    const resultado = await avaliarArquivoVendasAuto({
      caminho: nome, nomeArquivo: nome, fsImpl, checkpoint, outbox, agoraMs: AGORA_MS, sleepImpl: sleepImediato,
    });
    registrar(check(`T8/9/10/11 - ${nome} -> IGNORE`, resultado.action === 'IGNORE'));
    checkpoint.fechar();
    outbox.fechar();
  }

  // ---- T12/T13: archive delete por manifest ----
  {
    const manifestRecente = { 'vendas-auto-20260901-000000.xls': new Date(AGORA_MS - 10 * UM_DIA_MS).toISOString() };
    const r12 = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260901-000000.xls', manifest: manifestRecente, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    registrar(check('T12 - archive <30 dias -> KEEP', r12.action === 'KEEP'));

    const manifestAntigo = { 'vendas-auto-20260801-000000.xls': new Date(AGORA_MS - 31 * UM_DIA_MS).toISOString() };
    const r13 = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260801-000000.xls', manifest: manifestAntigo, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    registrar(check('T13 - archive >=30 dias -> WOULD_DELETE', r13.action === 'WOULD_DELETE'));
  }

  // ---- Manifest ausente -> SKIP_UNSAFE (nunca confia em mtime) ----
  {
    const r = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260801-000001.xls', manifest: {}, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    registrar(check('Archive sem manifest.archivedAt -> SKIP_UNSAFE (nunca confia em mtime)', r.action === 'SKIP_UNSAFE'));
  }

  // ---- T14/T15: dry-run nunca muta nada (garantido estruturalmente - nao existe fs.rename/unlink no modulo) ----
  {
    const fonte = require('fs').readFileSync(path.join(PROJETO, 'SERVICO', 'cleanup-exportados-nex.js'), 'utf8');
    registrar(check('T14/15 - modulo core nunca chama rename/unlink/rmSync/writeFile em EXPORTADOS/ARCHIVE', !/\brename|\bunlink|\brmSync|\bwriteFileSync|\bcopyFileSync/.test(fonte)));
  }

  // ---- T16: execucao repetida do dry-run e deterministica ----
  {
    const checkpoint = new CheckpointSqlite(':memory:');
    const outbox = new OutboxLocal(':memory:');
    const buffer = construirXlsVendasBuffer([{ numero: '90004', debitado: '50,00' }]);
    const fsImpl = criarFakeFs({ 'vendas-auto-20260901-100003.xls': { buffer, mtimeMs: AGORA_MS - 10 * UM_DIA_MS } });
    const r1 = await avaliarArquivoVendasAuto({ caminho: 'vendas-auto-20260901-100003.xls', nomeArquivo: 'vendas-auto-20260901-100003.xls', fsImpl, checkpoint, outbox, agoraMs: AGORA_MS, sleepImpl: sleepImediato });
    const r2 = await avaliarArquivoVendasAuto({ caminho: 'vendas-auto-20260901-100003.xls', nomeArquivo: 'vendas-auto-20260901-100003.xls', fsImpl, checkpoint, outbox, agoraMs: AGORA_MS, sleepImpl: sleepImediato });
    registrar(check('T16 - dry-run repetido e deterministico (mesmo action/reason)', r1.action === r2.action && r1.reason === r2.reason));
    checkpoint.fechar();
    outbox.fechar();
  }

  // ---- T17: nenhum segredo logado (source guard) ----
  {
    const fonteCore = require('fs').readFileSync(path.join(PROJETO, 'SERVICO', 'cleanup-exportados-nex.js'), 'utf8');
    const fonteCli = require('fs').readFileSync(path.join(PROJETO, 'SCRIPTS', 'cleanup-exportados-nex.js'), 'utf8');
    registrar(check('T17 - nenhum acesso a NEX_PRIME_INTEGRATION_SECRET', !fonteCore.includes('NEX_PRIME_INTEGRATION_SECRET') && !fonteCli.includes('NEX_PRIME_INTEGRATION_SECRET')));
  }

  // ---- T18: nenhum write SQLite (source guard) ----
  {
    const fonteCore = require('fs').readFileSync(path.join(PROJETO, 'SERVICO', 'cleanup-exportados-nex.js'), 'utf8');
    const chamaEscrita = /\.registrarEvento\(|\.atualizarEvento\(|\.enqueue\(|\.transicionar\(|\.registrarResultado\(|\.recuperarOrfaos\(|\.reabrirFailed\(/;
    registrar(check('T18 - modulo core nunca chama metodo de escrita de checkpoint/outbox', !chamaEscrita.test(fonteCore)));
  }

  // ---- Ambiguidade adicional: contentHash divergente -> SKIP_UNSAFE ----
  {
    const checkpoint = new CheckpointSqlite(':memory:');
    const outbox = new OutboxLocal(':memory:');
    const buffer = construirXlsVendasBuffer([{ numero: '90005', debitado: '50,00' }]);
    const fsImpl = criarFakeFs({ 'vendas-auto-20260901-100004.xls': { buffer, mtimeMs: AGORA_MS - 10 * UM_DIA_MS } });
    await checkpoint.registrarEvento({ eventId: 'DEBT_CREATED:NEX:90005', contentHash: 'hash-errado-de-proposito', status: 'PROCESSADO_LOCALMENTE' });
    await checkpoint.atualizarEvento('DEBT_CREATED:NEX:90005', { result: 'CREATED' });
    const resultado = await avaliarArquivoVendasAuto({
      caminho: 'vendas-auto-20260901-100004.xls', nomeArquivo: 'vendas-auto-20260901-100004.xls',
      fsImpl, checkpoint, outbox, agoraMs: AGORA_MS, sleepImpl: sleepImediato,
    });
    registrar(check('Extra - contentHash divergente -> SKIP_UNSAFE/CHECKPOINT_HASH_DIVERGENTE', resultado.action === 'SKIP_UNSAFE' && resultado.reason === 'CHECKPOINT_HASH_DIVERGENTE'));
    checkpoint.fechar();
    outbox.fechar();
  }

  // ---- Ambiguidade adicional: checkpoint com result nao confirmado (ex.: ERROR) -> SKIP_UNSAFE ----
  {
    const checkpoint = new CheckpointSqlite(':memory:');
    const outbox = new OutboxLocal(':memory:');
    const buffer = construirXlsVendasBuffer([{ numero: '90006', debitado: '50,00' }]);
    const fsImpl = criarFakeFs({ 'vendas-auto-20260901-100005.xls': { buffer, mtimeMs: AGORA_MS - 10 * UM_DIA_MS } });

    const { lerExportVendas } = require(path.join(PROJETO, 'SERVICO', 'leitor-export-vendas'));
    const { normalizarVendaNex } = require(path.join(PROJETO, 'SRC', 'normalizar-venda-nex'));
    const { gerarChaveIdentidadeTransacaoNex } = require(path.join(PROJETO, 'SRC', 'identidade-transacao-nex'));
    const { classificarVenda } = require(path.join(PROJETO, 'SRC', 'classificador-evento-venda-nex'));
    const { gerarEventosVenda } = require(path.join(PROJETO, 'SRC', 'gerador-evento-venda-nex'));
    const { linhas } = lerExportVendas(buffer, { nomeArquivo: 'x.xls' });
    const vn = normalizarVendaNex(linhas[0]);
    const ident = gerarChaveIdentidadeTransacaoNex(vn);
    const classif = classificarVenda(vn);
    const eventos = gerarEventosVenda(vn, ident.identityKey, null, classif);
    const contentHash = calcularContentHashEvento(eventos[0]);
    await checkpoint.registrarEvento({ eventId: eventos[0].eventId, contentHash, status: 'PROCESSADO_LOCALMENTE' });
    await checkpoint.atualizarEvento(eventos[0].eventId, { result: 'ERROR', httpStatus: 500 });

    const resultado = await avaliarArquivoVendasAuto({
      caminho: 'vendas-auto-20260901-100005.xls', nomeArquivo: 'vendas-auto-20260901-100005.xls',
      fsImpl, checkpoint, outbox, agoraMs: AGORA_MS, sleepImpl: sleepImediato,
    });
    registrar(check('Extra - checkpoint result=ERROR -> SKIP_UNSAFE/CHECKPOINT_RESULTADO_NAO_CONFIRMADO', resultado.action === 'SKIP_UNSAFE' && resultado.reason === 'CHECKPOINT_RESULTADO_NAO_CONFIRMADO'));
    checkpoint.fechar();
    outbox.fechar();
  }

  console.log('\n' + (todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'ALGUM TESTE FALHOU'));
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((erro) => {
  console.error('ERRO INESPERADO NO TESTE:', erro);
  process.exitCode = 1;
});
