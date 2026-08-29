'use strict';

/**
 * SCRIPT DE E2E REAL, USO MANUAL UNICO - NAO E TESTE PERMANENTE, NAO E
 * CHAMADO POR NENHUM PIPELINE AUTOMATICO.
 *
 * Executa exatamente 1 POST HTTP real para o endpoint webhookNex do
 * PRIME COBRANCAS, contendo APENAS o evento SALE_PAID:NEX:15751
 * (venda historica real, ja existente no export - nenhuma acao no NEX).
 *
 * O secret e lido via prompt oculto no proprio terminal de quem executa
 * este script - nunca passa por nenhuma outra ferramenta, nunca e escrito
 * em log/arquivo/commit.
 *
 * COMO RODAR (direto no seu terminal, fora de qualquer sessao de agente):
 *   cd C:\Nex\PrimeIntegracaoNex
 *   node SCRIPTS\e2e-post-unico-15751.js
 *
 * Vai pedir o secret (digitacao oculta) e depois mostrar um resumo
 * SANITIZADO do evento antes de enviar, pedindo confirmacao final.
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const PROJETO = __dirname + path.sep + '..';

const { lerExportVendas } = require(path.join(PROJETO, 'SERVICO', 'leitor-export-vendas'));
const { lerExportClientes } = require(path.join(PROJETO, 'SERVICO', 'leitor-export-clientes'));
const { normalizarVendaNex } = require(path.join(PROJETO, 'SRC', 'normalizar-venda-nex'));
const { normalizarClienteNex } = require(path.join(PROJETO, 'SRC', 'normalizar-cliente-nex'));
const { criarIndiceClientes } = require(path.join(PROJETO, 'SRC', 'customer-resolver-nex'));
const { gerarEventosDeVenda } = require(path.join(PROJETO, 'SERVICO', 'gerador-eventos-nex'));
const { avaliarGateEnvio } = require(path.join(PROJETO, 'SRC', 'gate-envio-evento-nex'));
const {
  criarRepositorioEventosHttp,
  construirCorpoRequisicao,
} = require(path.join(PROJETO, 'SERVICO', 'repositorio-eventos-http'));

const NEX_TRANSACTION_ID_ALVO = '15751';

const NEX_PRIME_ENDPOINT = 'https://primecobrancas.base44.app/functions/webhookNex';
const NEX_PRIME_ORIGIN = 'prime-store-udi-nex-01';

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
      if (char === '\n' || char === '\r' || char === '\u0004') {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(valor);
        return;
      }
      if (char === '\u0003') {
        process.stdout.write('\n');
        process.exit(1);
      }
      if (char === '\u007f' || char === '\b') {
        valor = valor.slice(0, -1);
        return;
      }
      valor += char;
    };

    stdin.on('data', onData);
  });
}

function perguntar(rl, texto) {
  return new Promise((resolve) => rl.question(texto, resolve));
}

async function main() {
  console.log('=== E2E REAL - POST UNICO #' + NEX_TRANSACTION_ID_ALVO + ' (SALE_PAID, CANELINHA) ===\n');

  const secret = await lerSecretOculto('Digite o NEX_PRIME_INTEGRATION_SECRET (nao sera exibido): ');
  if (!secret || !secret.trim()) {
    console.error('\nSecret vazio. Abortando. Nenhum POST foi feito.');
    process.exit(1);
  }

  // Pipeline real ja homologado (Fases A-E.1) - nao monta evento manualmente.
  const bufVendas = fs.readFileSync(path.join(PROJETO, 'EXPORTADOS', 'Exportar-28-08.xls'));
  const { linhas: linhasVendas } = lerExportVendas(bufVendas, { nomeArquivo: 'Exportar-28-08.xls' });
  const vendasNormalizadas = linhasVendas.map(normalizarVendaNex);

  const bufClientes = fs.readFileSync(path.join(PROJETO, 'EXPORTADOS', 'Exportar-clientes-completo.xls'));
  const { linhas: linhasClientes } = lerExportClientes(bufClientes, { nomeArquivo: 'Exportar-clientes-completo.xls' });
  const indice = criarIndiceClientes(linhasClientes.map(normalizarClienteNex));

  const vendaAlvo = vendasNormalizadas.find((v) => String(v.nexTransactionId) === NEX_TRANSACTION_ID_ALVO);
  if (!vendaAlvo) {
    console.error('\nVenda #' + NEX_TRANSACTION_ID_ALVO + ' nao encontrada no export. Abortando. Nenhum POST foi feito.');
    process.exit(1);
  }

  const entradas = gerarEventosDeVenda(vendaAlvo, indice);
  const entradaSalePaid = entradas.find((e) => e.eventType === 'SALE_PAID');
  if (!entradaSalePaid) {
    console.error('\nEvento SALE_PAID nao gerado para #' + NEX_TRANSACTION_ID_ALVO + ' (pipeline classificou diferente do esperado). Abortando.');
    console.error('Entradas geradas:', JSON.stringify(entradas.map((e) => e.eventType || e.status)));
    process.exit(1);
  }

  const resultadoGate = avaliarGateEnvio(entradaSalePaid);
  if (resultadoGate.status !== 'READY_TO_SEND') {
    console.error('\nGate nao aprovou o evento como READY_TO_SEND (motivo: ' + resultadoGate.reason + '). Abortando. Nenhum POST foi feito.');
    process.exit(1);
  }

  const { corpo } = construirCorpoRequisicao(NEX_PRIME_ORIGIN, resultadoGate);
  const eventoEnviado = corpo.events[0];

  if (corpo.events.length !== 1) {
    console.error('\nERRO INTERNO: batch != 1. Abortando.');
    process.exit(1);
  }

  console.log('\n=== EVENTO A SER ENVIADO (SANITIZADO) ===');
  console.log('endpoint:            ', NEX_PRIME_ENDPOINT);
  console.log('origin:              ', corpo.origin);
  console.log('batch:               ', corpo.events.length);
  console.log('eventId:             ', eventoEnviado.eventId);
  console.log('identityKey:         ', eventoEnviado.identityKey);
  console.log('contentHash:         ', eventoEnviado.contentHash);
  console.log('eventType:           ', eventoEnviado.eventType);
  console.log('occurredAt:          ', eventoEnviado.occurredAt);
  console.log('occurredAtTimezone:  ', eventoEnviado.occurredAtTimezone);
  console.log('sourceStatus:        ', eventoEnviado.sourceStatus);
  console.log('nexTransactionId:    ', eventoEnviado.nexTransactionId);
  console.log('nexCustomerCode:     ', eventoEnviado.nexCustomerCode);
  console.log('amount (payload):    ', eventoEnviado.payload && eventoEnviado.payload.amount);

  if (eventoEnviado.eventId !== 'SALE_PAID:NEX:' + NEX_TRANSACTION_ID_ALVO) {
    console.error('\nERRO: eventId nao bate com o esperado (SALE_PAID:NEX:' + NEX_TRANSACTION_ID_ALVO + '). Abortando.');
    process.exit(1);
  }

  // Travas explicitas de conteudo (cliente e valor), sobre os campos REAIS
  // ja produzidos pelo pipeline: nexCustomerCode (topo do evento HTTP) e
  // payload.amount (para SALE_PAID, amount = amountPaid - ver
  // SRC/gerador-evento-venda-nex.js). Nao inventam campo novo.
  if (String(eventoEnviado.nexCustomerCode) !== '316') {
    console.error('\nE2E_ABORTADO_CUSTOMER_CODE_DIVERGENTE');
    process.exit(1);
  }
  if (eventoEnviado.payload.amount !== 97) {
    console.error('\nE2E_ABORTADO_AMOUNT_DIVERGENTE');
    process.exit(1);
  }

  const rlConfirm = readline.createInterface({ input: process.stdin, output: process.stdout });
  const resposta = await perguntar(rlConfirm, '\nConfirma o ENVIO REAL (1 POST) deste evento? Digite EXATAMENTE "ENVIAR" para confirmar: ');
  rlConfirm.close();
  if (resposta !== 'ENVIAR') {
    console.log('\nConfirmacao nao recebida. Abortando. Nenhum POST foi feito.');
    process.exit(0);
  }

  const repo = criarRepositorioEventosHttp({
    endpoint: NEX_PRIME_ENDPOINT,
    origin: NEX_PRIME_ORIGIN,
    secret: secret.trim(),
  });

  console.log('\nEnviando (1 POST)...');
  const resultado = await repo.enviarEvento(resultadoGate);

  console.log('\n=== RESULTADO (SANITIZADO - sem secret, sem assinatura) ===');
  console.log('httpStatus:    ', resultado.httpStatus);
  console.log('correlationId: ', resultado.correlationId);
  console.log('eventId:       ', resultado.eventId);
  console.log('result:        ', resultado.result);
  console.log('erro:          ', resultado.erro);
  console.log('\nFIM. Nenhum segundo envio foi realizado por este script.');
}

main().catch((erro) => {
  console.error('\nErro inesperado (sanitizado):', erro && erro.message ? erro.message : String(erro));
  process.exit(1);
});
