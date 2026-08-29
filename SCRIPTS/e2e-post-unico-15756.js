'use strict';

/**
 * SCRIPT DE E2E REAL, USO MANUAL UNICO - NAO E TESTE PERMANENTE, NAO E
 * CHAMADO POR NENHUM PIPELINE AUTOMATICO.
 *
 * Executa exatamente 1 POST HTTP real para o endpoint webhookNex do
 * PRIME COBRANCAS, contendo APENAS o evento DEBT_CREATED:NEX:15756
 * (venda historica real, ja existente no export - nenhuma acao no NEX).
 *
 * Semantica do backend confirmada por auditoria direta do codigo real do
 * PRIME COBRANCAS antes desta implementacao: webhookNex e somente
 * inbox/persistencia em EventoNex + LogIntegracao; DEBT_CREATED nao cria
 * Venda/Parcela/Recibo automaticamente; processing_status inicial e
 * "received"; nenhum consumer automatico materializa DEBT_CREATED no
 * financeiro.
 *
 * Modelado sobre SCRIPTS/e2e-post-unico-15751.js (homologacao SALE_PAID,
 * preservado intacto como evidencia). Nao generalizado para N eventos
 * nesta fase - cada eventType ganha seu proprio script dedicado, com suas
 * proprias travas de conteudo, enquanto a homologacao ainda for manual.
 *
 * O secret e lido via prompt oculto no proprio terminal de quem executa
 * este script - nunca passa por nenhuma outra ferramenta, nunca e escrito
 * em log/arquivo/commit.
 *
 * COMO RODAR (direto no seu terminal, fora de qualquer sessao de agente):
 *   cd C:\Nex\PrimeIntegracaoNex
 *   node SCRIPTS\e2e-post-unico-15756.js
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

const NEX_TRANSACTION_ID_ALVO = '15756';
const EVENT_TYPE_ALVO = 'DEBT_CREATED';
const NEX_CUSTOMER_CODE_ALVO = '292';
const AMOUNT_ALVO = 89;
const CONTENT_HASH_ALVO = '25c3a8d64eb1ab29ecfd8b9a3d11858a119b0c237777170f5933d8513ed821ae';

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

/**
 * Funcao PURA (sem I/O, sem process.exit) que avalia as 12 travas
 * obrigatorias desta homologacao sobre um evento HTTP ja construido.
 * Retorna a lista de descricoes de travas que FALHARAM (vazia = tudo OK).
 * Exportada para ser testada isoladamente, inclusive com eventos
 * adulterados propositalmente, sem precisar rodar o pipeline real nem
 * derrubar o processo de teste com process.exit.
 */
function validarTravas(corpo, eventoEnviado) {
  const travas = [
    ['nexTransactionId === "' + NEX_TRANSACTION_ID_ALVO + '"', String(eventoEnviado.nexTransactionId) === NEX_TRANSACTION_ID_ALVO],
    ['eventType === "' + EVENT_TYPE_ALVO + '"', eventoEnviado.eventType === EVENT_TYPE_ALVO],
    ['sourceStatus === "READY_TO_SEND"', eventoEnviado.sourceStatus === 'READY_TO_SEND'],
    ['events.length === 1', corpo.events.length === 1],
    ['eventId === "' + EVENT_TYPE_ALVO + ':NEX:' + NEX_TRANSACTION_ID_ALVO + '"', eventoEnviado.eventId === EVENT_TYPE_ALVO + ':NEX:' + NEX_TRANSACTION_ID_ALVO],
    ['identityKey === "NEX:' + NEX_TRANSACTION_ID_ALVO + '"', eventoEnviado.identityKey === 'NEX:' + NEX_TRANSACTION_ID_ALVO],
    ['nexCustomerCode === "' + NEX_CUSTOMER_CODE_ALVO + '"', String(eventoEnviado.nexCustomerCode) === NEX_CUSTOMER_CODE_ALVO],
    ['payload.amount === ' + AMOUNT_ALVO, Number(eventoEnviado.payload.amount) === AMOUNT_ALVO],
    ['contentHash === "' + CONTENT_HASH_ALVO + '"', eventoEnviado.contentHash === CONTENT_HASH_ALVO],
    ['payload.amountPaid === null', eventoEnviado.payload.amountPaid === null],
    ['payload.amountDebt === ' + AMOUNT_ALVO, Number(eventoEnviado.payload.amountDebt) === AMOUNT_ALVO],
    ['payload.paymentMethod === null', eventoEnviado.payload.paymentMethod === null],
  ];
  return travas.filter(([, ok]) => !ok).map(([descricao]) => descricao);
}

/**
 * Monta o evento HTTP a partir do pipeline real (Reader->Parser->
 * Normalizacao->CustomerResolver->Classificacao->Gerador->Gate) e valida
 * as 12 travas obrigatorias desta homologacao ANTES de qualquer chamada
 * de rede. Retorna { corpo, resultadoGate } ou aborta o processo.
 */
function prepararEventoValidado() {
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
  const entradaAlvo = entradas.find((e) => e.eventType === EVENT_TYPE_ALVO);
  if (!entradaAlvo) {
    console.error('\nEvento ' + EVENT_TYPE_ALVO + ' nao gerado para #' + NEX_TRANSACTION_ID_ALVO + ' (pipeline classificou diferente do esperado). Abortando.');
    console.error('Entradas geradas:', JSON.stringify(entradas.map((e) => e.eventType || e.status)));
    process.exit(1);
  }

  const resultadoGate = avaliarGateEnvio(entradaAlvo);
  if (resultadoGate.status !== 'READY_TO_SEND') {
    console.error('\nGate nao aprovou o evento como READY_TO_SEND (motivo: ' + resultadoGate.reason + '). Abortando. Nenhum POST foi feito.');
    process.exit(1);
  }

  const { corpo } = construirCorpoRequisicao(NEX_PRIME_ORIGIN, resultadoGate);
  const eventoEnviado = corpo.events[0];

  const falhas = validarTravas(corpo, eventoEnviado);
  if (falhas.length > 0) {
    console.error('\nE2E_ABORTADO_TRAVA_DIVERGENTE');
    falhas.forEach((descricao) => console.error('  - FALHOU:', descricao));
    process.exit(1);
  }

  return { corpo, resultadoGate, eventoEnviado };
}

async function main() {
  console.log('=== E2E REAL - POST UNICO #' + NEX_TRANSACTION_ID_ALVO + ' (' + EVENT_TYPE_ALVO + ', MATHEUS HENRIQUE DEPRE) ===\n');

  const secret = await lerSecretOculto('Digite o NEX_PRIME_INTEGRATION_SECRET (nao sera exibido): ');
  if (!secret || !secret.trim()) {
    console.error('\nSecret vazio. Abortando. Nenhum POST foi feito.');
    process.exit(1);
  }

  // Pipeline real ja homologado (Fases A-E.1) - nao monta evento manualmente.
  // Todas as 12 travas sao validadas dentro desta funcao, antes do retorno.
  const { corpo, resultadoGate, eventoEnviado } = prepararEventoValidado();

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
  console.log('customerName:        ', eventoEnviado.payload && eventoEnviado.payload.customerName);
  console.log('payload.amount:      ', eventoEnviado.payload && eventoEnviado.payload.amount);
  console.log('amountPaid:          ', eventoEnviado.payload && eventoEnviado.payload.amountPaid);
  console.log('amountDebt:          ', eventoEnviado.payload && eventoEnviado.payload.amountDebt);
  console.log('paymentMethod:       ', eventoEnviado.payload && eventoEnviado.payload.paymentMethod);
  console.log('items:               ', JSON.stringify(eventoEnviado.payload && eventoEnviado.payload.items));

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

module.exports = { prepararEventoValidado, validarTravas };

if (require.main === module) {
  main().catch((erro) => {
    console.error('\nErro inesperado (sanitizado):', erro && erro.message ? erro.message : String(erro));
    process.exit(1);
  });
}
