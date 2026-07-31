'use strict';

/**
 * Teste PERMANENTE de SRC/executar-plano-importacao.js (Fase 2E).
 * Preservado a partir do scratchpad (arquivo teste-executar-plano.js) em
 * 2026-07-30 (Fase 4D - preparacao pre-commit): so caminho absoluto
 * trocado por relativo; renomeado para casar com o nome do modulo
 * testado. Nenhuma asserção alterada. Usa apenas dados ficticios.
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { gerarPlanoSincronizacao } = require(path.join(SRC, 'comparar-clientes'));
const { executarPlanoImportacao } = require(path.join(SRC, 'executar-plano-importacao'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

function contexto() {
  return {
    dataExecucao: '2026-07-30T00:00:00.000Z',
    geradorPrimeId: (nexCodigo) => `PRIME-TESTE-${nexCodigo}`,
  };
}

function clientePrime(overrides) {
  return Object.assign({
    prime_id: null, nex_codigo: 1, origem_sistema: 'NEX',
    nome: 'Cliente Teste', cpf_cnpj: null,
    telefone: null, celular: '11999990000', email: null,
    canal_preferido: 'whatsapp', whatsapp_validado: true,
    endereco_logradouro: 'Rua A', endereco_numero: '1', endereco_complemento: null,
    endereco_bairro: 'Centro', endereco_cidade: 'Cidade X', endereco_uf: 'SP', endereco_cep: '00000-000',
    saldo_debito_nex: 0, saldo_credito_nex: 0, saldo_debito_anterior: null, saldo_credito_anterior: null,
    variacao_saldo: null, valor_liquido_nex: 0, data_snapshot_nex: '2026-07-01',
    observacao_original_nex: '', observacao_categoria: 'vazia', vencimento_sugerido: null,
    parcelamento_sugerido: null, confianca_extracao: null,
    vencimento_confirmado: null, parcelamento_confirmado: null, status_cobranca: 'sem_debito',
    observacao_prime: 'nota interna importante',
    historico: [{ tipo: 'nota_manual', data: '2026-06-01', texto: 'evento anterior preexistente' }],
    ultima_cobranca_enviada_em: null, proxima_cobranca_agendada_em: null, tentativas_cobranca: 0,
    risco_inadimplencia: 0.42, resumo_ia: 'resumo gerado antes', sentimento_ultima_resposta: 'neutro',
    consentimento_contato: 'concedido', consentimento_registrado_em: '2026-05-01',
    cadastro_score: 0.8, criado_em: '2026-01-01T00:00:00.000Z', atualizado_em: '2026-06-01T00:00:00.000Z',
    fonte_arquivo_origem: 'clientes-nex.xls', tipo_ultima_operacao: 'importacao_inicial', hash_registro_nex: null,
  }, overrides);
}

function rodar(baseAtual, novaImportacao, ctx) {
  const plano = gerarPlanoSincronizacao(baseAtual, novaImportacao);
  return executarPlanoImportacao(baseAtual, novaImportacao, plano, ctx || contexto());
}

// ---------- 1. lote vazio ----------
console.log('\n=== 1. Lote vazio ===');
const r1 = rodar([], []);
todosPassaram &= check('vazio: nova_base = []', r1.nova_base.length === 0);
todosPassaram &= check('vazio: resumo tudo zero', Object.values(r1.resumo_execucao).every((v) => v === 0));
todosPassaram &= check('vazio: nao lanca excecao', true);

// ---------- 2. cliente novo ----------
console.log('\n=== 2. Cliente novo ===');
const novo2 = clientePrime({ nex_codigo: 200, saldo_debito_nex: 50, valor_liquido_nex: 50 });
const r2 = rodar([], [novo2]);
const c2 = r2.nova_base[0];
todosPassaram &= check('novo: criado no resumo', r2.resumo_execucao.criados === 1);
todosPassaram &= check('novo: prime_id gerado', c2.prime_id === 'PRIME-TESTE-200');
todosPassaram &= check('novo: criado_em = dataExecucao', c2.criado_em === '2026-07-30T00:00:00.000Z');
todosPassaram &= check('novo: tipo_ultima_operacao = importacao_inicial', c2.tipo_ultima_operacao === 'importacao_inicial');
todosPassaram &= check('novo: saldo_debito_anterior = null', c2.saldo_debito_anterior === null);
todosPassaram &= check('novo: evento cliente_importado gerado', r2.eventos_gerados.some((e) => e.tipo === 'cliente_importado' && e.nex_codigo === 200));

// ---------- 3. cliente existente sem alteracao ----------
console.log('\n=== 3. Cliente existente sem alteracao ===');
const base3 = clientePrime({ nex_codigo: 300, prime_id: 'PRIME-JA-EXISTE-300' });
const nova3 = clientePrime({ nex_codigo: 300 }); // identico
const r3 = rodar([base3], [nova3]);
const c3 = r3.nova_base[0];
todosPassaram &= check('sem_alt: sem_alteracao no resumo', r3.resumo_execucao.sem_alteracao === 1);
todosPassaram &= check('sem_alt: atualizado_em nao mudou', c3.atualizado_em === base3.atualizado_em);
todosPassaram &= check('sem_alt: historico nao ganhou evento novo', c3.historico.length === base3.historico.length);
todosPassaram &= check('sem_alt: prime_id preservado', c3.prime_id === 'PRIME-JA-EXISTE-300');

// ---------- 4. divida aumentou ----------
console.log('\n=== 4. Divida aumentou ===');
const base4 = clientePrime({ nex_codigo: 400, prime_id: 'P-400', saldo_debito_nex: 100, valor_liquido_nex: 100, status_cobranca: 'em_aberto' });
const nova4 = clientePrime({ nex_codigo: 400, saldo_debito_nex: 300, valor_liquido_nex: 300 });
const r4 = rodar([base4], [nova4]);
const c4 = r4.nova_base[0];
todosPassaram &= check('aumento: atualizados no resumo', r4.resumo_execucao.atualizados === 1);
todosPassaram &= check('aumento: saldo_debito_anterior = 100', c4.saldo_debito_anterior === 100);
todosPassaram &= check('aumento: saldo_debito_nex = 300', c4.saldo_debito_nex === 300);
todosPassaram &= check('aumento: variacao_saldo = 200', c4.variacao_saldo === 200);
todosPassaram &= check('aumento: status_cobranca continua em_aberto', c4.status_cobranca === 'em_aberto');
todosPassaram &= check('aumento: evento cliente_atualizado gerado', r4.eventos_gerados.some((e) => e.tipo === 'cliente_atualizado' && e.nex_codigo === 400));

// ---------- 5. divida diminuiu (mas nao quitada) ----------
console.log('\n=== 5. Divida diminuiu ===');
const base5 = clientePrime({ nex_codigo: 500, prime_id: 'P-500', saldo_debito_nex: 300, valor_liquido_nex: 300, status_cobranca: 'em_aberto' });
const nova5 = clientePrime({ nex_codigo: 500, saldo_debito_nex: 120, valor_liquido_nex: 120 });
const r5 = rodar([base5], [nova5]);
const c5 = r5.nova_base[0];
todosPassaram &= check('reducao: atualizados no resumo', r5.resumo_execucao.atualizados === 1);
todosPassaram &= check('reducao: saldo_debito_nex = 120', c5.saldo_debito_nex === 120);
todosPassaram &= check('reducao: variacao_saldo = -180', c5.variacao_saldo === -180);
todosPassaram &= check('reducao: status_cobranca continua em_aberto (nao zerou)', c5.status_cobranca === 'em_aberto');

// ---------- 6. divida quitada ----------
console.log('\n=== 6. Divida quitada ===');
const base6 = clientePrime({ nex_codigo: 600, prime_id: 'P-600', saldo_debito_nex: 250, valor_liquido_nex: 250, status_cobranca: 'em_aberto' });
const nova6 = clientePrime({ nex_codigo: 600, saldo_debito_nex: 0, valor_liquido_nex: 0 });
const r6 = rodar([base6], [nova6]);
const c6 = r6.nova_base[0];
todosPassaram &= check('quitado: quitados no resumo', r6.resumo_execucao.quitados === 1);
todosPassaram &= check('quitado: saldo_debito_nex = 0', c6.saldo_debito_nex === 0);
todosPassaram &= check('quitado: status_cobranca = pago', c6.status_cobranca === 'pago');
todosPassaram &= check('quitado: evento divida_quitada gerado', r6.eventos_gerados.some((e) => e.tipo === 'divida_quitada' && e.nex_codigo === 600));

// ---------- 7. telefone e endereco alterados ----------
console.log('\n=== 7. Telefone e endereco alterados ===');
const base7 = clientePrime({ nex_codigo: 700, prime_id: 'P-700', telefone: '4733221100', endereco_cidade: 'Cidade Antiga' });
const nova7 = clientePrime({ nex_codigo: 700, telefone: '4733229999', endereco_cidade: 'Cidade Nova' });
const r7 = rodar([base7], [nova7]);
const c7 = r7.nova_base[0];
todosPassaram &= check('contato: telefone atualizado', c7.telefone === '4733229999');
todosPassaram &= check('contato: endereco_cidade atualizado', c7.endereco_cidade === 'Cidade Nova');
todosPassaram &= check('contato: saldo nao mudou (permanece 0)', c7.saldo_debito_nex === 0);
todosPassaram &= check('contato: evento com campos_alterados corretos', r7.eventos_gerados.some((e) => e.tipo === 'cliente_atualizado' && e.campos_alterados.includes('telefoneMudou') && e.campos_alterados.includes('enderecoMudou')));

// ---------- 8. cliente removido da exportacao ----------
console.log('\n=== 8. Cliente removido da exportacao ===');
const base8 = clientePrime({ nex_codigo: 800, prime_id: 'P-800' });
const r8 = rodar([base8], []);
todosPassaram &= check('removido: nao_aplicados no resumo', r8.resumo_execucao.nao_aplicados === 1);
todosPassaram &= check('removido: presente em registros_nao_aplicados', r8.registros_nao_aplicados.some((x) => x.nex_codigo === 800));
todosPassaram &= check('removido: gerou aviso', r8.avisos.some((a) => a.includes('800')));
todosPassaram &= check('removido: cliente NAO foi excluido da nova_base', r8.nova_base.some((c) => c.nex_codigo === 800));

// ---------- 9. preservacao de campos internos do PRIME ----------
console.log('\n=== 9. Preservacao de campos internos do PRIME ===');
const base9 = clientePrime({
  nex_codigo: 900, prime_id: 'P-900', saldo_debito_nex: 50, valor_liquido_nex: 50,
  observacao_prime: 'NAO PODE SUMIR', consentimento_contato: 'negado', consentimento_registrado_em: '2026-02-02',
  canal_preferido: 'sms', whatsapp_validado: false, risco_inadimplencia: 0.9, resumo_ia: 'resumo antigo importante',
  sentimento_ultima_resposta: 'negativo', cadastro_score: 0.55,
});
const nova9 = clientePrime({ nex_codigo: 900, saldo_debito_nex: 999, valor_liquido_nex: 999 }); // sem esses campos (vem "vazio" do NEX)
const r9 = rodar([base9], [nova9]);
const c9 = r9.nova_base[0];
todosPassaram &= check('preserv: observacao_prime preservada', c9.observacao_prime === 'NAO PODE SUMIR');
todosPassaram &= check('preserv: consentimento_contato preservado', c9.consentimento_contato === 'negado');
todosPassaram &= check('preserv: canal_preferido preservado', c9.canal_preferido === 'sms');
todosPassaram &= check('preserv: whatsapp_validado preservado', c9.whatsapp_validado === false);
todosPassaram &= check('preserv: risco_inadimplencia preservado', c9.risco_inadimplencia === 0.9);
todosPassaram &= check('preserv: resumo_ia preservado', c9.resumo_ia === 'resumo antigo importante');
todosPassaram &= check('preserv: cadastro_score preservado', c9.cadastro_score === 0.55);
todosPassaram &= check('preserv: prime_id preservado', c9.prime_id === 'P-900');
todosPassaram &= check('preserv: saldo ainda assim foi atualizado (999)', c9.saldo_debito_nex === 999);

// ---------- 10. preservacao da BASE_ATUAL original ----------
console.log('\n=== 10. Preservacao da BASE_ATUAL original (sem mutacao) ===');
const base10 = clientePrime({ nex_codigo: 1000, prime_id: 'P-1000', saldo_debito_nex: 10, valor_liquido_nex: 10 });
const snapshotAntes = JSON.stringify(base10);
const nova10 = clientePrime({ nex_codigo: 1000, saldo_debito_nex: 777, valor_liquido_nex: 777, telefone: '999' });
const snapshotNovaAntes = JSON.stringify(nova10);
const planoTeste = gerarPlanoSincronizacao([base10], [nova10]);
const snapshotPlanoAntes = JSON.stringify(planoTeste);
const r10 = executarPlanoImportacao([base10], [nova10], planoTeste, contexto());
todosPassaram &= check('preserv-base: BASE_ATUAL nao foi mutada', JSON.stringify(base10) === snapshotAntes);
todosPassaram &= check('preserv-base: NOVA_IMPORTACAO nao foi mutada', JSON.stringify(nova10) === snapshotNovaAntes);
todosPassaram &= check('preserv-base: PLANO nao foi mutado', JSON.stringify(planoTeste) === snapshotPlanoAntes);
todosPassaram &= check('preserv-base: nova_base[0] nao compartilha referencia com base10', r10.nova_base[0] !== base10);
todosPassaram &= check('preserv-base: historico da nova_base nao compartilha array com base10.historico', r10.nova_base[0].historico !== base10.historico);

// ---------- 11. geracao correta do historico ----------
console.log('\n=== 11. Geracao correta do historico ===');
const base11 = clientePrime({ nex_codigo: 1100, prime_id: 'P-1100', saldo_debito_nex: 40, valor_liquido_nex: 40, historico: [{ tipo: 'nota_manual', data: '2026-01-01' }] });
const nova11 = clientePrime({ nex_codigo: 1100, saldo_debito_nex: 90, valor_liquido_nex: 90 });
const r11 = rodar([base11], [nova11]);
const c11 = r11.nova_base[0];
todosPassaram &= check('historico: manteve evento antigo + adicionou 1 novo', c11.historico.length === 2);
todosPassaram &= check('historico: evento antigo preservado', c11.historico[0].tipo === 'nota_manual');
todosPassaram &= check('historico: evento novo e cliente_atualizado', c11.historico[1].tipo === 'cliente_atualizado');
todosPassaram &= check('historico: evento novo tem saldo_anterior=40 e saldo_novo=90', c11.historico[1].saldo_anterior === 40 && c11.historico[1].saldo_novo === 90);

// ---------- 12. execucao deterministica ----------
console.log('\n=== 12. Execucao deterministica (duas rodadas identicas) ===');
const baseA = [clientePrime({ nex_codigo: 1200, prime_id: 'P-1200', saldo_debito_nex: 20, valor_liquido_nex: 20 })];
const novaA = [clientePrime({ nex_codigo: 1200, saldo_debito_nex: 20, valor_liquido_nex: 20 }), clientePrime({ nex_codigo: 1201, saldo_debito_nex: 15, valor_liquido_nex: 15 })];
const execucao1 = rodar(baseA, novaA, contexto());
const execucao2 = rodar(baseA, novaA, contexto());
todosPassaram &= check('determ: resultados identicos entre execucoes', JSON.stringify(execucao1) === JSON.stringify(execucao2));

console.log('\nResultado geral executar-plano-importacao.js:', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
process.exitCode = todosPassaram ? 0 : 1;
