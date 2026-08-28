'use strict';

/**
 * Identidade de transacao NEX (Fase EXPORT-FIRST - Fase D.2).
 *
 * PRINCIPIO CENTRAL: IDENTIDADE e FINGERPRINT sao responsabilidades
 * DIFERENTES e NAO devem ser misturadas.
 *   - IDENTIDADE (este arquivo) responde: "QUAL transacao NEX e esta?"
 *   - FINGERPRINT (fingerprint-transacao-nex.js) responde: "ESSA MESMA
 *     transacao mudou?"
 * Por isso a identidade aqui NUNCA usa hash de conteudo, e o fingerprint
 * nunca decide "qual" transacao e - so se ela mudou.
 *
 * ACHADO QUE MOTIVOU ESTE MODULO (Checkpoint D.1, aprovado): o export
 * oficial de Vendas contem, alem do namespace numerico sequencial padrao
 * (Origem="Local", ex.: "15751"), IDs de outros canais (Origem="Web"/"App"/
 * "Catálogo Online", ex.: "0001-W", "0001-C", "0001-7", "0001-2") cujo
 * contador NAO e globalmente unico - o mesmo "Número" pode se repetir ao
 * longo do tempo para transacoes de negocio genuinamente diferentes.
 *
 * REGRA DE IDENTIDADE:
 *   - Se nexTransactionId for PURAMENTE NUMERICO (regex /^\d+$/): a
 *     identidade depende SOMENTE de nexTransactionId. Comportamento
 *     identico ao da Fase D original - nenhum caso ja aprovado (#15751,
 *     #15756, #15758, #9999, #5595 etc.) muda de identidade.
 *   - Caso contrario (qualquer sufixo nao-numerico, nao hardcoded - a
 *     regra e generica e cobre formatos futuros semelhantes): a
 *     identidade passa a depender de nexTransactionId + occurredAt.
 *
 * occurredAt e OBRIGATORIO para IDs nao-numericos: se estiver ausente ou
 * invalido, este modulo NAO inventa uma identidade parcial - devolve um
 * resultado explicito de erro (status INVALID_IDENTITY), nunca um
 * timestamp de importacao/LastWriteTime/data atual como substituto.
 *
 * `source` e campos mutaveis (amountPaid, amountDebt, cancelled,
 * cancelledAt, paymentMethod) NUNCA fazem parte da identidade - eles
 * pertencem ao fingerprint, quando relevante.
 */

const REGEX_ID_PURAMENTE_NUMERICO = /^\d+$/;

/**
 * @param {string} nexTransactionId
 * @returns {boolean}
 */
function ehIdPuramenteNumerico(nexTransactionId) {
  if (nexTransactionId == null) return false;
  return REGEX_ID_PURAMENTE_NUMERICO.test(String(nexTransactionId).trim());
}

/**
 * @param {Object} registro - registro normalizado (venda ou transacao do
 *   cliente) - precisa ter `nexTransactionId` e, se o id nao for numerico,
 *   `occurredAt`.
 * @returns {{status:'OK', identityKey:string, numeric:boolean} | {status:'INVALID_IDENTITY', motivo:string}}
 */
function gerarChaveIdentidadeTransacaoNex(registro) {
  const r = registro || {};
  const idBruto = r.nexTransactionId;

  if (idBruto == null || String(idBruto).trim() === '') {
    return { status: 'INVALID_IDENTITY', motivo: 'NEX_TRANSACTION_ID_REQUIRED' };
  }

  const id = String(idBruto).trim();

  if (ehIdPuramenteNumerico(id)) {
    return { status: 'OK', identityKey: `NEX:${id}`, numeric: true };
  }

  const occurredAt = r.occurredAt;
  if (occurredAt == null || String(occurredAt).trim() === '') {
    return { status: 'INVALID_IDENTITY', motivo: 'OCCURRED_AT_REQUIRED_FOR_NON_NUMERIC_ID' };
  }

  return { status: 'OK', identityKey: `NEX:${id}:${occurredAt}`, numeric: false };
}

module.exports = { gerarChaveIdentidadeTransacaoNex, ehIdPuramenteNumerico, REGEX_ID_PURAMENTE_NUMERICO };
