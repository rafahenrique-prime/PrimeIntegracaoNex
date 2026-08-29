'use strict';

/**
 * Teste de SERVICO/detector-exports-nex.js (Fase F3.3). NENHUM teste deste
 * arquivo faz rede real, usa secret real, altera Base44, ou toca o
 * NEX/.nx1. Usa SOMENTE diretorios temporarios reais (criados sob
 * os.tmpdir(), removidos ao final).
 *
 * O conjunto principal e deterministico (funcoes internas testaveis via
 * varrerAgora()/sleepImpl injetavel); um unico bloco (F) exercita o
 * watcher nativo real, com timeouts generosos para nao ficar fragil.
 *
 * Executar com: node TESTES\teste-detector-exports-nex.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DetectorExportsNex } = require('../SERVICO/detector-exports-nex');

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

function criarDiretorioTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teste-detector-exports-'));
}

function removerDiretorio(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function escrever(caminho, conteudo) {
  fs.writeFileSync(caminho, conteudo);
}

function sha256De(conteudo) {
  return crypto.createHash('sha256').update(conteudo).digest('hex');
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function criarColetorDeEmissoes() {
  const emissoes = [];
  const onArquivoPronto = (info) => { emissoes.push(info); };
  return { emissoes, onArquivoPronto };
}

async function main() {
  let todosPassaram = true;

  // ---------- A/B/C/N. Filtro de extensao e nomes temporarios ----------
  console.log('\n=== A/B/C/N. Filtro de extensao (.xls/.xlsx aceitos; temporarios/ocultos ignorados) ===');
  {
    const dir = criarDiretorioTemp();
    const { emissoes, onArquivoPronto } = criarColetorDeEmissoes();
    const det = new DetectorExportsNex({ diretorio: dir, onArquivoPronto, intervaloEstabilidadeMs: 15 });

    escrever(path.join(dir, 'nao-suportado.txt'), 'texto qualquer');
    escrever(path.join(dir, 'em-download.crdownload'), 'parcial');
    escrever(path.join(dir, 'temporario.tmp'), 'parcial');
    escrever(path.join(dir, 'incompleto.part'), 'parcial');
    escrever(path.join(dir, '~$Exportar-vendas.xlsx'), 'lock file do excel');
    escrever(path.join(dir, '.oculto.xls'), 'oculto');
    escrever(path.join(dir, 'Exportar-vendas.xls'), 'conteudo xls valido');
    escrever(path.join(dir, 'Exportar-clientes.xlsx'), 'conteudo xlsx valido');

    await det.varrerAgora();

    todosPassaram &= check('B. .xls valido foi emitido', emissoes.some((e) => e.nomeArquivo === 'Exportar-vendas.xls'));
    todosPassaram &= check('C. .xlsx valido foi emitido', emissoes.some((e) => e.nomeArquivo === 'Exportar-clientes.xlsx'));
    todosPassaram &= check('A. .txt nao suportado nunca emitido', !emissoes.some((e) => e.nomeArquivo === 'nao-suportado.txt'));
    todosPassaram &= check('N. .crdownload ignorado', !emissoes.some((e) => e.nomeArquivo.includes('crdownload')));
    todosPassaram &= check('N. .tmp ignorado', !emissoes.some((e) => e.nomeArquivo.includes('temporario')));
    todosPassaram &= check('N. .part ignorado', !emissoes.some((e) => e.nomeArquivo.includes('incompleto')));
    todosPassaram &= check('N. lock file "~$" do Excel ignorado', !emissoes.some((e) => e.nomeArquivo.startsWith('~$')));
    todosPassaram &= check('N. arquivo oculto (".") ignorado', !emissoes.some((e) => e.nomeArquivo.startsWith('.')));
    todosPassaram &= check('exatamente 2 emissoes nesta varredura (so os 2 validos)', emissoes.length === 2);

    removerDiretorio(dir);
  }

  // ---------- D/T. Arquivo em escrita NAO e emitido prematuramente ----------
  console.log('\n=== D/T. Arquivo mutado ENTRE as duas observacoes -> nao emitido (instavel) ===');
  {
    const dir = criarDiretorioTemp();
    const caminho = path.join(dir, 'Exportar-em-progresso.xls');
    escrever(caminho, 'conteudo inicial, ainda sera alterado');

    const { emissoes, onArquivoPronto } = criarColetorDeEmissoes();
    let jaMutou = false;
    const sleepQueMutaOArquivo = async (ms) => {
      await esperar(ms);
      if (!jaMutou) {
        jaMutou = true;
        // simula o NEX ainda escrevendo o arquivo durante a janela de espera
        fs.appendFileSync(caminho, ' + mais dados chegando ainda');
      }
    };
    const det = new DetectorExportsNex({
      diretorio: dir, onArquivoPronto, intervaloEstabilidadeMs: 15, sleepImpl: sleepQueMutaOArquivo,
    });

    const resultados1 = await det.varrerAgora();
    todosPassaram &= check('1a varredura: arquivo mutado durante a espera -> NAO emitido', emissoes.length === 0);
    todosPassaram &= check('1a varredura: resultado explicitamente marca instabilidade', resultados1[0] && resultados1[0].ignorado === 'ARQUIVO_INSTAVEL_AINDA_SENDO_ESCRITO');

    // 2a varredura: agora o arquivo para de mudar (sleepImpl nao muta mais - jaMutou=true)
    const resultados2 = await det.varrerAgora();
    todosPassaram &= check('2a varredura (arquivo agora parado): emitido', emissoes.length === 1);
    todosPassaram &= check('conteudo final (com o append) e o que foi hasheado', emissoes[0].sha256 === sha256De('conteudo inicial, ainda sera alterado + mais dados chegando ainda'));

    removerDiretorio(dir);
  }

  // ---------- G/H. Mesmo arquivo sem mudanca nao reemite; mudanca reemite ----------
  console.log('\n=== G/H. Sem mudanca -> nao reemite; conteudo alterado -> nova emissao ===');
  {
    const dir = criarDiretorioTemp();
    const caminho = path.join(dir, 'Exportar-vendas.xls');
    escrever(caminho, 'versao 1');
    const { emissoes, onArquivoPronto } = criarColetorDeEmissoes();
    const det = new DetectorExportsNex({ diretorio: dir, onArquivoPronto, intervaloEstabilidadeMs: 10 });

    await det.varrerAgora();
    todosPassaram &= check('1a varredura emite 1 vez', emissoes.length === 1);
    const hash1 = emissoes[0].sha256;

    await det.varrerAgora();
    todosPassaram &= check('G. 2a varredura SEM mudanca no arquivo -> nao reemite (continua com 1 emissao)', emissoes.length === 1);

    await esperar(20); // garante mtime estritamente diferente em qualquer FS
    escrever(caminho, 'versao 2, conteudo diferente');
    await det.varrerAgora();
    todosPassaram &= check('H. apos alterar o conteudo, nova emissao ocorre', emissoes.length === 2);
    todosPassaram &= check('H. novo sha256 e diferente do anterior', emissoes[1].sha256 !== hash1 && emissoes[1].sha256 === sha256De('versao 2, conteudo diferente'));

    removerDiretorio(dir);
  }

  // ---------- I/M. Nome diferente com mesmo conteudo nao duplica (cobre tambem rename) ----------
  console.log('\n=== I/M. Nome diferente + mesmo conteudo -> dedupe por hash (renomear tem o mesmo efeito) ===');
  {
    const dir = criarDiretorioTemp();
    const conteudo = 'exatamente o mesmo conteudo em dois arquivos';
    const caminhoA = path.join(dir, 'Exportar-A.xls');
    const caminhoB = path.join(dir, 'Exportar-B.xls');
    escrever(caminhoA, conteudo);
    escrever(caminhoB, conteudo);

    const { emissoes, onArquivoPronto } = criarColetorDeEmissoes();
    const det = new DetectorExportsNex({ diretorio: dir, onArquivoPronto, intervaloEstabilidadeMs: 10 });
    const resultados = await det.varrerAgora();

    todosPassaram &= check('I. apenas 1 das 2 (nomes diferentes, mesmo conteudo) e emitida', emissoes.length === 1);
    todosPassaram &= check('I. a outra e explicitamente marcada como CONTEUDO_JA_VISTO', resultados.some((r) => r.ignorado === 'CONTEUDO_JA_VISTO'));

    // M. renomear um arquivo ja visto para um novo nome nao gera nova emissao
    const caminhoRenomeado = path.join(dir, 'Exportar-Renomeado.xls');
    fs.renameSync(caminhoA, caminhoRenomeado);
    await det.varrerAgora();
    todosPassaram &= check('M. apos renomear (mesmo conteudo ja visto), nenhuma nova emissao', emissoes.length === 1);

    removerDiretorio(dir);
  }

  // ---------- J. Polling encontra arquivo mesmo sem depender do watcher ----------
  console.log('\n=== J. Polling periodico detecta arquivo, watcher desligado deliberadamente ===');
  {
    const dir = criarDiretorioTemp();
    const { emissoes, onArquivoPronto } = criarColetorDeEmissoes();
    const det = new DetectorExportsNex({
      diretorio: dir, onArquivoPronto, intervaloEstabilidadeMs: 5, intervaloPollingMs: 40,
    });
    det.iniciar();
    // desliga o watcher deliberadamente para isolar o polling como unico mecanismo
    if (det._watcher) { det._watcher.close(); det._watcher = null; }

    escrever(path.join(dir, 'Exportar-via-polling.xls'), 'chegou depois do start, sem watcher');
    await esperar(200); // >= alguns ciclos de intervaloPollingMs

    todosPassaram &= check('J. arquivo detectado via polling, sem watcher ativo', emissoes.some((e) => e.nomeArquivo === 'Exportar-via-polling.xls'));

    det.parar();
    removerDiretorio(dir);
  }

  // ---------- K. Startup varre arquivos ja existentes ----------
  console.log('\n=== K. iniciar() varre (startup scan) arquivos ja existentes antes de qualquer evento novo ===');
  {
    const dir = criarDiretorioTemp();
    escrever(path.join(dir, 'Exportar-preexistente.xls'), 'ja estava aqui antes do iniciar()');
    const { emissoes, onArquivoPronto } = criarColetorDeEmissoes();
    const det = new DetectorExportsNex({ diretorio: dir, onArquivoPronto, intervaloEstabilidadeMs: 10, intervaloPollingMs: 100000 });

    det.iniciar();
    if (det._watcher) { det._watcher.close(); det._watcher = null; } // isola o efeito do startup scan
    await esperar(50);

    todosPassaram &= check('K. arquivo preexistente foi emitido pelo startup scan', emissoes.some((e) => e.nomeArquivo === 'Exportar-preexistente.xls'));

    det.parar();
    removerDiretorio(dir);
  }

  // ---------- L. Arquivo removido durante a espera nao derruba o detector ----------
  console.log('\n=== L. Arquivo removido durante a janela de estabilidade -> tratado, sem crash ===');
  {
    const dir = criarDiretorioTemp();
    const caminho = path.join(dir, 'Exportar-vai-sumir.xls');
    escrever(caminho, 'este arquivo vai ser removido antes da 2a checagem');

    const { emissoes, onArquivoPronto } = criarColetorDeEmissoes();
    const errosCapturados = [];
    const sleepQueRemoveOArquivo = async (ms) => {
      await esperar(ms);
      try { fs.unlinkSync(caminho); } catch (e) { /* ja pode ter sido removido */ }
    };
    const det = new DetectorExportsNex({
      diretorio: dir, onArquivoPronto, intervaloEstabilidadeMs: 10,
      sleepImpl: sleepQueRemoveOArquivo,
      onErro: (info) => errosCapturados.push(info),
    });

    let lancouExcecao = false;
    try {
      await det.varrerAgora();
    } catch (e) {
      lancouExcecao = true;
    }
    todosPassaram &= check('L. varrerAgora NAO lanca excecao quando arquivo some durante a espera', !lancouExcecao);
    todosPassaram &= check('L. nenhuma emissao para arquivo que sumiu', emissoes.length === 0);
    todosPassaram &= check('L. erro auditavel foi reportado via onErro (tipo ARQUIVO_SUMIU_DURANTE_ESPERA)', errosCapturados.some((e) => e.tipo === 'ARQUIVO_SUMIU_DURANTE_ESPERA'));

    removerDiretorio(dir);
  }

  // ---------- O. parar() fecha watcher/timers, nenhum callback tardio ----------
  console.log('\n=== O. parar() fecha watcher e timer; nenhuma emissao apos parar ===');
  {
    const dir = criarDiretorioTemp();
    const { emissoes, onArquivoPronto } = criarColetorDeEmissoes();
    const det = new DetectorExportsNex({ diretorio: dir, onArquivoPronto, intervaloEstabilidadeMs: 20, intervaloPollingMs: 30 });
    det.iniciar();
    todosPassaram &= check('watcher ativo apos iniciar()', det._watcher !== null);
    todosPassaram &= check('timer de polling ativo apos iniciar()', det._timerPolling !== null);

    det.parar();
    todosPassaram &= check('O. watcher fechado (referencia nula) apos parar()', det._watcher === null);
    todosPassaram &= check('O. timer de polling cancelado (referencia nula) apos parar()', det._timerPolling === null);

    escrever(path.join(dir, 'Exportar-depois-de-parar.xls'), 'nao deveria ser detectado');
    await esperar(100); // tempo suficiente para watcher/polling teriam disparado, se ainda ativos

    todosPassaram &= check('O. nenhuma emissao ocorre apos parar(), mesmo com novo arquivo chegando', emissoes.length === 0);

    removerDiretorio(dir);
  }

  // ---------- P/Q. SHA-256 correto; tamanho/mtime preservados ----------
  console.log('\n=== P/Q. SHA-256 bate com valor esperado; tamanho/mtime preservados no resultado ===');
  {
    const dir = criarDiretorioTemp();
    const caminho = path.join(dir, 'Exportar-hash.xls');
    const conteudo = 'conteudo especifico para validar o hash';
    escrever(caminho, conteudo);
    const statReal = fs.statSync(caminho);

    const { emissoes, onArquivoPronto } = criarColetorDeEmissoes();
    const det = new DetectorExportsNex({ diretorio: dir, onArquivoPronto, intervaloEstabilidadeMs: 10 });
    await det.varrerAgora();

    todosPassaram &= check('P. sha256 emitido bate com o calculado independentemente', emissoes[0].sha256 === sha256De(conteudo));
    todosPassaram &= check('Q. tamanho emitido bate com fs.statSync', emissoes[0].tamanho === statReal.size);
    todosPassaram &= check('Q. mtime emitido bate com fs.statSync (mesmo valor em ms)', new Date(emissoes[0].mtime).getTime() === statReal.mtime.getTime());

    removerDiretorio(dir);
  }

  // ---------- R. Diretorio ausente -> comportamento controlado ----------
  console.log('\n=== R. Diretorio inexistente -> nao lanca, reporta erro auditavel ===');
  {
    const dirInexistente = path.join(os.tmpdir(), 'este-diretorio-nao-existe-' + Date.now());
    const { emissoes, onArquivoPronto } = criarColetorDeEmissoes();
    const errosCapturados = [];
    const det = new DetectorExportsNex({
      diretorio: dirInexistente, onArquivoPronto, intervaloEstabilidadeMs: 10, onErro: (info) => errosCapturados.push(info),
    });

    let lancouExcecao = false;
    let resultado;
    try {
      resultado = await det.varrerAgora();
    } catch (e) {
      lancouExcecao = true;
    }
    todosPassaram &= check('R. varrerAgora sobre diretorio ausente NAO lanca excecao', !lancouExcecao);
    todosPassaram &= check('R. retorna lista vazia', Array.isArray(resultado) && resultado.length === 0);
    todosPassaram &= check('R. erro auditavel reportado (tipo DIRETORIO_INDISPONIVEL)', errosCapturados.some((e) => e.tipo === 'DIRETORIO_INDISPONIVEL'));
    todosPassaram &= check('R. nenhuma emissao', emissoes.length === 0);
  }

  // ---------- U. Multiplos arquivos independentes ----------
  console.log('\n=== U. Multiplos arquivos independentes sao detectados sem interferencia ===');
  {
    const dir = criarDiretorioTemp();
    escrever(path.join(dir, 'Exportar-1.xls'), 'conteudo do arquivo 1');
    escrever(path.join(dir, 'Exportar-2.xlsx'), 'conteudo do arquivo 2, bem diferente');
    escrever(path.join(dir, 'Exportar-3.xls'), 'conteudo do arquivo 3, tambem diferente');

    const { emissoes, onArquivoPronto } = criarColetorDeEmissoes();
    const det = new DetectorExportsNex({ diretorio: dir, onArquivoPronto, intervaloEstabilidadeMs: 10 });
    await det.varrerAgora();

    todosPassaram &= check('U. os 3 arquivos independentes foram emitidos', emissoes.length === 3);
    const hashesUnicos = new Set(emissoes.map((e) => e.sha256));
    todosPassaram &= check('U. cada um com seu proprio sha256, sem colisao', hashesUnicos.size === 3);
    todosPassaram &= check('U. nomes preservados corretamente por emissao', new Set(emissoes.map((e) => e.nomeArquivo)).size === 3);

    removerDiretorio(dir);
  }

  // ---------- V/W/X. Garantias estruturais (nunca toca dominio/HTTP/Base44/.nx1) ----------
  console.log('\n=== V/W/X. Garantias estruturais: nenhum parser de dominio, HTTP ou Base44/.nx1 referenciados ===');
  {
    const codigoDoModulo = fs.readFileSync(require.resolve('../SERVICO/detector-exports-nex'), 'utf8');
    todosPassaram &= check(
      'V. modulo nao importa nenhum parser/leitor/normalizador de dominio',
      !/leitor-export|normalizar-|parser-financeiro|parser-datas|customer-resolver|gerador-eventos|gate-envio/i.test(codigoDoModulo),
    );
    todosPassaram &= check(
      'W. modulo nao referencia fetch/http/repositorio-eventos-http',
      !/fetch\(|require\(['"]http|repositorio-eventos-http|enviarEvento/i.test(codigoDoModulo),
    );
    todosPassaram &= check(
      'X. modulo nao referencia Base44/.nx1/NexAdmin/NexServ',
      !/base44|\.nx1|nexadmin|nexserv/i.test(codigoDoModulo),
    );
  }

  // ---------- F. Teste de integracao com o watcher NATIVO real ----------
  console.log('\n=== F. Watcher nativo real: multiplos eventos para o mesmo arquivo nao duplicam emissao ===');
  {
    const dir = criarDiretorioTemp();
    const { emissoes, onArquivoPronto } = criarColetorDeEmissoes();
    const det = new DetectorExportsNex({ diretorio: dir, onArquivoPronto, intervaloEstabilidadeMs: 40, intervaloPollingMs: 100000 });
    det.iniciar();

    const caminho = path.join(dir, 'Exportar-watcher-real.xls');
    // varias escritas rapidas -> o watcher nativo tende a disparar multiplos
    // eventos (change/rename) para o MESMO arquivo em sequencia.
    escrever(caminho, 'a');
    await esperar(5);
    fs.appendFileSync(caminho, 'b');
    await esperar(5);
    fs.appendFileSync(caminho, 'c');

    // aguarda tempo suficiente para: watcher disparar, estabilidade (40ms),
    // hash e emissao - com folga generosa para nao ser fragil em CI lento.
    await esperar(600);

    todosPassaram &= check('F. exatamente 1 emissao apesar de multiplos eventos do watcher para o mesmo arquivo', emissoes.length === 1);
    if (emissoes.length >= 1) {
      todosPassaram &= check('F. conteudo final consolidado ("abc") foi o hasheado', emissoes[0].sha256 === sha256De('abc'));
    }

    det.parar();
    removerDiretorio(dir);
  }

  console.log(
    '\nResultado geral teste-detector-exports-nex.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((erro) => {
  console.error('Erro inesperado no teste:', erro);
  process.exitCode = 1;
});
