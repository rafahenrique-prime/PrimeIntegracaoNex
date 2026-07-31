'use strict';

/**
 * Leitor/diagnostico SOMENTE LEITURA de EXPORTADOS\clientes-nex.xls
 * Nao escreve nenhum arquivo em disco. Toda saida vai para stdout, mascarada.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ARQUIVO = path.join(__dirname, '..', 'EXPORTADOS', 'clientes-nex.xls');

// ---------- Mascaramento ----------

function onlyDigits(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

function maskCpfCnpj(raw) {
  const digits = onlyDigits(raw);
  if (digits.length === 11) {
    return `***.***.***-${digits.slice(-2)}`;
  }
  if (digits.length === 14) {
    return `**.***.***/****-${digits.slice(-2)}`;
  }
  return digits.length ? '[DOCUMENTO OCULTO]' : '';
}

function maskPhone(raw) {
  const digits = onlyDigits(raw);
  if (!digits.length) return '';
  const last4 = digits.slice(-4);
  return `(**) *****-${last4}`;
}

function maskEmail(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/^([^@\s]+)@([^\s]+)$/);
  if (!m) return s.length ? '[EMAIL OCULTO]' : '';
  const local = m[1];
  return `${local[0]}***@${m[2]}`;
}

function maskAddress(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return s.length ? '[ENDEREÇO OCULTO]' : '';
}

function anonimizarFormato(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\d/g, '#');
}

// ---------- Parser financeiro (coluna "Debito / Credito") ----------
// Nao usa o sinal numerico como fonte de classificacao. Le os rotulos
// "Debito" e "Credito" separadamente; ambos podem coexistir na mesma celula.

function parseValorBR(str) {
  if (str == null) return NaN;
  let s = String(str).trim();
  if (!s) return NaN;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma && !hasDot) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isNaN(n) ? NaN : n;
}

function parseFinanceiro(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { tipo: 'vazio', raw: text, debito: null, credito: null };

  const reDebito = /d[ée]bito\s*[:\-]?\s*r?\$?\s*([\d.,]+)/i;
  const reCredito = /cr[ée]dito\s*[:\-]?\s*r?\$?\s*([\d.,]+)/i;
  const mD = text.match(reDebito);
  const mC = text.match(reCredito);

  let debito = mD ? parseValorBR(mD[1]) : null;
  let credito = mC ? parseValorBR(mC[1]) : null;
  if (debito != null && Number.isNaN(debito)) debito = null;
  if (credito != null && Number.isNaN(credito)) credito = null;

  if (debito != null || credito != null) {
    return { tipo: 'reconhecido', raw: text, debito: debito || 0, credito: credito || 0 };
  }

  const soNumero = text.match(/^r?\$?\s*([\d.,]+)$/i);
  if (soNumero) {
    const v = parseValorBR(soNumero[1]);
    if (!Number.isNaN(v) && v === 0) {
      return { tipo: 'zero', raw: text, debito: 0, credito: 0 };
    }
  }

  return { tipo: 'formato_nao_reconhecido', raw: text, debito: null, credito: null };
}

// ---------- Classificador de observacoes ----------
// "Ambigua" so quando ha conflito real (mais de um dia distinto no mesmo texto).
// Presenca simultanea coerente de dia + parcela + valor = "estruturada".

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

// ---------- Normalizacao de nomes de coluna ----------

function normalizeHeaderName(h) {
  return String(h == null ? '' : h)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function classifyColumn(headerName) {
  const h = normalizeHeaderName(headerName);
  const tags = [];

  if (/^(id|cod|codigo|cod\.?cliente|codcli)$/.test(h) || /\bcod(igo)?\b/.test(h)) tags.push('id_codigo');
  if (/\bnome\b/.test(h) || /\brazao\b/.test(h) || /\bfantasia\b/.test(h)) tags.push('nome');
  if (/\btelefone\b/.test(h) || /\bfone\b/.test(h) || /\bcelular\b/.test(h) || /\bwhatsapp\b/.test(h)) tags.push('telefone');
  if (/\bcpf\b/.test(h) || /\bcnpj\b/.test(h) || /\bdocumento\b/.test(h)) tags.push('cpf_cnpj');
  if (/e-?mail/.test(h)) tags.push('email');
  if (/\bendereco\b/.test(h) || /\brua\b/.test(h) || /\blogradouro\b/.test(h) || /\bbairro\b/.test(h) || /\bcidade\b/.test(h) || /\bmunicipio\b/.test(h) || /\buf\b/.test(h) || /\bcep\b/.test(h)) tags.push('endereco');

  if (/\bfiado\b/.test(h)) tags.push('cobranca_fiado');
  if (/\bdebito\b/.test(h)) tags.push('cobranca_debito');
  if (/\bsaldo\b/.test(h)) tags.push('cobranca_saldo');
  if (/aberto/.test(h)) tags.push('cobranca_valor_aberto');
  if (/vencimento/.test(h)) tags.push('cobranca_vencimento');
  if (/parcela/.test(h)) tags.push('cobranca_parcela');
  if (/\bcredito\b/.test(h)) tags.push('cobranca_credito');
  if (/\blimite\b/.test(h)) tags.push('cobranca_limite');
  if (/\bvenda\b/.test(h)) tags.push('cobranca_venda');
  if (/debito/.test(h) && /credito/.test(h)) tags.push('saldo_dc');
  if (/observac/.test(h)) tags.push('observacoes');

  return tags;
}

function isEmptyCell(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function rowIsEmpty(row) {
  return row.every(isEmptyCell);
}

// ---------- Deteccao de cabecalho ----------

function detectHeaderRow(rows, maxScan = 15) {
  const limit = Math.min(maxScan, rows.length);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row || rowIsEmpty(row)) continue;
    const filled = row.filter((c) => !isEmptyCell(c));
    const textish = filled.filter((c) => typeof c === 'string' && String(c).trim().length > 0);
    if (filled.length >= 2 && textish.length / filled.length >= 0.5) {
      return i;
    }
  }
  return -1;
}

// ---------- Programa principal ----------

function main() {
  console.log('=== Diagnostico clientes-nex.xls (SOMENTE LEITURA) ===');
  console.log('Arquivo alvo:', ARQUIVO);

  if (!fs.existsSync(ARQUIVO)) {
    console.error('ERRO: arquivo nao encontrado. Nenhuma acao foi realizada.');
    process.exitCode = 1;
    return;
  }

  const stat = fs.statSync(ARQUIVO);
  console.log(`Tamanho: ${stat.size} bytes | Modificado em: ${stat.mtime.toISOString()}`);

  // Leitura em memoria, sem opcoes de escrita.
  const workbook = XLSX.readFile(ARQUIVO, { type: 'binary' });

  console.log(`\nAbas encontradas (${workbook.SheetNames.length}):`, workbook.SheetNames.join(', '));

  for (const sheetName of workbook.SheetNames) {
    console.log(`\n----- Aba: "${sheetName}" -----`);
    const ws = workbook.Sheets[sheetName];
    const ref = ws['!ref'] || '(vazia)';
    console.log('Intervalo utilizado:', ref);

    if (!ws['!ref']) {
      console.log('Aba sem conteudo. Pulando.');
      continue;
    }

    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    console.log('Total de linhas brutas (incluindo vazias):', rows.length);
    console.log('Total de colunas (pelo intervalo):', XLSX.utils.decode_range(ref).e.c + 1);

    const headerIdx = detectHeaderRow(rows);
    if (headerIdx === -1) {
      console.log('\nATENCAO: nao foi possivel identificar com seguranca a linha de cabecalho nas primeiras linhas.');
      console.log('Analise automatica de colunas abortada para esta aba (sem tentativa de correcao automatica).');
      continue;
    }

    const headerRow = rows[headerIdx].map((h) => String(h == null ? '' : h).trim());
    console.log(`\nLinha de cabecalho identificada: indice ${headerIdx} (linha ${headerIdx + 1} da planilha)`);
    console.log('Cabecalhos exatos:', JSON.stringify(headerRow));

    // Linhas de dados = tudo apos o cabecalho
    const dataRowsRaw = rows.slice(headerIdx + 1);

    // Linhas totalmente vazias
    const emptyRowIdxs = [];
    dataRowsRaw.forEach((r, i) => { if (rowIsEmpty(r)) emptyRowIdxs.push(headerIdx + 2 + i); });

    // Cabecalho repetido no meio da planilha
    const headerKey = JSON.stringify(headerRow.map((h) => normalizeHeaderName(h)));
    const repeatedHeaderIdxs = [];
    dataRowsRaw.forEach((r, i) => {
      const key = JSON.stringify(r.map((c) => normalizeHeaderName(c)));
      if (!rowIsEmpty(r) && key === headerKey) repeatedHeaderIdxs.push(headerIdx + 2 + i);
    });

    const dataRows = dataRowsRaw.filter((r) => !rowIsEmpty(r));
    console.log('Linhas totalmente vazias encontradas:', emptyRowIdxs.length, emptyRowIdxs.length ? `(linhas: ${emptyRowIdxs.slice(0, 20).join(', ')}${emptyRowIdxs.length > 20 ? '...' : ''})` : '');
    console.log('Cabecalhos repetidos no meio da planilha:', repeatedHeaderIdxs.length, repeatedHeaderIdxs.length ? `(linhas: ${repeatedHeaderIdxs.join(', ')})` : '');
    console.log('Total de registros uteis (nao vazios, exclui repeticoes de cabecalho):', dataRows.length - repeatedHeaderIdxs.length);

    // Classificacao de colunas
    const classification = headerRow.map((h, idx) => ({ idx, header: h, tags: classifyColumn(h) }));
    const byTag = {};
    classification.forEach((c) => c.tags.forEach((t) => { (byTag[t] = byTag[t] || []).push(c.header); }));

    console.log('\nClassificacao de colunas (heuristica por nome):');
    console.log('  Possiveis ID/codigo   :', byTag.id_codigo || []);
    console.log('  Possiveis nome        :', byTag.nome || []);
    console.log('  Possiveis telefone    :', byTag.telefone || []);
    console.log('  Possiveis CPF/CNPJ    :', byTag.cpf_cnpj || []);
    console.log('  Possiveis e-mail      :', byTag.email || []);
    console.log('  Possiveis endereco    :', byTag.endereco || []);

    console.log('\nCampos relacionados a cobranca encontrados:');
    ['cobranca_fiado', 'cobranca_debito', 'cobranca_saldo', 'cobranca_valor_aberto', 'cobranca_vencimento', 'cobranca_parcela', 'cobranca_credito', 'cobranca_limite', 'cobranca_venda']
      .forEach((tag) => console.log(`  ${tag.replace('cobranca_', '')}:`, byTag[tag] || '(nenhum)'));

    // Indices de colunas-chave (primeira ocorrencia de cada tag)
    const colIdx = (tag) => {
      const found = classification.find((c) => c.tags.includes(tag));
      return found ? found.idx : -1;
    };
    const idxNome = colIdx('nome');
    const idxTelefone = colIdx('telefone');
    const idxCpf = colIdx('cpf_cnpj');
    const idxEmail = colIdx('email');
    const idxEndereco = colIdx('endereco');
    const idxSaldoDC = colIdx('saldo_dc');
    const idxObservacoes = colIdx('observacoes');
    const idxCelular = classification.findIndex((c) => normalizeHeaderName(c.header) === 'celular');

    // Registros sem nome / telefone / cpf
    const realDataRows = dataRowsRaw.filter((r) => !rowIsEmpty(r) && JSON.stringify(r.map((c) => normalizeHeaderName(c))) !== headerKey);
    const semNome = idxNome === -1 ? 'coluna nao identificada' : realDataRows.filter((r) => isEmptyCell(r[idxNome])).length;
    const semTelefone = idxTelefone === -1 ? 'coluna nao identificada' : realDataRows.filter((r) => isEmptyCell(r[idxTelefone])).length;
    const semCpf = idxCpf === -1 ? 'coluna nao identificada' : realDataRows.filter((r) => isEmptyCell(r[idxCpf])).length;

    console.log('\nRegistros sem nome     :', semNome);
    console.log('Registros sem telefone :', semTelefone);
    console.log('Registros sem CPF/CNPJ :', semCpf);

    // Duplicidades (por CPF/CNPJ se existir, senao por nome)
    if (idxCpf !== -1) {
      const seen = new Map();
      realDataRows.forEach((r) => {
        const d = onlyDigits(r[idxCpf]);
        if (!d) return;
        seen.set(d, (seen.get(d) || 0) + 1);
      });
      const dups = [...seen.values()].filter((c) => c > 1).length;
      console.log('Possiveis duplicidades (por CPF/CNPJ):', dups);
    } else if (idxNome !== -1) {
      const seen = new Map();
      realDataRows.forEach((r) => {
        const n = normalizeHeaderName(r[idxNome]);
        if (!n) return;
        seen.set(n, (seen.get(n) || 0) + 1);
      });
      const dups = [...seen.values()].filter((c) => c > 1).length;
      console.log('Possiveis duplicidades (por nome, CPF/CNPJ nao identificado):', dups);
    } else {
      console.log('Possiveis duplicidades: nao foi possivel checar (sem coluna de nome ou CPF/CNPJ identificada)');
    }

    // ---------- AGREGACAO FINANCEIRA (todos os registros uteis) ----------
    console.log('\n=== AGREGACAO FINANCEIRA ===');
    if (idxSaldoDC === -1) {
      console.log('Coluna "Debito / Credito" nao identificada nesta aba. Agregacao financeira nao realizada.');
    } else {
      let comDebito = 0, comCredito = 0, comAmbos = 0, semMovimentacao = 0;
      let totalDebito = 0, totalCredito = 0;
      const naoReconhecidoFormatos = new Map();
      let debitoEObservacao = 0, debitoSemObservacao = 0, debitoECelular = 0, debitoSemCelular = 0;

      // Observacoes (agregadas junto, pois cruzam com debito)
      let obsVazia = 0, obsEstruturada = 0, obsParcial = 0, obsOperacional = 0, obsAmbigua = 0;
      let obsComDia = 0, obsComParcela = 0, obsComValor = 0;
      const exemploDias = new Set(), exemploParcelas = new Set(), exemploValores = new Set();

      realDataRows.forEach((r) => {
        const fin = parseFinanceiro(r[idxSaldoDC]);
        const temDebito = fin.tipo === 'reconhecido' && fin.debito > 0;
        const temCredito = fin.tipo === 'reconhecido' && fin.credito > 0;

        if (fin.tipo === 'formato_nao_reconhecido') {
          const shape = anonimizarFormato(fin.raw);
          naoReconhecidoFormatos.set(shape, (naoReconhecidoFormatos.get(shape) || 0) + 1);
        }

        if (temDebito) { comDebito++; totalDebito += fin.debito; }
        if (temCredito) { comCredito++; totalCredito += fin.credito; }
        if (temDebito && temCredito) comAmbos++;
        if (!temDebito && !temCredito) semMovimentacao++;

        const obsRaw = idxObservacoes === -1 ? '' : r[idxObservacoes];
        const obsInfo = classificarObservacao(obsRaw);
        switch (obsInfo.categoria) {
          case 'vazia': obsVazia++; break;
          case 'estruturada': obsEstruturada++; break;
          case 'parcialmente_estruturada': obsParcial++; break;
          case 'texto_operacional': obsOperacional++; break;
          case 'ambigua': obsAmbigua++; break;
        }
        if (obsInfo.dias && obsInfo.dias.length) { obsComDia++; obsInfo.dias.forEach((d) => exemploDias.add(`dia ${d}`)); }
        if (obsInfo.parcelas && obsInfo.parcelas.length) { obsComParcela++; obsInfo.parcelas.forEach((p) => exemploParcelas.add(`${p}x`)); }
        if (obsInfo.valores && obsInfo.valores.length) { obsComValor++; obsInfo.valores.forEach((v) => exemploValores.add(v)); }

        const temObservacao = !isEmptyCell(obsRaw);
        const temCelular = idxCelular !== -1 && !isEmptyCell(r[idxCelular]);
        if (temDebito) {
          if (temObservacao) debitoEObservacao++; else debitoSemObservacao++;
          if (temCelular) debitoECelular++; else debitoSemCelular++;
        }
      });

      console.log('Total de registros analisados        :', realDataRows.length);
      console.log('Clientes com debito                  :', comDebito);
      console.log('Clientes com credito                 :', comCredito);
      console.log('Clientes com debito e credito juntos  :', comAmbos);
      console.log('Clientes sem movimentacao             :', semMovimentacao);
      console.log('Formatos financeiros nao reconhecidos :', [...naoReconhecidoFormatos.values()].reduce((a, b) => a + b, 0));
      if (naoReconhecidoFormatos.size) {
        console.log('  Exemplos de formato (anonimizados, ate 5):');
        [...naoReconhecidoFormatos.entries()].slice(0, 5).forEach(([shape, count]) => console.log(`    "${shape}" x${count}`));
      }
      console.log('Total bruto de debito                 : R$', totalDebito.toFixed(2));
      console.log('Total bruto de credito                : R$', totalCredito.toFixed(2));
      console.log('Saldo liquido (debito - credito, informativo): R$', (totalDebito - totalCredito).toFixed(2));

      const referenciaNex = 25414.58;
      const diff = totalDebito - referenciaNex;
      console.log('\n--- Comparacao com total exibido na interface do NEX ---');
      console.log('Total NEX (informado pelo usuario)    : R$', referenciaNex.toFixed(2));
      console.log('Total calculado pelo script            : R$', totalDebito.toFixed(2));
      console.log('Valores iguais?                        :', Math.abs(diff) < 0.01 ? 'Sim' : 'Nao');
      console.log('Diferenca absoluta                     : R$', Math.abs(diff).toFixed(2));
      if (Math.abs(diff) >= 0.01) {
        console.log('Possiveis causas da diferenca (nao alterei nenhum dado para investigar isso automaticamente):');
        console.log('  - registros com "formato financeiro nao reconhecido" nao entraram na soma;');
        console.log('  - a tela do NEX pode filtrar por status do cliente (ativo/inativo) de forma diferente da planilha;');
        console.log('  - a exportacao pode ter sido gerada em momento diferente do total exibido ao vivo na tela;');
        console.log('  - a tela do NEX pode considerar apenas "Clientes com Debito" enquanto a planilha trouxe o cadastro completo;');
        console.log('  - arredondamento acumulado em muitos registros.');
      }

      console.log('\n=== OBSERVACOES ===');
      console.log('Vazia                    :', obsVazia);
      console.log('Estruturada              :', obsEstruturada);
      console.log('Parcialmente estruturada :', obsParcial);
      console.log('Texto operacional        :', obsOperacional);
      console.log('Ambigua                  :', obsAmbigua);
      console.log('Com dia reconhecido      :', obsComDia, exemploDias.size ? `(exemplos: ${[...exemploDias].slice(0, 5).join(', ')})` : '');
      console.log('Com parcelas reconhecidas:', obsComParcela, exemploParcelas.size ? `(exemplos: ${[...exemploParcelas].slice(0, 5).join(', ')})` : '');
      console.log('Com valor reconhecido    :', obsComValor, exemploValores.size ? `(exemplos anonimizados: ${[...exemploValores].slice(0, 5).map(anonimizarFormato).join(', ')})` : '');

      console.log('\n=== CONTADORES UTEIS PARA O PRIME COBRANCAS ===');
      console.log('Clientes com debito e observacao  :', debitoEObservacao);
      console.log('Clientes com debito sem observacao:', debitoSemObservacao);
      console.log('Clientes com debito e celular      :', debitoECelular);
      console.log('Clientes com debito sem celular     :', debitoSemCelular);
      const pctWhatsapp = comDebito > 0 ? ((debitoECelular / comDebito) * 100).toFixed(1) : '0.0';
      console.log(`Percentual em debito com celular (potencial WhatsApp): ${pctWhatsapp}%`);
    }
  }

  console.log('\n=== Fim do diagnostico. Nenhum arquivo foi criado ou alterado. ===');
}

main();
