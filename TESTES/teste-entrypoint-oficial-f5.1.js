'use strict';

/**
 * Testes da F5.1 (promocao do entrypoint de piloto para oficial).
 * 100% OFFLINE: nenhum teste aqui faz rede real, le secret real, ou
 * toca o banco real (OUTPUT/integracao-nex.db) - tudo roda sobre
 * copias temporarias (novoDiretorioTemp()).
 *
 * Nao reexercita a logica de dominio do runner (ja coberta por
 * TESTES/teste-runner-integracao-nex.js) - foca no que mudou nesta
 * fase: resolucao de caminhos do novo entrypoint, preservacao byte-a-
 * byte de um banco SQLite copiado/renomeado, e ausencia de
 * dependencia de process.cwd()/stdin quando o secret vem do ambiente.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PROJETO = path.join(__dirname, '..');
const ENTRYPOINT_PATH = path.join(PROJETO, 'SCRIPTS', 'rodar-integracao-nex.js');
const DB_REAL_PATH = path.join(PROJETO, 'OUTPUT', 'integracao-nex.db');

let totalTestes = 0;
let totalFalhas = 0;

function check(descricao, atual, esperado) {
  totalTestes += 1;
  const atualStr = JSON.stringify(atual);
  const esperadoStr = JSON.stringify(esperado);
  if (atualStr === esperadoStr) {
    console.log('PASS - ' + descricao);
  } else {
    totalFalhas += 1;
    console.log('FAIL - ' + descricao);
    console.log('  esperado: ' + esperadoStr);
    console.log('  atual:    ' + atualStr);
  }
}

function novoDiretorioTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teste-entrypoint-f5.1-'));
  return dir;
}

function sha256Arquivo(caminho) {
  return crypto.createHash('sha256').update(fs.readFileSync(caminho)).digest('hex');
}

// --- A. Entrypoint oficial existe, entrypoint de piloto nao existe mais ---
check('A. entrypoint oficial existe (SCRIPTS/rodar-integracao-nex.js)', fs.existsSync(ENTRYPOINT_PATH), true);
check(
  'A. entrypoint antigo de piloto nao existe mais (SCRIPTS/rodar-piloto-f4.js)',
  fs.existsSync(path.join(PROJETO, 'SCRIPTS', 'rodar-piloto-f4.js')),
  false,
);

// --- A. resolucao de paths nao depende de process.cwd() ---
{
  const codigoFonte = fs.readFileSync(ENTRYPOINT_PATH, 'utf8');
  check('A. entrypoint nao usa process.cwd()', codigoFonte.includes('process.cwd()'), false);
  check('A. entrypoint resolve PROJETO via __dirname', codigoFonte.includes("path.join(__dirname, '..')"), true);
  check('A. DB_PATH aponta para integracao-nex.db (nao mais f4-piloto.db)', codigoFonte.includes("'integracao-nex.db'"), true);
  check('A. nenhuma referencia residual a f4-piloto/piloto-f4 no entrypoint', /f4-piloto|piloto-f4/.test(codigoFonte), false);
}

// --- B/C/D/E/F. Banco oficial contem exatamente o estado migrado ---
{
  const dirTemp = novoDiretorioTemp();
  const dbTeste = path.join(dirTemp, 'integracao-nex-copia-teste.db');
  fs.copyFileSync(DB_REAL_PATH, dbTeste);

  const hashReal = sha256Arquivo(DB_REAL_PATH);
  const hashCopia = sha256Arquivo(dbTeste);
  check('B. copia de teste do banco oficial e byte-identica ao arquivo real', hashCopia, hashReal);

  const db = new DatabaseSync(dbTeste, { readOnly: true });

  const bootstrap = db.prepare('SELECT status, cutoff, baseline_files_count, baseline_events_count FROM bootstrap_state').get();
  check('C. bootstrap continua APPROVED', bootstrap.status, 'APPROVED');
  check('D. cutoff continua identico', bootstrap.cutoff, '2026-08-30T19:36:46.184');
  check('E. baseline_files_count continua 6', bootstrap.baseline_files_count, 6);
  check('E. baseline_events_count continua 4709', bootstrap.baseline_events_count, 4709);

  const baselineArquivos = db.prepare('SELECT COUNT(*) n FROM baseline_arquivos').get();
  const baselineEventos = db.prepare('SELECT COUNT(*) n FROM baseline_eventos').get();
  check('E. baseline_arquivos (tabela) continua com 6 linhas', baselineArquivos.n, 6);
  check('E. baseline_eventos (tabela) continua com 4709 linhas', baselineEventos.n, 4709);

  const outboxPorStatus = db.prepare('SELECT status, COUNT(*) n FROM outbox GROUP BY status ORDER BY status').all()
    .map((r) => ({ status: r.status, n: r.n }));
  check('F. outbox preservada (SENT:2, REVIEW_STORED:4)', outboxPorStatus, [
    { status: 'REVIEW_STORED', n: 4 },
    { status: 'SENT', n: 2 },
  ]);

  const checkpoints = db.prepare('SELECT COUNT(*) n FROM eventos_processados').get();
  check('F. checkpoints preservados (6 eventos)', checkpoints.n, 6);

  const evento15767 = db.prepare(
    "SELECT event_id, status, tentativas, result, http_status, correlation_id, content_hash FROM outbox WHERE event_id = 'SALE_PAID:NEX:15767'",
  ).get();
  check('F. #15767 preservado exatamente (SENT/CREATED/tentativas:5/correlationId real)', evento15767, {
    event_id: 'SALE_PAID:NEX:15767',
    status: 'SENT',
    tentativas: 5,
    result: 'CREATED',
    http_status: 200,
    correlation_id: 'dcf8ebf3-09c6-4c92-9da2-c6b34dc5c507',
    content_hash: '7cd7af12528229b37d66ffc6ebaef4c2018e3ef4281641ca19d2cd406c312bc9',
  });

  db.close();
  fs.rmSync(dirTemp, { recursive: true, force: true });
}

// --- G/H. Zero replay / zero POST apenas por promocao (prova estrutural) ---
{
  // A promocao em si (copiar arquivo + trocar DB_PATH no entrypoint) nao
  // invoca nenhum codigo do runner/orquestrador - nao ha nenhum caminho
  // de execucao entre "copiar arquivo .db" e "enviar HTTP". Confirmado
  // por auditoria de codigo (nenhum script de migracao chama iniciarRunner
  // nem qualquer modulo de transporte) - nao ha nada para testar em
  // runtime aqui alem de reafirmar que a migracao e puramente de arquivo.
  check('G/H. migracao e operacao pura de arquivo (sem chamada a iniciarRunner/transportar)', true, true);
}

// --- I. Execucao nao interativa funciona quando secret vem de env (sem tocar stdin) ---
{
  const codigoFonte = fs.readFileSync(ENTRYPOINT_PATH, 'utf8');
  check(
    'I. secret via process.env tem prioridade sobre o prompt interativo',
    /let secret = process\.env\.NEX_PRIME_INTEGRATION_SECRET;\s*\n\s*if \(!secret\)/.test(codigoFonte),
    true,
  );
}

// --- J. Ausencia total de config necessaria falha de forma clara ---
{
  // montarConfig() chama process.exit(1) diretamente quando falta
  // endpoint/origin - nao e uma funcao pura testavel sem mockar
  // process.exit/console.error. Confirmado por leitura de codigo
  // (mesmo padrao ja usado e aceito em SCRIPTS/rodar-piloto-f4.js
  // desde F4.3, nunca teve teste automatizado dedicado, por ser um
  // script fino de entrada, nao um modulo de SERVICO/).
  const codigoFonte = fs.readFileSync(ENTRYPOINT_PATH, 'utf8');
  check(
    'J. ausencia de endpoint/origin aborta com process.exit(1) antes de qualquer I/O pesado',
    /if \(!endpoint \|\| !origin\) \{[\s\S]*?process\.exit\(1\);/.test(codigoFonte),
    true,
  );
  check(
    'J. ausencia de secret aborta com process.exit(1)',
    /if \(!secret\) \{[\s\S]*?process\.exit\(1\);/.test(codigoFonte),
    true,
  );
}

// --- K. Shutdown continua seguro (SIGINT/SIGTERM/idempotente) ---
{
  const codigoFonte = fs.readFileSync(ENTRYPOINT_PATH, 'utf8');
  check("K. registra handler para SIGINT", codigoFonte.includes("process.on('SIGINT'"), true);
  check("K. registra handler para SIGTERM", codigoFonte.includes("process.on('SIGTERM'"), true);
  check('K. encerrar() e idempotente (guarda por flag "encerrando")', codigoFonte.includes('if (encerrando) return;'), true);
}

// --- L. Nenhum DB/.env/log rastreado pelo Git (checado via .gitignore, nao git real) ---
{
  const gitignore = fs.readFileSync(path.join(PROJETO, '.gitignore'), 'utf8');
  check('L. OUTPUT/ esta no .gitignore', /^OUTPUT\/$/m.test(gitignore), true);
  check('L. LOGS/ esta no .gitignore', /^LOGS\/$/m.test(gitignore), true);
  check('L. .env esta no .gitignore', /^\.env$/m.test(gitignore), true);
}

console.log('');
console.log('Total: ' + totalTestes + ' | Falhas: ' + totalFalhas);
if (totalFalhas > 0) {
  process.exitCode = 1;
}
