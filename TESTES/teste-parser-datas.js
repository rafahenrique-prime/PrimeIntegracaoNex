'use strict';

/**
 * Teste de SRC/parser-datas.js (Fase EXPORT-FIRST - Fase A).
 * Executar com: node TESTES\teste-parser-datas.js
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'SRC');
const { parseDataNex, parseHoraNex, combinarDataHora } = require(path.join(SRC, 'parser-datas'));

function check(desc, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((pass ? 'PASS' : 'FALHOU') + ' - ' + desc);
  if (!pass) {
    console.log('  esperado:', JSON.stringify(expected));
    console.log('  obtido  :', JSON.stringify(actual));
  }
  return pass;
}

let todosPassaram = true;

// ---------- parseDataNex ----------
todosPassaram &= check('Data real do experimento (8/28/26)', parseDataNex('8/28/26'), { ano: 2026, mes: 8, dia: 28 });
todosPassaram &= check('Data com ano de 4 digitos', parseDataNex('8/28/2026'), { ano: 2026, mes: 8, dia: 28 });
todosPassaram &= check('Data com dia/mes de 1 digito', parseDataNex('1/5/26'), { ano: 2026, mes: 1, dia: 5 });
todosPassaram &= check('Data vazia', parseDataNex(''), null);
todosPassaram &= check('Data null', parseDataNex(null), null);
todosPassaram &= check('Data undefined', parseDataNex(undefined), null);
todosPassaram &= check('Mes impossivel (13)', parseDataNex('13/1/26'), null);
todosPassaram &= check('Dia impossivel (32)', parseDataNex('1/32/26'), null);
todosPassaram &= check('Dia impossivel para o mes (2/30)', parseDataNex('2/30/26'), null);
todosPassaram &= check('29/02 em ano bissexto (2024) e valido', parseDataNex('2/29/24'), { ano: 2024, mes: 2, dia: 29 });
todosPassaram &= check('29/02 em ano NAO bissexto (2026) e invalido', parseDataNex('2/29/26'), null);
todosPassaram &= check('Formato totalmente invalido', parseDataNex('28-08-2026'), null);
todosPassaram &= check('Texto aleatorio', parseDataNex('nao e uma data'), null);

// ---------- parseHoraNex ----------
todosPassaram &= check('Hora real do experimento (16:43)', parseHoraNex('16:43'), { hora: 16, minuto: 43 });
todosPassaram &= check('Hora com zero a esquerda (08:05)', parseHoraNex('08:05'), { hora: 8, minuto: 5 });
todosPassaram &= check('Hora vazia', parseHoraNex(''), null);
todosPassaram &= check('Hora null', parseHoraNex(null), null);
todosPassaram &= check('Hora impossivel (25:00)', parseHoraNex('25:00'), null);
todosPassaram &= check('Minuto impossivel (16:61)', parseHoraNex('16:61'), null);
todosPassaram &= check('Formato invalido sem dois-pontos', parseHoraNex('1643'), null);

// ---------- combinarDataHora ----------
todosPassaram &= check(
  'Combinacao real do experimento #15756 (28/08/2026 16:37)',
  combinarDataHora(parseDataNex('8/28/26'), parseHoraNex('16:37')),
  '2026-08-28T16:37:00',
);
todosPassaram &= check(
  'Combinacao sem hora (assume 00:00, documentado)',
  combinarDataHora(parseDataNex('8/28/26'), null),
  '2026-08-28T00:00:00',
);
todosPassaram &= check('Combinacao com data invalida retorna null', combinarDataHora(null, parseHoraNex('16:37')), null);

console.log('\nResultado geral parser-datas.js:', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
process.exitCode = todosPassaram ? 0 : 1;
