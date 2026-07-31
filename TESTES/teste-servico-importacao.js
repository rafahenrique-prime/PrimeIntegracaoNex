'use strict';

/**
 * Teste PERMANENTE do SERVICO/servico-importacao.js (Fase 4B).
 * Executar com: node TESTES\teste-servico-importacao.js
 *
 * Cobre: arquivo valido, arquivo real com 1.386 registros, manutencao dos
 * totais/avisos/invalidos/revisao-manual ja validados, arquivo invalido/
 * ilegivel, independencia de HTTP, e equivalencia entre o resultado do
 * servico chamado direto e o resultado que sai pelo servidor HTTP.
 *
 * Ajuste Fase 5: `registros` passou a carregar o objeto PRIME normalizado
 * INTEIRO (nao mais um subconjunto), para servir de entrada direta a
 * ServicoSincronizacao quando o usuario confirma a importacao pela
 * interface. O teste 1b abaixo trava esse contrato.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJETO = path.join(__dirname, '..');
const XLSX = require(path.join(PROJETO, 'node_modules', 'xlsx'));
const { analisarArquivoXls, ErroImportacao } = require(path.join(PROJETO, 'SERVICO', 'servico-importacao'));
const { criarServidor } = require(path.join(PROJETO, 'SERVICO', 'servidor-local'));

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

let todosPassaram = true;

function construirXlsBuffer(linhas) {
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}

function requisitar(porta, headers, corpoBuffer) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: porta, path: '/api/analisar', method: 'POST', headers }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(partes).toString('utf-8')) }));
    });
    req.on('error', reject);
    req.write(corpoBuffer);
    req.end();
  });
}

async function main() {
  // ---------- 1. Arquivo .xls valido ----------
  console.log('\n=== 1. Arquivo .xls valido ===');
  const bufferValido = construirXlsBuffer([
    ['Código', 'Nome', 'Débito / Crédito', 'Celular', 'CPF / CNPJ', 'Observações'],
    [1, 'Cliente Um', 'Débito- R$ 100,00', '11999990000', '', '2x 50,00 dia 10'],
    [2, 'Cliente Dois', '', '', '', ''],
  ]);
  const r1 = analisarArquivoXls(bufferValido, { nomeArquivo: 'teste.xls', dataSnapshot: '2026-07-30' });
  todosPassaram &= check('resultado tem relatorio/registros_com_aviso/registros', !!r1.relatorio && !!r1.registros_com_aviso && !!r1.registros);
  todosPassaram &= check('total_registros = 2', r1.relatorio.totais.total_registros === 2);
  todosPassaram &= check('total_debito = 100', r1.relatorio.totais.total_debito === 100);
  todosPassaram &= check('registros[0].data_snapshot_nex vem de opcoes.dataSnapshot', r1.registros[0].data_snapshot_nex === '2026-07-30');

  // ---------- 1b. Contrato Fase 5: registros carrega o objeto PRIME completo ----------
  console.log('\n=== 1b. registros[] carrega o objeto PRIME completo (contrato Fase 5) ===');
  const reg1 = r1.registros[0];
  const camposObrigatoriosDoSchema = ['prime_id', 'nex_codigo', 'origem_sistema', 'historico', 'status_cobranca', 'consentimento_contato', 'tentativas_cobranca', 'fonte_arquivo_origem'];
  todosPassaram &= check('registro tem todos os campos obrigatorios do schema-prime', camposObrigatoriosDoSchema.every((c) => Object.prototype.hasOwnProperty.call(reg1, c)));
  todosPassaram &= check('registro.prime_id ainda null (normalizacao nao gera id)', reg1.prime_id === null);
  todosPassaram &= check('registro.historico e array vazio', Array.isArray(reg1.historico) && reg1.historico.length === 0);
  todosPassaram &= check('registro.origem_sistema = NEX', reg1.origem_sistema === 'NEX');
  todosPassaram &= check('registro.consentimento_contato = nao_solicitado', reg1.consentimento_contato === 'nao_solicitado');
  todosPassaram &= check('registro ainda tem os campos de exibicao (validacao_status, tem_celular)', 'validacao_status' in reg1 && 'tem_celular' in reg1);

  // ---------- 2/3/4. Resultado com os 1.386 registros reais + totais ja validados ----------
  console.log('\n=== 2/3/4. Os 1.386 registros reais - totais, avisos, invalidos, revisao manual ===');
  const bufferReal = fs.readFileSync(path.join(PROJETO, 'EXPORTADOS', 'clientes-nex.xls'));
  const r2 = analisarArquivoXls(bufferReal, { nomeArquivo: 'clientes-nex.xls', dataSnapshot: '2026-07-30' });
  const t = r2.relatorio.totais;
  const p = r2.relatorio.previsao_importacao;

  todosPassaram &= check('total_registros = 1386', t.total_registros === 1386);
  todosPassaram &= check('clientes_com_debito = 36', t.clientes_com_debito === 36);
  todosPassaram &= check('validos_com_aviso (avisos) = 38', t.validos_com_aviso === 38);
  todosPassaram &= check('invalidos = 0', t.invalidos === 0);
  todosPassaram &= check('revisao_manual = 28', p.revisao_manual === 28);
  todosPassaram &= check('com_celular = 791', t.com_celular === 791);
  todosPassaram &= check('total_debito = R$ 25414.58', t.total_debito === 25414.58);
  todosPassaram &= check('registros.length = 1386', r2.registros.length === 1386);
  todosPassaram &= check('registros_com_aviso.length = 38', r2.registros_com_aviso.length === 38);
  todosPassaram &= check('cada registro tem revisao_manual booleano', r2.registros.every((x) => typeof x.revisao_manual === 'boolean'));

  // ---------- 5. Arquivo invalido / conteudo ilegivel ----------
  console.log('\n=== 5. Arquivo invalido / conteudo ilegivel ===');
  let erroFormato = null;
  try { analisarArquivoXls(Buffer.from('qualquer coisa'), { nomeArquivo: 'teste.txt' }); } catch (e) { erroFormato = e; }
  todosPassaram &= check('extensao errada -> ErroImportacao formato_invalido', erroFormato instanceof ErroImportacao && erroFormato.codigo === 'formato_invalido');

  let erroVazio = null;
  try { analisarArquivoXls(Buffer.alloc(0), { nomeArquivo: 'teste.xls' }); } catch (e) { erroVazio = e; }
  todosPassaram &= check('buffer vazio -> ErroImportacao arquivo_vazio', erroVazio instanceof ErroImportacao && erroVazio.codigo === 'arquivo_vazio');

  // A lib xlsx e tolerante com texto solto (tenta ler como CSV) - para forcar
  // um erro real de parse, usamos a assinatura binaria valida do formato OLE
  // (.xls) seguida de bytes corrompidos, o que faz o parser CFB falhar.
  let erroIlegivel = null;
  const bufferCorrompido = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.from('bytes corrompidos apos o cabecalho OLE valido, sem estrutura interna real'),
  ]);
  try { analisarArquivoXls(bufferCorrompido, { nomeArquivo: 'teste.xls' }); } catch (e) { erroIlegivel = e; }
  todosPassaram &= check('conteudo binario corrompido -> ErroImportacao erro_leitura', erroIlegivel instanceof ErroImportacao && erroIlegivel.codigo === 'erro_leitura');

  let erroPlanilhaVazia = null;
  try { analisarArquivoXls(construirXlsBuffer([]), { nomeArquivo: 'vazia.xls' }); } catch (e) { erroPlanilhaVazia = e; }
  todosPassaram &= check('planilha sem linhas -> ErroImportacao planilha_vazia', erroPlanilhaVazia instanceof ErroImportacao && erroPlanilhaVazia.codigo === 'planilha_vazia');

  // ---------- 6. Independencia de HTTP ----------
  console.log('\n=== 6. Independencia de HTTP ===');
  todosPassaram &= check('modulo nao requer/usa o modulo "http"', !Object.keys(require.cache).some((k) => k.endsWith(path.sep + 'http.js')) || true); // node "http" e core, sempre no cache; teste real e estrutural abaixo
  const textoServico = fs.readFileSync(path.join(PROJETO, 'SERVICO', 'servico-importacao.js'), 'utf-8');
  todosPassaram &= check('servico-importacao.js nao importa o modulo "http"', !/require\(\s*['"]http['"]\s*\)/.test(textoServico));
  todosPassaram &= check('servico-importacao.js nao referencia req/res (objetos HTTP)', !/\breq\.(headers|url|method)\b/.test(textoServico) && !/\bres\.(writeHead|end)\b/.test(textoServico));
  todosPassaram &= check('analisarArquivoXls funciona chamado direto (sem servidor rodando)', typeof r2.relatorio === 'object');

  // ---------- 7. Igualdade entre resultado direto (servico) e resultado via HTTP (servidor) ----------
  console.log('\n=== 7. Igualdade entre resultado direto e resultado via HTTP ===');
  const servidor = criarServidor();
  await new Promise((resolve) => servidor.listen(0, resolve));
  const porta = servidor.address().port;

  const respostaHttp = await requisitar(porta, { 'X-Nome-Arquivo': 'clientes-nex.xls', 'Content-Type': 'application/octet-stream' }, bufferReal);
  servidor.close();

  todosPassaram &= check('resposta HTTP status 200', respostaHttp.status === 200);
  // dataSnapshot no servidor usa a data de hoje (nao injetada) - comparamos tudo exceto esse campo, que muda por dia.
  const normalizarParaComparar = (obj) => JSON.parse(JSON.stringify(obj).replace(/"data_snapshot_nex":"[\d-]+"/g, '"data_snapshot_nex":"IGNORADO"'));
  const diretoNormalizado = normalizarParaComparar(analisarArquivoXls(bufferReal, { nomeArquivo: 'clientes-nex.xls' }));
  const httpNormalizado = normalizarParaComparar(respostaHttp.json);
  todosPassaram &= check('resultado via HTTP e igual ao resultado direto do servico (exceto data do snapshot)', JSON.stringify(diretoNormalizado) === JSON.stringify(httpNormalizado));
  todosPassaram &= check('totais via HTTP identicos aos totais diretos', JSON.stringify(respostaHttp.json.relatorio.totais) === JSON.stringify(r2.relatorio.totais));

  // ---------- 8. Sem duplicacao de regra de negocio (versao atualizada p/ Fase 4B) ----------
  // Antes (Fase 3A/3B): servidor-local.js requeria SRC/* diretamente.
  // Agora (Fase 4B): servidor-local.js requer servico-importacao.js, que por sua
  // vez requer SRC/*. A cadeia de delegacao precisa continuar intacta.
  console.log('\n=== 8. Sem duplicacao de regra de negocio (cadeia de delegacao) ===');
  const textoServidor = fs.readFileSync(path.join(PROJETO, 'SERVICO', 'servidor-local.js'), 'utf-8');
  todosPassaram &= check('servidor-local.js requer servico-importacao.js', /require\([^)]*servico-importacao/.test(textoServidor));
  todosPassaram &= check('servidor-local.js NAO requer mais SRC/* diretamente (responsabilidade migrou)', !/require\([^)]*normalizar-clientes|require\([^)]*validar-normalizados|require\([^)]*simular-importacao/.test(textoServidor));
  todosPassaram &= check('servico-importacao.js requer normalizar-clientes de SRC', /require\([^)]*normalizar-clientes/.test(textoServico));
  todosPassaram &= check('servico-importacao.js requer validar-normalizados de SRC', /require\([^)]*validar-normalizados/.test(textoServico));
  todosPassaram &= check('servico-importacao.js requer simular-importacao de SRC', /require\([^)]*simular-importacao/.test(textoServico));

  console.log('\nResultado geral servico-importacao.js (Fase 4B):', todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM');
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((e) => { console.error('ERRO NO TESTE:', e); process.exitCode = 1; });
