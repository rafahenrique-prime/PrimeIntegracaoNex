'use strict';

/**
 * Teste PERMANENTE de SRC/normalizar-clientes.js (Fase 2A).
 * Recriado em 2026-07-30 (Fase 4D - preparacao pre-commit): este modulo
 * nunca teve um arquivo de teste preservado - os casos abaixo reproduzem
 * exatamente os testes isolados ja executados e aprovados durante a
 * Fase 2A, sem nenhuma regra nova. Usa apenas dados ficticios.
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { normalizarCliente } = require(path.join(SRC, 'normalizar-clientes'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;
const ctx = { fonteArquivo: 'teste.xls', dataSnapshot: '2026-07-30' };

// Caso 1: cliente com debito reconhecido e observacao estruturada
const r1 = normalizarCliente({
  'Código': 42, 'Nome': 'Teste Um', 'Débito / Crédito': 'Débito- R$ 200,00',
  'Celular': '11999990000', 'Observações': '3x 50,00 dia 10',
}, ctx);
todosPassaram &= check('Caso1: saldo_debito_nex = 200', r1.saldo_debito_nex === 200);
todosPassaram &= check('Caso1: status_cobranca = em_aberto', r1.status_cobranca === 'em_aberto');
todosPassaram &= check('Caso1: vencimento_sugerido = 10', r1.vencimento_sugerido === 10);
todosPassaram &= check('Caso1: parcelamento_sugerido = {qtd:3,valor:50}', r1.parcelamento_sugerido.qtd === 3 && r1.parcelamento_sugerido.valor === 50);
todosPassaram &= check('Caso1: confianca_extracao = alta', r1.confianca_extracao === 'alta');
todosPassaram &= check('Caso1: prime_id ainda null (normalizacao nao gera id)', r1.prime_id === null);
todosPassaram &= check('Caso1: nex_codigo = 42', r1.nex_codigo === 42);

// Caso 2: cliente sem debito, sem observacao, sem contato
const r2 = normalizarCliente({
  'Código': 7, 'Nome': 'Teste Dois', 'Débito / Crédito': '', 'Celular': '', 'Telefone': '', 'Observações': '',
}, ctx);
todosPassaram &= check('Caso2: saldo_debito_nex = 0', r2.saldo_debito_nex === 0);
todosPassaram &= check('Caso2: status_cobranca = sem_debito', r2.status_cobranca === 'sem_debito');
todosPassaram &= check('Caso2: celular = null', r2.celular === null);
todosPassaram &= check('Caso2: observacao_categoria = vazia', r2.observacao_categoria === 'vazia');
todosPassaram &= check('Caso2: vencimento_sugerido = null', r2.vencimento_sugerido === null);

// Caso 3: campo obrigatorio ausente no registro bruto (robustez)
const r3 = normalizarCliente({}, ctx);
todosPassaram &= check('Caso3: nao lanca excecao com registro vazio', r3 && typeof r3 === 'object');
todosPassaram &= check('Caso3: nome = string vazia (nao undefined)', r3.nome === '');
todosPassaram &= check('Caso3: nex_codigo = null', r3.nex_codigo === null);

console.log('\nResultado geral normalizar-clientes.js:', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
process.exitCode = todosPassaram ? 0 : 1;
