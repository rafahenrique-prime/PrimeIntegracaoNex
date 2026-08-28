'use strict';

/**
 * CustomerResolver puro e deterministico (Fase EXPORT-FIRST - Fase C).
 *
 * Resolve o nome de cliente de uma VENDA (que so tem texto livre, sem
 * codigo proprio) contra o indice construido a partir do cadastro oficial
 * de clientes (normalizarClienteNex), usando EXCLUSIVAMENTE normalizacao
 * exata controlada de nome (trim -> colapsar espacos -> uppercase ->
 * remover acentos, via normalizarNomeClienteNex ja existente).
 *
 * PROIBIDO NESTE MODULO: fuzzy matching, Levenshtein, similaridade,
 * startsWith/includes, apelidos, heuristica por sobrenome, "cliente mais
 * recente/frequente", "primeiro/menor/maior codigo", aproximacao por
 * telefone/CPF. A resolucao depende SOMENTE do nome normalizado.
 *
 * Nao gera eventId, eventType, dedupe, nem conhece IGNITE PRIME/HTTP/.nx1.
 */

const path = require('path');
const { normalizarNomeClienteNex } = require(path.join(__dirname, 'utilitarios-export-nex'));

/**
 * Constroi o indice de clientes a partir da lista de clientes normalizados
 * (saida de normalizarClienteNex, um por linha do export de Clientes).
 *
 * IMPORTANTE: o indice e Map<nomeNormalizado, Array<candidato>> - NUNCA
 * Map<nome, codigoUnico> - porque o mesmo nome pode legitimamente apontar
 * para varios codigos distintos (ex.: "CAROL BARBOSA" no cadastro real tem
 * multiplos codigos). Colapsar isso destruiria a ambiguidade real que o
 * CustomerResolver precisa detectar.
 *
 * @param {Object[]} clientesNormalizados - saida de normalizarClienteNex (um array)
 * @returns {Map<string, Array<{nexCustomerCode:string, nome:string, nomeNormalizado:string}>>}
 */
function criarIndiceClientes(clientesNormalizados) {
  const indice = new Map();
  const lista = Array.isArray(clientesNormalizados) ? clientesNormalizados : [];

  for (const cliente of lista) {
    if (!cliente || !cliente.nexCustomerCode) continue; // sem codigo -> nao e um candidato valido de resolucao
    const nomeNormalizado = cliente.nomeNormalizado || normalizarNomeClienteNex(cliente.nome);
    if (!nomeNormalizado) continue; // nome vazio -> nunca pode ser candidato (evitaria colisao generalizada em "")

    if (!indice.has(nomeNormalizado)) indice.set(nomeNormalizado, []);
    indice.get(nomeNormalizado).push({
      nexCustomerCode: cliente.nexCustomerCode,
      nome: cliente.nome,
      nomeNormalizado,
    });
  }

  return indice;
}

/**
 * Resolve um nome de venda (texto livre) contra o indice de clientes.
 * Regra fixa, sem excecao: 0 matches -> REVIEW_REQUIRED/SEM_MATCH;
 * 1 match -> RESOLVED; 2+ matches -> REVIEW_REQUIRED/MULTIPLOS_MATCHES.
 *
 * @param {string} nomeVenda - nome bruto vindo de vendaNormalizada.customerName
 * @param {Map} indiceClientes - saida de criarIndiceClientes
 * @returns {Object} resolucao (ver formatos RESOLVED/REVIEW_REQUIRED abaixo)
 */
function resolverCliente(nomeVenda, indiceClientes) {
  const nomeOriginal = nomeVenda == null ? '' : String(nomeVenda).trim();
  const nomeNormalizado = normalizarNomeClienteNex(nomeOriginal);

  if (!nomeNormalizado) {
    return {
      status: 'REVIEW_REQUIRED',
      motivo: 'SEM_MATCH',
      nomeOriginal,
      nomeNormalizado,
      candidatos: [],
    };
  }

  const candidatos = (indiceClientes && indiceClientes.get(nomeNormalizado)) || [];

  if (candidatos.length === 0) {
    return {
      status: 'REVIEW_REQUIRED',
      motivo: 'SEM_MATCH',
      nomeOriginal,
      nomeNormalizado,
      candidatos: [],
    };
  }

  if (candidatos.length === 1) {
    return {
      status: 'RESOLVED',
      nexCustomerCode: candidatos[0].nexCustomerCode,
      nomeOriginal,
      nomeNormalizado,
    };
  }

  return {
    status: 'REVIEW_REQUIRED',
    motivo: 'MULTIPLOS_MATCHES',
    nomeOriginal,
    nomeNormalizado,
    candidatos: candidatos.slice(),
  };
}

/**
 * Funcao de apoio: resolve o cliente diretamente a partir de uma venda ja
 * normalizada (normalizarVendaNex). NAO muta a venda original - devolve um
 * novo objeto combinando venda + resolucao. NAO insere nexCustomerCode
 * dentro do objeto de venda por mutacao.
 *
 * @param {Object} vendaNormalizada - saida de normalizarVendaNex
 * @param {Map} indiceClientes - saida de criarIndiceClientes
 * @returns {{ venda: Object, resolucaoCliente: Object }}
 */
function resolverClienteDaVenda(vendaNormalizada, indiceClientes) {
  const venda = vendaNormalizada || {};
  const resolucaoCliente = resolverCliente(venda.customerName, indiceClientes);
  return { venda, resolucaoCliente };
}

module.exports = { criarIndiceClientes, resolverCliente, resolverClienteDaVenda };
