'use strict';

/**
 * SCRIPT DE E2E REAL, USO MANUAL UNICO - NAO E TESTE PERMANENTE, NAO E
 * CHAMADO POR NENHUM PIPELINE AUTOMATICO.
 *
 * Executa exatamente 1 POST HTTP real para o endpoint webhookNex do
 * PRIME COBRANCAS, contendo APENAS o evento SALE_CANCELLED:NEX:9929
 * (venda historica real, ja cancelada no NEX - nenhuma acao no NEX,
 * nenhuma venda nova criada, nenhum cancelamento novo feito).
 *
 * Semantica do backend confirmada por auditoria direta do codigo real do
 * PRIME COBRANCAS antes desta implementacao: SALE_CANCELLED esta em
 * ALLOWED_EVENT_TYPES e no enum da Entity EventoNex; webhookNex e somente
 * inbox/persistencia em EventoNex + LogIntegracao; NAO existe no handler
 * nenhuma mutacao de Venda/Parcela/Recibo, nem cancelamento financeiro/
 * estorno/baixa/quitacao; nenhum consumer operacional de EventoNex reage
 * a SALE_CANCELLED.
 *
 * IMPORTANTE (auditoria F2.2-SALE_CANCELLED, etapa 1): o NEX nao cria um
 * numero de transacao separado para o cancelamento - "Cancelado"/
 * "Cancelado Em" sao atributos da MESMA linha da venda original. Por
 * isso o eventId/identityKey deste evento SALE_CANCELLED compartilham o
 * MESMO nexTransactionId (9929) do evento de base (SALE_PAID) ja
 * existente para esta transacao - isso NAO e inferido nem inventado por
 * este script, e a identidade compartilhada ja produzida pelo pipeline
 * real (SRC/gerador-evento-venda-nex.js, inalterado).
 *
 * DELIBERADAMENTE NAO usa o orquestrador (SERVICO/orquestrador-integracao-nex.js)
 * - SALE_CANCELLED continua fora de EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO
 * e este script nao altera isso. Reconstroi o evento chamando diretamente
 * os modulos de dominio ja homologados (Readers->Normalizacao->
 * CustomerResolver->Geracao->Gate), o mesmo padrao ja usado nos scripts
 * de homologacao anteriores (#15751/#15756/#15704/#15758).
 *
 * O secret e lido via prompt oculto no proprio terminal de quem executa
 * este script - nunca passa por nenhuma outra ferramenta, nunca e escrito
 * em log/arquivo/commit.
 *
 * COMO RODAR (direto no seu terminal, fora de qualquer sessao de agente):
 *   cd C:\Nex\PrimeIntegracaoNex
 *   node SCRIPTS\e2e-post-unico-9929.js
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

const NEX_TRANSACTION_ID_ALVO = '9929';
const EVENT_TYPE_ALVO = 'SALE_CANCELLED';
const NEX_CUSTOMER_CODE_ALVO = '624';
const OCCURRED_AT_ALVO = '2023-10-09T18:29:00';
const CONTENT_HASH_ALVO = 'd7e6e4388492f4cd8601143cd5cdbd698defff0ec0cfeedc3f44cce47fa81637';

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
 * Funcao PURA (sem I/O, sem process.exit) que avalia as travas
 * obrigatorias desta homologacao sobre um evento HTTP ja construido.
 * Retorna a lista de descricoes de travas que FALHARAM (vazia = tudo OK).
 */
function validarTravas(corpo, eventoEnviado) {
  const travas = [
    ['nexTransactionId === "' + NEX_TRANSACTION_ID_ALVO + '"', String(eventoEnviado.nexTransactionId) === NEX_TRANSACTION_ID_ALVO],
    ['eventType === "' + EVENT_TYPE_ALVO + '"', eventoEnviado.eventType === EVENT_TYPE_ALVO],
    ['sourceStatus === "READY_TO_SEND"', eventoEnviado.sourceStatus === 'READY_TO_SEND'],
    ['customerResolutionStatus === "RESOLVED"', eventoEnviado.payload.customerResolutionStatus === 'RESOLVED'],
    ['events.length === 1', corpo.events.length === 1],
    ['eventId === "' + EVENT_TYPE_ALVO + ':NEX:' + NEX_TRANSACTION_ID_ALVO + '"', eventoEnviado.eventId === EVENT_TYPE_ALVO + ':NEX:' + NEX_TRANSACTION_ID_ALVO],
    ['identityKey === "NEX:' + NEX_TRANSACTION_ID_ALVO + '"', eventoEnviado.identityKey === 'NEX:' + NEX_TRANSACTION_ID_ALVO],
    ['nexCustomerCode === "' + NEX_CUSTOMER_CODE_ALVO + '"', String(eventoEnviado.nexCustomerCode) === NEX_CUSTOMER_CODE_ALVO],
    ['occurredAt === "' + OCCURRED_AT_ALVO + '"', eventoEnviado.occurredAt === OCCURRED_AT_ALVO],
    ['payload.amount === null (nunca inventa valor para o cancelamento)', eventoEnviado.payload.amount === null],
    ['payload.cancelled === true', eventoEnviado.payload.cancelled === true],
    ['contentHash === "' + CONTENT_HASH_ALVO + '"', eventoEnviado.contentHash === CONTENT_HASH_ALVO],
    ['payload NAO contem relatedSaleId/parcelaId/debtId inventados', !Object.prototype.hasOwnProperty.call(eventoEnviado.payload, 'relatedSaleId') && !Object.prototype.hasOwnProperty.call(eventoEnviado.payload, 'parcelaId') && !Object.prototype.hasOwnProperty.call(eventoEnviado.payload, 'debtId')],
  ];
  return travas.filter(([, ok]) => !ok).map(([descricao]) => descricao);
}

/**
 * Monta o evento HTTP a partir do pipeline real (Reader->Parser->
 * Normalizacao->CustomerResolver->Classificacao->Gerador->Gate) e valida
 * todas as travas obrigatorias desta homologacao ANTES de qualquer
 * chamada de rede. Retorna { corpo, resultadoGate, eventoEnviado } ou
 * aborta o processo.
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
    console.error('\nEvento ' + EVENT_TYPE_ALVO + ' nao gerado para #' + NEX_TRANSACTION_ID_ALVO + ' (pipeline classificou diferente do esperado - a venda pode nao estar mais marcada como cancelada no export atual). Abortando.');
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
  console.log('=== E2E REAL - POST UNICO #' + NEX_TRANSACTION_ID_ALVO + ' (' + EVENT_TYPE_ALVO + ') ===\n');
  console.log('AVISO: este e o mesmo evento SALE_PAID:NEX:9929 ja existente (mesmo');
  console.log('nexTransactionId/identityKey), apenas com o flag de cancelamento. NENHUMA');
  console.log('venda nova sera criada. NENHUMA acao sera feita no NEX. SALE_CANCELLED');
  console.log('continua FORA da allowlist de envio automatico local apos este teste.\n');

  const secret = await lerSecretOculto('Digite o NEX_PRIME_INTEGRATION_SECRET (nao sera exibido): ');
  if (!secret || !secret.trim()) {
    console.error('\nSecret vazio. Abortando. Nenhum POST foi feito.');
    process.exit(1);
  }

  // Pipeline real ja homologado (Fases A-E.1) - nao monta evento manualmente.
  // Todas as travas sao validadas dentro desta funcao, antes do retorno.
  const { corpo, resultadoGate, eventoEnviado } = prepararEventoValidado();

  console.log('\n=== EVENTO A SER ENVIADO (SANITIZADO) ===');
  console.log('endpoint:                  ', NEX_PRIME_ENDPOINT);
  console.log('origin:                    ', corpo.origin);
  console.log('batch:                     ', corpo.events.length);
  console.log('eventId:                   ', eventoEnviado.eventId);
  console.log('identityKey:               ', eventoEnviado.identityKey);
  console.log('contentHash:               ', eventoEnviado.contentHash);
  console.log('eventType:                 ', eventoEnviado.eventType);
  console.log('occurredAt:                ', eventoEnviado.occurredAt);
  console.log('occurredAtTimezone:        ', eventoEnviado.occurredAtTimezone);
  console.log('sourceStatus:              ', eventoEnviado.sourceStatus);
  console.log('customerResolutionStatus:  ', eventoEnviado.payload && eventoEnviado.payload.customerResolutionStatus);
  console.log('nexTransactionId:          ', eventoEnviado.nexTransactionId);
  console.log('nexCustomerCode:           ', eventoEnviado.nexCustomerCode);
  console.log('amount:                    ', eventoEnviado.payload && eventoEnviado.payload.amount);
  console.log('cancelled:                 ', eventoEnviado.payload && eventoEnviado.payload.cancelled);
  console.log('cancelledAt:               ', eventoEnviado.payload && eventoEnviado.payload.cancelledAt);
  console.log('paymentMethod:             ', eventoEnviado.payload && eventoEnviado.payload.paymentMethod);
  console.log('items:                     ', JSON.stringify(eventoEnviado.payload && eventoEnviado.payload.items));

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
  console.log('Lembrete: rode este mesmo script de novo manualmente para o teste de reenvio (UNCHANGED),');
  console.log('conforme o roteiro da Etapa 2 - nao e feito automaticamente por este script.');
}

module.exports = { prepararEventoValidado, validarTravas };

if (require.main === module) {
  main().catch((erro) => {
    console.error('\nErro inesperado (sanitizado):', erro && erro.message ? erro.message : String(erro));
    process.exit(1);
  });
}
