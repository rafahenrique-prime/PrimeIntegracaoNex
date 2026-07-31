'use strict';

/**
 * Teste PERMANENTE da interface local (Fase 3A: SERVICO/servidor-local.js
 * + WEB/app-logico.js).
 * Preservado a partir do scratchpad em 2026-07-30 (Fase 4D - preparacao
 * pre-commit):
 *  - caminhos absolutos trocados por relativos, require('xlsx') direto;
 *  - teste com o arquivo real (5) e a lista de avisos (6) agora verificam
 *    a existencia do .xls antes de rodar - ele e ignorado pelo Git de
 *    proposito, entao um clone limpo nao vai te-lo;
 *  - AJUSTE: removida a antiga verificacao estrutural "servidor requer
 *    normalizar-clientes/validar-normalizados/simular-importacao de
 *    SRC diretamente" (Fase 3A). Ela ficou comprovadamente obsoleta na
 *    Fase 4B, que passou a fazer o servidor delegar para
 *    SERVICO/servico-importacao.js em vez de requerer SRC/* direto -
 *    exatamente o objetivo daquela fase. A verificacao equivalente e
 *    atualizada (cadeia de delegacao servidor -> servico -> SRC) ja
 *    existe em TESTES/teste-servico-importacao.js (teste 8), entao nao
 *    foi duplicada aqui. As checagens de nao-reimplementacao da regex
 *    financeira foram mantidas, pois continuam validas.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJETO = path.join(__dirname, '..');
const XLSX = require('xlsx');
const { criarServidor } = require(path.join(PROJETO, 'SERVICO', 'servidor-local'));
const AppLogico = require(path.join(PROJETO, 'WEB', 'app-logico'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

function requisitar(porta, metodo, urlPath, headers, corpoBuffer) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: porta, path: urlPath, method: metodo, headers }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf-8');
        let json = null;
        try { json = JSON.parse(texto); } catch (e) { /* nem sempre e json */ }
        resolve({ status: res.statusCode, json, texto });
      });
    });
    req.on('error', reject);
    if (corpoBuffer) req.write(corpoBuffer);
    req.end();
  });
}

function construirXlsBuffer(linhas) {
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}

async function main() {
  const servidor = criarServidor();
  await new Promise((resolve) => servidor.listen(0, resolve));
  const porta = servidor.address().port;
  console.log('Servidor de teste rodando em porta efemera:', porta);

  function snapshotProjeto() {
    const arquivos = [];
    function varrer(dir) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
        if (ent.name === 'node_modules') return;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) varrer(p);
        else arquivos.push(p + '|' + fs.statSync(p).size);
      });
    }
    varrer(PROJETO);
    return arquivos.sort().join('\n');
  }
  const snapshotAntes = snapshotProjeto();

  // ---------- 1. arquivo .xls valido ----------
  console.log('\n=== 1. Arquivo .xls valido ===');
  const bufferValido = construirXlsBuffer([
    ['Código', 'Nome', 'Débito / Crédito', 'Celular', 'CPF / CNPJ', 'Observações'],
    [1, 'Cliente Um', 'Débito- R$ 100,00', '11999990000', '', '2x 50,00 dia 10'],
    [2, 'Cliente Dois', '', '', '', ''],
  ]);
  const r1 = await requisitar(porta, 'POST', '/api/analisar', { 'X-Nome-Arquivo': 'teste.xls', 'Content-Type': 'application/octet-stream' }, bufferValido);
  todosPassaram &= check('valido: status 200', r1.status === 200);
  todosPassaram &= check('valido: total_registros = 2', r1.json && r1.json.relatorio.totais.total_registros === 2);
  todosPassaram &= check('valido: total_debito = 100', r1.json && r1.json.relatorio.totais.total_debito === 100);

  // ---------- 2. arquivo invalido (extensao errada) ----------
  console.log('\n=== 2. Arquivo invalido (extensao errada) ===');
  const r2 = await requisitar(porta, 'POST', '/api/analisar', { 'X-Nome-Arquivo': 'teste.txt', 'Content-Type': 'application/octet-stream' }, Buffer.from('qualquer coisa'));
  todosPassaram &= check('invalido: status 400', r2.status === 400);
  todosPassaram &= check('invalido: erro = formato_invalido', r2.json && r2.json.erro === 'formato_invalido');

  // ---------- 3. nenhum arquivo (corpo vazio) ----------
  console.log('\n=== 3. Nenhum arquivo (corpo vazio) ===');
  const r3 = await requisitar(porta, 'POST', '/api/analisar', { 'X-Nome-Arquivo': 'vazio.xls', 'Content-Type': 'application/octet-stream' }, Buffer.alloc(0));
  todosPassaram &= check('sem_arquivo: status 400', r3.status === 400);
  todosPassaram &= check('sem_arquivo: erro = arquivo_vazio', r3.json && r3.json.erro === 'arquivo_vazio');

  // ---------- 4. planilha vazia (xls valido, 0 linhas de dado) ----------
  console.log('\n=== 4. Planilha vazia (0 linhas) ===');
  const bufferPlanilhaVazia = construirXlsBuffer([]);
  const r4 = await requisitar(porta, 'POST', '/api/analisar', { 'X-Nome-Arquivo': 'planilha-vazia.xls', 'Content-Type': 'application/octet-stream' }, bufferPlanilhaVazia);
  todosPassaram &= check('planilha_vazia: status 400', r4.status === 400);
  todosPassaram &= check('planilha_vazia: erro = planilha_vazia', r4.json && r4.json.erro === 'planilha_vazia');

  // ---------- 5/6. previa com os 1.386 registros reais + lista de avisos, se o arquivo existir ----------
  console.log('\n=== 5/6. Previa com os 1.386 registros reais + lista de avisos ===');
  const arquivoReal = path.join(PROJETO, 'EXPORTADOS', 'clientes-nex.xls');
  if (fs.existsSync(arquivoReal)) {
    const bufferReal = fs.readFileSync(arquivoReal);
    const r5 = await requisitar(porta, 'POST', '/api/analisar', { 'X-Nome-Arquivo': 'clientes-nex.xls', 'Content-Type': 'application/octet-stream' }, bufferReal);
    todosPassaram &= check('real: status 200', r5.status === 200);
    todosPassaram &= check('real: total_registros = 1386', r5.json && r5.json.relatorio.totais.total_registros === 1386);
    todosPassaram &= check('real: total_debito = 25414.58', r5.json && r5.json.relatorio.totais.total_debito === 25414.58);
    todosPassaram &= check('real: clientes_com_debito = 36', r5.json && r5.json.relatorio.totais.clientes_com_debito === 36);
    todosPassaram &= check('real: registros_com_aviso tem 38 itens', r5.json && r5.json.registros_com_aviso.length === 38);

    todosPassaram &= check('avisos: com resultado -> secao avisos', AppLogico.proximaSecaoAoAbrirAvisos(true) === AppLogico.SECAO.AVISOS);
    todosPassaram &= check('avisos: sem resultado -> null (nao abre)', AppLogico.proximaSecaoAoAbrirAvisos(false) === null);
    const linhas = AppLogico.linhasTabelaAvisos(r5.json.registros_com_aviso);
    todosPassaram &= check('avisos: linhas da tabela = 38', linhas.length === 38);
    todosPassaram &= check('avisos: primeira coluna e nex_codigo numerico', typeof linhas[0][0] === 'number');
  } else {
    console.log('AVISO: EXPORTADOS/clientes-nex.xls nao encontrado neste ambiente (arquivo real, intencionalmente fora do Git) - pulando testes 5/6.');
  }

  // ---------- 7. troca por outro arquivo ----------
  console.log('\n=== 7. Troca por outro arquivo (app-logico.js) ===');
  todosPassaram &= check('troca: volta para secao upload', AppLogico.proximaSecaoAoTrocarArquivo() === AppLogico.SECAO.UPLOAD);
  todosPassaram &= check('troca: rejeita multiplos arquivos', AppLogico.validarArquivoSelecionado({ name: 'a.xls' }, [1, 2]).ok === false);
  todosPassaram &= check('troca: aceita xls unico', AppLogico.validarArquivoSelecionado({ name: 'a.xls' }, [1]).ok === true);
  todosPassaram &= check('troca: rejeita formato errado', AppLogico.validarArquivoSelecionado({ name: 'a.pdf' }, [1]).ok === false);

  // ---------- 8. garantia de que nenhum dado e gravado ----------
  console.log('\n=== 8. Garantia de que nenhum dado foi gravado ===');
  const snapshotDepois = snapshotProjeto();
  todosPassaram &= check('sem_gravacao: snapshot do projeto identico antes/depois das requisicoes', snapshotAntes === snapshotDepois);

  // ---------- 9. nao reimplementa a regex do parser financeiro no front/servidor ----------
  console.log('\n=== 9. Nao reimplementa regra de negocio no front/servidor ===');
  const servidorTexto = fs.readFileSync(path.join(PROJETO, 'SERVICO', 'servidor-local.js'), 'utf-8');
  const appLogicoTexto = fs.readFileSync(path.join(PROJETO, 'WEB', 'app-logico.js'), 'utf-8');
  const appTexto = fs.readFileSync(path.join(PROJETO, 'WEB', 'app.js'), 'utf-8');
  const regexParserFinanceiro = /d\[[eé]{2}\]bito/i; // fragmento caracteristico da regex do parser financeiro
  todosPassaram &= check('servidor NAO reimplementa a regex do parser financeiro', !regexParserFinanceiro.test(servidorTexto));
  todosPassaram &= check('app-logico NAO reimplementa a regex do parser financeiro', !regexParserFinanceiro.test(appLogicoTexto));
  todosPassaram &= check('app.js NAO reimplementa a regex do parser financeiro', !regexParserFinanceiro.test(appTexto));

  servidor.close();
  console.log('\nResultado geral interface local (Fase 3A):', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((e) => { console.error('ERRO NO TESTE:', e); process.exitCode = 1; });
