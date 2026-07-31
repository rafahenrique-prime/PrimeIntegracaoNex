'use strict';

/**
 * Teste PERMANENTE de SRC/validar-normalizados.js (Fase 2B).
 * Preservado a partir do scratchpad em 2026-07-30 (Fase 4D - preparacao
 * pre-commit): so foram trocados os caminhos absolutos por caminhos
 * relativos a raiz do projeto. Nenhuma asserção foi alterada. Usa apenas
 * nomes ficticios (Fulano/Beltrano/Ciclano).
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { validarRegistro } = require(path.join(SRC, 'validar-normalizados'));
const { normalizarCliente } = require(path.join(SRC, 'normalizar-clientes'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;
const ctx = { fonteArquivo: 'teste.xls', dataSnapshot: '2026-07-30' };

// CASO A: registro limpo, sem debito, sem observacao -> deve ser 'valido' puro
const a = normalizarCliente({ 'Código': 1, 'Nome': 'Fulano Teste', 'Débito / Crédito': '', 'Celular': '11999990000', 'Observações': '' }, ctx);
const rA = validarRegistro(a);
todosPassaram &= check('CasoA: status = valido', rA.status === 'valido');
todosPassaram &= check('CasoA: sem erros', rA.erros.length === 0);
todosPassaram &= check('CasoA: sem avisos', rA.avisos.length === 0);

// CASO B: com debito e celular, mas sem CPF -> deve gerar aviso
const b = normalizarCliente({ 'Código': 2, 'Nome': 'Beltrano Teste', 'Débito / Crédito': 'Débito- R$ 80,00', 'Celular': '11988887777', 'Observações': '' }, ctx);
const rB = validarRegistro(b);
todosPassaram &= check('CasoB: status = valido_com_aviso', rB.status === 'valido_com_aviso');
todosPassaram &= check('CasoB: sem erros', rB.erros.length === 0);
todosPassaram &= check('CasoB: tem aviso de CPF ausente', rB.avisos.some((x) => x.includes('CPF')));

// CASO C: com debito, sem nenhum contato
const c = normalizarCliente({ 'Código': 3, 'Nome': 'Ciclano Teste', 'Débito / Crédito': 'Débito- R$ 120,00', 'Celular': '', 'Telefone': '' }, ctx);
const rC = validarRegistro(c);
todosPassaram &= check('CasoC: status = valido_com_aviso', rC.status === 'valido_com_aviso');
todosPassaram &= check('CasoC: tem aviso de canal de contato', rC.avisos.some((x) => x.includes('celular')));

// CASO D: objeto malformado manualmente - nome vazio
const d = Object.assign({}, a, { nome: '' });
const rD = validarRegistro(d);
todosPassaram &= check('CasoD: status = invalido', rD.status === 'invalido');
todosPassaram &= check('CasoD: erro de nome presente', rD.erros.some((x) => x.includes('nome')));

// CASO E: saldo negativo
const e = Object.assign({}, a, { saldo_debito_nex: -50, valor_liquido_nex: -50 });
const rE = validarRegistro(e);
todosPassaram &= check('CasoE: status = invalido', rE.status === 'invalido');
todosPassaram &= check('CasoE: erro de saldo negativo presente', rE.erros.some((x) => x.includes('negativo')));

// CASO F: valor_liquido_nex nao bate com debito-credito
const f = Object.assign({}, b, { valor_liquido_nex: 999 });
const rF = validarRegistro(f);
todosPassaram &= check('CasoF: status = invalido', rF.status === 'invalido');
todosPassaram &= check('CasoF: erro de inconsistencia presente', rF.erros.some((x) => x.includes('nao bate')));

// CASO G: status_cobranca fora do enum
const g = Object.assign({}, a, { status_cobranca: 'quitado_para_sempre' });
const rG = validarRegistro(g);
todosPassaram &= check('CasoG: status = invalido', rG.status === 'invalido');
todosPassaram &= check('CasoG: erro de enum presente', rG.erros.some((x) => x.includes('enum')));

// CASO H: historico nao e array
const h = Object.assign({}, a, { historico: 'nao deveria ser string' });
const rH = validarRegistro(h);
todosPassaram &= check('CasoH: status = invalido', rH.status === 'invalido');

console.log('\nResultado geral validar-normalizados.js:', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
process.exitCode = todosPassaram ? 0 : 1;
