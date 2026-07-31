'use strict';

/**
 * Servidor HTTP local. NENHUM efeito colateral em disco: nao grava
 * arquivo, nao acessa banco real, nao integra Base44/Supabase/API
 * externa. Responsabilidade unica desta camada: adaptar HTTP <->
 * servicos (ServicoImportacao, ServicoSincronizacao).
 *
 * - recebe a requisicao;
 * - valida aspectos basicos de transporte/payload;
 * - delega aos servicos (SERVICO/servico-importacao.js,
 *   SERVICO/servico-sincronizacao.js);
 * - traduz o resultado/erro em resposta HTTP;
 * - nao contem regra de negocio (isso vive em SRC/).
 *
 * Instancia do RepositorioClientesFake (Fase 5):
 * - criada UMA UNICA VEZ, no carregamento deste modulo (linha
 *   `const repository = new RepositorioClientesFake()` abaixo);
 * - a MESMA instancia e reutilizada por todas as requisicoes enquanto
 *   este processo do servidor estiver rodando - e assim que uma
 *   segunda importacao "enxerga" clientes da primeira (comparar-
 *   clientes.js so funciona se buscarTodos() refletir o que foi salvo
 *   antes);
 * - e SOMENTE EM MEMORIA: reiniciar o servidor (matar e rodar `node
 *   SERVICO/servidor-local.js` de novo) cria um processo novo, logo uma
 *   instancia nova e vazia - todo o estado importado ate ali e perdido
 *   de proposito, pois isto NAO e uma persistencia real ainda.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { analisarArquivoXls, ErroImportacao } = require(path.join(__dirname, 'servico-importacao'));
const { sincronizar } = require(path.join(__dirname, 'servico-sincronizacao'));
const { RepositorioClientesFake } = require(path.join(__dirname, 'repositorio-clientes-fake'));

// Unica instancia do Repository para a vida deste processo - ver nota acima.
const repository = new RepositorioClientesFake();

const WEB_DIR = path.join(__dirname, '..', 'WEB');
const LIMITE_BYTES = 50 * 1024 * 1024; // 50MB de seguranca contra upload anormal

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function enviarJson(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(corpo));
}

function servirEstatico(req, res) {
  const rotaBruta = req.url.split('?')[0];
  const rota = rotaBruta === '/' ? '/index.html' : rotaBruta;
  const caminhoResolvido = path.normalize(path.join(WEB_DIR, rota));

  if (!caminhoResolvido.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end('Acesso negado');
    return;
  }

  fs.readFile(caminhoResolvido, (err, dados) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Nao encontrado');
      return;
    }
    const ext = path.extname(caminhoResolvido);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(dados);
  });
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > LIMITE_BYTES) {
        reject(new Error('arquivo excede o limite permitido'));
        req.destroy();
        return;
      }
      partes.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

async function tratarAnalisar(req, res) {
  const nomeArquivoBruto = req.headers['x-nome-arquivo'];
  let nomeArquivo;
  try {
    nomeArquivo = nomeArquivoBruto ? decodeURIComponent(nomeArquivoBruto) : undefined;
  } catch (e) {
    nomeArquivo = undefined; // nome invalido na URL - servico usa o padrao dele
  }

  let buffer;
  try {
    buffer = await lerCorpo(req);
  } catch (e) {
    enviarJson(res, 400, { erro: 'upload_invalido', mensagem: 'Nao foi possivel receber o arquivo. Tente novamente.' });
    return;
  }

  let resultado;
  try {
    resultado = analisarArquivoXls(buffer, { nomeArquivo });
  } catch (e) {
    if (e instanceof ErroImportacao) {
      enviarJson(res, 400, { erro: e.codigo, mensagem: e.message });
      return;
    }
    throw e; // erro inesperado - tratado pelo catch generico em criarServidor (500)
  }

  enviarJson(res, 200, resultado);
}

/**
 * Contrato de POST /api/importar (Fase 5)
 *
 * Entrada (JSON, Content-Type: application/json):
 *   { "registros": [ ...objetos PRIME completos, exatamente como
 *                     devolvidos em `registros` por POST /api/analisar... ] }
 *
 * O navegador reenvia sem alteracao o mesmo array que recebeu de
 * /api/analisar (decisao B da Fase 5: servidor sem cache/estado de
 * sessao). Registros com validacao_status === "invalido" sao
 * descartados aqui antes de sincronizar - nunca foram elegiveis para
 * importacao (mesma semantica de "ignorados" desde a Fase 2C).
 *
 * Saida 200 (sucesso):
 *   {
 *     "total_processado": number,          // registros validos/com aviso enviados a sincronizacao
 *     "resumo_execucao": { criados, atualizados, quitados, sem_alteracao, nao_aplicados },
 *     "avisos": string[],                   // avisos gerados durante a sincronizacao (ex.: cliente removido da exportacao)
 *     "registros_nao_aplicados": Array<{ nex_codigo, motivo }>,
 *     "quantidade_eventos_historico": number
 *   }
 *
 * Codigos de erro possiveis:
 *   400 upload_invalido      - falha ao receber o corpo da requisicao (limite de tamanho excedido etc.)
 *   400 payload_invalido     - corpo nao e JSON valido, ou "registros" nao e array
 *   500 erro_sincronizacao   - ServicoSincronizacao/Repository falhou (mensagem generica; detalhe tecnico so no console)
 *   500 erro_interno         - qualquer outra falha inesperada nao tratada acima
 * Um array "registros" vazio (ou totalmente filtrado por serem invalidos
 * apos revalidacao em ServicoSincronizacao) NAO e erro - retorna 200 com
 * resumo_execucao zerado (mesma semantica de "ignorados" desde a Fase 2C).
 *
 * A filtragem de "quais registros sao elegiveis para sincronizar" NAO
 * acontece aqui - fica inteira em SERVICO/servico-sincronizacao.js, que
 * revalida cada registro com SRC/validar-normalizados.js em vez de
 * confiar no validacao_status que veio do navegador.
 */
function gerarPrimeId() {
  return 'PRIME-' + crypto.randomUUID();
}

async function tratarImportar(req, res) {
  let buffer;
  try {
    buffer = await lerCorpo(req);
  } catch (e) {
    enviarJson(res, 400, { erro: 'upload_invalido', mensagem: 'Nao foi possivel receber a solicitacao. Tente novamente.' });
    return;
  }

  let corpo;
  try {
    corpo = JSON.parse(buffer.toString('utf-8'));
  } catch (e) {
    enviarJson(res, 400, { erro: 'payload_invalido', mensagem: 'Corpo da requisicao nao e um JSON valido.' });
    return;
  }

  if (!corpo || !Array.isArray(corpo.registros)) {
    enviarJson(res, 400, { erro: 'payload_invalido', mensagem: 'Envie { registros: [...] } com o resultado de uma analise previa.' });
    return;
  }

  const contexto = { dataExecucao: new Date().toISOString(), geradorPrimeId: gerarPrimeId };

  let resultado;
  try {
    // A filtragem de elegibilidade (o que conta como "invalido") e a
    // revalidacao contra adulteracao acontecem dentro de sincronizar() -
    // ver SERVICO/servico-sincronizacao.js.
    resultado = await sincronizar(repository, corpo.registros, contexto);
  } catch (e) {
    // Log tecnico seguro: so a mensagem do erro, nunca o conteudo dos clientes.
    console.error('Falha ao sincronizar via /api/importar:', e && e.message);
    enviarJson(res, 500, { erro: 'erro_sincronizacao', mensagem: 'Nao foi possivel concluir a importacao. Nenhum dado foi salvo.' });
    return;
  }

  const execucao = resultado.execucao;
  enviarJson(res, 200, {
    total_processado: resultado.totalProcessado,
    resumo_execucao: execucao.resumo_execucao,
    avisos: execucao.avisos,
    registros_nao_aplicados: execucao.registros_nao_aplicados,
    quantidade_eventos_historico: execucao.eventos_gerados.length,
  });
}

function criarServidor() {
  return http.createServer((req, res) => {
    const rota = req.url.split('?')[0];
    if (req.method === 'POST' && rota === '/api/analisar') {
      tratarAnalisar(req, res).catch(() => {
        enviarJson(res, 500, { erro: 'erro_interno', mensagem: 'Erro inesperado ao processar o arquivo.' });
      });
      return;
    }
    if (req.method === 'POST' && rota === '/api/importar') {
      tratarImportar(req, res).catch(() => {
        enviarJson(res, 500, { erro: 'erro_interno', mensagem: 'Erro inesperado ao processar a importacao.' });
      });
      return;
    }
    if (req.method === 'GET') {
      servirEstatico(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

if (require.main === module) {
  const porta = process.env.PORT || 3000;
  const servidor = criarServidor();
  servidor.listen(porta, () => {
    console.log(`Servidor local rodando em http://localhost:${porta}`);
    console.log('Importacoes usam RepositorioClientesFake (memoria do processo) - nao ha banco real, nenhum dado e gravado em disco, nenhuma integracao externa. Reiniciar o servidor apaga tudo que foi importado.');
  });
}

// `repository` e exportado so para permitir que os testes armem falhas
// (simularFalhaNaProximaGravacao) ou inspecionem o estado da MESMA
// instancia que o servidor usa - nunca para logica de producao.
module.exports = { criarServidor, repository };
