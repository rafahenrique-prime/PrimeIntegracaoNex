'use strict';

/**
 * Normalizacao PURA da venda lida pelo leitor-export-vendas (Fase
 * EXPORT-FIRST - Fase B). Transforma a linha bruta em uma estrutura
 * previsivel - NAO conhece IGNITE PRIME, HTTP, Repository, CustomerResolver,
 * dedupe, eventId, eventType final ou .nx1.
 *
 * DECISAO DE DESIGN (pagamento parcial, ex.: venda real #9999 do historico -
 * Valor Pago R$420,00 + Debitado R$139,00 na MESMA linha):
 * este normalizador PRESERVA os dois fatos, `amountPaid` e `amountDebt`,
 * de forma independente - NAO decide se a venda e SALE_PAID, DEBT_CREATED
 * ou um futuro SALE_PARTIALLY_PAID. Essa classificacao pertence a uma fase
 * posterior (ainda nao aprovada). Aqui: preservar fatos, nao inventar
 * eventos.
 */

const path = require('path');
const SRC_DIR = __dirname;
const { parseValorSolto } = require(path.join(SRC_DIR, 'parser-financeiro'));
const { parseItensVenda } = require(path.join(SRC_DIR, 'parser-itens-venda'));
const { parseDataNex, parseHoraNex, combinarDataHora } = require(path.join(SRC_DIR, 'parser-datas'));
const { parseBooleanoSimNao } = require(path.join(SRC_DIR, 'utilitarios-export-nex'));

const TIPOS_CONHECIDOS = ['Venda', 'Devolução'];

function isVazio(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function stringOuNull(v) {
  return isVazio(v) ? null : String(v).trim();
}

/**
 * @param {Object} linhaBruta - uma linha de `lerExportVendas(...).linhas`
 * @returns {Object} venda normalizada
 */
function normalizarVendaNex(linhaBruta) {
  const l = linhaBruta || {};

  const data = parseDataNex(l.data);
  const hora = parseHoraNex(l.hora);

  return {
    nexTransactionId: stringOuNull(l.numero),
    occurredAt: combinarDataHora(data, hora),
    tipoOriginal: stringOuNull(l.tipo),
    customerName: stringOuNull(l.cliente),
    items: parseItensVenda(l.itens),
    subtotal: parseValorSolto(l.subtotal),
    discount: parseValorSolto(l.desconto),
    amountPaid: parseValorSolto(l.valorPago),
    amountDebt: parseValorSolto(l.debitado),
    paymentMethod: stringOuNull(l.meioPagto),
    cancelled: parseBooleanoSimNao(l.cancelado) === true,
    cancelledAt: stringOuNull(l.canceladoEm),
    seller: stringOuNull(l.vendedor),
    employee: stringOuNull(l.funcionario),
    observations: stringOuNull(l.observacoes),
    source: 'export_vendas_historico',
  };
}

/**
 * Validacao explicita (nao lanca excecao). Segue o estilo de
 * SRC/validar-normalizados.js.
 *
 * @param {Object} vendaNormalizada - saida de normalizarVendaNex
 * @param {Object} [linhaBruta] - linha original, usada so para diagnosticar
 *   *qual* campo bruto (data ou hora) causou occurredAt=null.
 * @returns {{status: 'valido'|'valido_com_aviso'|'invalido', erros: string[], avisos: string[]}}
 */
function validarVendaNex(vendaNormalizada, linhaBruta) {
  const erros = [];
  const avisos = [];
  const v = vendaNormalizada || {};
  const l = linhaBruta || {};

  if (isVazio(v.nexTransactionId)) erros.push('campo obrigatorio "Número" ausente');

  if (isVazio(v.occurredAt)) {
    if (!isVazio(l.data) && parseDataNex(l.data) == null) {
      erros.push('campo "Data" invalido');
    } else if (isVazio(l.data)) {
      erros.push('campo obrigatorio "Data" ausente');
    }
  }
  if (!isVazio(l.hora) && parseHoraNex(l.hora) == null) {
    erros.push('campo "Hora" invalido');
  }

  if (v.tipoOriginal && TIPOS_CONHECIDOS.indexOf(v.tipoOriginal) === -1) {
    avisos.push(`"Tipo" inesperado: "${v.tipoOriginal}" (esperado um de: ${TIPOS_CONHECIDOS.join(', ')})`);
  } else if (isVazio(v.tipoOriginal)) {
    erros.push('campo obrigatorio "Tipo" ausente');
  }

  const status = erros.length ? 'invalido' : avisos.length ? 'valido_com_aviso' : 'valido';
  return { status, erros, avisos };
}

module.exports = { normalizarVendaNex, validarVendaNex, TIPOS_CONHECIDOS };
