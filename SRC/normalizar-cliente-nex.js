'use strict';

/**
 * Normalizacao PURA do cliente lido pelo leitor-export-clientes (Fase
 * EXPORT-FIRST - Fase B). Transforma a linha bruta em uma estrutura
 * previsivel - NAO conhece IGNITE PRIME, HTTP, Repository, CustomerResolver,
 * dedupe, eventId/eventType ou .nx1.
 *
 * IMPORTANTE: nexCustomerCode aqui vem DIRETAMENTE da coluna "Código" do
 * proprio cadastro de clientes - isso NAO e o futuro CustomerResolver (que
 * servira para descobrir o codigo quando uma VENDA so tem o nome do
 * cliente, sem coluna de codigo propria).
 *
 * O codigo e preservado como STRING (nunca convertido para Number), para
 * nao arriscar perder zeros a esquerda caso o NEX venha a usa-los no futuro.
 */

const path = require('path');
const SRC_DIR = __dirname;
const { normalizarNomeClienteNex } = require(path.join(SRC_DIR, 'utilitarios-export-nex'));

function isVazio(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function stringOuNull(v) {
  return isVazio(v) ? null : String(v).trim();
}

/**
 * @param {Object} linhaBruta - uma linha de `lerExportClientes(...).linhas`
 * @returns {Object} cliente normalizado
 */
function normalizarClienteNex(linhaBruta) {
  const l = linhaBruta || {};
  const nomeOriginal = stringOuNull(l.nome) || '';

  return {
    nexCustomerCode: stringOuNull(l.codigo),
    nome: nomeOriginal,
    nomeNormalizado: normalizarNomeClienteNex(nomeOriginal),
    debitoCredito: stringOuNull(l.debitoCredito),
    celular: stringOuNull(l.celular),
    telefone: stringOuNull(l.telefone),
    cpfCnpj: stringOuNull(l.cpfCnpj),
    status: stringOuNull(l.status),
    incluidoEm: stringOuNull(l.incluidoEm),
    alteradoEm: stringOuNull(l.alteradoEm),
    source: 'export_clientes',
  };
}

/**
 * Validacao explicita (nao lanca excecao) - segue o mesmo estilo de
 * SRC/validar-normalizados.js: devolve status/erros/avisos, nunca deixa
 * uma linha corrompida virar silenciosamente um registro "valido".
 *
 * @param {Object} clienteNormalizado - saida de normalizarClienteNex
 * @returns {{status: 'valido'|'invalido', erros: string[], avisos: string[]}}
 */
function validarClienteNex(clienteNormalizado) {
  const erros = [];
  const avisos = [];
  const c = clienteNormalizado || {};

  if (isVazio(c.nexCustomerCode)) erros.push('campo obrigatorio "Código" ausente');
  if (isVazio(c.nome)) erros.push('campo obrigatorio "Nome" ausente');

  if (isVazio(c.celular) && isVazio(c.telefone)) avisos.push('cliente sem nenhum telefone/celular cadastrado');

  return { status: erros.length ? 'invalido' : 'valido', erros, avisos };
}

module.exports = { normalizarClienteNex, validarClienteNex };
