'use strict';

/**
 * SCRIPT DE E2E REAL, USO MANUAL UNICO - NAO E TESTE PERMANENTE, NAO E
 * CHAMADO POR NENHUM PIPELINE AUTOMATICO.
 *
 * Executa exatamente 1 POST HTTP real para o endpoint webhookNex do
 * PRIME COBRANCAS, contendo APENAS o evento DEBT_PAYMENT:NEX:15758
 * (pagamento historico real, ja existente no extrato individual do
 * cliente - nenhuma acao no NEX).
 *
 * Semantica do backend confirmada por auditoria direta do codigo real do
 * PRIME COBRANCAS antes desta implementacao: DEBT_PAYMENT esta em
 * ALLOWED_EVENT_TYPES de base44/shared/webhookNexHandler.ts; o handler faz
 * SOMENTE recepcao/persistencia em EventoNex + LogIntegracao; nenhuma
 * logica financeira de Venda/Parcela/Recibo/baixa/quitacao/cancelamento;
 * nenhum consumer financeiro especifico de DEBT_PAYMENT/EventoNex foi
 * encontrado (as rotinas financeiras do PRIME estao ligadas a outros
 * fluxos, como EventoMercadoPago/Parcela, nao ao EventoNex).
 *
 * REGRA SEMANTICA CRITICA (categoria de evidencia D - auditoria F2.3):
 * #15758 NAO possui vinculo deterministico com DEBT_CREATED:NEX:15756,
 * nem com nenhuma Venda/Parcela/debtId/saleId/relatedSaleId/relatedDebtId.
 * O export oficial (extrato individual de cliente) NAO expoe nenhuma
 * coluna que ligue um pagamento a divida de origem - isso e uma limitacao
 * estrutural do dado, nao uma lacuna de implementacao (ver
 * SRC/gerador-evento-transacao-cliente-nex.js, que documenta a omissao
 * deliberada de relatedSaleId). O fato de #15756 (divida, R$89) e #15758
 * (pagamento, R$89) pertencerem ao mesmo cliente e ocorrerem em sequencia
 * e apenas uma narrativa util de auditoria - NUNCA um vinculo automatico.
 * Este script transporta DEBT_PAYMENT como fato ISOLADO. Nao implementa,
 * nao sugere e nao permite auto-baixa de nenhuma divida.
 *
 * Modelado sobre SCRIPTS/e2e-post-unico-15751.js (SALE_PAID),
 * SCRIPTS/e2e-post-unico-15756.js (DEBT_CREATED) e
 * SCRIPTS/e2e-post-unico-15704.js (SALE_PARTIALLY_PAID), todos
 * preservados intactos como evidencia. Nao generalizado para N eventos
 * nesta fase.
 *
 * O secret e lido via prompt oculto no proprio terminal de quem executa
 * este script - nunca passa por nenhuma outra ferramenta, nunca e escrito
 * em log/arquivo/commit.
 *
 * COMO RODAR (direto no seu terminal, fora de qualquer sessao de agente):
 *   cd C:\Nex\PrimeIntegracaoNex
 *   node SCRIPTS\e2e-post-unico-15758.js
 *
 * Vai pedir o secret (digitacao oculta) e depois mostrar um resumo
 * SANITIZADO do evento antes de enviar, pedindo confirmacao final.
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const PROJETO = __dirname + path.sep + '..';

const { lerExportTransacoesCliente } = require(path.join(PROJETO, 'SERVICO', 'leitor-export-transacoes-cliente'));
const { normalizarTransacaoClienteNex } = require(path.join(PROJETO, 'SRC', 'normalizar-transacao-cliente-nex'));
const { gerarEventoDeTransacaoCliente } = require(path.join(PROJETO, 'SERVICO', 'gerador-eventos-nex'));
const { avaliarGateEnvio } = require(path.join(PROJETO, 'SRC', 'gate-envio-evento-nex'));
const {
  criarRepositorioEventosHttp,
  construirCorpoRequisicao,
} = require(path.join(PROJETO, 'SERVICO', 'repositorio-eventos-http'));

const NEX_TRANSACTION_ID_ALVO = '15758';
const EVENT_TYPE_ALVO = 'DEBT_PAYMENT';
const NEX_CUSTOMER_CODE_ALVO = '292';
const CUSTOMER_NAME_ALVO = 'MATHEUS HENRIQUE DEPRE';
const AMOUNT_ALVO = 89;
const PAYMENT_METHOD_ALVO = 'Dinheiro';
const OCCURRED_AT_ALVO = '2026-08-28T17:08:00';
const CONTENT_HASH_ALVO = 'de1a31afdec9dc054ca90250d0e8ce6a11d6270fcd74eb2036e8768c8671400f';

// Contexto do relatorio (qual cliente foi selecionado na tela do NEX ao
// gerar o extrato individual) - fornecido explicitamente, NUNCA inferido
// da linha do export (o extrato nao repete nome/codigo do cliente por
// linha - ver gerador-evento-transacao-cliente-nex.js).
const CONTEXTO_CLIENTE = { nexCustomerCode: NEX_CUSTOMER_CODE_ALVO, customerName: CUSTOMER_NAME_ALVO };

// Campos que, se aparecessem no payload, representariam um vinculo com a
// divida original (proibido por esta fase - categoria de evidencia D).
const CAMPOS_DE_VINCULO_PROIBIDOS = [
  'relatedSaleId', 'relatedDebtId', 'saleId', 'vendaId', 'parcelaId', 'parcela_id', 'debtId',
];

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
 * Funcao PURA (sem I/O, sem process.exit) que avalia as 22 travas
 * obrigatorias desta homologacao. Recebe tambem o conjunto COMPLETO de
 * entradas geradas a partir do mesmo extrato (necessario para as travas
 * 20-22: ausencia de DEBT_CREATED/SALE_PAID/SALE_PARTIALLY_PAID gerados
 * junto para o mesmo nexTransactionId).
 * Retorna a lista de descricoes de travas que FALHARAM (vazia = tudo OK).
 */
function validarTravas(corpo, eventoEnviado, todasAsEntradasGeradas) {
  const payload = eventoEnviado.payload || {};

  const outrosEventTypesMesmaTransacao = todasAsEntradasGeradas
    .filter((e) => e && e.nexTransactionId === eventoEnviado.nexTransactionId && e.eventType && e !== payload)
    .map((e) => e.eventType);

  const camposDeVinculoPresentes = CAMPOS_DE_VINCULO_PROIBIDOS.filter((campo) => Object.prototype.hasOwnProperty.call(payload, campo));

  const travas = [
    ['nexTransactionId === "' + NEX_TRANSACTION_ID_ALVO + '"', String(eventoEnviado.nexTransactionId) === NEX_TRANSACTION_ID_ALVO],
    ['eventType === "' + EVENT_TYPE_ALVO + '"', eventoEnviado.eventType === EVENT_TYPE_ALVO],
    ['sourceStatus === "READY_TO_SEND"', eventoEnviado.sourceStatus === 'READY_TO_SEND'],
    ['customerResolutionStatus === "RESOLVED"', payload.customerResolutionStatus === 'RESOLVED'],
    ['events.length === 1', corpo.events.length === 1],
    ['eventId === "' + EVENT_TYPE_ALVO + ':NEX:' + NEX_TRANSACTION_ID_ALVO + '"', eventoEnviado.eventId === EVENT_TYPE_ALVO + ':NEX:' + NEX_TRANSACTION_ID_ALVO],
    ['identityKey === "NEX:' + NEX_TRANSACTION_ID_ALVO + '"', eventoEnviado.identityKey === 'NEX:' + NEX_TRANSACTION_ID_ALVO],
    ['nexCustomerCode === "' + NEX_CUSTOMER_CODE_ALVO + '"', String(eventoEnviado.nexCustomerCode) === NEX_CUSTOMER_CODE_ALVO],
    ['customerName === "' + CUSTOMER_NAME_ALVO + '"', payload.customerName === CUSTOMER_NAME_ALVO],
    ['payload.amount === ' + AMOUNT_ALVO, Number(payload.amount) === AMOUNT_ALVO],
    ['paymentMethod === "' + PAYMENT_METHOD_ALVO + '"', payload.paymentMethod === PAYMENT_METHOD_ALVO],
    ['contentHash === "' + CONTENT_HASH_ALVO + '"', eventoEnviado.contentHash === CONTENT_HASH_ALVO],
    ['occurredAt === "' + OCCURRED_AT_ALVO + '"', eventoEnviado.occurredAt === OCCURRED_AT_ALVO],
    ['NAO existe relatedSaleId/relatedDebtId/saleId/vendaId/parcelaId/debtId no payload', camposDeVinculoPresentes.length === 0],
    ['evento nao contem instrucao de baixa/quitacao (nenhum campo actionType/settlement/baixa)', !('actionType' in payload) && !('settlement' in payload) && !('baixa' in payload)],
    ['nenhum DEBT_CREATED adicional para este nexTransactionId', !outrosEventTypesMesmaTransacao.includes('DEBT_CREATED')],
    ['nenhum SALE_PAID adicional para este nexTransactionId', !outrosEventTypesMesmaTransacao.includes('SALE_PAID')],
    ['nenhum SALE_PARTIALLY_PAID adicional para este nexTransactionId', !outrosEventTypesMesmaTransacao.includes('SALE_PARTIALLY_PAID')],
  ];
  return travas.filter(([, ok]) => !ok).map(([descricao]) => descricao);
}

/**
 * Monta o evento HTTP a partir do pipeline real (Reader->Parser->
 * Normalizacao->Gerador(com contexto de cliente explicito)->Gate) e
 * valida todas as travas obrigatorias desta homologacao ANTES de qualquer
 * chamada de rede. Retorna { corpo, resultadoGate, eventoEnviado } ou
 * aborta o processo.
 */
function prepararEventoValidado() {
  const buf = fs.readFileSync(path.join(PROJETO, 'EXPORTADOS', 'Exportar-extrato-cliente-individual.xls'));
  const { linhas } = lerExportTransacoesCliente(buf, { nomeArquivo: 'Exportar-extrato-cliente-individual.xls' });
  const normalizadas = linhas.map(normalizarTransacaoClienteNex);

  const todasAsEntradas = normalizadas.map((t) => gerarEventoDeTransacaoCliente(t, CONTEXTO_CLIENTE));

  const entradaAlvo = todasAsEntradas.find(
    (e) => e && e.eventType === EVENT_TYPE_ALVO && String(e.nexTransactionId) === NEX_TRANSACTION_ID_ALVO,
  );
  if (!entradaAlvo) {
    console.error('\nEvento ' + EVENT_TYPE_ALVO + ' nao gerado para #' + NEX_TRANSACTION_ID_ALVO + ' (pipeline classificou diferente do esperado ou transacao nao encontrada). Abortando.');
    console.error('Entradas geradas:', JSON.stringify(todasAsEntradas.map((e) => e && (e.eventType || e.status))));
    process.exit(1);
  }

  const resultadoGate = avaliarGateEnvio(entradaAlvo);
  if (resultadoGate.status !== 'READY_TO_SEND') {
    console.error('\nGate nao aprovou o evento como READY_TO_SEND (motivo: ' + resultadoGate.reason + '). Abortando. Nenhum POST foi feito.');
    process.exit(1);
  }

  const { corpo } = construirCorpoRequisicao(NEX_PRIME_ORIGIN, resultadoGate);
  const eventoEnviado = corpo.events[0];

  const falhas = validarTravas(corpo, eventoEnviado, todasAsEntradas);
  if (falhas.length > 0) {
    console.error('\nE2E_ABORTADO_TRAVA_DIVERGENTE');
    falhas.forEach((descricao) => console.error('  - FALHOU:', descricao));
    process.exit(1);
  }

  return { corpo, resultadoGate, eventoEnviado, todasAsEntradas };
}

async function main() {
  console.log('=== E2E REAL - POST UNICO #' + NEX_TRANSACTION_ID_ALVO + ' (' + EVENT_TYPE_ALVO + ', MATHEUS HENRIQUE DEPRE) ===\n');
  console.log('AVISO: este evento e transportado como FATO ISOLADO. Nenhum vinculo com');
  console.log('DEBT_CREATED:NEX:15756 ou qualquer Venda/Parcela e criado ou inferido.\n');

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
  console.log('customerName:              ', eventoEnviado.payload && eventoEnviado.payload.customerName);
  console.log('amount:                    ', eventoEnviado.payload && eventoEnviado.payload.amount);
  console.log('paymentMethod:             ', eventoEnviado.payload && eventoEnviado.payload.paymentMethod);
  console.log('relatedSaleId presente?    ', Object.prototype.hasOwnProperty.call(eventoEnviado.payload || {}, 'relatedSaleId'));

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

module.exports = { prepararEventoValidado, validarTravas, CONTEXTO_CLIENTE };

if (require.main === module) {
  main().catch((erro) => {
    console.error('\nErro inesperado (sanitizado):', erro && erro.message ? erro.message : String(erro));
    process.exit(1);
  });
}
