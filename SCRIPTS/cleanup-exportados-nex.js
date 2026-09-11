'use strict';

/**
 * CLI administrativo de cleanup de EXPORTADOS (HARDENING 1A / Cleanup V2).
 * Roda SEPARADO do PrimeIntegracaoNex service, do PrimeNexExportAgent e do
 * PrimeNexScheduledLauncher (decisao arquitetural: nunca misturar cleanup
 * de filesystem com o pipeline financeiro critico - ver
 * SERVICO/cleanup-exportados-nex.js para a logica de decisao/mutacao real).
 *
 * Dois modos, MUTUAMENTE EXCLUSIVOS, nunca um default implicito:
 *
 *   --dry-run    100% somente-leitura (inalterado desde a V1) - so relata
 *                o que SERIA feito, escreve so um log JSONL informativo em
 *                LOGS/, nunca toca EXPORTADOS/EXPORT_ARCHIVE/manifest.json.
 *
 *   --move-real  Cleanup V2 Fase 1 - move FISICAMENTE (via
 *                SERVICO/cleanup-exportados-nex.js::moverArquivoParaArchiveReal)
 *                cada arquivo que passou em TODOS os gates (identico ao
 *                --dry-run) de EXPORTADOS/ para EXPORT_ARCHIVE/, e persiste
 *                {archivedAt, sha256} no manifesto. NUNCA apaga nada -
 *                DELETE real nao existe nesta fase, em nenhum modo.
 *
 * Uso:
 *   node SCRIPTS/cleanup-exportados-nex.js --dry-run
 *   node SCRIPTS/cleanup-exportados-nex.js --move-real
 *
 * Sem NENHUM dos dois, ou com AMBOS ao mesmo tempo, o script recusa rodar
 * (fail-closed) - nunca assume um modo padrao "silencioso", nunca tenta
 * adivinhar qual dos dois o chamador queria. Nenhuma Task Scheduler,
 * servico ou runner de producao passa --move-real - e' 100% manual,
 * nunca wireado automaticamente.
 */

const fs = require('fs');
const path = require('path');

const PROJETO = path.join(__dirname, '..');
const {
  nomeEhVendasAutoValido,
  avaliarArquivoVendasAuto,
  avaliarArquivoArchive,
  moverArquivoParaArchiveReal,
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

/**
 * Le o manifesto de archive. FAIL-CLOSED explicito (Cleanup V2 Fase 1 -
 * gap de seguranca fechado antes do commit): manifest.json AUSENTE e' um
 * estado inicial valido ({}); manifest.json EXISTENTE mas corrompido
 * (JSON invalido OU raiz nao-objeto) NUNCA e' tratado como vazio - lanca
 * um erro com `code = 'MANIFEST_CORROMPIDO_FAIL_CLOSED'` e o chamador
 * (--move-real) deve abortar ANTES de qualquer linkSync/unlinkSync/escrita
 * de manifesto. Esta funcao e' somente-leitura - o arquivo corrompido no
 * disco nunca e' tocado/sobrescrito por ela.
 * @param {string} [manifestPath] - injetavel para testes em sandbox
 *   (default: caminho real de producao ARCHIVE_MANIFEST_PATH)
 */
function lerManifestArchive(manifestPath) {
  const caminho = manifestPath || ARCHIVE_MANIFEST_PATH;
  let bruto;
  try {
    bruto = fs.readFileSync(caminho, 'utf8');
  } catch (erro) {
    if (erro.code === 'ENOENT') return {}; // estado inicial valido - nenhum manifesto ainda
    throw erro;
  }
  let parsed;
  try {
    parsed = JSON.parse(bruto);
  } catch (erroParse) {
    const falha = new Error(`MANIFEST_CORROMPIDO_FAIL_CLOSED: ${caminho} existe mas nao e um JSON valido (${erroParse.message}) - abortando sem nenhuma mutacao. Corrija ou restaure manualmente antes de tentar novamente.`);
    falha.code = 'MANIFEST_CORROMPIDO_FAIL_CLOSED';
    throw falha;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const falha = new Error(`MANIFEST_CORROMPIDO_FAIL_CLOSED: ${caminho} existe mas a raiz nao e um objeto valido - abortando sem nenhuma mutacao.`);
    falha.code = 'MANIFEST_CORROMPIDO_FAIL_CLOSED';
    throw falha;
  }
  return parsed;
}

/** Cleanup V2 Fase 1 - GAP 4 (single instance): lock exclusivo, SOMENTE
 * para --move-real (--dry-run nunca precisa - e' 100% leitura).
 * `fs.mkdirSync` sem `{recursive:true}` e' atomico e exclusivo (falha
 * EEXIST se o diretorio ja existir) - primitiva multiplataforma padrao
 * para locks de arquivo, sem exigir nenhuma API nativa adicional. NUNCA
 * "rouba" lock por timeout/idade - um lock remanescente apos um crash fica
 * ali de proposito, exigindo revisao humana explicita (remocao manual do
 * diretorio) antes de rodar --move-real novamente. */
const LOCK_PATH = path.join(LOGS_DIR, '.cleanup-move-real.lock');

/** @param {string} [lockPath] - injetavel para testes em sandbox */
function adquirirLockMoveReal(lockPath) {
  const caminho = lockPath || LOCK_PATH;
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  try {
    fs.mkdirSync(caminho);
  } catch (erro) {
    if (erro.code === 'EEXIST') return { adquirido: false, lockPath: caminho };
    throw erro;
  }
  return { adquirido: true, lockPath: caminho };
}

/** Remove o lock. So' deve ser chamada por quem recebeu `adquirido:true` de
 * adquirirLockMoveReal (nunca "rouba"/apaga lock alheio) - ver uso em
 * `executarMoveReal` (bloco finally, condicionado a `lock.adquirido`). */
function liberarLockMoveReal(lockPath) {
  const caminho = lockPath || LOCK_PATH;
  try {
    fs.rmdirSync(caminho);
  } catch (erro) {
    if (erro.code !== 'ENOENT') throw erro;
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

async function executarDryRun(agoraMs) {
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

/**
 * Cleanup V2 Fase 1 - MOVE REAL. Reusa EXATAMENTE os mesmos gates 1-6 de
 * avaliarArquivoVendasAuto (identico ao --dry-run) para decidir
 * WOULD_ARCHIVE; so' para arquivos WOULD_ARCHIVE chama
 * moverArquivoParaArchiveReal (gates 7-12, mutacao real). Nunca avalia
 * EXPORT_ARCHIVE para delete - DELETE real nao existe nesta fase, em
 * nenhum modo.
 */
async function executarMoveReal(agoraMs) {
  // ---- GAP 4: lock exclusivo ANTES de qualquer leitura de manifesto ou
  // mutacao - duas execucoes de --move-real nunca podem correr juntas. ----
  const lock = adquirirLockMoveReal();
  if (!lock.adquirido) {
    // eslint-disable-next-line no-console
    console.error(
      `cleanup-exportados-nex: --move-real ja esta em execucao (lock ${lock.lockPath} existe) - abortando SEM nenhuma mutacao ` +
        '(zero linkSync/unlinkSync/escrita de manifesto). Se tiver certeza de que nenhuma outra execucao esta rodando ' +
        '(ex.: um lock remanescente apos um crash), revise manualmente antes de remover o diretorio de lock.',
    );
    process.exitCode = 1;
    return;
  }

  try {
    const checkpoint = new CheckpointSqlite(DB_PATH);
    const outbox = new OutboxLocal(DB_PATH);

    let nomesSource = [];
    const resultados = [];
    try {
      nomesSource = listarCandidatos(SOURCE_DIR) || [];
      let manifestAtual = lerManifestArchive();

      for (const nome of nomesSource) {
        const caminho = path.join(SOURCE_DIR, nome);
        // eslint-disable-next-line no-await-in-loop
        const decisao = await avaliarArquivoVendasAuto({
          caminho,
          nomeArquivo: nome,
          fsImpl: fs,
          checkpoint,
          outbox,
          agoraMs,
          moveAfterDays: MOVE_AFTER_DAYS,
        });

        if (decisao.action !== 'WOULD_ARCHIVE') {
          resultados.push(decisao);
          continue; // eslint-disable-line no-continue
        }

        const resultadoMove = moverArquivoParaArchiveReal({
          nomeArquivo: nome,
          exportadosDir: SOURCE_DIR,
          archiveDir: ARCHIVE_DIR,
          manifestPath: ARCHIVE_MANIFEST_PATH,
          sha256Esperado: decisao.sha256,
          manifestAtual,
          agoraMs,
          fsImpl: fs,
        });
        if (resultadoMove.manifestAtualizado) {
          manifestAtual = resultadoMove.manifestAtualizado;
        }
        resultados.push(Object.assign({ decisaoOriginal: decisao.action }, resultadoMove));
      }
    } finally {
      // GAP FINAL 2: fechar checkpoint/outbox mesmo se o bloco acima
      // lancar (manifesto corrompido, erro de avaliacao, erro inesperado
      // no loop) - nunca deixa uma conexao SQLite aberta por excecao.
      // Cada fechar() tem seu proprio try/catch (independente um do outro
      // e do erro original do bloco acima) para NUNCA mascarar a excecao
      // original que motivou este finally - uma falha ao fechar e' so'
      // reportada (nao fatal), nunca sobrescreve o erro real.
      try {
        checkpoint.fechar();
      } catch (erroFechar) {
        // eslint-disable-next-line no-console
        console.error('cleanup-exportados-nex: falha ao fechar checkpoint (nao fatal, erro original preservado):', erroFechar);
      }
      try {
        outbox.fechar();
      } catch (erroFechar) {
        // eslint-disable-next-line no-console
        console.error('cleanup-exportados-nex: falha ao fechar outbox (nao fatal, erro original preservado):', erroFechar);
      }
    }

    const resumo = {
      REAL_FILES_SCANNED: nomesSource.length,
      AUTO_VENDAS_FILES: nomesSource.filter(nomeEhVendasAutoValido).length,
      ARCHIVED_REAL: resultados.filter((r) => r.action === 'ARCHIVED_REAL').length,
      JA_CONCLUIDO: resultados.filter((r) => r.action === 'JA_CONCLUIDO').length,
      SKIP_UNSAFE: resultados.filter((r) => r.action === 'SKIP_UNSAFE').length,
      KEEP: resultados.filter((r) => r.action === 'KEEP').length,
      IGNORED: nomesSource.length - nomesSource.filter(nomeEhVendasAutoValido).length,
    };

    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const logPath = path.join(LOGS_DIR, `cleanup-exportados-nex-move-real-${agoraIsoParaNomeArquivo()}.jsonl`);
    const linhasLog = resultados.map((r) =>
      JSON.stringify({
        timestamp: new Date(agoraMs).toISOString(),
        action: r.action,
        reason: r.reason,
        filename: r.filename,
        sha256: r.sha256 != null ? r.sha256 : null,
      }),
    );
    fs.appendFileSync(logPath, linhasLog.map((l) => `${l}\n`).join(''));

    // eslint-disable-next-line no-console
    console.log('=== CLEANUP EXPORTADOS NEX (--move-real) ===');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(resumo, null, 2));
    // eslint-disable-next-line no-console
    console.log('\n--- Detalhe por arquivo (EXPORTADOS -> EXPORT_ARCHIVE) ---');
    for (const r of resultados) {
      // eslint-disable-next-line no-console
      console.log(`${r.action}\t${r.filename}\t${r.reason || ''}`);
    }
    // eslint-disable-next-line no-console
    console.log(`\nLog gravado em: ${logPath}`);
    // eslint-disable-next-line no-console
    console.log('MOVE-REAL: somente o MOVE (EXPORTADOS -> EXPORT_ARCHIVE) foi executado onde ARCHIVED_REAL aparece acima. DELETE real nao existe nesta fase - nada em EXPORT_ARCHIVE foi ou pode ser apagado por este script.');
  } finally {
    // GAP 4: libera SOMENTE o lock que esta execucao adquiriu (nunca chega
    // aqui com adquirido=false - esse caso ja retornou antes do try).
    liberarLockMoveReal(lock.lockPath);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const moveReal = args.includes('--move-real');

  if (dryRun && moveReal) {
    // eslint-disable-next-line no-console
    console.error('cleanup-exportados-nex: --dry-run e --move-real sao incompativeis - escolha exatamente um.');
    process.exitCode = 1;
    return;
  }
  if (!dryRun && !moveReal) {
    // eslint-disable-next-line no-console
    console.error(
      'cleanup-exportados-nex: recusando executar sem um modo explicito. Use --dry-run (100% somente-leitura) ou ' +
        '--move-real (Cleanup V2 Fase 1 - move fisicamente EXPORTADOS/*.xls elegiveis para EXPORT_ARCHIVE/, nunca deleta). ' +
        'Rode: node SCRIPTS/cleanup-exportados-nex.js --dry-run',
    );
    process.exitCode = 1;
    return;
  }

  const agoraMs = Date.now();
  if (dryRun) {
    await executarDryRun(agoraMs);
  } else {
    await executarMoveReal(agoraMs);
  }
}

if (require.main === module) {
  main().catch((erro) => {
    // eslint-disable-next-line no-console
    console.error('cleanup-exportados-nex: erro inesperado:', erro);
    process.exitCode = 1;
  });
}

// Exportado SOMENTE para testes em sandbox (TESTES/teste-cleanup-exportados-nex.js).
// O guard `require.main === module` acima garante que `require()`-ar este
// arquivo (em vez de executa-lo diretamente) nunca dispara main() como
// efeito colateral - comportamento de execucao direta (`node SCRIPTS/...`)
// e' identico ao anterior a esta mudanca.
module.exports = {
  lerManifestArchive,
  adquirirLockMoveReal,
  liberarLockMoveReal,
  LOCK_PATH,
};
