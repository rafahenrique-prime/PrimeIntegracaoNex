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
const os = require('os');
const fs = require('fs');
const PROJETO = path.join(__dirname, '..');
const XLSX = require(path.join(PROJETO, 'node_modules', 'xlsx'));

const {
  nomeEhVendasAutoValido,
  avaliarArquivoVendasAuto,
  avaliarArquivoArchive,
  moverArquivoParaArchiveReal,
  entradaManifestoValida,
  calcularSha256DeBuffer,
} = require(path.join(PROJETO, 'SERVICO', 'cleanup-exportados-nex'));
const { CheckpointSqlite } = require(path.join(PROJETO, 'SERVICO', 'checkpoint-sqlite'));
const { OutboxLocal } = require(path.join(PROJETO, 'SERVICO', 'outbox-local'));
const { calcularContentHashEvento } = require(path.join(PROJETO, 'SERVICO', 'repositorio-eventos-http'));
const {
  lerManifestArchive,
  adquirirLockMoveReal,
  liberarLockMoveReal,
} = require(path.join(PROJETO, 'SCRIPTS', 'cleanup-exportados-nex'));

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

  // ---- Cleanup V2 Fase 0: schema do manifesto de archive com sha256 ----
  const SHA_VALIDO_A = 'a'.repeat(64);
  const SHA_VALIDO_B = 'B'.repeat(64); // maiuscula valida (regex case-insensitive), deve ser preservada exatamente na saida

  // ---- T12/T13: archive KEEP/WOULD_DELETE por manifest novo (archivedAt+sha256) ----
  {
    const manifestRecente = { 'vendas-auto-20260901-000000.xls': { archivedAt: new Date(AGORA_MS - 10 * UM_DIA_MS).toISOString(), sha256: SHA_VALIDO_A } };
    const r12 = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260901-000000.xls', manifest: manifestRecente, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    registrar(check('T12 - archive <30 dias -> KEEP', r12.action === 'KEEP'));
    registrar(check('A/F - sha256 minuscula preservado exatamente no resultado (KEEP)', r12.sha256 === SHA_VALIDO_A));

    const manifestAntigo = { 'vendas-auto-20260801-000000.xls': { archivedAt: new Date(AGORA_MS - 31 * UM_DIA_MS).toISOString(), sha256: SHA_VALIDO_B } };
    const r13 = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260801-000000.xls', manifest: manifestAntigo, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    registrar(check('T13 - archive >=30 dias -> WOULD_DELETE', r13.action === 'WOULD_DELETE'));
    registrar(check('A/F - sha256 maiuscula preservado exatamente no resultado (WOULD_DELETE)', r13.sha256 === SHA_VALIDO_B));
  }

  // ---- Manifest ausente -> SKIP_UNSAFE (nunca confia em mtime) ----
  {
    const r = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260801-000001.xls', manifest: {}, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    registrar(check('Archive sem manifest.archivedAt -> SKIP_UNSAFE (nunca confia em mtime)', r.action === 'SKIP_UNSAFE' && r.reason.startsWith('MANIFEST_ARCHIVED_AT_AUSENTE')));
  }

  // ---- D. archivedAt ausente (entrada e objeto, mas sem campo archivedAt) -> SKIP_UNSAFE ----
  {
    const manifest = { 'vendas-auto-20260801-000002.xls': { sha256: SHA_VALIDO_A } };
    const r = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260801-000002.xls', manifest, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    registrar(check('D - archivedAt ausente (entrada objeto sem archivedAt) -> SKIP_UNSAFE/MANIFEST_ARCHIVED_AT_AUSENTE', r.action === 'SKIP_UNSAFE' && r.reason.startsWith('MANIFEST_ARCHIVED_AT_AUSENTE')));
  }

  // ---- E. archivedAt invalido -> SKIP_UNSAFE ----
  {
    const manifest = { 'vendas-auto-20260801-000003.xls': { archivedAt: 'nao-e-uma-data', sha256: SHA_VALIDO_A } };
    const r = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260801-000003.xls', manifest, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    registrar(check('E - archivedAt invalido -> SKIP_UNSAFE/MANIFEST_ARCHIVED_AT_INVALIDO', r.action === 'SKIP_UNSAFE' && r.reason === 'MANIFEST_ARCHIVED_AT_INVALIDO'));
  }

  // ---- B. sha256 ausente (archivedAt valido, sem sha256) -> SKIP_UNSAFE ----
  {
    const manifest = { 'vendas-auto-20260801-000004.xls': { archivedAt: new Date(AGORA_MS - 31 * UM_DIA_MS).toISOString() } };
    const r = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260801-000004.xls', manifest, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    registrar(check('B - sha256 ausente -> SKIP_UNSAFE/MANIFEST_SHA256_AUSENTE', r.action === 'SKIP_UNSAFE' && r.reason.startsWith('MANIFEST_SHA256_AUSENTE')));
  }

  // ---- C. sha256 invalido (formato estrutural errado, mas nao vazio) -> SKIP_UNSAFE/MANIFEST_SHA256_INVALIDO ----
  for (const shaInvalido of ['abc123', SHA_VALIDO_A.slice(0, 63), `${SHA_VALIDO_A.slice(0, 63)}g`]) {
    const manifest = { 'vendas-auto-20260801-000005.xls': { archivedAt: new Date(AGORA_MS - 31 * UM_DIA_MS).toISOString(), sha256: shaInvalido } };
    const r = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260801-000005.xls', manifest, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    registrar(check(`C - sha256 invalido ("${shaInvalido}") -> SKIP_UNSAFE/MANIFEST_SHA256_INVALIDO`, r.action === 'SKIP_UNSAFE' && r.reason.startsWith('MANIFEST_SHA256_INVALIDO')));
  }

  // ---- B2. sha256 somente espacos -> tratado como AUSENTE (mesmo criterio de blank de ehPlaceholder), nao INVALIDO ----
  {
    const manifest = { 'vendas-auto-20260801-000008.xls': { archivedAt: new Date(AGORA_MS - 31 * UM_DIA_MS).toISOString(), sha256: '   ' } };
    const r = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260801-000008.xls', manifest, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    registrar(check('B2 - sha256 somente espacos -> SKIP_UNSAFE/MANIFEST_SHA256_AUSENTE', r.action === 'SKIP_UNSAFE' && r.reason.startsWith('MANIFEST_SHA256_AUSENTE')));
  }

  // ---- I. formato legado hipotetico (string ISO pura, sem sha256) - nao existe nenhum manifesto real/legado
  // nesta instalacao (verificado antes desta mudanca); mesmo assim, a leitura tolera o formato antigo sem
  // lancar, mas NUNCA o trata como completo. ----
  {
    const manifest = { 'vendas-auto-20260801-000006.xls': new Date(AGORA_MS - 31 * UM_DIA_MS).toISOString() };
    let lancou = false;
    let r;
    try {
      r = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260801-000006.xls', manifest, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    } catch (erro) {
      lancou = true;
    }
    registrar(check('I - formato legado (string ISO pura) nao lanca excecao', !lancou));
    registrar(check('I - formato legado (string ISO pura) -> sempre SKIP_UNSAFE/MANIFEST_SHA256_AUSENTE (nunca aceito como completo)', !!r && r.action === 'SKIP_UNSAFE' && r.reason.startsWith('MANIFEST_SHA256_AUSENTE')));
  }

  // ---- J. manifesto corrompido (entrada nem string nem objeto util) -> fail-closed, nunca lanca ----
  for (const entradaCorrompida of [42, ['x'], true]) {
    const manifest = { 'vendas-auto-20260801-000007.xls': entradaCorrompida };
    let lancou = false;
    let r;
    try {
      r = avaliarArquivoArchive({ nomeArquivo: 'vendas-auto-20260801-000007.xls', manifest, agoraMs: AGORA_MS, deleteAfterDays: 30 });
    } catch (erro) {
      lancou = true;
    }
    registrar(check(`J - manifesto corrompido (${JSON.stringify(entradaCorrompida)}) nao lanca excecao`, !lancou));
    registrar(check(`J - manifesto corrompido (${JSON.stringify(entradaCorrompida)}) -> SKIP_UNSAFE`, !!r && r.action === 'SKIP_UNSAFE'));
  }

  // ---- T14/T15: as funcoes de DECISAO (dry-run: avaliarArquivoVendasAuto/
  // avaliarArquivoArchive) nunca mutam nada - escopo do regex e' SOMENTE
  // essas duas funcoes, nunca o arquivo inteiro (que agora TEM mutacao
  // real intencional e gated em moverArquivoParaArchiveReal, Cleanup V2
  // Fase 1 - ver M14 abaixo para a guarda positiva correspondente). ----
  {
    const fonte = require('fs').readFileSync(path.join(PROJETO, 'SERVICO', 'cleanup-exportados-nex.js'), 'utf8');
    const inicioDecisao = fonte.indexOf('async function avaliarArquivoVendasAuto');
    const fimDecisao = fonte.indexOf('function statSeguro');
    registrar(check('T14/15 - inicio/fim das funcoes de decisao encontrados no source (guarda nao-vazia)', inicioDecisao > -1 && fimDecisao > inicioDecisao));
    const trechoDecisao = fonte.slice(inicioDecisao, fimDecisao);
    registrar(check('T14/15 - avaliarArquivoVendasAuto/avaliarArquivoArchive (decisao/dry-run) nunca chamam rename/unlink/link/rmSync/writeFile', !/\brename|\bunlink|\blinkSync|\brmSync|\bwriteFileSync|\bcopyFileSync/.test(trechoDecisao)));
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

  // ================================================================
  // Cleanup V2 Fase 1 - MOVE REAL. TODOS os testes de mutacao abaixo
  // usam SOMENTE diretorios sob os.tmpdir() (fs.mkdtempSync) - NUNCA
  // C:\Nex\PrimeIntegracaoNex\EXPORTADOS nem EXPORT_ARCHIVE reais.
  // ================================================================

  function criarSandboxMoveReal() {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-v2-move-real-'));
    const exportadosDir = path.join(raiz, 'EXPORTADOS');
    const archiveDir = path.join(raiz, 'EXPORT_ARCHIVE');
    fs.mkdirSync(exportadosDir, { recursive: true });
    return { raiz, exportadosDir, archiveDir, manifestPath: path.join(archiveDir, 'manifest.json') };
  }

  function limparSandbox(raiz) {
    fs.rmSync(raiz, { recursive: true, force: true });
  }

  /** fsImpl que delega ao fs real, exceto os metodos sobrepostos - usado
   * SOMENTE para simular, de forma isolada e explicita, condicoes que nao
   * podem ser reproduzidas de forma portavel neste ambiente de teste
   * (EXDEV sem um segundo volume real disponivel; symlink/reparse point
   * sem privilegio elevado no Windows). Testa NOSSA logica de reacao a
   * esses erros, nao a garantia do SO em si (que e' documentada e
   * assumida, nao reimplementada aqui). */
  function fsRealComOverrides(overrides) {
    const base = {
      statSync: (...a) => fs.statSync(...a),
      lstatSync: (...a) => fs.lstatSync(...a),
      readFileSync: (...a) => fs.readFileSync(...a),
      writeFileSync: (...a) => fs.writeFileSync(...a),
      linkSync: (...a) => fs.linkSync(...a),
      unlinkSync: (...a) => fs.unlinkSync(...a),
      renameSync: (...a) => fs.renameSync(...a),
      mkdirSync: (...a) => fs.mkdirSync(...a),
    };
    return Object.assign(base, overrides);
  }

  // ---- M1/M2: happy path (Estado A) real + segunda execucao idempotente (Estado F) ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95001', debitado: '10,00' }]);
    const nome = 'vendas-auto-20260801-090000.xls';
    fs.writeFileSync(path.join(sb.exportadosDir, nome), buffer);
    const sha256 = calcularSha256DeBuffer(buffer);

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: sha256, manifestAtual: {}, agoraMs: AGORA_MS,
    });
    registrar(check('M1 - happy path (Estado A) -> ARCHIVED_REAL', resultado.action === 'ARCHIVED_REAL'));
    registrar(check('M1 - source removido apos move real', !fs.existsSync(path.join(sb.exportadosDir, nome))));
    registrar(check('M1 - dest existe apos move real', fs.existsSync(path.join(sb.archiveDir, nome))));
    registrar(check('M1 - conteudo do dest identico ao original (nunca corrompido)', fs.readFileSync(path.join(sb.archiveDir, nome)).equals(buffer)));
    const manifestDisco = JSON.parse(fs.readFileSync(sb.manifestPath, 'utf8'));
    registrar(check('M1 - manifest.json escrito e estruturalmente valido', entradaManifestoValida(manifestDisco[nome])));
    registrar(check('M1 - sha256 no manifesto bate com o arquivo', manifestDisco[nome].sha256 === sha256));
    registrar(check('PL1 - happy path passou pela revalidacao pos-link silenciosamente (POST_LINK_HASH_REVALIDATION=PASS)', resultado.action === 'ARCHIVED_REAL'));

    const resultado2 = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: sha256, manifestAtual: manifestDisco, agoraMs: AGORA_MS + UM_DIA_MS,
    });
    registrar(check('M2 - segunda execucao (Estado F) -> JA_CONCLUIDO (idempotente)', resultado2.action === 'JA_CONCLUIDO'));
    const manifestDisco2 = JSON.parse(fs.readFileSync(sb.manifestPath, 'utf8'));
    registrar(check('M2 - manifest NAO foi reescrito/alterado na segunda execucao', JSON.stringify(manifestDisco2) === JSON.stringify(manifestDisco)));
    registrar(check('M2 - dest continua com o mesmo conteudo (nunca duplicado/sobrescrito)', fs.readFileSync(path.join(sb.archiveDir, nome)).equals(buffer)));
    limparSandbox(sb.raiz);
  }

  // ---- PL2 (GAP FINAL 1): revalidacao POS-LINK detecta divergencia mesmo
  // quando o Gate 7/TOCTOU (reler o source ANTES do link) ja passou -
  // simula algo alterando o conteudo IMEDIATAMENTE apos o linkSync (como
  // e' hard link, mesmo inode - a alteracao aparece em source E dest) ----
  {
    const sb = criarSandboxMoveReal();
    const bufferOriginal = construirXlsVendasBuffer([{ numero: '95016', debitado: '85,00' }]);
    const bufferAlterado = construirXlsVendasBuffer([{ numero: '95016', debitado: '999999,00' }]);
    const nome = 'vendas-auto-20260801-090015.xls';
    const sourcePath = path.join(sb.exportadosDir, nome);
    const destPath = path.join(sb.archiveDir, nome);
    fs.writeFileSync(sourcePath, bufferOriginal);
    const shaOriginal = calcularSha256DeBuffer(bufferOriginal);

    const fsSimulado = fsRealComOverrides({
      linkSync: (source, dest) => {
        fs.linkSync(source, dest);
        // Simula uma alteracao no conteudo IMEDIATAMENTE apos o hard link
        // (cenario extremamente raro - algo escreveu no inode compartilhado
        // entre o link e a revalidacao pos-link).
        fs.writeFileSync(dest, bufferAlterado);
      },
    });

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: shaOriginal, manifestAtual: {}, agoraMs: AGORA_MS, fsImpl: fsSimulado,
    });
    registrar(check('PL2 - revalidacao pos-link detecta divergencia -> SKIP_UNSAFE/POST_LINK_HASH_DIVERGENTE', resultado.action === 'SKIP_UNSAFE' && resultado.reason.startsWith('POST_LINK_HASH_DIVERGENTE')));
    registrar(check('PL2 - manifest.json NAO foi criado (POST_LINK_DIVERGENCE_MANIFEST_WRITTEN=NO)', !fs.existsSync(sb.manifestPath)));
    registrar(check('PL2 - source/dest permanecem intactos (hard link nunca desfeito, POST_LINK_DIVERGENCE_SOURCE_UNLINKED=NO) para reconciliacao pela proxima execucao', fs.existsSync(sourcePath) && fs.existsSync(destPath)));
    limparSandbox(sb.raiz);
  }

  // ---- M3: TOCTOU - hash mudou entre a decisao e a acao -> SKIP_UNSAFE, zero mutacao ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95002', debitado: '20,00' }]);
    const nome = 'vendas-auto-20260801-090001.xls';
    const sourcePath = path.join(sb.exportadosDir, nome);
    fs.writeFileSync(sourcePath, buffer);
    const shaErrado = 'f'.repeat(64); // deliberadamente nao bate com o conteudo real do arquivo

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: shaErrado, manifestAtual: {}, agoraMs: AGORA_MS,
    });
    registrar(check('M3 - TOCTOU hash divergente -> SKIP_UNSAFE/TOCTOU_HASH_DIVERGENTE', resultado.action === 'SKIP_UNSAFE' && resultado.reason.startsWith('TOCTOU_HASH_DIVERGENTE')));
    registrar(check('M3 - source preservado (nada movido)', fs.existsSync(sourcePath)));
    registrar(check('M3 - dest NUNCA criado', !fs.existsSync(path.join(sb.archiveDir, nome))));
    limparSandbox(sb.raiz);
  }

  // ---- M4: destino ja existe, hash IGUAL, manifesto AUSENTE (Estado B - crash entre link e manifesto) ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95003', debitado: '30,00' }]);
    const nome = 'vendas-auto-20260801-090002.xls';
    const sourcePath = path.join(sb.exportadosDir, nome);
    const destPath = path.join(sb.archiveDir, nome);
    fs.writeFileSync(sourcePath, buffer);
    fs.mkdirSync(sb.archiveDir, { recursive: true });
    fs.writeFileSync(destPath, buffer); // simula: link ja foi feito, processo morreu ANTES do manifesto
    const sha256 = calcularSha256DeBuffer(buffer);

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: sha256, manifestAtual: {}, agoraMs: AGORA_MS,
    });
    registrar(check('M4 - Estado B (dest igual, sem manifest) -> ARCHIVED_REAL/RECUPERADO_APOS_CRASH_ENTRE_LINK_E_MANIFESTO', resultado.action === 'ARCHIVED_REAL' && resultado.reason === 'RECUPERADO_APOS_CRASH_ENTRE_LINK_E_MANIFESTO'));
    registrar(check('M4 - source removido apos recuperacao (etapa concluida)', !fs.existsSync(sourcePath)));
    const manifestDisco = JSON.parse(fs.readFileSync(sb.manifestPath, 'utf8'));
    registrar(check('M4 - manifest escrito corretamente na recuperacao', entradaManifestoValida(manifestDisco[nome]) && manifestDisco[nome].sha256 === sha256));
    limparSandbox(sb.raiz);
  }

  // ---- M5: destino ja existe, hash IGUAL, manifesto JA VALIDO (Estado D - crash antes de remover origem) ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95004', debitado: '40,00' }]);
    const nome = 'vendas-auto-20260801-090003.xls';
    const sourcePath = path.join(sb.exportadosDir, nome);
    const destPath = path.join(sb.archiveDir, nome);
    fs.writeFileSync(sourcePath, buffer);
    fs.mkdirSync(sb.archiveDir, { recursive: true });
    fs.writeFileSync(destPath, buffer);
    const sha256 = calcularSha256DeBuffer(buffer);
    const archivedAtOriginal = new Date(AGORA_MS - 5 * UM_DIA_MS).toISOString();
    const manifestPrevio = { [nome]: { archivedAt: archivedAtOriginal, sha256 } };
    fs.writeFileSync(sb.manifestPath, JSON.stringify(manifestPrevio));

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: sha256, manifestAtual: manifestPrevio, agoraMs: AGORA_MS,
    });
    registrar(check('M5 - Estado D (dest+manifest ja validos) -> ARCHIVED_REAL/RECUPERADO_APOS_CRASH_ANTES_DE_REMOVER_ORIGEM', resultado.action === 'ARCHIVED_REAL' && resultado.reason === 'RECUPERADO_APOS_CRASH_ANTES_DE_REMOVER_ORIGEM'));
    registrar(check('M5 - source removido', !fs.existsSync(sourcePath)));
    const manifestDisco = JSON.parse(fs.readFileSync(sb.manifestPath, 'utf8'));
    registrar(check('M5 - archivedAt PRESERVADO (retencao NAO reiniciada)', manifestDisco[nome].archivedAt === archivedAtOriginal));
    limparSandbox(sb.raiz);
  }

  // ---- D1: Estado D com manifesto estruturalmente valido mas sha256
  // DIVERGENTE do conteudo real (GAP 2 - nunca confiar so' na validade
  // estrutural) -> SKIP_UNSAFE, origem NUNCA removida ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95012', debitado: '45,00' }]);
    const nome = 'vendas-auto-20260801-090011.xls';
    const sourcePath = path.join(sb.exportadosDir, nome);
    const destPath = path.join(sb.archiveDir, nome);
    fs.writeFileSync(sourcePath, buffer);
    fs.mkdirSync(sb.archiveDir, { recursive: true });
    fs.writeFileSync(destPath, buffer); // dest identico ao source
    const shaReal = calcularSha256DeBuffer(buffer);
    const shaFalsoNoManifesto = 'c'.repeat(64); // estruturalmente valido, mas NAO bate com o conteudo real
    const manifestComShaErrado = { [nome]: { archivedAt: new Date(AGORA_MS - UM_DIA_MS).toISOString(), sha256: shaFalsoNoManifesto } };

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: shaReal, manifestAtual: manifestComShaErrado, agoraMs: AGORA_MS,
    });
    registrar(check('D1 - manifesto valido mas sha256 divergente do conteudo real -> SKIP_UNSAFE/MANIFEST_DEST_HASH_DIVERGENTE', resultado.action === 'SKIP_UNSAFE' && resultado.reason.startsWith('MANIFEST_DEST_HASH_DIVERGENTE')));
    registrar(check('D1 - source PRESERVADO (nunca removido com manifesto suspeito)', fs.existsSync(sourcePath)));
    registrar(check('D1 - manifest.json em disco NAO foi tocado (a chamada nunca chegou a escrever)', !fs.existsSync(sb.manifestPath)));
    limparSandbox(sb.raiz);
  }

  // ---- M6: destino ja existe, hash DIFERENTE (Estado C - conflito, bloquear, NUNCA sobrescrever) ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95005', debitado: '50,00' }]);
    const bufferDiferente = construirXlsVendasBuffer([{ numero: '95005', debitado: '999,00' }]);
    const nome = 'vendas-auto-20260801-090004.xls';
    const sourcePath = path.join(sb.exportadosDir, nome);
    const destPath = path.join(sb.archiveDir, nome);
    fs.writeFileSync(sourcePath, buffer);
    fs.mkdirSync(sb.archiveDir, { recursive: true });
    fs.writeFileSync(destPath, bufferDiferente);
    const sha256 = calcularSha256DeBuffer(buffer);

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: sha256, manifestAtual: {}, agoraMs: AGORA_MS,
    });
    registrar(check('M6 - Estado C (conflito de hash) -> SKIP_UNSAFE/CONFLITO_DESTINO_HASH_DIVERGENTE', resultado.action === 'SKIP_UNSAFE' && resultado.reason.startsWith('CONFLITO_DESTINO_HASH_DIVERGENTE')));
    registrar(check('M6 - dest NUNCA sobrescrito (conteudo original do conflito preservado)', fs.readFileSync(destPath).equals(bufferDiferente)));
    registrar(check('M6 - source preservado (nao removido apos bloqueio)', fs.existsSync(sourcePath)));
    limparSandbox(sb.raiz);
  }

  // ---- M7: source ausente, dest existe, manifesto AUSENTE (Estado E -
  // CORRIGIDO antes do commit: NUNCA auto-oficializar um orfao sem prova
  // de origem - backfill automatico removido, agora exige revisao humana) ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95006', debitado: '60,00' }]);
    const nome = 'vendas-auto-20260801-090005.xls';
    const destPath = path.join(sb.archiveDir, nome);
    fs.mkdirSync(sb.archiveDir, { recursive: true });
    fs.writeFileSync(destPath, buffer); // source NUNCA existiu neste sandbox; manifesto ausente
    const shaDest = calcularSha256DeBuffer(buffer);

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: shaDest, manifestAtual: {}, agoraMs: AGORA_MS,
    });
    registrar(check('M7 - Estado E (orfao sem manifesto) -> SKIP_UNSAFE/ORFAO_ARCHIVE_REQUER_REVISAO_HUMANA (nunca auto-oficializado)', resultado.action === 'SKIP_UNSAFE' && resultado.reason.startsWith('ORFAO_ARCHIVE_REQUER_REVISAO_HUMANA')));
    registrar(check('M7 - NENHUM manifest.json foi criado (backfill automatico removido)', !fs.existsSync(sb.manifestPath)));
    registrar(check('M7 - dest preservado, byte-identico, nunca tocado', fs.readFileSync(destPath).equals(buffer)));
    limparSandbox(sb.raiz);
  }

  // ---- F1: Estado F com manifesto estruturalmente valido mas sha256
  // DIVERGENTE do conteudo real do destino (GAP 2) -> SKIP_UNSAFE, dest e
  // manifesto preservados, NADA reescrito ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95013', debitado: '55,00' }]);
    const nome = 'vendas-auto-20260801-090012.xls';
    const destPath = path.join(sb.archiveDir, nome);
    fs.mkdirSync(sb.archiveDir, { recursive: true });
    fs.writeFileSync(destPath, buffer); // source ja removido (fluxo normal apos um ARCHIVED_REAL anterior)
    const shaFalsoNoManifesto = 'd'.repeat(64); // estruturalmente valido, mas NAO bate com o dest real
    const manifestComShaErrado = { [nome]: { archivedAt: new Date(AGORA_MS - 2 * UM_DIA_MS).toISOString(), sha256: shaFalsoNoManifesto } };
    const manifestJsonOriginal = JSON.stringify(manifestComShaErrado);
    fs.writeFileSync(sb.manifestPath, manifestJsonOriginal);

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: undefined, manifestAtual: manifestComShaErrado, agoraMs: AGORA_MS,
    });
    registrar(check('F1 - manifesto valido mas sha256 nao bate com o dest real -> SKIP_UNSAFE/MANIFEST_DEST_HASH_DIVERGENTE', resultado.action === 'SKIP_UNSAFE' && resultado.reason.startsWith('MANIFEST_DEST_HASH_DIVERGENTE')));
    registrar(check('F1 - manifest.json em disco preservado BYTE-IDENTICO (nunca reescrito)', fs.readFileSync(sb.manifestPath, 'utf8') === manifestJsonOriginal));
    registrar(check('F1 - dest preservado, byte-identico, nunca tocado', fs.readFileSync(destPath).equals(buffer)));
    limparSandbox(sb.raiz);
  }

  // ---- M8: manifesto ja diz "arquivado", mas dest NAO existe -> inconsistencia, nunca resolver sozinho ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95007', debitado: '70,00' }]);
    const nome = 'vendas-auto-20260801-090006.xls';
    const sourcePath = path.join(sb.exportadosDir, nome);
    fs.writeFileSync(sourcePath, buffer);
    const sha256 = calcularSha256DeBuffer(buffer);
    const manifestFalso = { [nome]: { archivedAt: new Date(AGORA_MS - UM_DIA_MS).toISOString(), sha256 } };

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: sha256, manifestAtual: manifestFalso, agoraMs: AGORA_MS,
    });
    registrar(check('M8 - manifest diz arquivado mas dest ausente -> SKIP_UNSAFE/MANIFEST_INCONSISTENTE_SEM_DEST', resultado.action === 'SKIP_UNSAFE' && resultado.reason.startsWith('MANIFEST_INCONSISTENTE_SEM_DEST')));
    registrar(check('M8 - source preservado, nada movido', fs.existsSync(sourcePath)));
    registrar(check('M8 - dest continua nao existindo (nunca criado sem entender a inconsistencia)', !fs.existsSync(path.join(sb.archiveDir, nome))));
    limparSandbox(sb.raiz);
  }

  // ---- M9: EXDEV simulado (mesmo volume nao comprovado) - so' 1 volume real disponivel neste ambiente de teste ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95008', debitado: '80,00' }]);
    const nome = 'vendas-auto-20260801-090007.xls';
    const sourcePath = path.join(sb.exportadosDir, nome);
    fs.writeFileSync(sourcePath, buffer);
    const sha256 = calcularSha256DeBuffer(buffer);

    const fsSimulado = fsRealComOverrides({
      linkSync: () => {
        const erro = new Error('EXDEV: cross-device link not permitted (simulado - ambiente de teste so tem 1 volume real)');
        erro.code = 'EXDEV';
        throw erro;
      },
    });

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: sha256, manifestAtual: {}, agoraMs: AGORA_MS, fsImpl: fsSimulado,
    });
    registrar(check('M9 - EXDEV simulado -> SKIP_UNSAFE/VOLUMES_DIFERENTES (nunca cai para copy+delete)', resultado.action === 'SKIP_UNSAFE' && resultado.reason.startsWith('VOLUMES_DIFERENTES')));
    registrar(check('M9 - source preservado', fs.existsSync(sourcePath)));
    registrar(check('M9 - dest NUNCA criado', !fs.existsSync(path.join(sb.archiveDir, nome))));
    limparSandbox(sb.raiz);
  }

  // ---- M10: path traversal / nomeArquivo fora da raiz -> SKIP_UNSAFE/PATH_CONTAINMENT (defesa em profundidade dentro da propria funcao) ----
  {
    const sb = criarSandboxMoveReal();
    const nomeMalicioso = `..${path.sep}evil.xls`;
    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nomeMalicioso, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: 'x'.repeat(64), manifestAtual: {}, agoraMs: AGORA_MS,
    });
    registrar(check('M10 - path traversal em nomeArquivo -> SKIP_UNSAFE/PATH_CONTAINMENT_SOURCE_INVALIDO', resultado.action === 'SKIP_UNSAFE' && resultado.reason === 'PATH_CONTAINMENT_SOURCE_INVALIDO'));
    limparSandbox(sb.raiz);
  }

  // ---- M11: symlink/reparse point rejeitado (simulado via lstat override - Windows exige privilegio elevado para criar symlink real) ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95009', debitado: '90,00' }]);
    const nome = 'vendas-auto-20260801-090008.xls';
    const sourcePath = path.join(sb.exportadosDir, nome);
    fs.writeFileSync(sourcePath, buffer);
    const sha256 = calcularSha256DeBuffer(buffer);

    const fsSimulado = fsRealComOverrides({
      lstatSync: (caminho) => {
        const st = fs.lstatSync(caminho);
        if (path.resolve(String(caminho)) === path.resolve(sourcePath)) {
          return Object.assign(st, { isSymbolicLink: () => true });
        }
        return st;
      },
    });

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: sha256, manifestAtual: {}, agoraMs: AGORA_MS, fsImpl: fsSimulado,
    });
    registrar(check('M11 - source symlink/reparse simulado -> SKIP_UNSAFE/SYMLINK_OU_REPARSE_POINT_REJEITADO', resultado.action === 'SKIP_UNSAFE' && resultado.reason === 'SYMLINK_OU_REPARSE_POINT_REJEITADO'));
    registrar(check('M11 - source preservado (nunca seguido/movido)', fs.existsSync(sourcePath)));
    limparSandbox(sb.raiz);
  }

  // ---- R1: SOURCE_DIR (a RAIZ, nao um arquivo) simulado como
  // symlink/reparse point -> SKIP_UNSAFE, zero mutacao (defesa adicional
  // pedida no hardening pre-commit) ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95014', debitado: '65,00' }]);
    const nome = 'vendas-auto-20260801-090013.xls';
    const sourcePath = path.join(sb.exportadosDir, nome);
    fs.writeFileSync(sourcePath, buffer);
    const sha256 = calcularSha256DeBuffer(buffer);

    const fsSimulado = fsRealComOverrides({
      lstatSync: (caminho) => {
        const st = fs.lstatSync(caminho);
        if (path.resolve(String(caminho)) === path.resolve(sb.exportadosDir)) {
          return Object.assign(st, { isSymbolicLink: () => true });
        }
        return st;
      },
    });

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: sha256, manifestAtual: {}, agoraMs: AGORA_MS, fsImpl: fsSimulado,
    });
    registrar(check('R1 - SOURCE_DIR (raiz) symlink/reparse simulado -> SKIP_UNSAFE/SOURCE_ROOT_REPARSE_REJEITADO', resultado.action === 'SKIP_UNSAFE' && resultado.reason.startsWith('SOURCE_ROOT_REPARSE_REJEITADO')));
    registrar(check('R1 - source preservado, dest NUNCA criado', fs.existsSync(sourcePath) && !fs.existsSync(path.join(sb.archiveDir, nome))));
    limparSandbox(sb.raiz);
  }

  // ---- R2: ARCHIVE_DIR (a RAIZ) simulado como symlink/reparse point
  // (diretorio ja existe) -> SKIP_UNSAFE, zero mutacao ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95015', debitado: '75,00' }]);
    const nome = 'vendas-auto-20260801-090014.xls';
    const sourcePath = path.join(sb.exportadosDir, nome);
    fs.writeFileSync(sourcePath, buffer);
    fs.mkdirSync(sb.archiveDir, { recursive: true }); // precisa existir para o lstat ter algo a "substituir"
    const sha256 = calcularSha256DeBuffer(buffer);

    const fsSimulado = fsRealComOverrides({
      lstatSync: (caminho) => {
        const st = fs.lstatSync(caminho);
        if (path.resolve(String(caminho)) === path.resolve(sb.archiveDir)) {
          return Object.assign(st, { isSymbolicLink: () => true });
        }
        return st;
      },
    });

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: sha256, manifestAtual: {}, agoraMs: AGORA_MS, fsImpl: fsSimulado,
    });
    registrar(check('R2 - ARCHIVE_DIR (raiz) symlink/reparse simulado -> SKIP_UNSAFE/ARCHIVE_ROOT_REPARSE_REJEITADO', resultado.action === 'SKIP_UNSAFE' && resultado.reason.startsWith('ARCHIVE_ROOT_REPARSE_REJEITADO')));
    registrar(check('R2 - source preservado (nunca movido)', fs.existsSync(sourcePath)));
    limparSandbox(sb.raiz);
  }

  // ---- M12: manifesto corrompido no disco -> lerManifestArchive() (camada
  // CLI, SCRIPTS/cleanup-exportados-nex.js) FALHA-FECHADO explicitamente
  // (GAP 1 - CORRIGIDO antes do commit: NUNCA tratar corrompido como {}
  // e seguir para MOVE - o correto e' abortar SEM nenhuma mutacao) ----
  {
    const sb = criarSandboxMoveReal();
    fs.mkdirSync(sb.archiveDir, { recursive: true });
    const conteudoCorrompido = 'isto nao e um JSON valido {{{';
    fs.writeFileSync(sb.manifestPath, conteudoCorrompido);

    let lancou = false;
    let codigoErro = null;
    try {
      lerManifestArchive(sb.manifestPath);
    } catch (erro) {
      lancou = true;
      codigoErro = erro.code;
    }
    registrar(check('M12 - manifest.json corrompido (JSON invalido) -> lerManifestArchive lanca (fail-closed)', lancou));
    registrar(check('M12 - erro tem code MANIFEST_CORROMPIDO_FAIL_CLOSED', codigoErro === 'MANIFEST_CORROMPIDO_FAIL_CLOSED'));
    registrar(check('M12 - manifest.json preservado BYTE-IDENTICO (lerManifestArchive nunca escreve)', fs.readFileSync(sb.manifestPath, 'utf8') === conteudoCorrompido));

    // Raiz nao-objeto (ex.: um array como JSON raiz) tambem e' fail-closed,
    // nunca tratado como {}.
    fs.writeFileSync(sb.manifestPath, '[1,2,3]');
    let lancou2 = false;
    try {
      lerManifestArchive(sb.manifestPath);
    } catch (erro) {
      lancou2 = true;
    }
    registrar(check('M12b - manifest.json com raiz nao-objeto (array) -> lerManifestArchive lanca (fail-closed)', lancou2));

    // Manifesto AUSENTE continua sendo estado inicial valido ({}), nunca confundido com corrupcao.
    fs.rmSync(sb.manifestPath, { force: true });
    let semLancar = null;
    let lancou3 = false;
    try {
      semLancar = lerManifestArchive(sb.manifestPath);
    } catch (erro) {
      lancou3 = true;
    }
    registrar(check('M12c - manifest.json AUSENTE -> {} (estado inicial valido, nunca lanca)', !lancou3 && semLancar && Object.keys(semLancar).length === 0));

    limparSandbox(sb.raiz);
  }

  // ---- M13: manifesto com entrada conflitante para OUTRO arquivo - preservada intacta, nunca "corrigida" silenciosamente ----
  {
    const sb = criarSandboxMoveReal();
    const buffer = construirXlsVendasBuffer([{ numero: '95011', debitado: '25,00' }]);
    const nome = 'vendas-auto-20260801-090010.xls';
    fs.writeFileSync(path.join(sb.exportadosDir, nome), buffer);
    const sha256 = calcularSha256DeBuffer(buffer);
    const manifestComLixoAlheio = { 'vendas-auto-99999999-999999.xls': 'entrada-em-formato-completamente-invalido' };

    const resultado = moverArquivoParaArchiveReal({
      nomeArquivo: nome, exportadosDir: sb.exportadosDir, archiveDir: sb.archiveDir,
      manifestPath: sb.manifestPath, sha256Esperado: sha256, manifestAtual: manifestComLixoAlheio, agoraMs: AGORA_MS,
    });
    registrar(check('M13 - move real ignora entrada invalida de OUTRO arquivo no manifesto', resultado.action === 'ARCHIVED_REAL'));
    const manifestDisco = JSON.parse(fs.readFileSync(sb.manifestPath, 'utf8'));
    registrar(check('M13 - entrada alheia (invalida) preservada INTACTA, nunca removida/corrigida silenciosamente', manifestDisco['vendas-auto-99999999-999999.xls'] === 'entrada-em-formato-completamente-invalido'));
    registrar(check('M13 - nova entrada do arquivo processado escrita corretamente ao lado da entrada alheia', entradaManifestoValida(manifestDisco[nome])));
    limparSandbox(sb.raiz);
  }

  // ---- M14: guarda positiva - moverArquivoParaArchiveReal e' a UNICA funcao do modulo com mutacao real (linkSync/unlinkSync), sem retry cego ----
  {
    const fonte = require('fs').readFileSync(path.join(PROJETO, 'SERVICO', 'cleanup-exportados-nex.js'), 'utf8');
    const inicioMove = fonte.indexOf('function moverArquivoParaArchiveReal');
    const trechoMove = fonte.slice(inicioMove, fonte.indexOf('module.exports'));
    registrar(check('M14 - moverArquivoParaArchiveReal contem linkSync (mutacao real intencional e gated)', /\.linkSync\(/.test(trechoMove)));
    registrar(check('M14 - moverArquivoParaArchiveReal contem unlinkSync (mutacao real intencional e gated)', /\.unlinkSync\(/.test(trechoMove)));
    registrar(check('M14 - zero retry cego (sem loop de tentativa) dentro de moverArquivoParaArchiveReal', !/while\s*\(|for\s*\(\s*;;\s*\)|setTimeout/.test(trechoMove)));
  }

  // ================================================================
  // GAP 4 - lock exclusivo para --move-real (mkdirSync atomico). Testado
  // como primitiva pura em sandbox: adquirirLockMoveReal/liberarLockMoveReal
  // sao funcoes puras de filesystem, sem estado compartilhado alem do
  // proprio diretorio de lock - nao ha necessidade de um subprocess
  // concorrente real para provar a exclusao mutua.
  // ================================================================

  // ---- L1: primeira aquisicao bem-sucedida; segunda (lock ja existe) e' bloqueada ----
  {
    const raizLock = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-v2-lock-'));
    const lockPath = path.join(raizLock, '.cleanup-move-real.lock');

    const primeira = adquirirLockMoveReal(lockPath);
    registrar(check('L1 - primeira aquisicao de lock -> adquirido=true', primeira.adquirido === true));
    registrar(check('L1 - diretorio de lock existe apos aquisicao', fs.existsSync(lockPath)));

    const segunda = adquirirLockMoveReal(lockPath);
    registrar(check('L1 - segunda aquisicao (lock ja existe) -> adquirido=false, FAIL-CLOSED', segunda.adquirido === false));
    registrar(check('L1 - lock nao foi duplicado/alterado pela segunda tentativa', fs.existsSync(lockPath)));

    liberarLockMoveReal(lockPath);
    registrar(check('L1 - liberarLockMoveReal remove o diretorio de lock', !fs.existsSync(lockPath)));
    fs.rmSync(raizLock, { recursive: true, force: true });
  }

  // ---- L2: apos liberar, uma nova aquisicao volta a funcionar normalmente ----
  {
    const raizLock = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-v2-lock-'));
    const lockPath = path.join(raizLock, '.cleanup-move-real.lock');
    adquirirLockMoveReal(lockPath);
    liberarLockMoveReal(lockPath);
    const terceira = adquirirLockMoveReal(lockPath);
    registrar(check('L2 - apos release, nova aquisicao -> adquirido=true (nao fica preso para sempre)', terceira.adquirido === true));
    liberarLockMoveReal(lockPath);
    fs.rmSync(raizLock, { recursive: true, force: true });
  }

  // ---- L3: liberar um lock que nunca existiu nao lanca (ENOENT tolerado) ----
  {
    const raizLock = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-v2-lock-'));
    const lockPath = path.join(raizLock, '.cleanup-move-real.lock');
    let lancou = false;
    try {
      liberarLockMoveReal(lockPath);
    } catch (erro) {
      lancou = true;
    }
    registrar(check('L3 - liberar um lock inexistente nao lanca', !lancou));
    fs.rmSync(raizLock, { recursive: true, force: true });
  }

  // ---- L4 (guarda estrutural): executarMoveReal adquire o lock ANTES de
  // ler o manifesto/iterar arquivos, aborta cedo quando adquirido=false, e
  // libera o lock em `finally` - nunca chama liberarLockMoveReal fora
  // desse finally (nunca "libera" um lock que talvez nao tenha sido
  // adquirido por esta execucao). ----
  {
    const fonteCli = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'cleanup-exportados-nex.js'), 'utf8');
    const inicioFn = fonteCli.indexOf('async function executarMoveReal');
    const fimFn = fonteCli.indexOf('async function main');
    const trechoFn = fonteCli.slice(inicioFn, fimFn);
    const idxAdquirir = trechoFn.indexOf('adquirirLockMoveReal(');
    const idxLerManifest = trechoFn.indexOf('lerManifestArchive(');
    const idxFinally = trechoFn.indexOf('finally');
    const idxLiberar = trechoFn.indexOf('liberarLockMoveReal(');
    registrar(check('L4 - executarMoveReal chama adquirirLockMoveReal', idxAdquirir > -1));
    registrar(check('L4 - lock e adquirido ANTES de ler o manifesto', idxAdquirir > -1 && idxLerManifest > -1 && idxAdquirir < idxLerManifest));
    registrar(check('L4 - existe um bloco finally que libera o lock', idxFinally > -1 && idxLiberar > idxFinally));
    registrar(check('L4 - liberarLockMoveReal so aparece 1x no corpo (dentro do finally)', (trechoFn.match(/liberarLockMoveReal\(/g) || []).length === 1));
  }

  // ================================================================
  // GAP FINAL 2 - fechamento de checkpoint/outbox mesmo em excecao. Teste
  // ESTRUTURAL (nao abre o DB real de producao, conforme explicitamente
  // pedido): a chamada `fechar()` estar de fato DENTRO de um bloco
  // `finally` do JavaScript e' prova suficiente de RESOURCES_CLOSED_ON_
  // SUCCESS=YES e RESOURCES_CLOSED_ON_EXCEPTION=YES, pois a linguagem
  // GARANTE a execucao do finally em ambos os caminhos (sucesso ou
  // excecao) - o que precisa ser provado e' que o codigo REALMENTE usa
  // esse mecanismo (e nao, como antes desta correcao, so' chama fechar()
  // no caminho feliz apos o loop).
  // ================================================================
  {
    const fonteCli = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'cleanup-exportados-nex.js'), 'utf8');
    const inicioFn = fonteCli.indexOf('async function executarMoveReal');
    const fimFn = fonteCli.indexOf('async function main');
    const trechoFn = fonteCli.slice(inicioFn, fimFn);

    const idxOutboxNew = trechoFn.indexOf('new OutboxLocal(DB_PATH)');
    const idxInnerTry = trechoFn.indexOf('try {', idxOutboxNew);
    const idxInnerFinally = trechoFn.indexOf('} finally {', idxInnerTry);
    const idxResumo = trechoFn.indexOf('const resumo');
    registrar(check('RC1 - existe um bloco try logo apos abrir checkpoint/outbox', idxOutboxNew > -1 && idxInnerTry > idxOutboxNew));
    registrar(check('RC2 - existe um finally correspondente ANTES do resumo ser calculado', idxInnerFinally > idxInnerTry && idxInnerFinally < idxResumo));

    const trechoFinally = trechoFn.slice(idxInnerFinally, idxResumo);
    registrar(check('RC3 - checkpoint.fechar() esta dentro desse finally (RESOURCES_CLOSED_ON_SUCCESS=YES e RESOURCES_CLOSED_ON_EXCEPTION=YES, garantia da linguagem)', /checkpoint\.fechar\(\)/.test(trechoFinally)));
    registrar(check('RC4 - outbox.fechar() esta dentro desse finally (RESOURCES_CLOSED_ON_SUCCESS=YES e RESOURCES_CLOSED_ON_EXCEPTION=YES, garantia da linguagem)', /outbox\.fechar\(\)/.test(trechoFinally)));
    registrar(check('RC5 - cada fechar() tem seu proprio try/catch (uma falha ao fechar nao mascara a excecao original nem impede o outro fechar)', (trechoFinally.match(/try\s*\{/g) || []).length >= 2 && /catch \(erroFechar\)/.test(trechoFinally)));
    registrar(check('RC6 - checkpoint.fechar()/outbox.fechar() aparecem exatamente 1x cada em executarMoveReal (sem chamada duplicada fora do finally)', (trechoFn.match(/checkpoint\.fechar\(\)/g) || []).length === 1 && (trechoFn.match(/outbox\.fechar\(\)/g) || []).length === 1));
  }

  // ================================================================
  // Limpeza de texto obsoleto: ORFAO_RECONCILIADO nao e' mais um resultado
  // possivel de --move-real (ver M7 acima) - nao pode sobrar em nenhum
  // resumo/mensagem do CLI, sob risco de sugerir um comportamento que nao
  // existe mais.
  // ================================================================
  {
    const fonteCli = fs.readFileSync(path.join(PROJETO, 'SCRIPTS', 'cleanup-exportados-nex.js'), 'utf8');
    registrar(check('LIMPEZA - nenhuma mencao residual a ORFAO_RECONCILIADO no CLI (comportamento removido no GAP 3)', !fonteCli.includes('ORFAO_RECONCILIADO')));
  }

  // ---- M15 (CLI): flag ausente e flags incompativeis sao bloqueados ANTES de qualquer acesso a diretorio/DB (subprocess real, seguro) ----
  {
    const { spawnSync } = require('child_process');
    const cliPath = path.join(PROJETO, 'SCRIPTS', 'cleanup-exportados-nex.js');

    const semFlag = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
    registrar(check('M15 - CLI sem nenhuma flag -> exit code 1', semFlag.status === 1));
    registrar(check('M15 - CLI sem nenhuma flag -> mensagem de recusa explicita', /recusando executar sem um modo explicito/.test(semFlag.stderr)));

    const flagsIncompativeis = spawnSync(process.execPath, [cliPath, '--dry-run', '--move-real'], { encoding: 'utf8' });
    registrar(check('M15 - CLI com --dry-run e --move-real juntos -> exit code 1', flagsIncompativeis.status === 1));
    registrar(check('M15 - CLI flags incompativeis -> mensagem explicita', /incompativeis/.test(flagsIncompativeis.stderr)));
  }

  console.log('\n' + (todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'ALGUM TESTE FALHOU'));
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((erro) => {
  console.error('ERRO INESPERADO NO TESTE:', erro);
  process.exitCode = 1;
});
