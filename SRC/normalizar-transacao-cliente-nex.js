'use strict';

/**
 * Normalizacao PURA da transacao lida pelo leitor-export-transacoes-cliente
 * (extrato individual do cliente, Fase EXPORT-FIRST - Fase B). Transforma a
 * linha bruta em uma estrutura previsivel - NAO conhece IGNITE PRIME, HTTP,
 * Repository, dedupe, eventId ou eventType final (ex.: NAO decide ainda que
 * "Tipo = Pagamento Débito" vira um evento DEBT_PAYMENT - so preserva o
 * texto original em `transactionType`).
 *
 * IMPORTANTE: o extrato individual do cliente nao repete necessariamente o
 * nome/codigo do cliente em cada linha (auditado - o cliente e o contexto
 * de geracao do proprio relatorio, nao uma coluna). Este normalizador NAO
 * inventa nexCustomerCode nem customerName - quem sabe qual cliente gerou
 * o extrato e quem chamou o leitor (uma camada/orquestrador futuro, ainda
 * nao aprovado).
 */

const path = require('path');
const SRC_DIR = __dirname;
const { parseValorSolto } = require(path.join(SRC_DIR, 'parser-financeiro'));
const { parseDataNex, parseHoraNex, combinarDataHora } = require(path.join(SRC_DIR, 'parser-datas'));
const { parseBooleanoSimNao } = require(path.join(SRC_DIR, 'utilitarios-export-nex'));

function isVazio(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function stringOuNull(v) {
  return isVazio(v) ? null : String(v).trim();
}

/**
 * @param {Object} linhaBruta - uma linha de `lerExportTransacoesCliente(...).linhas`
 * @returns {Object} transacao normalizada
 */
function normalizarTransacaoClienteNex(linhaBruta) {
  const l = linhaBruta || {};

  const data = parseDataNex(l.data);
  const hora = parseHoraNex(l.hora);

  return {
    nexTransactionId: stringOuNull(l.noTran),
    occurredAt: combinarDataHora(data, hora),
    transactionType: stringOuNull(l.tipo),
    description: stringOuNull(l.descricao),
    totalAmount: parseValorSolto(l.totalFinal),
    amountPaid: parseValorSolto(l.valorPago),
    amountDebt: parseValorSolto(l.debitado),
    paymentMethod: stringOuNull(l.meioPagto),
    seller: stringOuNull(l.vendedor),
    employee: stringOuNull(l.funcionario),
    cancelled: parseBooleanoSimNao(l.cancelado) === true,
    source: 'export_extrato_cliente_individual',
  };
}

/**
 * Validacao explicita (nao lanca excecao). Segue o estilo de
 * SRC/validar-normalizados.js.
 *
 * @param {Object} transacaoNormalizada - saida de normalizarTransacaoClienteNex
 * @param {Object} [linhaBruta] - linha original, usada so para diagnosticar
 *   *qual* campo bruto (data ou hora) causou occurredAt=null.
 * @returns {{status: 'valido'|'invalido', erros: string[], avisos: string[]}}
 */
function validarTransacaoClienteNex(transacaoNormalizada, linhaBruta) {
  const erros = [];
  const avisos = [];
  const t = transacaoNormalizada || {};
  const l = linhaBruta || {};

  if (isVazio(t.nexTransactionId)) erros.push('campo obrigatorio "No.Tran" ausente');
  if (isVazio(t.transactionType)) erros.push('campo obrigatorio "Tipo" ausente');

  if (isVazio(t.occurredAt)) {
    if (!isVazio(l.data) && parseDataNex(l.data) == null) {
      erros.push('campo "Data" invalido');
    } else if (isVazio(l.data)) {
      erros.push('campo obrigatorio "Data" ausente');
    }
  }
  if (!isVazio(l.hora) && parseHoraNex(l.hora) == null) {
    erros.push('campo "Hora" invalido');
  }

  return { status: erros.length ? 'invalido' : 'valido', erros, avisos };
}

module.exports = { normalizarTransacaoClienteNex, validarTransacaoClienteNex };
