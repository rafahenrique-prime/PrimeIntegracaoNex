'use strict';

/**
 * CLI-ponte FINO (F6.14B2.10A) entre o PRIME NEX EXPORT AGENT (C#) e o
 * Reader real de Vendas (SERVICO/leitor-export-vendas.js). NUNCA
 * reimplementa nenhuma regra de validacao - so le o arquivo do disco,
 * chama `lerExportVendas(buffer, opcoes)` sem alteracao, e imprime um
 * contrato JSON minimo em stdout + exit code determinístico.
 *
 * Uso:
 *   node SCRIPTS/validar-export-vendas.js <caminho-absoluto-do-xls>
 *
 * Contrato de saida (stdout - SEMPRE uma unica linha JSON, nunca payload
 * de negocio/PII):
 *   sucesso:        {"ok":true,"rows":4883}
 *   Reader rejeitou:{"ok":false,"errorCode":"colunas_inesperadas","reason":"..."}
 *
 * Exit code:
 *   0 = ok:true
 *   1 = ok:false (Reader rejeitou o arquivo)
 *   2 = erro de uso/infraestrutura (argumento ausente, arquivo inexistente,
 *       nao e um arquivo, erro ao ler do disco) - nunca confundido com
 *       rejeicao do Reader (exit 1)
 *
 * stderr: reservado para diagnostico tecnico (nunca parseado pelo lado
 * C#, nunca usado para decidir sucesso/falha) - tambem nunca contem
 * linhas de vendas/PII.
 *
 * Esta fase (F6.14B2.10A) e' SOMENTE VALIDACAO - este CLI nunca move,
 * copia, apaga ou renomeia o arquivo, nunca decide EXPORT_STAGE/
 * EXPORTADOS (isso e' governanca exclusiva do Agent C#), nunca publica.
 */

const fs = require('fs');
const path = require('path');
const { lerExportVendas, ErroLeituraExportVendas } = require(path.join(__dirname, '..', 'SERVICO', 'leitor-export-vendas'));

const EXIT_OK = 0;
const EXIT_READER_REJEITOU = 1;
const EXIT_ERRO_USO_OU_INFRA = 2;

function emitirContrato(objeto) {
  // stdout reservado EXCLUSIVAMENTE a esta unica linha JSON.
  process.stdout.write(JSON.stringify(objeto) + '\n');
}

function main() {
  const caminho = process.argv[2];

  if (!caminho) {
    process.stderr.write('Uso: node validar-export-vendas.js <caminho-absoluto-do-xls>\n');
    process.exitCode = EXIT_ERRO_USO_OU_INFRA;
    return;
  }

  let stat;
  try {
    stat = fs.statSync(caminho);
  } catch (e) {
    process.stderr.write(`Arquivo nao encontrado/inacessivel: ${e.message}\n`);
    process.exitCode = EXIT_ERRO_USO_OU_INFRA;
    return;
  }

  if (!stat.isFile()) {
    process.stderr.write('Caminho informado nao e um arquivo.\n');
    process.exitCode = EXIT_ERRO_USO_OU_INFRA;
    return;
  }

  let buffer;
  try {
    // Somente leitura - nunca reescreve, renomeia ou apaga o arquivo.
    buffer = fs.readFileSync(caminho);
  } catch (e) {
    process.stderr.write(`Erro ao ler arquivo: ${e.message}\n`);
    process.exitCode = EXIT_ERRO_USO_OU_INFRA;
    return;
  }

  try {
    const resultado = lerExportVendas(buffer, { nomeArquivo: path.basename(caminho) });
    emitirContrato({ ok: true, rows: resultado.linhas.length });
    process.exitCode = EXIT_OK;
  } catch (e) {
    if (e instanceof ErroLeituraExportVendas) {
      emitirContrato({ ok: false, errorCode: e.codigo, reason: e.message });
      process.exitCode = EXIT_READER_REJEITOU;
      return;
    }
    // Excecao inesperada, fora do contrato conhecido do Reader - trata
    // como erro de infraestrutura, nunca como "ok:false" do Reader (nao
    // e' o mesmo sinal - nao presumir qual codigo usar).
    process.stderr.write(`Erro inesperado ao validar: ${e && e.message}\n`);
    process.exitCode = EXIT_ERRO_USO_OU_INFRA;
  }
}

main();
