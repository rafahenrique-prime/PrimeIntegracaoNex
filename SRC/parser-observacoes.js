'use strict';

/**
 * Parser da coluna "Observacoes" do NEX.
 * Extraido e validado na Fase 1 (analisar-clientes.js) - nenhuma logica foi
 * alterada aqui alem da extracao para modulo reutilizavel.
 *
 * "Ambigua" so quando ha conflito real (mais de um dia distinto no mesmo
 * texto). Presenca coerente de dia + parcela + valor = "estruturada".
 * As saidas aqui sao SUGESTOES - nunca autoritativas (ver schema-prime.js).
 */

function extrairSinaisObservacao(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { vazio: true, dias: [], parcelas: [], valores: [] };

  const diasSet = new Set();
  const diaRegex = /\bdia\s*(\d{1,2})\b/gi;
  let m;
  while ((m = diaRegex.exec(text))) diasSet.add(parseInt(m[1], 10));

  const parcelas = [];
  const parcelaRegex = /\b(\d{1,2})\s*x\b/gi;
  while ((m = parcelaRegex.exec(text))) parcelas.push(parseInt(m[1], 10));

  const valores = text.match(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+\.\d{2}/g) || [];

  return { vazio: false, dias: [...diasSet], parcelas, valores };
}

function classificarObservacao(raw) {
  const sig = extrairSinaisObservacao(raw);
  if (sig.vazio) return { categoria: 'vazia', ...sig };
  if (sig.dias.length > 1) return { categoria: 'ambigua', ...sig };

  const tiposPresentes = [sig.dias.length > 0, sig.parcelas.length > 0, sig.valores.length > 0].filter(Boolean).length;
  if (tiposPresentes >= 2) return { categoria: 'estruturada', ...sig };
  if (tiposPresentes === 1) return { categoria: 'parcialmente_estruturada', ...sig };
  return { categoria: 'texto_operacional', ...sig };
}

module.exports = { extrairSinaisObservacao, classificarObservacao };
