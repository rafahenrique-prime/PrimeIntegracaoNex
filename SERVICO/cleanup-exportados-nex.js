'use strict';

/**
 * Cleanup administrativo de EXPORTADOS (HARDENING 1A) - avalia retencao de
 * arquivos `vendas-auto-*.xls` gerados pelo piloto recorrente
 * (PrimeNexVendasExport). Responsabilidade UNICA: decidir se um arquivo
 * pode ser movido para EXPORT_ARCHIVE (apos MOVE_AFTER_DAYS) ou apagado do
 * EXPORT_ARCHIVE (apos DELETE_ARCHIVE_AFTER_DAYS).
 *
 * ate a Fase 0 (HARDENING 1A/2E), este modulo era 100% somente-leitura de
 * filesystem. Cleanup V2 Fase 1 adiciona moverArquivoParaArchiveReal()
 * (mutacao REAL: fs.linkSync/fs.unlinkSync/fs.renameSync), mas SOMENTE
 * chamada pelo chamador (SCRIPTS/cleanup-exportados-nex.js) quando
 * --move-real e' passado explicitamente - nunca pelo modo --dry-run
 * (que continua 100% somente-leitura, inalterado) nem por nenhuma Task/
 * servico/runner de producao (nenhum wiring automatico existe). DELETE
 * real continua completamente inexistente nesta fase.
 *
 * NUNCA escreve em checkpoint/outbox - usa apenas os metodos de LEITURA
 * ja existentes (CheckpointSqlite.buscarEvento, OutboxLocal.buscarPorEventId).
 *
 * ESCOPO V1 (deliberadamente reduzido - reduz blast radius):
 *   - Age SOMENTE em arquivos cujo nome bate EXATAMENTE com
 *     `vendas-auto-YYYYMMDD-HHMMSS.xls` (nomeEhVendasAutoValido). Qualquer
 *     outro nome (Exportar-*.xls, clientes*.xls, extrato*.xls, arquivos
 *     manuais/legados) e classificado IGNORE sem nenhuma outra avaliacao.
 *   - Usa exatamente o MESMO pipeline de parsing/identidade/classificacao
 *     ja homologado (leitor-export-vendas -> normalizar-venda-nex ->
 *     identidade-transacao-nex -> classificador-evento-venda-nex ->
 *     gerador-evento-venda-nex -> calcularContentHashEvento), para nunca
 *     reimplementar ou divergir da logica real de producao usada por
 *     SERVICO/orquestrador-integracao-nex.js.
 *
 * REGRA FAIL-CLOSED (Secao 2 da ordem HARDENING 1A): um arquivo so e
 * elegivel para WOULD_ARCHIVE se TODAS as transacoes "relevantes" nele
 * (aquelas cujo eventType esta na allowlist de envio automatico - as
 * unicas que algum dia entram em checkpoint/outbox) tiverem checkpoint
 * PRESENTE, com o MESMO contentHash calculado agora, com `result` em
 * RESULTADOS_CONFIRMADOS, E (quando ainda presente na outbox) em estado
 * TERMINAL (nunca PENDING/RETRY/SENDING). Qualquer ambiguidade (parsing
 * falho, identidade invalida, checkpoint ausente/divergente/nao-confirmado,
 * outbox nao-terminal) resulta em SKIP_UNSAFE - nunca WOULD_ARCHIVE.
 */

const path = require('path');
const crypto = require('crypto');

const { lerExportVendas } = require(path.join(__dirname, 'leitor-export-vendas'));
const { normalizarVendaNex } = require(path.join(__dirname, '..', 'SRC', 'normalizar-venda-nex'));
const { gerarChaveIdentidadeTransacaoNex } = require(path.join(__dirname, '..', 'SRC', 'identidade-transacao-nex'));
const { classificarVenda } = require(path.join(__dirname, '..', 'SRC', 'classificador-evento-venda-nex'));
const { gerarEventosVenda } = require(path.join(__dirname, '..', 'SRC', 'gerador-evento-venda-nex'));
const { calcularContentHashEvento } = require(path.join(__dirname, 'repositorio-eventos-http'));
const { identificarTipoExport, TIPOS_EXPORT, EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO } = require(path.join(__dirname, 'orquestrador-integracao-nex'));
const { RESULTADOS_CONFIRMADOS } = require(path.join(__dirname, 'checkpoint-sqlite'));

const PADRAO_VENDAS_AUTO = /^vendas-auto-\d{8}-\d{6}\.xls$/;

/** Cleanup V2 Fase 0 - mesmo formato hex ja usado por calcularSha256DeBuffer
 * abaixo (crypto.createHash('sha256').digest('hex')): 64 caracteres
 * hexadecimais, case-insensitive. */
const REGEX_SHA256_HEX = /^[0-9a-f]{64}$/i;

/** @param {string} nome @returns {boolean} */
function nomeEhVendasAutoValido(nome) {
  return typeof nome === 'string' && PADRAO_VENDAS_AUTO.test(nome);
}

function sleepPadrao(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calcularSha256DeBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function idadeEmDias(mtimeMs, agoraMs) {
  return (agoraMs - mtimeMs) / (24 * 60 * 60 * 1000);
}

/**
 * Extrai, do buffer de um export de Vendas, a lista de transacoes
 * "relevantes" (eventType na allowlist de envio automatico) com seu
 * eventId + contentHash ja calculados pelo MESMO caminho de codigo do
 * orquestrador real. Nunca consulta checkpoint/outbox - so parsing puro.
 *
 * @returns {{status:'OK', transacoes:Array<{eventId:string, contentHash:string, nexTransactionId:string}>, totalLinhas:number} | {status:'ERRO', motivo:string}}
 */
function extrairTransacoesRelevantes(buffer, nomeArquivo) {
  const tipoExport = identificarTipoExport(buffer);
  if (tipoExport !== TIPOS_EXPORT.VENDAS) {
    return { status: 'ERRO', motivo: 'TIPO_EXPORT_INESPERADO (esperado VENDAS, nome sugere vendas-auto mas conteudo nao bate)' };
  }

  let linhas;
  try {
    ({ linhas } = lerExportVendas(buffer, { nomeArquivo }));
  } catch (erro) {
    return { status: 'ERRO', motivo: `FALHA_LEITURA: ${erro.message}` };
  }

  const transacoes = [];
  for (const linha of linhas) {
    let vendaNormalizada;
    try {
      vendaNormalizada = normalizarVendaNex(linha);
    } catch (erro) {
      return { status: 'ERRO', motivo: `FALHA_NORMALIZACAO: ${erro.message}` };
    }

    const identidade = gerarChaveIdentidadeTransacaoNex(vendaNormalizada);
    if (identidade.status === 'INVALID_IDENTITY') {
      // Fail-closed: uma transacao sem identidade valida nunca pode ser
      // provada segura - nao ha como saber se ela geraria (ou nao) um
      // evento financeiro em outra circunstancia. Nao ignoramos
      // silenciosamente.
      return { status: 'ERRO', motivo: `IDENTIDADE_INVALIDA: ${identidade.motivo} (nexTransactionId=${vendaNormalizada && vendaNormalizada.nexTransactionId})` };
    }

    const classificacao = classificarVenda(vendaNormalizada);
    const eventos = gerarEventosVenda(vendaNormalizada, identidade.identityKey, null, classificacao);

    for (const evento of eventos) {
      if (evento.status === 'UNCLASSIFIED') continue; // nunca teve eventId, nunca foi enviado - nao relevante para o gate
      if (!EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO.has(evento.eventType)) continue; // nunca chega a checkpoint/outbox
      transacoes.push({
        eventId: evento.eventId,
        contentHash: calcularContentHashEvento(evento),
        nexTransactionId: evento.nexTransactionId,
      });
    }
  }

  return { status: 'OK', transacoes, totalLinhas: linhas.length };
}

/**
 * Avalia o estado de protecao (checkpoint + outbox) de UMA transacao
 * relevante. Somente leitura - nunca escreve.
 * @param {{eventId:string, contentHash:string}} transacao
 * @param {Object} checkpoint - instancia de CheckpointSqlite (leitura)
 * @param {Object} outbox - instancia de OutboxLocal (leitura)
 * @returns {Promise<{protegido:boolean, motivo?:string, outboxStatus?:string}>}
 */
async function avaliarProtecaoTransacao(transacao, checkpoint, outbox) {
  const itemOutbox = await outbox.buscarPorEventId(transacao.eventId);
  if (itemOutbox && ['PENDING', 'RETRY', 'SENDING'].includes(itemOutbox.status)) {
    return { protegido: false, motivo: 'OUTBOX_NAO_TERMINAL', outboxStatus: itemOutbox.status };
  }

  const linhaCheckpoint = await checkpoint.buscarEvento(transacao.eventId);
  if (!linhaCheckpoint) {
    return { protegido: false, motivo: 'CHECKPOINT_AUSENTE' };
  }
  if (linhaCheckpoint.contentHash !== transacao.contentHash) {
    return { protegido: false, motivo: 'CHECKPOINT_HASH_DIVERGENTE' };
  }
  if (!RESULTADOS_CONFIRMADOS.has(linhaCheckpoint.result)) {
    return { protegido: false, motivo: 'CHECKPOINT_RESULTADO_NAO_CONFIRMADO', outboxStatus: itemOutbox ? itemOutbox.status : null };
  }

  return { protegido: true, outboxStatus: itemOutbox ? itemOutbox.status : null };
}

/**
 * Avalia UM arquivo candidato de EXPORTADOS/ para retencao.
 *
 * @param {Object} opcoes
 * @param {string} opcoes.caminho - caminho completo do arquivo
 * @param {string} opcoes.nomeArquivo - basename
 * @param {Object} opcoes.fsImpl - injetavel (default `fs`); precisa de
 *   `statSync` e `readFileSync`
 * @param {Object} opcoes.checkpoint - instancia de CheckpointSqlite (leitura)
 * @param {Object} opcoes.outbox - instancia de OutboxLocal (leitura)
 * @param {number} opcoes.agoraMs - `Date.now()` injetavel
 * @param {number} [opcoes.moveAfterDays] - default 7
 * @param {number} [opcoes.intervaloEstabilidadeMs] - default 500
 * @param {Function} [opcoes.sleepImpl] - injetavel
 * @returns {Promise<Object>} entrada de resultado (ver shape no README do modulo)
 */
async function avaliarArquivoVendasAuto(opcoes) {
  const opc = opcoes || {};
  const fsImpl = opc.fsImpl;
  const moveAfterDays = opc.moveAfterDays != null ? opc.moveAfterDays : 7;
  const intervaloEstabilidadeMs = opc.intervaloEstabilidadeMs != null ? opc.intervaloEstabilidadeMs : 500;
  const sleep = opc.sleepImpl || sleepPadrao;

  const base = { filename: opc.nomeArquivo, caminho: opc.caminho };

  if (!nomeEhVendasAutoValido(opc.nomeArquivo)) {
    return Object.assign({}, base, { action: 'IGNORE', reason: 'FORA_DO_ESCOPO_V1 (nome nao bate com vendas-auto-YYYYMMDD-HHMMSS.xls)' });
  }

  let statInicial;
  try {
    statInicial = fsImpl.statSync(opc.caminho);
  } catch (erro) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `ARQUIVO_INACESSIVEL: ${erro.message}` });
  }

  const size = statInicial.size;
  const age = idadeEmDias(statInicial.mtimeMs, opc.agoraMs);

  if (age < moveAfterDays) {
    return Object.assign({}, base, { action: 'KEEP', reason: 'IDADE_INSUFICIENTE', size, age });
  }

  // Estabilidade: um vendas-auto-* com idade >= moveAfterDays nunca deveria
  // estar sendo escrito agora, mas verificamos mesmo assim (defesa em
  // profundidade, mesmo padrao ja usado pelo detector).
  await sleep(intervaloEstabilidadeMs);
  let statFinal;
  try {
    statFinal = fsImpl.statSync(opc.caminho);
  } catch (erro) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `ARQUIVO_SUMIU_DURANTE_ESPERA: ${erro.message}`, size, age });
  }
  if (statFinal.size !== statInicial.size || statFinal.mtimeMs !== statInicial.mtimeMs) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'ARQUIVO_INSTAVEL_SENDO_ESCRITO', size, age });
  }

  let buffer;
  try {
    buffer = fsImpl.readFileSync(opc.caminho);
  } catch (erro) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `FALHA_LEITURA: ${erro.message}`, size, age });
  }

  const sha256 = calcularSha256DeBuffer(buffer);
  const extraido = extrairTransacoesRelevantes(buffer, opc.nomeArquivo);
  if (extraido.status === 'ERRO') {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: extraido.motivo, size, age, sha256 });
  }

  const resumoStatus = {};
  let algumNaoProtegido = false;
  let motivoBloqueio = null;

  for (const transacao of extraido.transacoes) {
    // eslint-disable-next-line no-await-in-loop
    const protecao = await avaliarProtecaoTransacao(transacao, opc.checkpoint, opc.outbox);
    const chaveResumo = protecao.protegido ? 'PROTEGIDO' : protecao.motivo;
    resumoStatus[chaveResumo] = (resumoStatus[chaveResumo] || 0) + 1;
    if (!protecao.protegido && !algumNaoProtegido) {
      algumNaoProtegido = true;
      motivoBloqueio = protecao.motivo;
    }
  }

  if (algumNaoProtegido) {
    return Object.assign({}, base, {
      action: 'SKIP_UNSAFE',
      reason: motivoBloqueio,
      size,
      age,
      sha256,
      transactionCount: extraido.transacoes.length,
      checkpointStatusSummary: resumoStatus,
    });
  }

  return Object.assign({}, base, {
    action: 'WOULD_ARCHIVE',
    reason: extraido.transacoes.length === 0 ? 'SEM_TRANSACAO_FINANCEIRA_RELEVANTE' : 'TODAS_TRANSACOES_PROTEGIDAS',
    size,
    age,
    sha256,
    transactionCount: extraido.transacoes.length,
    checkpointStatusSummary: resumoStatus,
  });
}

/**
 * Avalia UM arquivo dentro de EXPORT_ARCHIVE para possivel delete
 * definitivo. NUNCA usa mtime como fonte de `archivedAt` (o move pode
 * preservar timestamps antigos do arquivo original) - exige um manifesto
 * persistente (`{ [nomeArquivo]: {archivedAt, sha256} }`) como unica fonte
 * de verdade para a idade DENTRO do archive E para uma futura revalidacao
 * de integridade (Cleanup V2 Fase 0 - o proprio delete real, que
 * revalidaria este sha256 contra o arquivo no disco, NAO e implementado
 * nesta fase; aqui so preparamos o schema e a validacao estrutural).
 *
 * Nenhum manifesto real ou legado existe nesta instalacao (verificado
 * explicitamente antes desta mudanca) - este e um formato NOVO, nao uma
 * migracao de dado real. Mesmo assim, por seguranca, uma entrada no
 * formato ANTIGO hipotetico (string ISO pura, sem sha256) e lida sem
 * lancar excecao - mas NUNCA tratada como completa (sempre
 * MANIFEST_SHA256_AUSENTE, fail-closed), pois sem hash nao ha como provar
 * integridade.
 *
 * @param {Object} opcoes
 * @param {string} opcoes.nomeArquivo
 * @param {Object} opcoes.manifest - `{ [nomeArquivo]: {archivedAt:string, sha256:string} }`
 *   (uma entrada em formato de string ISO pura tambem e aceita para
 *   leitura, mas sempre resulta em MANIFEST_SHA256_AUSENTE)
 * @param {number} opcoes.agoraMs
 * @param {number} [opcoes.deleteAfterDays] - default 30
 * @returns {Object}
 */
function avaliarArquivoArchive(opcoes) {
  const opc = opcoes || {};
  const deleteAfterDays = opc.deleteAfterDays != null ? opc.deleteAfterDays : 30;
  const base = { filename: opc.nomeArquivo };

  if (!nomeEhVendasAutoValido(opc.nomeArquivo)) {
    return Object.assign({}, base, { action: 'IGNORE', reason: 'FORA_DO_ESCOPO_V1' });
  }

  const entrada = opc.manifest && opc.manifest[opc.nomeArquivo];
  if (!entrada) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_ARCHIVED_AT_AUSENTE (nunca apagar sem saber quando foi arquivado)' });
  }

  // Formato legado hipotetico (string ISO pura, sem sha256) - lido sem
  // lancar, nunca tratado como completo (ver doc acima).
  const archivedAtIso = typeof entrada === 'string' ? entrada : entrada.archivedAt;
  const sha256 = typeof entrada === 'string' ? undefined : entrada.sha256;

  if (!archivedAtIso || typeof archivedAtIso !== 'string') {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_ARCHIVED_AT_AUSENTE (nunca apagar sem saber quando foi arquivado)' });
  }

  const archivedAtMs = Date.parse(archivedAtIso);
  if (Number.isNaN(archivedAtMs)) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_ARCHIVED_AT_INVALIDO' });
  }

  if (!sha256 || typeof sha256 !== 'string' || sha256.trim() === '') {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_SHA256_AUSENTE (sem hash nao ha como revalidar integridade antes de um delete real futuro)' });
  }
  if (!REGEX_SHA256_HEX.test(sha256)) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_SHA256_INVALIDO (esperado hex sha256 de 64 caracteres)' });
  }

  const age = idadeEmDias(archivedAtMs, opc.agoraMs);
  if (age < deleteAfterDays) {
    return Object.assign({}, base, { action: 'KEEP', reason: 'IDADE_NO_ARCHIVE_INSUFICIENTE', age, sha256 });
  }
  return Object.assign({}, base, { action: 'WOULD_DELETE', reason: 'IDADE_NO_ARCHIVE_EXCEDIDA', age, sha256 });
}

/**
 * Cleanup V2 Fase 1 - le o estado (existe/simbolico) de um caminho SEM
 * seguir symlink/reparse point (lstat, nunca stat) - usado pelo MOVE real
 * para nunca operar sobre um link (gate 10: symlink/reparse point so e
 * aceito se houver prova segura, e nesta fase a prova segura e' NUNCA
 * seguir - qualquer symlink encontrado e rejeitado).
 * @param {Object} fsImpl @param {string} caminho
 * @returns {{existe:boolean, simbolico:boolean, tamanho?:number, mtimeMs?:number}}
 */
function statSeguro(fsImpl, caminho) {
  let st;
  try {
    st = fsImpl.lstatSync(caminho);
  } catch (erro) {
    if (erro.code === 'ENOENT') return { existe: false, simbolico: false };
    throw erro;
  }
  return { existe: true, simbolico: st.isSymbolicLink(), tamanho: st.size, mtimeMs: st.mtimeMs };
}

/**
 * Gate 10 (containment) - `caminho` precisa ser filho DIRETO de `raiz`
 * (nunca subdiretorio, nunca traversal, nunca fora da raiz) - mesmo
 * padrao ja homologado em WINDOWS/PrimeNexExportAgent/Real/
 * FileMoveAtomicPublisher.cs (Gates 1/4). Defesa em profundidade: o nome
 * do arquivo ja passou por nomeEhVendasAutoValido (regex ancorada, sem
 * "/" nem "\" possivel), mas nunca confiamos em uma unica camada.
 */
function containmentDireto(caminho, raiz) {
  return path.dirname(path.resolve(caminho)) === path.resolve(raiz);
}

/**
 * Cleanup V2 Fase 1 - escreve o manifesto de archive de forma atomica:
 * tmpfile (nome unico, mesmo diretorio do manifesto - garante mesmo
 * volume) + fs.renameSync sobre o destino final. Ao contrario do MOVE de
 * EXPORTADOS->EXPORT_ARCHIVE (onde overwrite e' PROIBIDO), aqui
 * sobrescrever o manifesto.json anterior e' exatamente o comportamento
 * desejado - fs.rename no Node SEMPRE substitui um arquivo REGULAR
 * existente no destino (MOVFILE_REPLACE_EXISTING no Windows via libuv,
 * comportamento identico ao rename(2) POSIX) - nenhum leitor concorrente
 * pode observar um JSON parcialmente escrito, so a versao antiga completa
 * ou a nova completa.
 * @param {Object} fsImpl @param {string} manifestPath @param {Object} manifestObj
 */
function escreverManifestoSeguro(fsImpl, manifestPath, manifestObj) {
  const dir = path.dirname(manifestPath);
  fsImpl.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.manifest.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fsImpl.writeFileSync(tmpPath, JSON.stringify(manifestObj, null, 2), 'utf8');
  fsImpl.renameSync(tmpPath, manifestPath);
}

/** @param {Object} entrada @returns {boolean} true se `{archivedAt, sha256}` estruturalmente validos */
function entradaManifestoValida(entrada) {
  return !!entrada
    && typeof entrada === 'object'
    && typeof entrada.archivedAt === 'string'
    && !Number.isNaN(Date.parse(entrada.archivedAt))
    && typeof entrada.sha256 === 'string'
    && REGEX_SHA256_HEX.test(entrada.sha256);
}

/**
 * Cleanup V2 Fase 1 - MOVE REAL de UM arquivo de EXPORTADOS/ para
 * EXPORT_ARCHIVE/, atras de --move-real (NUNCA chamada pelo modo
 * --dry-run). So deve ser chamada quando avaliarArquivoVendasAuto() ja
 * decidiu WOULD_ARCHIVE para este mesmo arquivo (gates 1-6 ja passaram).
 *
 * GARANTIA REAL (nao e' "move atomico" de ponta a ponta - a SEQUENCIA
 * inteira pode ser interrompida por crash entre passos; cada PASSO
 * individual e' atomico no SO, e a funcao e' idempotente: toda chamada
 * reconcilia o estado ATUAL do disco+manifesto antes de agir, nunca
 * assume que e' a primeira tentativa):
 *
 *   1. fs.linkSync(source, dest) - cria um HARD LINK (mesmos bytes
 *      fisicos do source, sem copiar nada) no destino. Atomico: ou cria
 *      do zero com o conteudo exato do source, ou falha - EEXIST se dest
 *      ja existir (NUNCA sobrescreve), EXDEV se source/dest estiverem em
 *      volumes diferentes (prova de mesmo volume em RUNTIME - gate 9 -
 *      nunca inferida de string de drive/mount point/subst).
 *   2. Manifesto {archivedAt, sha256} escrito via escreverManifestoSeguro
 *      (tmpfile+rename, atomico) ANTES de tocar o source.
 *   3. fs.unlinkSync(source) - so' DEPOIS do manifesto confirmado em
 *      disco. Ate aqui, dest e source sao o MESMO conteudo fisico -
 *      remover o source nao perde nada mesmo se o processo morrer
 *      exatamente aqui.
 *
 * Se o processo morrer entre qualquer passo, a PROXIMA chamada com o
 * MESMO nomeArquivo detecta o estado real (source/dest/manifesto) e
 * conclui so' o que falta - nunca repete um passo ja feito, nunca
 * sobrescreve, nunca perde dado, zero retry cego (cada chamada e' uma
 * unica tentativa determinada pelo estado observado, nunca um loop).
 *
 * @param {Object} opcoes
 * @param {string} opcoes.nomeArquivo
 * @param {string} opcoes.exportadosDir
 * @param {string} opcoes.archiveDir
 * @param {string} opcoes.manifestPath
 * @param {string} opcoes.sha256Esperado - hash calculado por
 *   avaliarArquivoVendasAuto no momento da decisao WOULD_ARCHIVE
 * @param {Object} opcoes.manifestAtual - manifesto ja lido pelo chamador
 * @param {number} opcoes.agoraMs
 * @param {Object} [opcoes.fsImpl] - injetavel para testes (default `fs` real)
 * @returns {Object}
 */
function moverArquivoParaArchiveReal(opcoes) {
  const opc = opcoes || {};
  const fsImpl = opc.fsImpl || require('fs');
  const nomeArquivo = opc.nomeArquivo;
  const sourcePath = path.join(opc.exportadosDir, nomeArquivo);
  const destPath = path.join(opc.archiveDir, nomeArquivo);
  const base = { filename: nomeArquivo };

  // ---- Gate ROOT (defesa adicional - hardening pre-commit): as RAIZES
  // (SOURCE_DIR/ARCHIVE_DIR), nao so os arquivos individuais, nunca podem
  // ser symlink/junction/reparse point. Sem esta checagem, um root
  // substituido por um link redirecionaria toda a arvore de
  // EXPORTADOS/EXPORT_ARCHIVE sem que o gate simbolico por-arquivo abaixo
  // (que so' olha source/dest) percebesse. Ausencia (raiz ainda nao existe -
  // ex.: EXPORT_ARCHIVE no primeiro move) e' aceita normalmente; so'
  // rejeitamos quando a raiz EXISTE e e' um link. ----
  const statRootExportados = statSeguro(fsImpl, opc.exportadosDir);
  if (statRootExportados.existe && statRootExportados.simbolico) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'SOURCE_ROOT_REPARSE_REJEITADO (EXPORTADOS e um symlink/junction/reparse point - requer revisao humana)' });
  }
  const statRootArchive = statSeguro(fsImpl, opc.archiveDir);
  if (statRootArchive.existe && statRootArchive.simbolico) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'ARCHIVE_ROOT_REPARSE_REJEITADO (EXPORT_ARCHIVE e um symlink/junction/reparse point - requer revisao humana)' });
  }

  // ---- Gate 10: containment (defesa em profundidade). ----
  if (!containmentDireto(sourcePath, opc.exportadosDir)) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'PATH_CONTAINMENT_SOURCE_INVALIDO' });
  }
  if (!containmentDireto(destPath, opc.archiveDir)) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'PATH_CONTAINMENT_DEST_INVALIDO' });
  }

  const statSource = statSeguro(fsImpl, sourcePath);
  const statDest = statSeguro(fsImpl, destPath);

  // ---- Gate simbolico: rejeita se QUALQUER lado for link/reparse point. ----
  if (statSource.simbolico || statDest.simbolico) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'SYMLINK_OU_REPARSE_POINT_REJEITADO' });
  }

  const manifestEntry = opc.manifestAtual && opc.manifestAtual[nomeArquivo];
  const manifestValido = entradaManifestoValida(manifestEntry);

  if (!statSource.existe && !statDest.existe) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'ARQUIVO_DESAPARECEU_ANTES_DO_MOVE' });
  }

  // ---- Estados E/F: source ja sumiu, dest existe. ----
  if (!statSource.existe && statDest.existe) {
    if (!manifestValido) {
      // Estado E (CORRIGIDO - gap de seguranca fechado antes do commit):
      // sem source E sem manifesto valido, NAO HA PROVA SUFICIENTE de que
      // este arquivo em EXPORT_ARCHIVE veio de um MOVE real desta
      // ferramenta (poderia ter sido copiado manualmente, restaurado de um
      // backup, etc.). Nunca "oficializar" um orfao sozinho - nunca
      // escreve manifesto, nunca inventa archivedAt, nunca toca o dest.
      // Fica pendente de revisao humana explicita (missao futura e
      // dedicada, com evidencia externa de origem).
      return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'ORFAO_ARCHIVE_REQUER_REVISAO_HUMANA (dest existe sem source e sem manifesto valido - origem nao comprovada, nada foi escrito/alterado)' });
    }
    // Estado F: manifesto diz "ja concluido" - GAP 2 (revalidacao de hash):
    // a validade ESTRUTURAL de manifestEntry (entradaManifestoValida) nao
    // prova que o sha256 registrado bate com o CONTEUDO REAL do destino
    // agora. Reler e recalcular antes de aceitar como concluido.
    let bufferDestF;
    try {
      bufferDestF = fsImpl.readFileSync(destPath);
    } catch (erro) {
      return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `ESTADO_F_LEITURA_DEST_FALHOU: ${erro.message}` });
    }
    const shaDestF = calcularSha256DeBuffer(bufferDestF);
    const shaEsperadoBateComDest = opc.sha256Esperado ? opc.sha256Esperado === shaDestF : true;
    if (manifestEntry.sha256 !== shaDestF || !shaEsperadoBateComDest) {
      return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_DEST_HASH_DIVERGENTE (manifesto valido estruturalmente, mas sha256 nao bate com o conteudo real do destino - requer revisao humana, nada alterado)' });
    }
    return Object.assign({}, base, { action: 'JA_CONCLUIDO', reason: 'OPERACAO_JA_FINALIZADA_IDEMPOTENTE', sha256: shaDestF });
  }

  // A partir daqui, statSource.existe === true.
  // ---- Inconsistencia: manifesto ja diz "arquivado" para este nome, mas
  // dest NAO existe. Isso so acontece se o manifesto foi editado/corrompido
  // manualmente fora do fluxo normal (nesta funcao, um manifestValido para
  // um nomeArquivo so e escrito DEPOIS de dest existir - ver estados
  // A/B/D abaixo). Nunca resolver sozinho sobrescrevendo a entrada antiga -
  // exige revisao humana explicita. ----
  if (!statDest.existe && manifestValido) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_INCONSISTENTE_SEM_DEST (manifesto diz arquivado, mas o arquivo nao esta em EXPORT_ARCHIVE - requer revisao humana)' });
  }

  // ---- Gate 7 (TOCTOU): reler e recalcular o hash do source AGORA,
  // comparar com o hash usado na decisao WOULD_ARCHIVE. ----
  let bufferSource;
  try {
    bufferSource = fsImpl.readFileSync(sourcePath);
  } catch (erro) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `TOCTOU_LEITURA_SOURCE_FALHOU: ${erro.message}` });
  }
  const shaSourceAgora = calcularSha256DeBuffer(bufferSource);
  if (shaSourceAgora !== opc.sha256Esperado) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'TOCTOU_HASH_DIVERGENTE (arquivo mudou entre a decisao e a acao)' });
  }

  if (statDest.existe) {
    // ---- Estados B/C/D: dest ja existe - comparar hash antes de decidir. ----
    let bufferDest;
    try {
      bufferDest = fsImpl.readFileSync(destPath);
    } catch (erro) {
      return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `RECONCILIACAO_LEITURA_DEST_FALHOU: ${erro.message}` });
    }
    const shaDest = calcularSha256DeBuffer(bufferDest);
    if (shaDest !== shaSourceAgora) {
      // Estado C: BLOQUEAR. Nunca sobrescrever um destino com conteudo diferente.
      return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'CONFLITO_DESTINO_HASH_DIVERGENTE (destino ja existe com conteudo DIFERENTE - nunca sobrescrito)' });
    }
    if (!manifestValido) {
      // Estado B: crash entre link e manifesto - escreve o manifesto agora, so' entao remove a origem.
      const manifestNovo = Object.assign({}, opc.manifestAtual, { [nomeArquivo]: { archivedAt: new Date(opc.agoraMs).toISOString(), sha256: shaDest } });
      try {
        escreverManifestoSeguro(fsImpl, opc.manifestPath, manifestNovo);
      } catch (erro) {
        return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `RECUPERACAO_MANIFEST_WRITE_FALHOU: ${erro.message}` });
      }
      try {
        fsImpl.unlinkSync(sourcePath);
      } catch (erro) {
        return Object.assign({}, base, { action: 'ARCHIVED_REAL', reason: `RECUPERADO_MAS_UNLINK_SOURCE_FALHOU: ${erro.message} (proxima execucao remove a origem remanescente)`, sha256: shaDest, manifestAtualizado: manifestNovo });
      }
      return Object.assign({}, base, { action: 'ARCHIVED_REAL', reason: 'RECUPERADO_APOS_CRASH_ENTRE_LINK_E_MANIFESTO', sha256: shaDest, manifestAtualizado: manifestNovo });
    }
    // Estado D: manifesto estruturalmente valido e source===dest bate -
    // GAP 2 (CORRIGIDO): ainda falta confirmar que o PROPRIO manifesto
    // bate com esse hash (nao so' que source===dest entre si) antes de
    // remover a origem.
    if (manifestEntry.sha256 !== shaDest) {
      return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'MANIFEST_DEST_HASH_DIVERGENTE (source e dest identicos entre si, mas o sha256 do manifesto nao bate com nenhum dos dois - requer revisao humana, origem preservada)' });
    }
    try {
      fsImpl.unlinkSync(sourcePath);
    } catch (erro) {
      return Object.assign({}, base, { action: 'ARCHIVED_REAL', reason: `RECUPERADO_MAS_UNLINK_SOURCE_FALHOU: ${erro.message} (proxima execucao remove a origem remanescente)`, sha256: manifestEntry.sha256 });
    }
    return Object.assign({}, base, { action: 'ARCHIVED_REAL', reason: 'RECUPERADO_APOS_CRASH_ANTES_DE_REMOVER_ORIGEM', sha256: manifestEntry.sha256 });
  }

  // ---- Estado A: caminho normal - dest ainda nao existe. ----
  try {
    fsImpl.mkdirSync(opc.archiveDir, { recursive: true });
    fsImpl.linkSync(sourcePath, destPath);
  } catch (erro) {
    if (erro.code === 'EEXIST') {
      // Corrida rara entre o statSeguro acima e agora - nunca sobrescrever;
      // a PROXIMA chamada reconcilia via Estados B/C/D acima.
      return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'DESTINO_APARECEU_DURANTE_A_OPERACAO (corrida rara) - proxima execucao reconcilia' });
    }
    if (erro.code === 'EXDEV') {
      return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'VOLUMES_DIFERENTES (EXDEV) - mesmo volume nao comprovado, MOVE real nunca cai para copy+delete' });
    }
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `LINK_FALHOU: ${erro.message}` });
  }

  // ---- GAP FINAL 1 (revalidacao pos-link): hard link nao copia bytes -
  // dest e source apontam para o MESMO conteudo fisico - mas ainda existe
  // uma pequena janela entre o Gate 7/TOCTOU (reler+hashear o source, LA
  // EM CIMA) e este ponto. Reler o dest AGORA, imediatamente apos o
  // linkSync e ANTES de escrever qualquer manifesto, fecha essa janela.
  // Se divergir, dest (e por extensao source, mesmo inode) PODEM estar em
  // um estado anomalo - NUNCA tenta desfazer automaticamente (um unlink/
  // rewrite aqui seria mais uma mutacao arriscada em cima de algo ja
  // inesperado). Nao escreve manifesto, nao remove source; a PROXIMA
  // execucao reconcilia via Estados B/C/D ja homologados (que recalculam
  // hash do zero, nunca confiam neste calculo antigo). ----
  let bufferDestPosLink;
  try {
    bufferDestPosLink = fsImpl.readFileSync(destPath);
  } catch (erro) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `POST_LINK_LEITURA_DEST_FALHOU: ${erro.message} (dest ja existe fisicamente, proxima execucao reconcilia)` });
  }
  const shaDestPosLink = calcularSha256DeBuffer(bufferDestPosLink);
  if (shaDestPosLink !== shaSourceAgora || shaDestPosLink !== opc.sha256Esperado) {
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: 'POST_LINK_HASH_DIVERGENTE (conteudo do destino imediatamente apos o link nao bate com o esperado - nada escrito, proxima execucao reconcilia)' });
  }

  const manifestNovo = Object.assign({}, opc.manifestAtual, { [nomeArquivo]: { archivedAt: new Date(opc.agoraMs).toISOString(), sha256: shaSourceAgora } });
  try {
    escreverManifestoSeguro(fsImpl, opc.manifestPath, manifestNovo);
  } catch (erro) {
    // dest ja existe (link feito), mas o manifesto falhou ao escrever -
    // a PROXIMA chamada reconcilia via Estado B. Nunca tenta desfazer o
    // link (isso seria mais uma mutacao arriscada em cima de uma ja falha).
    return Object.assign({}, base, { action: 'SKIP_UNSAFE', reason: `MANIFEST_WRITE_FALHOU_APOS_LINK: ${erro.message} (dest ja existe, proxima execucao reconcilia)`, sha256: shaSourceAgora });
  }

  try {
    fsImpl.unlinkSync(sourcePath);
  } catch (erro) {
    // Arquivo ja esta 100% seguro em EXPORT_ARCHIVE com manifesto correto -
    // so a origem nao foi removida ainda. Proxima execucao reconcilia via Estado D.
    return Object.assign({}, base, { action: 'ARCHIVED_REAL', reason: `MOVE_REAL_CONCLUIDO_MAS_UNLINK_SOURCE_FALHOU: ${erro.message} (proxima execucao remove a origem remanescente)`, sha256: shaSourceAgora, manifestAtualizado: manifestNovo });
  }

  return Object.assign({}, base, { action: 'ARCHIVED_REAL', reason: 'MOVE_REAL_CONCLUIDO', sha256: shaSourceAgora, manifestAtualizado: manifestNovo });
}

module.exports = {
  PADRAO_VENDAS_AUTO,
  REGEX_SHA256_HEX,
  nomeEhVendasAutoValido,
  extrairTransacoesRelevantes,
  avaliarProtecaoTransacao,
  avaliarArquivoVendasAuto,
  avaliarArquivoArchive,
  calcularSha256DeBuffer,
  statSeguro,
  containmentDireto,
  escreverManifestoSeguro,
  entradaManifestoValida,
  moverArquivoParaArchiveReal,
};
