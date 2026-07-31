'use strict';

/**
 * Servidor HTTP local. NENHUM efeito colateral: nao grava arquivo em
 * disco, nao acessa banco, nao integra Base44. Responsabilidade unica
 * desta camada: adaptar HTTP <-> ServicoImportacao.
 *
 * - recebe a requisicao;
 * - valida aspectos basicos de transporte (corpo dentro do limite);
 * - chama SERVICO/servico-importacao.js;
 * - traduz o resultado/erro em resposta HTTP;
 * - nao contem regra de negocio nem le/normaliza a planilha diretamente
 *   (isso migrou para servico-importacao.js na Fase 4B).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { analisarArquivoXls, ErroImportacao } = require(path.join(__dirname, 'servico-importacao'));

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

function criarServidor() {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/analisar') {
      tratarAnalisar(req, res).catch(() => {
        enviarJson(res, 500, { erro: 'erro_interno', mensagem: 'Erro inesperado ao processar o arquivo.' });
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
    console.log('SIMULACAO - nenhum dado e gravado, nenhum banco e acessado, nenhuma integracao real.');
  });
}

module.exports = { criarServidor };
