'use strict';

/**
 * Entrypoint FINO oficial da integracao NEX -> PRIME COBRANCAS. Unico
 * script que le configuracao operacional real (endpoint/origin/secret,
 * diretorio de exports, caminho do banco) e chama `iniciarRunner(...)`
 * de SERVICO/runner-integracao-nex.js.
 *
 * NAO reimplementa nada de dominio - parser, gate, allowlist,
 * anti-replay, outbox, retry, checkpoint, detector, HMAC e transporte
 * HTTP continuam 100% no runner e nos modulos que ele compoe. Este
 * arquivo so: monta config, chama iniciarRunner, trata SIGINT/SIGTERM,
 * e mantem o processo vivo enquanto o runner estiver ativo.
 *
 * SECRET: nunca hardcoded, nunca logado, nunca impresso. Ordem de
 * resolucao: 1) process.env.NEX_PRIME_INTEGRATION_SECRET (caminho
 * nao-interativo, usado em producao/servico Windows - a variavel deve
 * ser definida na configuracao do servico, nao em arquivo); 2) arquivo
 * .env na raiz do projeto (coberto por .gitignore, parser minimo
 * KEY=VALUE, sem dependencia nova); 3) se ainda ausente, pede uma
 * UNICA vez no terminal (leitura oculta) - fallback para execucao
 * manual/supervisionada, nunca o caminho esperado em producao 24/7.
 *
 * Uso:
 *   node SCRIPTS/rodar-integracao-nex.js
 *
 * Ctrl+C (SIGINT) ou SIGTERM (inclusive o enviado pelo Windows Service
 * Control Manager/NSSM ao parar o servico) encerram o runner de forma
 * segura (nunca apagam/resetam o banco operacional).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROJETO = path.join(__dirname, '..');

const { iniciarRunner } = require(path.join(PROJETO, 'SERVICO', 'runner-integracao-nex'));
const { LoggerEstruturado } = require(path.join(PROJETO, 'SERVICO', 'logger-estruturado'));

const DB_PATH = path.join(PROJETO, 'OUTPUT', 'integracao-nex.db');
const DIRETORIO_EXPORTS = path.join(PROJETO, 'EXPORTADOS');
const LOGS_DIR = path.join(PROJETO, 'LOGS');

/**
 * Parser minimo de arquivo .env (KEY=VALUE por linha, ignora linhas
 * vazias/comentarios) - sem dependencia nova (dotenv nao e dependencia
 * deste projeto). So preenche `process.env` para chaves AINDA nao
 * definidas (nunca sobrescreve uma variavel ja exportada no
 * ambiente/servico).
 */
function carregarDotEnvSeExistir(caminhoEnv) {
  if (!fs.existsSync(caminhoEnv)) return;
  const conteudo = fs.readFileSync(caminhoEnv, 'utf8');
  for (const linhaBruta of conteudo.split(/\r?\n/)) {
    const linha = linhaBruta.trim();
    if (!linha || linha.startsWith('#')) continue;
    const idx = linha.indexOf('=');
    if (idx === -1) continue;
    const chave = linha.slice(0, idx).trim();
    let valor = linha.slice(idx + 1).trim();
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1);
    }
    if (chave && process.env[chave] === undefined) {
      process.env[chave] = valor;
    }
  }
}

const CODIGO_ENTER_LF = String.fromCharCode(10);
const CODIGO_ENTER_CR = String.fromCharCode(13);
const CODIGO_EOF_CTRL_D = String.fromCharCode(4);
const CODIGO_INTERRUPT_CTRL_C = String.fromCharCode(3);
const CODIGO_BACKSPACE_DEL = String.fromCharCode(127);
const CODIGO_BACKSPACE_BS = String.fromCharCode(8);

/**
 * Leitura oculta de terminal - FALLBACK para execucao manual/
 * supervisionada. Em producao/servico 24/7, o secret deve vir de
 * process.env (definido na configuracao do servico), e esta funcao
 * nunca e chamada.
 */
function lerSecretOculto(pergunta) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const stdin = process.stdin;
    let valor = '';

    process.stdout.write(pergunta);

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (char) => {
      char = char.toString();
      if (char === CODIGO_ENTER_LF || char === CODIGO_ENTER_CR || char === CODIGO_EOF_CTRL_D) {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(valor);
        return;
      }
      if (char === CODIGO_INTERRUPT_CTRL_C) {
        process.stdout.write('\n');
        process.exit(1);
      }
      if (char === CODIGO_BACKSPACE_DEL || char === CODIGO_BACKSPACE_BS) {
        valor = valor.slice(0, -1);
        return;
      }
      valor += char;
    };

    stdin.on('data', onData);
  });
}

async function montarConfig() {
  carregarDotEnvSeExistir(path.join(PROJETO, '.env'));

  const endpoint = process.env.NEX_PRIME_ENDPOINT;
  const origin = process.env.NEX_PRIME_ORIGIN;
  if (!endpoint || !origin) {
    console.error(
      'ERRO: NEX_PRIME_ENDPOINT e/ou NEX_PRIME_ORIGIN ausentes. ' +
        'Defina-os no ambiente ou em um arquivo .env na raiz do projeto (ver .env.example). Abortando.',
    );
    process.exit(1);
  }

  let secret = process.env.NEX_PRIME_INTEGRATION_SECRET;
  if (!secret) {
    secret = await lerSecretOculto('NEX_PRIME_INTEGRATION_SECRET nao encontrado no ambiente/.env. Digite-o agora (nao sera exibido): ');
  }
  if (!secret) {
    console.error('ERRO: secret nao fornecido. Abortando. Nenhum runner foi iniciado.');
    process.exit(1);
  }

  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  const logger = new LoggerEstruturado({ diretorio: LOGS_DIR, prefixoArquivo: 'integracao-nex' });

  return {
    dbPath: DB_PATH,
    diretorioExports: DIRETORIO_EXPORTS,
    endpoint,
    origin,
    secret,
    logger,
  };
}

async function main() {
  console.log('PrimeIntegracaoNex - iniciando runner operacional...');
  console.log('Banco:', DB_PATH);
  console.log('Diretorio observado:', DIRETORIO_EXPORTS);

  const config = await montarConfig();
  let runner;
  try {
    runner = await iniciarRunner(config);
  } catch (erro) {
    console.error('Runner recusou iniciar:', erro && erro.message);
    process.exitCode = 1;
    return;
  }

  console.log('Runner iniciado. Pressione Ctrl+C para encerrar com seguranca.');

  let encerrando = false;
  async function encerrar(motivo) {
    if (encerrando) return;
    encerrando = true;
    console.log('\nEncerrando runner (' + motivo + ')...');
    await runner.parar(motivo);
    console.log('Runner encerrado. Estado preservado em', DB_PATH);
    process.exit(0);
  }

  process.on('SIGINT', () => { encerrar('SIGINT'); });
  process.on('SIGTERM', () => { encerrar('SIGTERM'); });
}

main().catch((erro) => {
  console.error('Erro inesperado ao iniciar a integracao NEX:', erro && erro.message);
  process.exitCode = 1;
});
