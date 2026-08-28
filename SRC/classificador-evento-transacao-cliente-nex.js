'use strict';

/**
 * Classificacao PURA de uma transacao do extrato individual do cliente
 * (Fase EXPORT-FIRST - Fase E). Fonte primaria formalizada: o extrato
 * individual do cliente e a fonte primaria SOMENTE para PAGAMENTO DÉBITO
 * (DEBT_PAYMENT) - conforme Checkpoint D.1/politica aprovada na Fase E.
 *
 * IMPORTANTE (politica de fontes, NAO merge automatico): o extrato
 * individual tambem contem linhas "Venda" (o mesmo fato que o Export de
 * Vendas ja cobre com autoridade). Este classificador NAO reclassifica
 * "Venda" como SALE_PAID/DEBT_CREATED/etc. - isso pertenceria ao Export de
 * Vendas. Uma linha "Venda" encontrada aqui volta como UNCLASSIFIED com
 * motivo explicito, documentando a decisao de nao fazer merge de fontes
 * nesta fase.
 */

function classificarTransacaoCliente(transacaoNormalizada) {
  const t = transacaoNormalizada || {};

  if (t.transactionType === 'Pagamento Débito') {
    return { status: 'CLASSIFIED', eventType: 'DEBT_PAYMENT' };
  }

  return {
    status: 'UNCLASSIFIED',
    motivo:
      t.transactionType === 'Venda'
        ? 'VENDA_NO_EXTRATO_INDIVIDUAL_NAO_CLASSIFICADA_AQUI_FONTE_PRIMARIA_E_EXPORT_VENDAS'
        : `TRANSACTION_TYPE_NAO_TRATADO: ${t.transactionType == null ? '(ausente)' : t.transactionType}`,
  };
}

module.exports = { classificarTransacaoCliente };
