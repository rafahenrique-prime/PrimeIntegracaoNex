'use strict';

/**
 * CLI administrativo de cleanup de EXPORTADOS (HARDENING 1A). Roda SEPARADO
 * do PrimeIntegracaoNex service, do PrimeNexExportAgent e do
 * PrimeNexScheduledLauncher (decisao arquitetural: nunca misturar cleanup
 * de filesystem com o pipeline financeiro critico - ver
 * SERVICO/cleanup-exportados-nex.js para a logica de decisao real).
 *
 * NESTA VERSAO (V1): SOMENTE --dry-run e suportado. Nao existe nenhum
 * caminho de codigo neste arquivo (nem no modulo core) que mova ou apague
 * um arquivo real - a implementacao de execucao real fica para uma rodada
 * futura, apos homologacao do dry-run contra producao real.
 *
 * Uso:
 *   node SCRIPTS/cleanup-exportados-nex.js --dry-run
 *
 * Sem --dry-run, o script recusa rodar (fail closed) - nunca assume um
 * modo padrao "silencioso".
 */

const fs = require('fs');
const path = require('path');

const PROJETO = path.join(__dirname, '..');
const {
  nomeEhVendasAutoValido,
  avaliarArquivoVendasAuto,
  avaliarArquivoArchive,
} = require(path.join(PROJETO, 'SERVICO', 'cleanup-exportados-nex'));
const { CheckpointSqlite } = require(path.join(PROJETO, 'SERVICO', 'checkpoint-sqlite'));
const { OutboxLocal } = require(path.join(PROJETO, 'SERVICO', 'outbox-local'));

const SOURCE_DIR = path.join(PROJETO, 'EXPORTADOS');
const ARCHIVE_DIR = path.join(PROJETO, 'EXPORT_ARCHIVE');
const ARCHIVE_MANIFEST_PATH = path.join(ARCHIVE_DIR, 'manifest.json');
const DB_PATH = path.join(PROJETO, 'OUTPUT', 'integracao-nex.db');
const LOGS_DIR = path.join(PROJETO, 'LOGS');

const MOVE_AFTER_DAYS = 7;
const DELETE_ARCHIVE_AFTER_DAYS = 30;

function agoraIsoParaNomeArquivo() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function lerManifestArchive() {
  try {
    const bruto = fs.readFileSync(ARCHIVE_MANIFEST_PATH, 'utf8');
    return JSON.parse(bruto);
  } catch (erro) {
    if (erro.code === 'ENOENT') return {};
    throw erro; // manifest corrompido: nunca inventar um manifest vazio silenciosamente
  }
}

function listarCandidatos(diretorio) {
  try {
    return fs.readdirSync(diretorio);
  } catch (erro) {
    if (erro.code === 'ENOENT') return null; // diretorio nao existe ainda - dry-run nunca o cria
    throw erro;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--dry-run')) {
    // eslint-disable-next-line no-console
    console.error(
      'cleanup-exportados-nex: recusando executar. Esta versao (V1) so suporta o modo ' +
        '--dry-run (nenhuma mutacao real de filesystem esta implementada ainda). ' +
        'Rode: node SCRIPTS/cleanup-exportados-nex.js --dry-run',
    );
    process.exitCode = 1;
    return;
  }

  const agoraMs = Date.now();
  const checkpoint = new CheckpointSqlite(DB_PATH);
  const outbox = new OutboxLocal(DB_PATH);

  const nomesSource = listarCandidatos(SOURCE_DIR) || [];
  const resultadosSource = [];
  for (const nome of nomesSource) {
    const caminho = path.join(SOURCE_DIR, nome);
    // eslint-disable-next-line no-await-in-loop
    const resultado = await avaliarArquivoVendasAuto({
      caminho,
      nomeArquivo: nome,
      fsImpl: fs,
      checkpoint,
      outbox,
      agoraMs,
      moveAfterDays: MOVE_AFTER_DAYS,
    });
    resultadosSource.push(resultado);
  }

  checkpoint.fechar();
  outbox.fechar();

  const nomesArchive = listarCandidatos(ARCHIVE_DIR) || [];
  const manifest = nomesArchive.length ? lerManifestArchive() : {};
  const resultadosArchive = [];
  for (const nome of nomesArchive) {
    if (nome === 'manifest.json') continue;
    resultadosArchive.push(
      avaliarArquivoArchive({ nomeArquivo: nome, manifest, agoraMs, deleteAfterDays: DELETE_ARCHIVE_AFTER_DAYS }),
    );
  }

  const resumo = {
    REAL_FILES_SCANNED: nomesSource.length,
    AUTO_VENDAS_FILES: nomesSource.filter(nomeEhVendasAutoValido).length,
    WOULD_ARCHIVE: resultadosSource.filter((r) => r.action === 'WOULD_ARCHIVE').length,
    WOULD_DELETE: resultadosArchive.filter((r) => r.action === 'WOULD_DELETE').length,
    SKIP_UNSAFE: resultadosSource.filter((r) => r.action === 'SKIP_UNSAFE').length,
    KEEP: resultadosSource.filter((r) => r.action === 'KEEP').length + resultadosArchive.filter((r) => r.action === 'KEEP').length,
    IGNORED: nomesSource.length - nomesSource.filter(nomeEhVendasAutoValido).length,
  };

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const manifestLogPath = path.join(LOGS_DIR, `cleanup-exportados-nex-${agoraIsoParaNomeArquivo()}.jsonl`);
  const linhasManifest = [];
  for (const r of resultadosSource) {
    linhasManifest.push(
      JSON.stringify({
        timestamp: new Date(agoraMs).toISOString(),
        action: r.action,
        reason: r.reason,
        filename: r.filename,
        size: r.size != null ? r.size : null,
        sha256: r.sha256 != null ? r.sha256 : null,
        age: r.age != null ? Number(r.age.toFixed(2)) : null,
        transactionCount: r.transactionCount != null ? r.transactionCount : null,
        checkpointStatusSummary: r.checkpointStatusSummary || null,
      }),
    );
  }
  for (const r of resultadosArchive) {
    linhasManifest.push(
      JSON.stringify({
        timestamp: new Date(agoraMs).toISOString(),
        action: r.action,
        reason: r.reason,
        filename: r.filename,
        age: r.age != null ? Number(r.age.toFixed(2)) : null,
      }),
    );
  }
  fs.appendFileSync(manifestLogPath, linhasManifest.map((l) => l + '\n').join(''));

  // eslint-disable-next-line no-console
  console.log('=== CLEANUP EXPORTADOS NEX (--dry-run) ===');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(resumo, null, 2));
  // eslint-disable-next-line no-console
  console.log('\n--- Detalhe por arquivo (EXPORTADOS) ---');
  for (const r of resultadosSource) {
    // eslint-disable-next-line no-console
    console.log(`${r.action}\t${r.filename}\t${r.reason || ''}`);
  }
  if (resultadosArchive.length) {
    // eslint-disable-next-line no-console
    console.log('\n--- Detalhe por arquivo (EXPORT_ARCHIVE) ---');
    for (const r of resultadosArchive) {
      // eslint-disable-next-line no-console
      console.log(`${r.action}\t${r.filename}\t${r.reason || ''}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\nManifest gravado em: ${manifestLogPath}`);
  // eslint-disable-next-line no-console
  console.log('DRY-RUN: nenhum arquivo foi movido, apagado, ou alterado. Nenhuma escrita em SQLite.');
}

main().catch((erro) => {
  // eslint-disable-next-line no-console
  console.error('cleanup-exportados-nex: erro inesperado:', erro);
  process.exitCode = 1;
});
