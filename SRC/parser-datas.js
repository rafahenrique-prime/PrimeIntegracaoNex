'use strict';

/**
 * Parser de data/hora dos exports oficiais do NEX (Fase EXPORT-FIRST).
 * Formatos observados nos exports auditados:
 *   Data: "8/28/26"  (M/D/YY, sem zero a esquerda, ano com 2 digitos)
 *   Hora: "16:43"    (HH:mm, 24h)
 *
 * Funcoes puras - nao dependem de I/O, nao lancam excecao para entrada
 * invalida (retornam `null`, para o chamador decidir como tratar).
 *
 * DECISAO DE FUSO HORARIO (documentada conforme exigido): o NEX nao informa
 * fuso horario nos exports. `combinarDataHora` produz uma string ISO "naive"
 * (sem sufixo "Z" e sem offset, ex.: "2026-08-28T16:37:00") representando o
 * horario local da loja exatamente como exibido pelo NEX - NAO e UTC e nao
 * deve ser tratada como tal. Isso segue o mesmo espirito ja usado no projeto
 * para `dataSnapshot` (string "YYYY-MM-DD" simples, sem fuso), evitando
 * introduzir conversao de fuso horario silenciosa que o NEX nunca forneceu.
 */

function parseDataNex(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;

  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;

  const mes = parseInt(m[1], 10);
  const dia = parseInt(m[2], 10);
  const anoRaw = m[3];
  const ano = anoRaw.length === 2 ? 2000 + parseInt(anoRaw, 10) : parseInt(anoRaw, 10);

  if (mes < 1 || mes > 12) return null;
  if (dia < 1 || dia > 31) return null;

  // Valida dias impossiveis para o mes/ano informados (ex.: 2/30, 4/31).
  const diasNoMes = new Date(ano, mes, 0).getDate();
  if (dia > diasNoMes) return null;

  return { ano, mes, dia };
}

function parseHoraNex(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;

  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const hora = parseInt(m[1], 10);
  const minuto = parseInt(m[2], 10);

  if (hora < 0 || hora > 23) return null;
  if (minuto < 0 || minuto > 59) return null;

  return { hora, minuto };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {{ano:number, mes:number, dia:number}|null} data - retorno de parseDataNex
 * @param {{hora:number, minuto:number}|null} [hora] - retorno de parseHoraNex; se
 *   ausente/invalido, assume 00:00 (documentado - nao lanca excecao).
 * @returns {string|null} ISO "naive" local (sem fuso), ou null se `data` for invalido.
 */
function combinarDataHora(data, hora) {
  if (!data) return null;
  const h = hora || { hora: 0, minuto: 0 };
  return `${data.ano}-${pad2(data.mes)}-${pad2(data.dia)}T${pad2(h.hora)}:${pad2(h.minuto)}:00`;
}

module.exports = { parseDataNex, parseHoraNex, combinarDataHora };
