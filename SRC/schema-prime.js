'use strict';

/**
 * Definicao congelada do schema do PRIME Cobrancas (aprovada em Fase 2).
 * Apenas metadados dos campos - nao contem logica de validacao
 * (isso pertence a validar-normalizados.js, ainda nao implementado).
 */
const SCHEMA_PRIME = [
  // A. Identificacao
  { campo: 'prime_id', tipo: 'string(uuid)', obrigatorio: true, origem: 'PRIME', finalidade: 'Identificador unico e definitivo do cliente no PRIME', editavel: false },
  { campo: 'nex_codigo', tipo: 'string|number', obrigatorio: true, origem: 'NEX', finalidade: 'Referencia externa ao Codigo do cadastro do NEX', editavel: false },
  { campo: 'origem_sistema', tipo: 'enum(NEX,Base44,Manual,CSV,API,Outro)', obrigatorio: true, origem: 'PRIME', finalidade: 'Sistema/processo de origem do registro', editavel: false },

  // B. Identidade
  { campo: 'nome', tipo: 'string', obrigatorio: true, origem: 'NEX', finalidade: 'Identificacao do cliente', editavel: true },
  { campo: 'cpf_cnpj', tipo: 'string', obrigatorio: false, origem: 'NEX', finalidade: 'Documento legal, quando disponivel', editavel: true },

  // C. Contato
  { campo: 'telefone', tipo: 'string', obrigatorio: false, origem: 'NEX', finalidade: 'Canal secundario', editavel: true },
  { campo: 'celular', tipo: 'string', obrigatorio: false, origem: 'NEX', finalidade: 'Canal principal (WhatsApp)', editavel: true },
  { campo: 'email', tipo: 'string', obrigatorio: false, origem: 'NEX', finalidade: 'Canal alternativo', editavel: true },
  { campo: 'canal_preferido', tipo: 'enum(whatsapp,sms,ligacao,email,nenhum)', obrigatorio: false, origem: 'PRIME/IA', finalidade: 'Canal priorizado pela automacao', editavel: true },
  { campo: 'whatsapp_validado', tipo: 'boolean', obrigatorio: false, origem: 'PRIME', finalidade: 'Confirma se o numero e WhatsApp ativo', editavel: true },

  // D. Endereco
  { campo: 'endereco_logradouro', tipo: 'string', obrigatorio: false, origem: 'NEX', finalidade: 'Endereco', editavel: true },
  { campo: 'endereco_numero', tipo: 'string', obrigatorio: false, origem: 'NEX', finalidade: 'Endereco', editavel: true },
  { campo: 'endereco_complemento', tipo: 'string', obrigatorio: false, origem: 'NEX', finalidade: 'Endereco', editavel: true },
  { campo: 'endereco_bairro', tipo: 'string', obrigatorio: false, origem: 'NEX', finalidade: 'Endereco', editavel: true },
  { campo: 'endereco_cidade', tipo: 'string', obrigatorio: false, origem: 'NEX', finalidade: 'Endereco', editavel: true },
  { campo: 'endereco_uf', tipo: 'string', obrigatorio: false, origem: 'NEX', finalidade: 'Endereco', editavel: true },
  { campo: 'endereco_cep', tipo: 'string', obrigatorio: false, origem: 'NEX', finalidade: 'Endereco', editavel: true },

  // E. Situacao financeira
  { campo: 'saldo_debito_nex', tipo: 'decimal', obrigatorio: true, origem: 'NEX', finalidade: 'Valor de debito da ultima exportacao', editavel: false },
  { campo: 'saldo_credito_nex', tipo: 'decimal', obrigatorio: true, origem: 'NEX', finalidade: 'Valor de credito da ultima exportacao', editavel: false },
  { campo: 'saldo_debito_anterior', tipo: 'decimal', obrigatorio: false, origem: 'PRIME', finalidade: 'saldo_debito_nex da sincronizacao anterior', editavel: false },
  { campo: 'saldo_credito_anterior', tipo: 'decimal', obrigatorio: false, origem: 'PRIME', finalidade: 'saldo_credito_nex da sincronizacao anterior', editavel: false },
  { campo: 'variacao_saldo', tipo: 'decimal', obrigatorio: false, origem: 'Derivado', finalidade: 'Diferenca entre saldo liquido atual e anterior', editavel: false },
  { campo: 'valor_liquido_nex', tipo: 'decimal', obrigatorio: true, origem: 'Derivado', finalidade: 'saldo_debito_nex - saldo_credito_nex', editavel: false },
  { campo: 'data_snapshot_nex', tipo: 'timestamp', obrigatorio: true, origem: 'PRIME', finalidade: 'Data do arquivo que originou o saldo', editavel: false },

  // F. Sugestoes extraidas de Observacoes (nunca autoritativas)
  { campo: 'observacao_original_nex', tipo: 'string', obrigatorio: false, origem: 'NEX', finalidade: 'Texto bruto preservado', editavel: false },
  { campo: 'observacao_categoria', tipo: 'enum(estruturada,parcialmente_estruturada,texto_operacional,ambigua,vazia)', obrigatorio: false, origem: 'Derivado', finalidade: 'Classificacao automatica da observacao', editavel: false },
  { campo: 'vencimento_sugerido', tipo: 'integer(dia)', obrigatorio: false, origem: 'Derivado', finalidade: 'Sugestao de vencimento extraida da observacao', editavel: true },
  { campo: 'parcelamento_sugerido', tipo: 'object{qtd,valor}', obrigatorio: false, origem: 'Derivado', finalidade: 'Sugestao de parcelamento extraida da observacao', editavel: true },
  { campo: 'confianca_extracao', tipo: 'enum(alta,media,baixa)|null', obrigatorio: false, origem: 'Derivado', finalidade: 'Confiabilidade da extracao acima', editavel: false },

  // G. Dados definitivos de cobranca
  { campo: 'vencimento_confirmado', tipo: 'date|integer', obrigatorio: false, origem: 'PRIME', finalidade: 'Vencimento validado por humano', editavel: true },
  { campo: 'parcelamento_confirmado', tipo: 'object{qtd,valor}', obrigatorio: false, origem: 'PRIME', finalidade: 'Parcelamento validado', editavel: true },
  { campo: 'status_cobranca', tipo: 'enum(sem_debito,em_aberto,em_negociacao,cobranca_enviada,promessa_pagamento,pago,inadimplente_recorrente)', obrigatorio: true, origem: 'PRIME', finalidade: 'Estado do processo de cobranca', editavel: true },
  { campo: 'observacao_prime', tipo: 'string', obrigatorio: false, origem: 'PRIME', finalidade: 'Anotacao interna da equipe', editavel: true },

  // H. Historico
  { campo: 'historico', tipo: 'array<object>', obrigatorio: true, origem: 'PRIME', finalidade: 'Log de eventos do cliente', editavel: false },

  // I. Automacao / IA
  { campo: 'ultima_cobranca_enviada_em', tipo: 'timestamp', obrigatorio: false, origem: 'PRIME', finalidade: 'Controle de reenvio', editavel: false },
  { campo: 'proxima_cobranca_agendada_em', tipo: 'timestamp', obrigatorio: false, origem: 'PRIME/IA', finalidade: 'Proxima acao agendada', editavel: true },
  { campo: 'tentativas_cobranca', tipo: 'integer', obrigatorio: true, origem: 'PRIME', finalidade: 'Contador de tentativas', editavel: false },
  { campo: 'risco_inadimplencia', tipo: 'decimal|enum', obrigatorio: false, origem: 'IA', finalidade: 'Score de propensao a nao pagar', editavel: false },
  { campo: 'resumo_ia', tipo: 'string', obrigatorio: false, origem: 'IA', finalidade: 'Resumo textual da situacao', editavel: false },
  { campo: 'sentimento_ultima_resposta', tipo: 'enum', obrigatorio: false, origem: 'IA', finalidade: 'Sentimento da ultima resposta do cliente', editavel: false },

  // J. Consentimento / LGPD
  { campo: 'consentimento_contato', tipo: 'enum(concedido,negado,nao_solicitado)', obrigatorio: true, origem: 'PRIME', finalidade: 'Controle de consentimento para contato', editavel: true },
  { campo: 'consentimento_registrado_em', tipo: 'timestamp', obrigatorio: false, origem: 'PRIME', finalidade: 'Auditoria do consentimento', editavel: false },

  // K. Qualidade do cadastro
  { campo: 'cadastro_score', tipo: 'decimal|enum', obrigatorio: false, origem: 'Derivado', finalidade: 'Avaliacao automatica da qualidade/completude do cadastro (algoritmo ainda nao definido)', editavel: false },

  // L. Auditoria e controle de importacao/sincronizacao
  { campo: 'criado_em', tipo: 'timestamp', obrigatorio: true, origem: 'PRIME', finalidade: 'Data da importacao inicial', editavel: false },
  { campo: 'atualizado_em', tipo: 'timestamp', obrigatorio: true, origem: 'PRIME', finalidade: 'Data da ultima sincronizacao', editavel: false },
  { campo: 'fonte_arquivo_origem', tipo: 'string', obrigatorio: true, origem: 'PRIME', finalidade: 'Nome do arquivo usado na ultima sincronizacao', editavel: false },
  { campo: 'tipo_ultima_operacao', tipo: 'enum(importacao_inicial,sincronizacao)', obrigatorio: true, origem: 'PRIME', finalidade: 'Processo que tocou o registro por ultimo', editavel: false },
  { campo: 'hash_registro_nex', tipo: 'string', obrigatorio: false, origem: 'Derivado', finalidade: 'Hash para deteccao de mudanca na sincronizacao', editavel: false },
];

module.exports = { SCHEMA_PRIME };
