'use strict';

/**
 * Teste PERMANENTE de SRC/comparar-clientes.js (Fase 2D).
 * Preservado a partir do scratchpad em 2026-07-30 (Fase 4D - preparacao
 * pre-commit): so caminho absoluto trocado por relativo. Nenhuma
 * asserção alterada. Usa apenas dados ficticios ("Rua A", "Cidade X").
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { compararCliente, gerarPlanoSincronizacao } = require(path.join(SRC, 'comparar-clientes'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

function clienteBase(overrides) {
  return Object.assign({
    nex_codigo: 1, saldo_debito_nex: 100, saldo_credito_nex: 0,
    telefone: null, celular: '11999990000', email: null,
    endereco_logradouro: 'Rua A', endereco_numero: '1', endereco_complemento: null,
    endereco_bairro: 'Centro', endereco_cidade: 'Cidade X', endereco_uf: 'SP', endereco_cep: '00000-000',
    observacao_original_nex: 'dia 10',
  }, overrides);
}

// 1. cliente novo
console.log('\n=== 1. Cliente novo ===');
const r1 = compararCliente(undefined, clienteBase({ nex_codigo: 101 }));
todosPassaram &= check('novo: tipo = cliente_novo', r1.tipo === 'cliente_novo');
todosPassaram &= check('novo: acao = criar novo cadastro', r1.acoes[0] === 'criar novo cadastro');
todosPassaram &= check('novo: saldo_anterior = null', r1.saldo_anterior === null);

// 2. cliente sem alteracao (base e nova identicos)
console.log('\n=== 2. Cliente sem alteracao ===');
const base2 = clienteBase({ nex_codigo: 102 });
const nova2 = clienteBase({ nex_codigo: 102 });
const r2 = compararCliente(base2, nova2);
todosPassaram &= check('sem_alt: tipo = cliente_existente_sem_alteracao', r2.tipo === 'cliente_existente_sem_alteracao');
todosPassaram &= check('sem_alt: acoes = [nenhuma alteracao]', r2.acoes.length === 1 && r2.acoes[0] === 'nenhuma alteracao');
todosPassaram &= check('sem_alt: diferenca_saldo = 0', r2.diferenca_saldo === 0);

// 3. cliente com saldo maior (aumento da divida)
console.log('\n=== 3. Cliente com saldo maior ===');
const base3 = clienteBase({ nex_codigo: 103, saldo_debito_nex: 100 });
const nova3 = clienteBase({ nex_codigo: 103, saldo_debito_nex: 250 });
const r3 = compararCliente(base3, nova3);
todosPassaram &= check('aumento: classificacao = aumento_divida', r3.classificacao_saldo === 'aumento_divida');
todosPassaram &= check('aumento: diferenca_saldo = 150', r3.diferenca_saldo === 150);
todosPassaram &= check('aumento: acao inclui atualizar saldo', r3.acoes.includes('atualizar saldo'));

// 4. cliente com saldo menor (reducao, mas nao quitado)
console.log('\n=== 4. Cliente com saldo menor (reducao) ===');
const base4 = clienteBase({ nex_codigo: 104, saldo_debito_nex: 300 });
const nova4 = clienteBase({ nex_codigo: 104, saldo_debito_nex: 100 });
const r4 = compararCliente(base4, nova4);
todosPassaram &= check('reducao: classificacao = reducao_divida', r4.classificacao_saldo === 'reducao_divida');
todosPassaram &= check('reducao: diferenca_saldo = -200', r4.diferenca_saldo === -200);
todosPassaram &= check('reducao: acao inclui atualizar saldo', r4.acoes.includes('atualizar saldo'));

// 5. cliente quitado (saldo anterior > 0, atual = 0)
console.log('\n=== 5. Cliente quitado ===');
const base5 = clienteBase({ nex_codigo: 105, saldo_debito_nex: 180 });
const nova5 = clienteBase({ nex_codigo: 105, saldo_debito_nex: 0 });
const r5 = compararCliente(base5, nova5);
todosPassaram &= check('quitado: classificacao = divida_quitada', r5.classificacao_saldo === 'divida_quitada');
todosPassaram &= check('quitado: acao = marcar como quitado', r5.acoes.includes('marcar como quitado'));

// 6. cliente com telefone alterado (demais campos iguais)
console.log('\n=== 6. Cliente com telefone alterado ===');
const base6 = clienteBase({ nex_codigo: 106, telefone: '4733221100' });
const nova6 = clienteBase({ nex_codigo: 106, telefone: '4733229999' });
const r6 = compararCliente(base6, nova6);
todosPassaram &= check('telefone: tipo = cliente_existente_com_alteracao', r6.tipo === 'cliente_existente_com_alteracao');
todosPassaram &= check('telefone: acao inclui atualizar telefone', r6.acoes.includes('atualizar telefone'));
todosPassaram &= check('telefone: acao inclui manter saldo (nao mudou)', r6.acoes.includes('manter saldo'));
todosPassaram &= check('telefone: acao inclui manter celular (nao mudou)', r6.acoes.includes('manter celular'));

// 7. cliente removido da exportacao
console.log('\n=== 7. Cliente removido da exportacao ===');
const r7 = compararCliente(clienteBase({ nex_codigo: 107 }), undefined);
todosPassaram &= check('removido: tipo = cliente_removido_da_exportacao', r7.tipo === 'cliente_removido_da_exportacao');
todosPassaram &= check('removido: saldo_atual = null', r7.saldo_atual === null);
todosPassaram &= check('removido: nao sugere exclusao automatica', r7.acoes[0].includes('nao remover automaticamente'));

// 8. lote vazio (via gerarPlanoSincronizacao)
console.log('\n=== 8. Lote vazio ===');
const r8 = gerarPlanoSincronizacao([], []);
todosPassaram &= check('lote vazio: total_comparados = 0', r8.resumo.total_comparados === 0);
todosPassaram &= check('lote vazio: plano = []', r8.plano.length === 0);
todosPassaram &= check('lote vazio: nao lanca excecao', true);

console.log('\nResultado geral comparar-clientes.js:', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
process.exitCode = todosPassaram ? 0 : 1;
