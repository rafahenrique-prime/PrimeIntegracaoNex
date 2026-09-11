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

// Valores literais que o export do NEX por vezes grava como texto no lugar
// de deixar a celula vazia (ex.: coluna Email/Observações contendo a string
// "null"). Comparação sempre case-insensitive.
const PLACEHOLDERS_LITERAIS = new Set(['null', 'undefined', 'nan']);

/**
 * Igual a `isVazio`, mas também reconhece placeholders literais do NEX
 * ("null"/"undefined"/"NaN", case-insensitive) e, quando `tratarHifenComoAusente`
 * for true, um valor cujo conteúdo INTEIRO (após trim) seja exatamente "-"
 * (marcador de "não informado" usado pelo NEX em campos estruturados).
 *
 * NUNCA remove um hífen que faça parte de um valor maior - ex.: "Rua A-10"
 * continua válido em qualquer modo, porque a comparação é sempre com a
 * string inteira, nunca com uma sub-string.
 */
function ehPlaceholder(v, { tratarHifenComoAusente = false } = {}) {
  if (isVazio(v)) return true;
  const s = String(v).trim();
  if (PLACEHOLDERS_LITERAIS.has(s.toLowerCase())) return true;
  if (tratarHifenComoAusente && s === '-') return true;
  return false;
}

/**
 * Igual a `stringOuNull`, mas usando `ehPlaceholder` no lugar de `isVazio` -
 * ou seja, também colapsa placeholders literais do NEX para `null`.
 */
function campoOuNull(v, opcoes) {
  return ehPlaceholder(v, opcoes) ? null : String(v).trim();
}

// Cabeçalhos brutos (ver SERVICO/leitor-export-clientes.js) que compõem o
// endereço e não têm campo mapeado próprio em MAPA_CAMPOS - só existem em
// `linhaBruta`. Nesta ordem porque é a ordem natural de leitura de um
// endereço (logradouro, número, complemento, bairro, cidade, estado, CEP).
const CABECALHOS_ENDERECO = ['Endereço', 'Número', 'Complemento', 'Bairro', 'Cidade', 'Estado', 'CEP'];

/**
 * Monta o endereço a partir dos componentes brutos disponíveis em
 * `linhaBruta` (ver mapearLinhaPorCabecalho), normalizando CADA componente
 * individualmente antes de concatenar - assim um único componente
 * placeholder (ex.: CEP = "-") é descartado sem afetar os demais
 * componentes reais do mesmo endereço. Retorna `null` quando nenhum
 * componente sobra (endereço totalmente ausente/placeholder).
 */
function montarEndereco(linhaBruta) {
  const bruto = linhaBruta || {};
  const partes = CABECALHOS_ENDERECO
    .map((cabecalho) => campoOuNull(bruto[cabecalho], { tratarHifenComoAusente: true }))
    .filter(Boolean);
  return partes.length ? partes.join(', ') : null;
}

/**
 * @param {Object} linhaBruta - uma linha de `lerExportClientes(...).linhas`
 * @returns {Object} cliente normalizado
 */
function normalizarClienteNex(linhaBruta) {
  const l = linhaBruta || {};
  const nomeOriginal = stringOuNull(l.nome) || '';
  const status = stringOuNull(l.status);

  return {
    nexCustomerCode: stringOuNull(l.codigo),
    nome: nomeOriginal,
    nomeNormalizado: normalizarNomeClienteNex(nomeOriginal),
    debitoCredito: stringOuNull(l.debitoCredito),
    celular: campoOuNull(l.celular, { tratarHifenComoAusente: true }),
    telefone: campoOuNull(l.telefone, { tratarHifenComoAusente: true }),
    cpfCnpj: campoOuNull(l.cpfCnpj, { tratarHifenComoAusente: true }),
    email: campoOuNull(l.email, { tratarHifenComoAusente: true }),
    endereco: montarEndereco(l.linhaBruta),
    // "-" isolado em observações NÃO é tratado como placeholder (sem
    // evidência de que seja sempre um marcador de ausência ali, diferente
    // dos campos estruturados acima) - só "null"/"undefined"/"NaN"/vazio.
    observacoes: campoOuNull(l.observacoes, { tratarHifenComoAusente: false }),
    status,
    // Mapeamento homologado (F6.16C/F6.16D) do valor bruto do NEX para o
    // enum usado pelo Cliente do Base44. Campo adicional e não substitui
    // `status` (que preserva o valor bruto do NEX) para não quebrar
    // consumidores existentes que esperam o texto original ("Ativo").
    statusBase44: status === 'Ativo' ? 'ativo' : status === 'Inativo' ? 'inativo' : null,
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

module.exports = { normalizarClienteNex, validarClienteNex, ehPlaceholder, montarEndereco };
