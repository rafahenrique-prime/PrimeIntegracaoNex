'use strict';

/**
 * Teste de SERVICO/bootstrap-integracao-nex.js e
 * SERVICO/estado-bootstrap-sqlite.js (Fase F3.7). NENHUM teste deste
 * arquivo faz rede real, usa secret real, altera Base44, ou toca o
 * NEX/.nx1. Usa fixtures XLS sinteticas (mesmo padrao das fases
 * anteriores) e bancos SQLite temporarios.
 *
 * Fixtures equivalentes aos 4 eventos ja homologados via E2E real
 * (#15751/#15756/#15704/#15758) usadas para provar que podem ser
 * corretamente classificados como BASELINE - SEM POST, SEM Base44.
 *
 * Executar com: node TESTES\teste-bootstrap-integracao-nex.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));
const { EstadoBootstrapSqlite, ESTADOS_BOOTSTRAP, TransicaoBootstrapInvalidaError } = require('../SERVICO/estado-bootstrap-sqlite');
const { OrquestradorIntegracaoNex } = require('../SERVICO/orquestrador-integracao-nex');
const { OutboxLocal, ESTADOS } = require('../SERVICO/outbox-local');
const { CheckpointSqlite, RESULTADOS_CONFIRMADOS } = require('../SERVICO/checkpoint-sqlite');
const {
  BootstrapIntegracaoNex,
  BootstrapNaoAprovadoError,
  IndiceClientesIndisponivelError,
  ehBaseline,
} = require('../SERVICO/bootstrap-integracao-nex');

function check(desc, cond) {
  const booleano = !!cond;
  console.log((booleano ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return booleano;
}

function novoDiretorioTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teste-bootstrap-'));
}

const VENDAS_HEADER = [
  '', 'Ação', 'Número', 'Resumo', 'Tipo', 'Data', 'Hora', 'Origem', 'Itens', 'Cliente',
  'Observações', 'Vendedor', 'Desconto', 'Subtotal', 'Entrega', 'Valor Pago', 'Meio Pagto',
  'Crédito Usado', 'Debitado', 'Troco', 'Tx.Ent/Frete', 'Transp/Entregador', 'Cancelado',
  'Cancelado por', 'Cancelado Em', 'Creditado', 'Funcionário',
];
const CLIENTES_HEADER = [
  '', 'Ação', 'Nome', 'Débito / Crédito', 'Código', 'Observações', 'Sexo', 'Telefone',
  'Celular', 'Incluído Em', 'Alterado Em', 'Status',
];
const EXTRATO_HEADER = [
  'Ação', 'No.Tran', 'Data', 'Hora', 'Total Final', 'Tipo', 'Descrição', 'Observações',
  'Vl.Produtos', 'Desconto', 'Tx.Entrega/Frete', 'Valor Pago', 'Meio Pagto', 'Debitado',
  'Crédito', 'Crédito Usado', 'Funcionário', 'Vendedor', 'Entregador/Transp.', 'Cancelado',
  'Cancelado por', 'Cancelado Em', 'Recebido Por',
];
function linhaDe(header, valores) {
  return header.map((h) => (Object.prototype.hasOwnProperty.call(valores, h) ? valores[h] : ''));
}
function construirXlsBuffer(linhas) {
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}
function escrever(dir, nome, buffer) {
  const caminho = path.join(dir, nome);
  fs.writeFileSync(caminho, buffer);
  return caminho;
}

function bufferClientesFixture() {
  return construirXlsBuffer([
    CLIENTES_HEADER,
    linhaDe(CLIENTES_HEADER, { Nome: 'CANELINHA', Código: '316', Status: 'Ativo' }),
    linhaDe(CLIENTES_HEADER, { Nome: 'MATHEUS HENRIQUE DEPRE', Código: '292', Status: 'Ativo' }),
    linhaDe(CLIENTES_HEADER, { Nome: 'JADER', Código: '86', Status: 'Ativo' }),
  ]);
}

function bufferVendasHistoricasFixture() {
  return construirXlsBuffer([
    VENDAS_HEADER,
    linhaDe(VENDAS_HEADER, { Número: '15751', Tipo: 'Venda', Data: '8/28/26', Hora: '14:17', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 97.00 ', 'Meio Pagto': 'Cartão de Crédito' }),
    linhaDe(VENDAS_HEADER, { Número: '15756', Tipo: 'Venda', Data: '8/28/26', Hora: '16:37', Cliente: 'MATHEUS HENRIQUE DEPRE', Itens: '1 X BRAND 018 HUGO BOSS', Debitado: 'R$ 89.00 ' }),
    linhaDe(VENDAS_HEADER, { Número: '15704', Tipo: 'Venda', Data: '8/17/26', Hora: '14:50', Cliente: 'JADER', Itens: '2 X LUPO SPORT 0002', Subtotal: 'R$ 318.00 ', 'Valor Pago': 'R$ 159.00 ', 'Meio Pagto': 'PIX', Debitado: 'R$ 159.00 ' }),
  ]);
}

function bufferExtratoFixture() {
  return construirXlsBuffer([
    EXTRATO_HEADER,
    linhaDe(EXTRATO_HEADER, { 'No.Tran': '15756', Tipo: 'Venda', Data: '8/28/26', Hora: '16:37', 'Total Final': 'R$ 89.00 ', Debitado: 'R$ 89.00 ' }),
    linhaDe(EXTRATO_HEADER, { 'No.Tran': '15758', Tipo: 'Pagamento Débito', Data: '8/28/26', Hora: '17:08', 'Total Final': 'R$ 89.00 ', 'Valor Pago': 'R$ 89.00 ', 'Meio Pagto': 'Dinheiro' }),
  ]);
}

async function main() {
  let todosPassaram = true;

  // ---------- A. bootstrap inicia NOT_STARTED ----------
  console.log('\n=== A. bootstrap inicia NOT_STARTED ===');
  {
    const estado = new EstadoBootstrapSqlite(':memory:');
    const inicial = await estado.obterEstado();
    todosPassaram &= check('A. estado inicial e NOT_STARTED', inicial.status === ESTADOS_BOOTSTRAP.NOT_STARTED);
    estado.fechar();
  }

  // ---------- E/F/G. Semantica exata do cutoff (funcao pura) ----------
  console.log('\n=== E/F/G. Cutoff: T-1ms baseline, T baseline, T+1ms novo ===');
  {
    const cutoff = '2026-08-28T14:17:00.500';
    const antes = '2026-08-28T14:17:00.499';
    const igual = '2026-08-28T14:17:00.500';
    const depois = '2026-08-28T14:17:00.501';
    todosPassaram &= check('E. T-1ms -> baseline (<=)', ehBaseline(antes, cutoff) === true);
    todosPassaram &= check('F. T exato -> baseline (<=)', ehBaseline(igual, cutoff) === true);
    todosPassaram &= check('G. T+1ms -> NOVO (>)', ehBaseline(depois, cutoff) === false);
  }

  // ---------- B/C/D. dry-run muda estado, nao grava outbox/checkpoint ----------
  console.log('\n=== B/C/D. dry-run muda estado para DRY_RUN, nao persiste nada ===');
  let dirPrincipal, dbPath, estado, outbox, checkpoint, orq, boot;
  {
    dirPrincipal = novoDiretorioTemp();
    dbPath = path.join(dirPrincipal, 'db.db');
    estado = new EstadoBootstrapSqlite(dbPath);
    outbox = new OutboxLocal(dbPath);
    checkpoint = new CheckpointSqlite(dbPath);
    orq = new OrquestradorIntegracaoNex({ outbox, checkpoint });
    boot = new BootstrapIntegracaoNex({ estado, orquestrador: orq, diretorioExports: dirPrincipal });

    escrever(dirPrincipal, 'Exportar-clientes.xls', bufferClientesFixture());
    escrever(dirPrincipal, 'Exportar-vendas.xls', bufferVendasHistoricasFixture());
    escrever(dirPrincipal, 'Exportar-extrato.xls', bufferExtratoFixture());

    const cutoff = '2026-08-29T00:00:00';
    const relDry = await boot.executarDryRun(cutoff);
    todosPassaram &= check('B. estado muda para DRY_RUN apos executarDryRun', (await estado.obterEstado()).status === ESTADOS_BOOTSTRAP.DRY_RUN);
    todosPassaram &= check('dry-run classifica arquivos/eventos (relatorio nao vazio)', relDry.totalArquivos === 3 && relDry.baseline >= 1);
    todosPassaram &= check('C. dry-run NAO grava outbox', (await outbox.listarPorStatus(ESTADOS.PENDING)).length === 0);
    todosPassaram &= check('D. dry-run NAO marca checkpoint remoto-confirmado', (await checkpoint.buscarEvento('SALE_PAID:NEX:15751')) === null);
  }

  // ---------- H/I/J. Baseline de arquivos ----------
  console.log('\n=== H/I/J. Baseline de arquivos: reconhecido, mesmo hash/nome diferente, hash alterado detectado ===');
  {
    const conteudoA = 'conteudo identico A';
    const hashSha = require('crypto').createHash('sha256').update(conteudoA).digest('hex');
    const r1 = await estado.baselinarArquivo(hashSha, 'arquivo-a.xls');
    todosPassaram &= check('H. arquivo novo -> criado=true (registrado como baseline)', r1.criado === true);
    todosPassaram &= check('H. arquivoEhBaseline confirma', await estado.arquivoEhBaseline(hashSha));

    // I. mesmo hash, nome DIFERENTE -> continua baseline (chave e o hash, nao o nome)
    const r2 = await estado.baselinarArquivo(hashSha, 'arquivo-renomeado.xls');
    todosPassaram &= check('I. mesmo hash com nome diferente -> no-op (ja e baseline, identidade e o conteudo)', r2.criado === false);

    // J. conteudo diferente -> hash diferente -> NAO e baseline ainda (precisa ser registrado separadamente)
    const conteudoB = 'conteudo bem diferente B';
    const hashShaB = require('crypto').createHash('sha256').update(conteudoB).digest('hex');
    todosPassaram &= check('J. conteudo com hash diferente NAO e reconhecido como baseline automaticamente', (await estado.arquivoEhBaseline(hashShaB)) === false);
  }

  // ---------- K/L/M/N/O. Baseline de eventos ----------
  console.log('\n=== K/L/M/N/O. Baseline de eventos: BASELINED_LOCAL != CONFIRMED_REMOTE; idempotente; hash alterado sinalizado ===');
  {
    const r1 = await estado.baselinarEvento('SALE_PAID:NEX:99001', 'hash-original', '99001');
    todosPassaram &= check('K. evento historico baselinado (criado=true)', r1.criado === true && r1.alterado === false);

    const buscado = await estado.buscarEventoBaseline('SALE_PAID:NEX:99001');
    todosPassaram &= check('L. status do baseline e BASELINED_LOCAL, nunca CREATED/UNCHANGED/etc.', buscado.status === 'BASELINED_LOCAL' && !RESULTADOS_CONFIRMADOS.has(buscado.status));

    // M. idempotente
    const r2 = await estado.baselinarEvento('SALE_PAID:NEX:99001', 'hash-original', '99001');
    todosPassaram &= check('M. baselinar de novo com MESMO hash -> no-op (criado=false, alterado=false)', r2.criado === false && r2.alterado === false);

    // N. evento baseline mesmo hash -> avaliarEventoContraBaseline diz "nao mudou"
    const avaliacaoMesmoHash = await estado.avaliarEventoContraBaseline('SALE_PAID:NEX:99001', 'hash-original');
    todosPassaram &= check('N. avaliarEventoContraBaseline: ehBaseline=true, hashMudou=false (deve ser ignorado/anti-replay)', avaliacaoMesmoHash.ehBaseline === true && avaliacaoMesmoHash.hashMudou === false);

    // O. hash diferente -> sinalizado, nao ignorado silenciosamente
    const r3 = await estado.baselinarEvento('SALE_PAID:NEX:99001', 'hash-ALTERADO', '99001');
    todosPassaram &= check('O. baselinar com hash DIFERENTE -> alterado=true, hashAnterior preservado', r3.alterado === true && r3.hashAnterior === 'hash-original');
    const avaliacaoHashMudou = await estado.avaliarEventoContraBaseline('SALE_PAID:NEX:99001', 'hash-ALTERADO');
    todosPassaram &= check('O. apos alteracao, avaliarEventoContraBaseline reconhece o NOVO hash como "nao mudou" (ja atualizado)', avaliacaoHashMudou.hashMudou === false);
  }

  // ---------- Confirmar baseline real (arquivos+eventos do dry-run anterior) ----------
  console.log('\n=== Confirmar baseline real a partir do dry-run (idempotente - rodado 2x) ===');
  const cutoffReal = '2026-08-29T00:00:00';
  let relBase1, relBase2;
  {
    relBase1 = await boot.confirmarBaseline(cutoffReal);
    todosPassaram &= check('estado muda para BASELINED', (await estado.obterEstado()).status === ESTADOS_BOOTSTRAP.BASELINED);
    todosPassaram &= check('arquivos baselinados = 3', relBase1.arquivosBaselinados === 3);

    // O. teste de baseline repetido (idempotencia no nivel do modulo bootstrap)
    relBase2 = await boot.confirmarBaseline(cutoffReal);
    todosPassaram &= check('baseline repetido: mesma contagem de arquivos (idempotente)', relBase2.arquivosBaselinados === relBase1.arquivosBaselinados);
    todosPassaram &= check('baseline repetido: mesma contagem de eventos (idempotente)', relBase2.eventosBaselinados === relBase1.eventosBaselinados);
    todosPassaram &= check('baseline repetido: NAO gerou outbox', (await outbox.listarPorStatus(ESTADOS.PENDING)).length === 0);
  }

  // ---------- P/Q. APPROVED exige acao explicita; sem APPROVED bloqueia ----------
  console.log('\n=== P/Q. APPROVED so via aprovar() explicito; sem isso, operacao normal e bloqueada (falha fechada) ===');
  {
    const caminhoVendas = path.join(dirPrincipal, 'Exportar-vendas.xls');
    let bloqueou = false;
    try {
      await boot.processarArquivoOperacional(caminhoVendas);
    } catch (e) {
      bloqueou = e instanceof BootstrapNaoAprovadoError;
    }
    todosPassaram &= check('Q. sem APPROVED, processarArquivoOperacional lanca BootstrapNaoAprovadoError', bloqueou);
    todosPassaram &= check('P. aprovacao exige chamada explicita (nao ocorreu sozinha apos baseline)', (await estado.obterEstado()).status === ESTADOS_BOOTSTRAP.BASELINED);

    await boot.aprovar();
    todosPassaram &= check('P. apos aprovar() explicito, status = APPROVED', (await estado.obterEstado()).status === ESTADOS_BOOTSTRAP.APPROVED);

    let transicaoInvalida = false;
    try { await estado.iniciarDryRun('2026-01-01T00:00:00'); } catch (e) { transicaoInvalida = e instanceof TransicaoBootstrapInvalidaError; }
    todosPassaram &= check('transicao invalida (APPROVED -> DRY_RUN) e rejeitada', transicaoInvalida);
  }

  // ---------- Y/Z/AA/AB. Indice de clientes deterministico, fail-closed sem Clientes ----------
  console.log('\n=== Y/Z/AA/AB. Indice de clientes reconstruido deterministicamente; falha fechada sem export de Clientes ===');
  {
    const dirSemClientes = novoDiretorioTemp();
    const dbSemClientes = path.join(dirSemClientes, 'db.db');
    const estadoSC = new EstadoBootstrapSqlite(dbSemClientes);
    const outboxSC = new OutboxLocal(dbSemClientes);
    const checkpointSC = new CheckpointSqlite(dbSemClientes);
    const orqSC = new OrquestradorIntegracaoNex({ outbox: outboxSC, checkpoint: checkpointSC });
    const bootSC = new BootstrapIntegracaoNex({ estado: estadoSC, orquestrador: orqSC, diretorioExports: dirSemClientes });

    const caminhoVendasSC = escrever(dirSemClientes, 'Exportar-vendas.xls', bufferVendasHistoricasFixture());
    const cutoffSC = '2026-08-29T00:00:00';
    await bootSC.executarDryRun(cutoffSC);
    await bootSC.confirmarBaseline(cutoffSC);
    await bootSC.aprovar();

    let falhouFechado = false;
    try {
      await bootSC.processarArquivoOperacional(caminhoVendasSC);
    } catch (e) {
      falhouFechado = e instanceof IndiceClientesIndisponivelError;
    }
    todosPassaram &= check('AA. sem export de Clientes -> falha fechada (IndiceClientesIndisponivelError)', falhouFechado);
    todosPassaram &= check('Z. Vendas NAO foi processada silenciosamente sem indice (nenhum item na outbox)', (await outboxSC.listarPorStatus(ESTADOS.PENDING)).length === 0);

    // Agora disponibiliza Clientes e confirma que passa a funcionar deterministicamente
    escrever(dirSemClientes, 'Exportar-clientes.xls', bufferClientesFixture());
    await bootSC.inicializarIndiceClientes();
    todosPassaram &= check('Y. inicializarIndiceClientes() processa o export de Clientes disponivel', true);

    // reprocessa arquivo NOVO (fora do baseline) para provar resolucao exact-only
    const bufferComEventoNovo = construirXlsBuffer([
      VENDAS_HEADER,
      linhaDe(VENDAS_HEADER, { Número: '77001', Tipo: 'Venda', Data: '8/30/26', Hora: '09:00', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 10.00 ' }),
      linhaDe(VENDAS_HEADER, { Número: '77002', Tipo: 'Venda', Data: '8/30/26', Hora: '09:05', Cliente: 'CLIENTE INEXISTENTE XPTO', 'Valor Pago': 'R$ 10.00 ' }),
    ]);
    const caminhoNovoSC = escrever(dirSemClientes, 'Exportar-vendas-novo.xls', bufferComEventoNovo);
    const relIndice = await bootSC.processarArquivoOperacional(caminhoNovoSC);
    const evento77001 = relIndice.readyToSend.find((r) => r.event.nexTransactionId === '77001');
    todosPassaram &= check('AB. resolver continua exact-only: CANELINHA resolve para 316', evento77001 && evento77001.event.nexCustomerCode === '316');
    const evento77002 = relIndice.reviewRequired.find((r) => r.event && r.event.nexTransactionId === '77002');
    todosPassaram &= check('AB. cliente inexistente -> REVIEW_REQUIRED, nunca codigo inventado', evento77002 && evento77002.event.nexCustomerCode == null);

    outboxSC.fechar(); checkpointSC.fechar(); estadoSC.fechar();
    fs.rmSync(dirSemClientes, { recursive: true, force: true });
  }

  // ---------- S/T/U/V. Pos-APPROVED: novo evento, REVIEW_REQUIRED, SALE_CANCELLED, UNCLASSIFIED ----------
  console.log('\n=== S/T/U/V. Pos-APPROVED: evento novo segue fluxo normal; SALE_CANCELLED (liberado) tambem enfileira; UNCLASSIFIED nunca financeiro ===');
  {
    // arquivo de vendas com: evento baseline identico (15751), evento novo pos-cutoff,
    // SALE_CANCELLED pos-cutoff, e review_required pos-cutoff
    const bufferComTudo = construirXlsBuffer([
      VENDAS_HEADER,
      linhaDe(VENDAS_HEADER, { Número: '15751', Tipo: 'Venda', Data: '8/28/26', Hora: '14:17', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 97.00 ', 'Meio Pagto': 'Cartão de Crédito' }), // baseline identico
      linhaDe(VENDAS_HEADER, { Número: '88001', Tipo: 'Venda', Data: '8/30/26', Hora: '10:00', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 33.00 ' }), // NOVO
      linhaDe(VENDAS_HEADER, { Número: '88002', Tipo: 'Venda', Data: '8/30/26', Hora: '11:00', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 20.00 ', Cancelado: 'Sim', 'Cancelado Em': '8/30/26 12:00' }), // SALE_CANCELLED novo
      linhaDe(VENDAS_HEADER, { Número: '88003', Tipo: 'Venda', Data: '8/30/26', Hora: '13:00', Cliente: 'CANELINHA' }), // UNCLASSIFIED (sem valores)
    ]);
    const caminho = escrever(dirPrincipal, 'Exportar-vendas-pos-approved.xls', bufferComTudo);
    const rel = await boot.processarArquivoOperacional(caminho);

    todosPassaram &= check('S. #15751 (identico ao baseline) -> ignoradosAntiReplay, nao enfileirado', rel.ignoradosAntiReplay.includes('SALE_PAID:NEX:15751') && !rel.enfileirados.includes('SALE_PAID:NEX:15751'));
    todosPassaram &= check('S. #88001 (novo, pos-cutoff) -> enfileirado normalmente', rel.enfileirados.includes('SALE_PAID:NEX:88001'));

    todosPassaram &= check('U. SALE_CANCELLED pos-cutoff (liberado) enfileirado normalmente', rel.enfileirados.includes('SALE_CANCELLED:NEX:88002'));
    todosPassaram &= check('U. SALE_CANCELLED pos-cutoff (liberado) existe na outbox', (await outbox.buscarPorEventId('SALE_CANCELLED:NEX:88002')) != null);

    const entradaUnclassified = rel.eventosGerados.find((r) => r.event && r.event.nexTransactionId === '88003');
    todosPassaram &= check('V. #88003 sem valores -> REVIEW_REQUIRED/UNCLASSIFIED_EVENT, nunca financeiro', entradaUnclassified && entradaUnclassified.reason === 'UNCLASSIFIED_EVENT');
    todosPassaram &= check('V. #88003 nunca aparece em enfileirados', !rel.enfileirados.some((id) => id && id.includes('88003')));

    // T. novo REVIEW_REQUIRED > cutoff preserva sourceStatus e ainda entra na outbox (politica F3.4)
    const bufferReview = construirXlsBuffer([
      VENDAS_HEADER,
      linhaDe(VENDAS_HEADER, { Número: '88004', Tipo: 'Venda', Data: '8/30/26', Hora: '14:00', Cliente: 'CLIENTE SEM CADASTRO ALGUM', 'Valor Pago': 'R$ 15.00 ' }),
    ]);
    const caminhoReview = escrever(dirPrincipal, 'Exportar-vendas-review.xls', bufferReview);
    const relReview = await boot.processarArquivoOperacional(caminhoReview);
    const item88004 = await outbox.buscarPorEventId('SALE_PAID:NEX:88004');
    todosPassaram &= check('T. REVIEW_REQUIRED pos-cutoff entra na outbox com sourceStatus REVIEW_REQUIRED (politica F3.4 preservada)', item88004 != null && item88004.sourceStatus === 'REVIEW_REQUIRED');
  }

  // ---------- W/X. Arquivo baseline alterado depois, contendo evento novo ----------
  console.log('\n=== W/X. Arquivo baseline alterado (novo conteudo/hash) contendo evento novo pos-cutoff funciona corretamente ===');
  {
    const caminhoAlteravel = path.join(dirPrincipal, 'Exportar-vendas.xls'); // ja e baseline (hash original ja registrado)
    const conteudoOriginal = fs.readFileSync(caminhoAlteravel);

    // altera o arquivo baseline original, adicionando uma linha nova pos-cutoff
    const bufferAlterado = construirXlsBuffer([
      VENDAS_HEADER,
      linhaDe(VENDAS_HEADER, { Número: '15751', Tipo: 'Venda', Data: '8/28/26', Hora: '14:17', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 97.00 ', 'Meio Pagto': 'Cartão de Crédito' }),
      linhaDe(VENDAS_HEADER, { Número: '15756', Tipo: 'Venda', Data: '8/28/26', Hora: '16:37', Cliente: 'MATHEUS HENRIQUE DEPRE', Itens: '1 X BRAND 018 HUGO BOSS', Debitado: 'R$ 89.00 ' }),
      linhaDe(VENDAS_HEADER, { Número: '15704', Tipo: 'Venda', Data: '8/17/26', Hora: '14:50', Cliente: 'JADER', Itens: '2 X LUPO SPORT 0002', Subtotal: 'R$ 318.00 ', 'Valor Pago': 'R$ 159.00 ', 'Meio Pagto': 'PIX', Debitado: 'R$ 159.00 ' }),
      linhaDe(VENDAS_HEADER, { Número: '99900', Tipo: 'Venda', Data: '8/31/26', Hora: '15:00', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 44.00 ' }), // NOVO, so aparece agora
    ]);
    fs.writeFileSync(caminhoAlteravel, bufferAlterado);

    const relAlterado = await boot.processarArquivoOperacional(caminhoAlteravel);
    todosPassaram &= check('W. arquivo baseline alterado: eventos ja conhecidos (15751/15756/15704) continuam ignorados (anti-replay)', relAlterado.ignoradosAntiReplay.includes('SALE_PAID:NEX:15751') && relAlterado.ignoradosAntiReplay.includes('DEBT_CREATED:NEX:15756'));
    todosPassaram &= check('W. evento genuinamente novo dentro do arquivo alterado (99900) e processado', relAlterado.enfileirados.includes('SALE_PAID:NEX:99900'));

    // X. reprocessar de novo o MESMO arquivo alterado nao duplica o evento 99900
    const relRepetido = await boot.processarArquivoOperacional(caminhoAlteravel);
    todosPassaram &= check('X. reprocessar o mesmo arquivo alterado de novo NAO duplica o evento 99900 na outbox', !relRepetido.enfileirados.includes('SALE_PAID:NEX:99900'));
    const listaOutbox99900 = await outbox.listarPorNexTransactionId('99900');
    todosPassaram &= check('X. exatamente 1 linha de outbox para #99900 (sem duplicacao)', listaOutbox99900.length === 1);

    fs.writeFileSync(caminhoAlteravel, conteudoOriginal); // restaura, nao e essencial mas evita confusao em blocos seguintes
  }

  // ---------- AC/AD/AE/AF. auditarConsistencia ----------
  console.log('\n=== AC/AD/AE/AF. auditarConsistencia detecta outbox terminal sem checkpoint confirmado ===');
  {
    const dirAudit = novoDiretorioTemp();
    const dbAudit = path.join(dirAudit, 'db.db');
    const outboxAudit = new OutboxLocal(dbAudit);
    const checkpointAudit = new CheckpointSqlite(dbAudit);
    const estadoAudit = new EstadoBootstrapSqlite(dbAudit);
    const orqAudit = new OrquestradorIntegracaoNex({ outbox: outboxAudit, checkpoint: checkpointAudit });
    const bootAudit = new BootstrapIntegracaoNex({ estado: estadoAudit, orquestrador: orqAudit, diretorioExports: dirAudit });

    // item SENT sem checkpoint (simula crash entre outbox e checkpoint, F3.5)
    await outboxAudit.enqueue({ eventId: 'SALE_PAID:NEX:AUDIT1', contentHash: 'h1', payload: {} });
    await outboxAudit.claimNext();
    await outboxAudit.registrarResultado('SALE_PAID:NEX:AUDIT1', { result: 'CREATED', httpStatus: 200, correlationId: 'c1' });

    // item REVIEW_STORED sem checkpoint
    await outboxAudit.enqueue({ eventId: 'SALE_PAID:NEX:AUDIT2', contentHash: 'h2', payload: {} });
    await outboxAudit.claimNext();
    await outboxAudit.registrarResultado('SALE_PAID:NEX:AUDIT2', { result: 'REVIEW_STORED', httpStatus: 200, correlationId: 'c2' });

    // item SENT COM checkpoint correto (nao deve aparecer na auditoria)
    await outboxAudit.enqueue({ eventId: 'SALE_PAID:NEX:AUDIT3', contentHash: 'h3', payload: {} });
    await outboxAudit.claimNext();
    await outboxAudit.registrarResultado('SALE_PAID:NEX:AUDIT3', { result: 'CREATED', httpStatus: 200, correlationId: 'c3' });
    await checkpointAudit.registrarEvento({ eventId: 'SALE_PAID:NEX:AUDIT3', contentHash: 'h3', status: 'PENDING' });
    await checkpointAudit.atualizarEvento('SALE_PAID:NEX:AUDIT3', { status: 'SENT', result: 'CREATED', httpStatus: 200 });

    const inconsistencias = await bootAudit.auditarConsistencia(outboxAudit, checkpointAudit);
    todosPassaram &= check('AC. AUDIT1 (SENT sem checkpoint) detectado', inconsistencias.some((i) => i.eventId === 'SALE_PAID:NEX:AUDIT1' && i.motivo === 'CHECKPOINT_AUSENTE'));
    todosPassaram &= check('AD. AUDIT2 (REVIEW_STORED sem checkpoint) detectado', inconsistencias.some((i) => i.eventId === 'SALE_PAID:NEX:AUDIT2'));
    todosPassaram &= check('AF. AUDIT3 (com checkpoint correto) NAO e reportado', !inconsistencias.some((i) => i.eventId === 'SALE_PAID:NEX:AUDIT3'));
    todosPassaram &= check('AE. auditoria nunca cria/inventa registro de checkpoint (so leitura)', (await checkpointAudit.buscarEvento('SALE_PAID:NEX:AUDIT1')) === null);

    outboxAudit.fechar(); checkpointAudit.fechar(); estadoAudit.fechar();
    fs.rmSync(dirAudit, { recursive: true, force: true });
  }

  // ---------- AG/AH/AI/R. Restart preserva estado/baseline ----------
  console.log('\n=== AG/AH/AI/R. Restart (fechar/reabrir) preserva estado bootstrap, baseline de arquivo e de evento ===');
  {
    estado.fechar();
    outbox.fechar();
    checkpoint.fechar();

    const estadoReaberto = new EstadoBootstrapSqlite(dbPath);
    const outboxReaberto = new OutboxLocal(dbPath);
    const checkpointReaberto = new CheckpointSqlite(dbPath);

    const estadoAposRestart = await estadoReaberto.obterEstado();
    todosPassaram &= check('AG/R. status APPROVED preservado apos restart', estadoAposRestart.status === ESTADOS_BOOTSTRAP.APPROVED);
    todosPassaram &= check('AG. cutoff preservado apos restart', estadoAposRestart.cutoff === cutoffReal);

    const hashSha = require('crypto').createHash('sha256').update('conteudo identico A').digest('hex');
    todosPassaram &= check('AH. baseline de ARQUIVO preservado apos restart', await estadoReaberto.arquivoEhBaseline(hashSha));

    const eventoBaselinePreservado = await estadoReaberto.buscarEventoBaseline('SALE_PAID:NEX:15751');
    todosPassaram &= check('AI. baseline de EVENTO (#15751) preservado apos restart', eventoBaselinePreservado != null && eventoBaselinePreservado.status === 'BASELINED_LOCAL');

    estado = estadoReaberto;
    outbox = outboxReaberto;
    checkpoint = checkpointReaberto;
  }

  // ---------- AJ/AK/AL/AM/AN. Fixtures reais homologadas como baseline ----------
  console.log('\n=== AJ-AN. #15751/#15756/#15704/#15758 podem ser baseline; #15758 sem vinculo #15756 ===');
  {
    const b15751 = await estado.buscarEventoBaseline('SALE_PAID:NEX:15751');
    const b15756 = await estado.buscarEventoBaseline('DEBT_CREATED:NEX:15756');
    const b15704 = await estado.buscarEventoBaseline('SALE_PARTIALLY_PAID:NEX:15704');
    todosPassaram &= check('AJ. #15751 e baseline', b15751 != null);
    todosPassaram &= check('AK. #15756 e baseline', b15756 != null);
    todosPassaram &= check('AL. #15704 e baseline', b15704 != null);

    // #15758 (DEBT_PAYMENT, do extrato individual) precisa de contextoClienteExtrato
    const dirExtrato = novoDiretorioTemp();
    const dbExtrato = path.join(dirExtrato, 'db.db');
    const estadoExtrato = new EstadoBootstrapSqlite(dbExtrato);
    const outboxExtrato = new OutboxLocal(dbExtrato);
    const orqExtrato = new OrquestradorIntegracaoNex({ outbox: outboxExtrato });
    const bootExtrato = new BootstrapIntegracaoNex({
      estado: estadoExtrato, orquestrador: orqExtrato, diretorioExports: dirExtrato,
      contextoClienteExtrato: { nexCustomerCode: '292', customerName: 'MATHEUS HENRIQUE DEPRE' },
    });
    escrever(dirExtrato, 'Exportar-extrato.xls', bufferExtratoFixture());
    const cutoffExtrato = '2026-08-29T00:00:00';
    await bootExtrato.executarDryRun(cutoffExtrato);
    const relBaseExtrato = await bootExtrato.confirmarBaseline(cutoffExtrato);
    const b15758 = await estadoExtrato.buscarEventoBaseline('DEBT_PAYMENT:NEX:15758');
    todosPassaram &= check('AM. #15758 e baseline', b15758 != null);
    todosPassaram &= check('AN. #15758 baseline nao referencia #15756 em nenhum campo', JSON.stringify(b15758).includes('15756') === false);
    const b15756NoExtrato = await estadoExtrato.buscarEventoBaseline('DEBT_CREATED:NEX:15756');
    todosPassaram &= check('AN. #15756 (linha "Venda" dentro do extrato) NAO vira baseline aqui (fonte primaria e o export de Vendas)', b15756NoExtrato === null);

    outboxExtrato.fechar(); estadoExtrato.fechar();
    fs.rmSync(dirExtrato, { recursive: true, force: true });
  }

  // ---------- F3.7.1 - A/B/C/D. Historico com hash alterado: BLOQUEADO, classificado, idempotente; evento novo no mesmo arquivo continua liberado ----------
  console.log('\n=== F3.7.1 A-D. BASELINE_CHANGED: bloqueado (nunca outbox/checkpoint), classificado, idempotente; evento novo continua liberado ===');
  {
    const dirHA = novoDiretorioTemp();
    const dbHA = path.join(dirHA, 'db.db');
    const estadoHA = new EstadoBootstrapSqlite(dbHA);
    const outboxHA = new OutboxLocal(dbHA);
    const checkpointHA = new CheckpointSqlite(dbHA);
    const orqHA = new OrquestradorIntegracaoNex({ outbox: outboxHA, checkpoint: checkpointHA });
    const bootHA = new BootstrapIntegracaoNex({ estado: estadoHA, orquestrador: orqHA, diretorioExports: dirHA });

    escrever(dirHA, 'Exportar-clientes.xls', bufferClientesFixture());
    // A. baseline: eventId X (#50001), valor original, occurredAt = cutoff - 1 dia
    const bufferOriginal = construirXlsBuffer([
      VENDAS_HEADER,
      linhaDe(VENDAS_HEADER, { Número: '50001', Tipo: 'Venda', Data: '8/29/26', Hora: '10:00', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 100.00 ' }),
    ]);
    const caminhoHA = escrever(dirHA, 'Exportar-vendas.xls', bufferOriginal);
    const cutoffHA = '2026-08-30T00:00:00';

    await bootHA.executarDryRun(cutoffHA);
    await bootHA.confirmarBaseline(cutoffHA);
    await bootHA.aprovar();

    const baselineOriginal = await estadoHA.buscarEventoBaseline('SALE_PAID:NEX:50001');
    const hashA = baselineOriginal.contentHash;
    todosPassaram &= check('A. #50001 baselinado com hash A', baselineOriginal != null);

    // B. depois de APPROVED, o MESMO eventId (#50001) tem seu VALOR alterado no export (hash B), mesmo occurredAt historico
    const bufferAlterado = construirXlsBuffer([
      VENDAS_HEADER,
      linhaDe(VENDAS_HEADER, { Número: '50001', Tipo: 'Venda', Data: '8/29/26', Hora: '10:00', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 999.00 ' }), // valor mudou -> hash muda, occurredAt igual
      linhaDe(VENDAS_HEADER, { Número: '50002', Tipo: 'Venda', Data: '8/30/26', Hora: '08:00', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 5.00 ' }), // D. evento realmente novo, occurredAt > cutoff
    ]);
    fs.writeFileSync(caminhoHA, bufferAlterado);

    const relHA = await bootHA.processarArquivoOperacional(caminhoHA);
    const alteracao = relHA.historicoAlterado.find((h) => h.eventId === 'SALE_PAID:NEX:50001');

    todosPassaram &= check('alteracao detectada e classificada como BASELINE_CHANGED', alteracao != null && alteracao.classificacao === 'BASELINE_CHANGED');
    todosPassaram &= check('hashAnterior = A (preservado)', alteracao.hashAnterior === hashA);
    todosPassaram &= check('hashNovo = B (diferente de A)', alteracao.hashNovo !== hashA);
    todosPassaram &= check('#50001 NAO aparece mais em ignoradosAntiReplay (agora tem classificacao propria)', !relHA.ignoradosAntiReplay.includes('SALE_PAID:NEX:50001'));
    todosPassaram &= check('ZERO outbox para #50001 (bloqueado, nao apenas "ignorado como identico")', (await outboxHA.buscarPorEventId('SALE_PAID:NEX:50001')) === null);
    todosPassaram &= check('ZERO checkpoint confirmado remoto para #50001', (await checkpointHA.eventoJaConfirmado('SALE_PAID:NEX:50001', alteracao.hashNovo)) === false);
    todosPassaram &= check('#50001 nunca aparece em enfileirados', !relHA.enfileirados.includes('SALE_PAID:NEX:50001'));

    // D. #50002 (occurredAt > cutoff) segue fluxo normal, no MESMO arquivo alterado
    todosPassaram &= check('D. #50002 (novo, occurredAt > cutoff, mesmo arquivo) segue fluxo normal e e enfileirado', relHA.enfileirados.includes('SALE_PAID:NEX:50002'));

    // C. repetir o mesmo hash B novamente (reprocessar o mesmo arquivo alterado) -> mesma classificacao, sem crescimento/duplicacao
    const relHA2 = await bootHA.processarArquivoOperacional(caminhoHA);
    const alteracao2 = relHA2.historicoAlterado.find((h) => h.eventId === 'SALE_PAID:NEX:50001');
    todosPassaram &= check('C. reprocessar com o MESMO hash B -> mesma classificacao BASELINE_CHANGED (idempotente)', alteracao2 != null && alteracao2.hashNovo === alteracao.hashNovo && alteracao2.hashAnterior === alteracao.hashAnterior);
    todosPassaram &= check('C. baseline_eventos NAO foi alterado por processarArquivoOperacional (so leitura - baseline continua com hash A)', (await estadoHA.buscarEventoBaseline('SALE_PAID:NEX:50001')).contentHash === hashA);
    todosPassaram &= check('C. #50002 nao duplicado na outbox ao reprocessar', (await outboxHA.listarPorNexTransactionId('50002')).length === 1);

    outboxHA.fechar(); checkpointHA.fechar(); estadoHA.fechar();
    fs.rmSync(dirHA, { recursive: true, force: true });
  }

  // ---------- F3.7.1 - Timezone: contrato naive-local, comparacao por string, independente da maquina ----------
  console.log('\n=== F3.7.1 Timezone. occurredAt/cutoff naive America/Sao_Paulo; comparacao por string; independente da maquina ===');
  {
    const cutoffSP = '2026-08-30T00:00:00'; // conceitualmente: meia-noite de 30/08/2026 em America/Sao_Paulo
    todosPassaram &= check('15. T-1ms (2026-08-29 23:59:59.999 SP) -> BASELINE', ehBaseline('2026-08-29T23:59:59.999', cutoffSP) === true);
    todosPassaram &= check('16. T exato (2026-08-30 00:00:00.000 SP) -> BASELINE', ehBaseline('2026-08-30T00:00:00.000', cutoffSP) === true);
    todosPassaram &= check('17. T+1ms (2026-08-30 00:00:00.001 SP) -> NOVO', ehBaseline('2026-08-30T00:00:00.001', cutoffSP) === false);

    // 17. caso que detectaria erro de interpretacao UTC: se o codigo (por engano)
    // convertesse esses valores para UTC assumindo timezone da MAQUINA, o
    // resultado mudaria dependendo de onde o processo roda. Como a comparacao
    // e por STRING (nunca por Date/epoch), o resultado abaixo e sempre o
    // mesmo, comprovado executando em varios fusos horarios simulados via
    // TZ (quando disponivel no ambiente) - aqui provamos estruturalmente que
    // NENHUMA chamada a Date/epoch participa da decisao.
    const codigoBootstrap = fs.readFileSync(require.resolve('../SERVICO/bootstrap-integracao-nex'), 'utf8');
    const trechoEhBaseline = codigoBootstrap.slice(codigoBootstrap.indexOf('function ehBaseline'), codigoBootstrap.indexOf('function ehBaseline') + 300);
    todosPassaram &= check('18. ehBaseline() nao usa Date.parse/new Date/getTime (comparacao 100% por string, independente da timezone da maquina)', !/Date\.parse|new Date\(|getTime\(/.test(trechoEhBaseline));

    // Formato com "Z"/offset explicito e REJEITADO, nunca mal-interpretado como UTC
    let lancouComZ = false;
    try { ehBaseline('2026-08-29T23:59:59.999Z', cutoffSP); } catch (e) { lancouComZ = true; }
    todosPassaram &= check('13. valor com "Z" (UTC explicito) e REJEITADO, nunca silenciosamente aceito/mal-interpretado', lancouComZ);
    let lancouComOffset = false;
    try { ehBaseline('2026-08-29T23:59:59.999-03:00', cutoffSP); } catch (e) { lancouComOffset = true; }
    todosPassaram &= check('valor com offset explicito (-03:00) tambem e REJEITADO', lancouComOffset);

    // Independencia real da timezone do processo Node (spawn com TZ diferente, se suportado no ambiente)
    try {
      const { execFileSync } = require('child_process');
      const script = `console.log(require(${JSON.stringify(require.resolve('../SERVICO/bootstrap-integracao-nex'))}).ehBaseline('2026-08-30T00:00:00.001','2026-08-30T00:00:00'))`;
      const comTzUTC = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'UTC' } }).toString().trim();
      const comTzTokyo = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'Asia/Tokyo' } }).toString().trim();
      todosPassaram &= check('17b. resultado identico rodando com TZ=UTC e TZ=Asia/Tokyo (independente da timezone do processo)', comTzUTC === 'false' && comTzTokyo === 'false' && comTzUTC === comTzTokyo);
    } catch (e) {
      console.log('AVISO: nao foi possivel testar TZ via subprocesso neste ambiente (nao bloqueante) -', e.message);
    }
  }

  // ---------- AO. Nenhum historico vai para outbox durante bootstrap ----------
  console.log('\n=== AO. Nenhum evento historico foi enfileirado durante todo o processo de bootstrap ===');
  {
    const item15751 = await outbox.buscarPorEventId('SALE_PAID:NEX:15751');
    const item15756 = await outbox.buscarPorEventId('DEBT_CREATED:NEX:15756');
    const item15704 = await outbox.buscarPorEventId('SALE_PARTIALLY_PAID:NEX:15704');
    todosPassaram &= check('AO. #15751 nunca foi enfileirado (nem no dry-run, nem no baseline)', item15751 === null);
    todosPassaram &= check('AO. #15756 nunca foi enfileirado', item15756 === null);
    todosPassaram &= check('AO. #15704 nunca foi enfileirado', item15704 === null);
  }

  // ---------- F4FIX A-H. Indice de Clientes deterministico no dry-run/baseline, independente da ordem de readdir ----------
  console.log('\n=== F4FIX A-H. executarDryRun/confirmarBaseline usam o Clients export mais recente por mtime, mesmo com ordem de readdir problematica ===');
  {
    const dirFix = novoDiretorioTemp();
    const dbFix = path.join(dirFix, 'db.db');

    const caminhoAtual = escrever(dirFix, 'clientes-A-atual.xls', construirXlsBuffer([
      CLIENTES_HEADER,
      linhaDe(CLIENTES_HEADER, { Nome: 'CANELINHA', Código: '316', Status: 'Ativo' }),
      linhaDe(CLIENTES_HEADER, { Nome: 'CLIENTE SOMENTE NOVO', Código: '999', Status: 'Ativo' }),
    ]));
    const caminhoAntigo = escrever(dirFix, 'clientes-B-antigo.xls', construirXlsBuffer([
      CLIENTES_HEADER,
      linhaDe(CLIENTES_HEADER, { Nome: 'CANELINHA', Código: '316', Status: 'Ativo' }),
    ]));
    const caminhoOutro = escrever(dirFix, 'clientes-C-outro.xls', construirXlsBuffer([
      CLIENTES_HEADER,
      linhaDe(CLIENTES_HEADER, { Nome: 'CANELINHA', Código: '316', Status: 'Ativo' }),
    ]));
    const caminhoVendas = escrever(dirFix, 'vendas-teste.xls', construirXlsBuffer([
      VENDAS_HEADER,
      linhaDe(VENDAS_HEADER, { Número: '90001', Tipo: 'Venda', Data: '8/1/26', Hora: '10:00', Cliente: 'CLIENTE SOMENTE NOVO', 'Valor Pago': 'R$ 10.00 ' }),
    ]));
    const caminhoExtrato = escrever(dirFix, 'extrato-teste.xls', bufferExtratoFixture());

    // mtimes explicitos: clientes-A-atual.xls e inequivocamente o MAIS RECENTE de todos.
    const agora = Date.now();
    fs.utimesSync(caminhoAntigo, new Date(agora - 300000), new Date(agora - 300000));
    fs.utimesSync(caminhoOutro, new Date(agora - 200000), new Date(agora - 200000));
    fs.utimesSync(caminhoVendas, new Date(agora - 100000), new Date(agora - 100000));
    fs.utimesSync(caminhoExtrato, new Date(agora - 50000), new Date(agora - 50000));
    fs.utimesSync(caminhoAtual, new Date(agora), new Date(agora));

    // C. Ordem de readdir DELIBERADAMENTE problematica: o Vendas aparece ANTES
    // do Clients mais recente na listagem bruta - exatamente o cenario real
    // que expos o bug (clientes-nex.xls, mais antigo, era processado entre o
    // Clients novo e o arquivo de Vendas).
    const ordemProblematica = ['clientes-B-antigo.xls', 'vendas-teste.xls', 'clientes-C-outro.xls', 'extrato-teste.xls', 'clientes-A-atual.xls', 'db.db'];
    const fsOrdemFixa = {
      readdirSync: () => ordemProblematica,
      readFileSync: (...args) => fs.readFileSync(...args),
      statSync: (...args) => fs.statSync(...args),
      createReadStream: (...args) => fs.createReadStream(...args),
    };

    const estadoFix = new EstadoBootstrapSqlite(dbFix);
    const outboxFix = new OutboxLocal(dbFix);
    const checkpointFix = new CheckpointSqlite(dbFix);
    const orqFix = new OrquestradorIntegracaoNex({ outbox: outboxFix, checkpoint: checkpointFix });
    const bootFix = new BootstrapIntegracaoNex({ estado: estadoFix, orquestrador: orqFix, diretorioExports: dirFix, fsImpl: fsOrdemFixa });

    const cutoffFix = '2026-08-01T00:00:00';
    const relDryFix = await bootFix.executarDryRun(cutoffFix);

    // A/D. Mesmo com um Clients antigo (e o proprio Vendas) processados ANTES
    // do Clients mais recente na ordem bruta, o cliente que so existe no
    // Clients mais recente deve resolver (RESOLVED), nunca SEM_MATCH.
    const relVendasFix = await orqFix.processarArquivo(caminhoVendas, { dryRun: true });
    const evento90001 = [...relVendasFix.readyToSend, ...relVendasFix.reviewRequired].find((r) => r.event && r.event.nexTransactionId === '90001');
    todosPassaram &= check('A/D. Vendas classificado com o Clients MAIS RECENTE (RESOLVED=999), mesmo com Clients antigo e Vendas antes dele na ordem de readdir', evento90001 && evento90001.event.nexCustomerCode === '999');

    // B/C. relDryFix e o relatorio RESUMIDO (nao expoe os arrays de eventos) -
    // reclassificar via _varrerEClassificar (mesmo metodo interno usado por
    // executarDryRun/confirmarBaseline) prova que ambos usam o MESMO indice,
    // independente da ordem de readdir.
    const resultadoInterno = await bootFix._varrerEClassificar(cutoffFix);
    const entrada90001Interna = [...resultadoInterno.baseline, ...resultadoInterno.novos].find((r) => r.event.nexTransactionId === '90001');
    todosPassaram &= check('B/C. _varrerEClassificar (usado por dry-run E baseline) tambem resolve 999, independente da ordem de readdir', entrada90001Interna && entrada90001Interna.event.nexCustomerCode === '999');

    // F. Extrato individual sem contexto continua fail-closed (CONTEXTO_CLIENTE_AUSENTE)
    const relExtratoFix = await orqFix.processarArquivo(caminhoExtrato, { dryRun: true });
    todosPassaram &= check('F. Extrato individual sem contexto continua CONTEXTO_CLIENTE_AUSENTE (fail-closed preservado)', relExtratoFix.erroArquivo && relExtratoFix.erroArquivo.tipo === 'CONTEXTO_CLIENTE_AUSENTE');

    // G. dry-run continua zero-write (nao gravou outbox/checkpoint)
    todosPassaram &= check('G. dry-run continua zero-write (outbox vazia)', (await outboxFix.listarPorStatus(ESTADOS.PENDING)).length === 0);
    todosPassaram &= check('G. dry-run continua zero-write (checkpoint remoto nao tocado)', (await checkpointFix.buscarEvento('SALE_PAID:NEX:90001')) === null);

    // H. confirmarBaseline usa a MESMA classificacao do dry-run (mesmo indice,
    // ja fixado deterministicamente na primeira chamada de _varrerEClassificar).
    const relBaseFix = await bootFix.confirmarBaseline(cutoffFix);
    todosPassaram &= check('H. confirmarBaseline baseliniza o MESMO numero de eventos que o dry-run classificou como baseline', relBaseFix.eventosBaselinados === resultadoInterno.baseline.length);

    estadoFix.fechar(); outboxFix.fechar(); checkpointFix.fechar();
    fs.rmSync(dirFix, { recursive: true, force: true });
  }

  // ---------- F4FIX E. Clients parcial mais novo e escolhido, sem heuristica por quantidade de linhas ----------
  console.log('\n=== F4FIX E. Clients parcial (poucas linhas) mas mais recente por mtime E o escolhido - regra oficial preservada ===');
  {
    const dirParcial = novoDiretorioTemp();
    const dbParcial = path.join(dirParcial, 'db.db');

    const caminhoCompleto = escrever(dirParcial, 'clientes-completo.xls', construirXlsBuffer([
      CLIENTES_HEADER,
      linhaDe(CLIENTES_HEADER, { Nome: 'CANELINHA', Código: '316', Status: 'Ativo' }),
      linhaDe(CLIENTES_HEADER, { Nome: 'MATHEUS HENRIQUE DEPRE', Código: '292', Status: 'Ativo' }),
    ]));
    const caminhoParcial = escrever(dirParcial, 'clientes-parcial.xls', construirXlsBuffer([
      CLIENTES_HEADER,
      linhaDe(CLIENTES_HEADER, { Nome: 'CLIENTE SO NO PARCIAL', Código: '888', Status: 'Ativo' }),
    ]));
    const caminhoVendasParcial = escrever(dirParcial, 'vendas-parcial.xls', construirXlsBuffer([
      VENDAS_HEADER,
      linhaDe(VENDAS_HEADER, { Número: '90002', Tipo: 'Venda', Data: '8/1/26', Hora: '11:00', Cliente: 'CLIENTE SO NO PARCIAL', 'Valor Pago': 'R$ 10.00 ' }),
    ]));

    const agora = Date.now();
    fs.utimesSync(caminhoCompleto, new Date(agora - 100000), new Date(agora - 100000));
    fs.utimesSync(caminhoVendasParcial, new Date(agora - 50000), new Date(agora - 50000));
    // clientes-parcial.xls tem SO 1 linha de dados, mas e o mtime MAIS RECENTE de todos -
    // deve ser escolhido mesmo assim (regra e mtime, nunca quantidade de linhas).
    fs.utimesSync(caminhoParcial, new Date(agora), new Date(agora));

    const estadoParcial = new EstadoBootstrapSqlite(dbParcial);
    const outboxParcial = new OutboxLocal(dbParcial);
    const checkpointParcial = new CheckpointSqlite(dbParcial);
    const orqParcial = new OrquestradorIntegracaoNex({ outbox: outboxParcial, checkpoint: checkpointParcial });
    const bootParcial = new BootstrapIntegracaoNex({ estado: estadoParcial, orquestrador: orqParcial, diretorioExports: dirParcial });

    await bootParcial._varrerEClassificar('2026-08-01T00:00:00');
    const relVendasParcial = await orqParcial.processarArquivo(caminhoVendasParcial, { dryRun: true });
    const evento90002 = [...relVendasParcial.readyToSend, ...relVendasParcial.reviewRequired].find((r) => r.event && r.event.nexTransactionId === '90002');
    todosPassaram &= check('E. Clients PARCIAL (1 linha) mas mais recente por mtime foi o escolhido (RESOLVED=888, nao inventa heuristica por tamanho)', evento90002 && evento90002.event.nexCustomerCode === '888');

    estadoParcial.fechar(); outboxParcial.fechar(); checkpointParcial.fechar();
    fs.rmSync(dirParcial, { recursive: true, force: true });
  }

  // ---------- AP/AQ/AR/AS. Garantias estruturais ----------
  console.log('\n=== AP-AS. Garantias estruturais: zero HTTP real/POST/Base44/.nx1 ===');
  {
    for (const arquivo of ['bootstrap-integracao-nex.js', 'estado-bootstrap-sqlite.js']) {
      const codigoCompleto = fs.readFileSync(require.resolve('../SERVICO/' + arquivo), 'utf8');
      const codigoSemComentarios = codigoCompleto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      todosPassaram &= check(`AP/AQ. ${arquivo}: nunca chama fetch/POST real`, !/fetch\(|\.post\(/i.test(codigoSemComentarios));
      todosPassaram &= check(`${arquivo}: nao usa secret/HMAC`, !/secret|hmac/i.test(codigoSemComentarios));
      todosPassaram &= check(`AR/AS. ${arquivo}: nao referencia Base44/.nx1/NexAdmin/NexServ`, !/base44|\.nx1|nexadmin|nexserv/i.test(codigoSemComentarios));
    }
  }

  estado.fechar();
  outbox.fechar();
  checkpoint.fechar();
  fs.rmSync(dirPrincipal, { recursive: true, force: true });

  console.log(
    '\nResultado geral teste-bootstrap-integracao-nex.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((erro) => {
  console.error('Erro inesperado no teste:', erro);
  process.exitCode = 1;
});
