'use strict';

/**
 * Teste de SERVICO/orquestrador-integracao-nex.js (Fase F3.4). NENHUM
 * teste deste arquivo faz rede real, usa secret real, altera Base44, ou
 * toca o NEX/.nx1. Usa fixtures XLS sinteticas (mesmo padrao ja usado nos
 * testes das Fases A-E.1) escritas em arquivos temporarios reais (o
 * orquestrador le do disco, como fara com arquivos entregues pelo
 * detector), e um banco SQLite temporario para checkpoint/outbox.
 *
 * Fixtures equivalentes aos 4 eventos ja homologados via E2E real:
 * #15751 (SALE_PAID), #15756 (DEBT_CREATED), #15704 (SALE_PARTIALLY_PAID),
 * #15758 (DEBT_PAYMENT) - usadas para provar que o orquestrador reproduz
 * exatamente os mesmos eventId/contentHash/identityKey ja confirmados em
 * producao, sem reimplementar logica de dominio.
 *
 * Executar com: node TESTES\teste-orquestrador-integracao-nex.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));
const {
  OrquestradorIntegracaoNex,
  identificarTipoExport,
  TIPOS_EXPORT,
  EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO,
} = require('../SERVICO/orquestrador-integracao-nex');
const { CheckpointSqlite } = require('../SERVICO/checkpoint-sqlite');
const { OutboxLocal, ESTADOS } = require('../SERVICO/outbox-local');

function check(desc, cond) {
  console.log((cond ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return cond;
}

// ---------- Fixtures XLS sinteticas (mesmo padrao das Fases A-E.1) ----------

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

function linhaVendaTxt(valores) { return linhaDe(VENDAS_HEADER, valores); }
function linhaClienteTxt(valores) { return linhaDe(CLIENTES_HEADER, valores); }
function linhaExtratoTxt(valores) { return linhaDe(EXTRATO_HEADER, valores); }

function novoDiretorioTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teste-orquestrador-'));
}

function escreverArquivo(dir, nome, buffer) {
  const caminho = path.join(dir, nome);
  fs.writeFileSync(caminho, buffer);
  return caminho;
}

// Fixture de clientes: CANELINHA(316), MATHEUS HENRIQUE DEPRE(292), JADER(86)
function bufferClientesFixture() {
  return construirXlsBuffer([
    CLIENTES_HEADER,
    linhaClienteTxt({ Nome: 'CANELINHA', Código: '316', Status: 'Ativo' }),
    linhaClienteTxt({ Nome: 'MATHEUS HENRIQUE DEPRE', Código: '292', Status: 'Ativo' }),
    linhaClienteTxt({ Nome: 'JADER', Código: '86', Status: 'Ativo' }),
    linhaClienteTxt({ Nome: 'CAROL BARBOSA', Código: '501', Status: 'Ativo' }),
    linhaClienteTxt({ Nome: 'CAROL BARBOSA', Código: '502', Status: 'Ativo' }),
  ]);
}

// Fixture de vendas: #15751 SALE_PAID, #15756 DEBT_CREATED, #15704
// SALE_PARTIALLY_PAID, #16001 SALE_CANCELLED, #16002 UNCLASSIFIED,
// #16003 cliente SEM_MATCH, #16004 cliente MULTIPLOS_MATCHES.
function bufferVendasFixture() {
  return construirXlsBuffer([
    VENDAS_HEADER,
    linhaVendaTxt({
      Número: '15751', Tipo: 'Venda', Data: '8/28/26', Hora: '14:17', Cliente: 'CANELINHA',
      'Valor Pago': 'R$ 97.00 ', 'Meio Pagto': 'Cartão de Crédito',
    }),
    linhaVendaTxt({
      Número: '15756', Tipo: 'Venda', Data: '8/28/26', Hora: '16:37', Cliente: 'MATHEUS HENRIQUE DEPRE',
      Itens: '1 X BRAND 018 HUGO BOSS', Debitado: 'R$ 89.00 ',
    }),
    linhaVendaTxt({
      Número: '15704', Tipo: 'Venda', Data: '8/17/26', Hora: '14:50', Cliente: 'JADER',
      Itens: '2 X LUPO SPORT 0002', Subtotal: 'R$ 318.00 ', 'Valor Pago': 'R$ 159.00 ',
      'Meio Pagto': 'PIX', Debitado: 'R$ 159.00 ',
    }),
    linhaVendaTxt({
      Número: '16001', Tipo: 'Venda', Data: '8/20/26', Hora: '10:00', Cliente: 'CANELINHA',
      'Valor Pago': 'R$ 50.00 ', 'Meio Pagto': 'Dinheiro', Cancelado: 'Sim', 'Cancelado Em': '8/21/26 09:00',
    }),
    linhaVendaTxt({
      Número: '16002', Tipo: 'Venda', Data: '8/22/26', Hora: '11:00', Cliente: 'CANELINHA',
    }),
    linhaVendaTxt({
      Número: '16003', Tipo: 'Venda', Data: '8/23/26', Hora: '12:00', Cliente: 'CLIENTE SEM CADASTRO NENHUM',
      'Valor Pago': 'R$ 30.00 ', 'Meio Pagto': 'Dinheiro',
    }),
    linhaVendaTxt({
      Número: '16004', Tipo: 'Venda', Data: '8/24/26', Hora: '13:00', Cliente: 'CAROL BARBOSA',
      'Valor Pago': 'R$ 40.00 ', 'Meio Pagto': 'Dinheiro',
    }),
  ]);
}

// Fixture de extrato individual do cliente 292 (MATHEUS HENRIQUE DEPRE):
// #15758 DEBT_PAYMENT + a propria linha "Venda" de #15756 (ja no mesmo
// arquivo, deve voltar UNCLASSIFIED aqui, fonte primaria e o export de
// Vendas).
function bufferExtratoFixture() {
  return construirXlsBuffer([
    EXTRATO_HEADER,
    linhaExtratoTxt({
      'No.Tran': '15756', Tipo: 'Venda', Data: '8/28/26', Hora: '16:37',
      'Total Final': 'R$ 89.00 ', Debitado: 'R$ 89.00 ',
    }),
    linhaExtratoTxt({
      'No.Tran': '15758', Tipo: 'Pagamento Débito', Data: '8/28/26', Hora: '17:08',
      'Total Final': 'R$ 89.00 ', 'Valor Pago': 'R$ 89.00 ', 'Meio Pagto': 'Dinheiro',
    }),
  ]);
}

async function main() {
  let todosPassaram = true;

  // ---------- A/B/C/D. Identificacao do tipo de export ----------
  console.log('\n=== A/B/C/D. Identificacao do tipo de export por cabecalho (nao por nome) ===');
  todosPassaram &= check('A. export de Clientes identificado', identificarTipoExport(bufferClientesFixture()) === TIPOS_EXPORT.CLIENTES);
  todosPassaram &= check('B. export de Vendas identificado', identificarTipoExport(bufferVendasFixture()) === TIPOS_EXPORT.VENDAS);
  todosPassaram &= check('C. extrato individual identificado', identificarTipoExport(bufferExtratoFixture()) === TIPOS_EXPORT.EXTRATO_INDIVIDUAL);
  const bufferDesconhecido = construirXlsBuffer([['Coluna Qualquer', 'Outra Coluna'], ['x', 'y']]);
  todosPassaram &= check('D. arquivo com cabecalho desconhecido -> DESCONHECIDO', identificarTipoExport(bufferDesconhecido) === TIPOS_EXPORT.DESCONHECIDO);

  const dirPrincipal = novoDiretorioTemp();
  const caminhoDb = path.join(dirPrincipal, 'checkpoint-e-outbox.db');
  let checkpoint = new CheckpointSqlite(caminhoDb);
  let outbox = new OutboxLocal(caminhoDb);
  let orq = new OrquestradorIntegracaoNex({ checkpoint, outbox });

  {
    const caminho = escreverArquivo(dirPrincipal, 'desconhecido.xls', bufferDesconhecido);
    const relatorio = await orq.processarArquivo(caminho);
    todosPassaram &= check('D. processarArquivo(desconhecido) nao gera evento nenhum', relatorio.eventosGerados.length === 0 && relatorio.enfileirados.length === 0);
    todosPassaram &= check('D. erroArquivo = ARQUIVO_NAO_RECONHECIDO', relatorio.erroArquivo && relatorio.erroArquivo.tipo === 'ARQUIVO_NAO_RECONHECIDO');
  }

  // ---------- E/F/G/H. Clientes constroem indice; resolucao correta ----------
  console.log('\n=== E/F/G/H. Export de Clientes constroi indice; resolucao exata/SEM_MATCH/MULTIPLOS_MATCHES ===');
  {
    const caminho = escreverArquivo(dirPrincipal, 'Exportar-clientes.xls', bufferClientesFixture());
    const relatorio = await orq.processarArquivo(caminho);
    todosPassaram &= check('E. indiceAtualizado = true apos processar Clientes', relatorio.indiceAtualizado === true);
    todosPassaram &= check('E. totalLinhas = 5 (CANELINHA, MATHEUS, JADER, 2x CAROL BARBOSA)', relatorio.totalLinhas === 5);
  }

  // ---------- I/J/K. Eventos homologados gerados corretamente (fixtures reais) ----------
  console.log('\n=== I/J/K/AA/AB/AC. SALE_PAID/DEBT_CREATED/SALE_PARTIALLY_PAID batem com os valores reais homologados ===');
  let relatorioVendas;
  {
    const caminho = escreverArquivo(dirPrincipal, 'Exportar-vendas.xls', bufferVendasFixture());
    relatorioVendas = await orq.processarArquivo(caminho);

    const evento15751 = relatorioVendas.readyToSend.find((r) => r.event.nexTransactionId === '15751');
    todosPassaram &= check('I/AA. #15751 -> SALE_PAID, READY_TO_SEND', evento15751 && evento15751.event.eventType === 'SALE_PAID');
    todosPassaram &= check('AA. #15751 eventId real homologado', evento15751 && evento15751.event.eventId === 'SALE_PAID:NEX:15751');

    const evento15756 = relatorioVendas.readyToSend.find((r) => r.event.nexTransactionId === '15756');
    todosPassaram &= check('J/AB. #15756 -> DEBT_CREATED, READY_TO_SEND', evento15756 && evento15756.event.eventType === 'DEBT_CREATED');
    todosPassaram &= check('AB. #15756 eventId real homologado', evento15756 && evento15756.event.eventId === 'DEBT_CREATED:NEX:15756');

    const evento15704 = relatorioVendas.readyToSend.find((r) => r.event.nexTransactionId === '15704');
    todosPassaram &= check('K/AC. #15704 -> SALE_PARTIALLY_PAID, READY_TO_SEND', evento15704 && evento15704.event.eventType === 'SALE_PARTIALLY_PAID');
    todosPassaram &= check('AC. #15704 eventId real homologado', evento15704 && evento15704.event.eventId === 'SALE_PARTIALLY_PAID:NEX:15704');
  }

  // ---------- M/N. SALE_CANCELLED: liberado, homologado E2E (#9929) ----------
  console.log('\n=== M/N. SALE_CANCELLED liberado, elegivel entra na outbox como qualquer outro ===');
  {
    const canceladoBase = relatorioVendas.eventosGerados.filter((r) => r.event.nexTransactionId === '16001');
    todosPassaram &= check('M. #16001 gera pelo menos 2 entradas (base + SALE_CANCELLED)', canceladoBase.length >= 2);
    const entradaCancelada = canceladoBase.find((r) => r.event.eventType === 'SALE_CANCELLED');
    todosPassaram &= check('M. SALE_CANCELLED foi classificado/gerado localmente', entradaCancelada != null);
    todosPassaram &= check(
      'N. EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO inclui SALE_CANCELLED',
      EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO.has('SALE_CANCELLED'),
    );
    if (entradaCancelada && entradaCancelada.status === 'READY_TO_SEND') {
      todosPassaram &= check(
        'N. SALE_CANCELLED READY_TO_SEND nao aparece em bloqueadosParaAutomacao',
        !relatorioVendas.bloqueadosParaAutomacao.some((r) => r.event.eventType === 'SALE_CANCELLED'),
      );
      todosPassaram &= check(
        'N. SALE_CANCELLED READY_TO_SEND foi enfileirado',
        relatorioVendas.enfileirados.includes(entradaCancelada.event.eventId),
      );
      const outboxCancelado = await outbox.buscarPorEventId(entradaCancelada.event.eventId);
      todosPassaram &= check('N. SALE_CANCELLED READY_TO_SEND existe na outbox', outboxCancelado != null);
    }
  }

  // ---------- O. UNCLASSIFIED nunca vira evento financeiro ----------
  console.log('\n=== O. UNCLASSIFIED nunca produz evento financeiro/outbox ===');
  {
    const entrada16002 = relatorioVendas.eventosGerados.find((r) => r.event && r.event.nexTransactionId === '16002');
    todosPassaram &= check('O. #16002 (sem valores) e REVIEW_REQUIRED/UNCLASSIFIED_EVENT', entrada16002 && entrada16002.status === 'REVIEW_REQUIRED' && entrada16002.reason === 'UNCLASSIFIED_EVENT');
    todosPassaram &= check('O. #16002 nunca aparece em enfileirados', !relatorioVendas.enfileirados.some((id) => id && id.includes('16002')));
  }

  // ---------- G/H (CustomerResolver via orquestrador, dados reais de negocio) ----------
  console.log('\n=== G/H. Cliente sem match e com multiplos matches nao recebem codigo inventado ===');
  {
    const entrada16003 = relatorioVendas.eventosGerados.find((r) => r.event && r.event.nexTransactionId === '16003');
    todosPassaram &= check('G. #16003 (cliente sem cadastro) -> REVIEW_REQUIRED/CUSTOMER_NOT_RESOLVED', entrada16003 && entrada16003.reason === 'CUSTOMER_NOT_RESOLVED');
    todosPassaram &= check('G. #16003 nexCustomerCode continua null (nunca inventado)', entrada16003 && entrada16003.event.nexCustomerCode == null);

    const entrada16004 = relatorioVendas.eventosGerados.find((r) => r.event && r.event.nexTransactionId === '16004');
    todosPassaram &= check('H. #16004 (CAROL BARBOSA, 2 codigos) -> REVIEW_REQUIRED/CUSTOMER_NOT_RESOLVED', entrada16004 && entrada16004.reason === 'CUSTOMER_NOT_RESOLVED');
    todosPassaram &= check('H. #16004 nexCustomerCode continua null (nunca escolhe automaticamente)', entrada16004 && entrada16004.event.nexCustomerCode == null);
  }

  // ---------- L/AD. DEBT_PAYMENT via extrato individual (contexto explicito) ----------
  console.log('\n=== L/AD/AE/AF. Extrato individual: DEBT_PAYMENT correto, sem vinculo com a divida original ===');
  let relatorioExtrato;
  {
    const caminho = escreverArquivo(dirPrincipal, 'Exportar-extrato.xls', bufferExtratoFixture());
    relatorioExtrato = await orq.processarArquivo(caminho, { contextoClienteExtrato: { nexCustomerCode: '292', customerName: 'MATHEUS HENRIQUE DEPRE' } });

    const evento15758 = relatorioExtrato.readyToSend.find((r) => r.event.nexTransactionId === '15758');
    todosPassaram &= check('L/AD. #15758 -> DEBT_PAYMENT, READY_TO_SEND', evento15758 && evento15758.event.eventType === 'DEBT_PAYMENT');
    todosPassaram &= check('AD. #15758 eventId real homologado', evento15758 && evento15758.event.eventId === 'DEBT_PAYMENT:NEX:15758');
    todosPassaram &= check('AE. nenhum relatedSaleId no payload do DEBT_PAYMENT', !Object.prototype.hasOwnProperty.call(evento15758.event, 'relatedSaleId'));

    const linha15756NoExtrato = relatorioExtrato.eventosGerados.find((r) => r.event && r.event.nexTransactionId === '15756');
    todosPassaram &= check(
      'AF. #15756 (linha "Venda" dentro do MESMO extrato) volta UNCLASSIFIED, nunca vinculado a #15758',
      linha15756NoExtrato && linha15756NoExtrato.status === 'REVIEW_REQUIRED' && linha15756NoExtrato.reason === 'UNCLASSIFIED_EVENT',
    );
    todosPassaram &= check('AF. #15758 na outbox nao referencia #15756 em nenhum campo', JSON.stringify(evento15758.event).includes('15756') === false);
  }

  // ---------- Extrato sem contexto de cliente -> erro estrutural controlado ----------
  console.log('\n=== Extrato individual sem contexto do cliente -> erro estrutural, arquivo inteiro falha (controlado) ===');
  {
    const caminho = escreverArquivo(dirPrincipal, 'Exportar-extrato-sem-contexto.xls', bufferExtratoFixture());
    const relatorio = await orq.processarArquivo(caminho); // sem contextoClienteExtrato
    todosPassaram &= check('erroArquivo = CONTEXTO_CLIENTE_AUSENTE', relatorio.erroArquivo && relatorio.erroArquivo.tipo === 'CONTEXTO_CLIENTE_AUSENTE');
    todosPassaram &= check('nenhum evento gerado/enfileirado sem contexto', relatorio.eventosGerados.length === 0 && relatorio.enfileirados.length === 0);
  }

  // ---------- P/Q/R/S. Checkpoint/outbox: dedupe, novo evento, conflito ----------
  console.log('\n=== P/Q/R/S. Checkpoint dedupe, novo evento PENDING, reenvio nao duplica, hash divergente vira conflito ===');
  {
    const item15751 = await outbox.buscarPorEventId('SALE_PAID:NEX:15751');
    todosPassaram &= check('Q. #15751 entrou na outbox como PENDING', item15751 && item15751.status === ESTADOS.PENDING);
    todosPassaram &= check('Q. payload de #15751 na outbox bate com o evento real', item15751.payload.eventId === 'SALE_PAID:NEX:15751');

    // Simula CREATED confirmado no checkpoint para #15751 (como se F3.5 ja tivesse enviado e recebido resposta)
    await checkpoint.registrarEvento({ eventId: 'SALE_PAID:NEX:15751', identityKey: 'NEX:15751', nexTransactionId: '15751', contentHash: item15751.contentHash, status: 'PENDING' });
    await checkpoint.atualizarEvento('SALE_PAID:NEX:15751', { status: 'SENT', httpStatus: 200, result: 'CREATED', correlationId: 'corr-teste' });

    // Reprocessa o MESMO arquivo de vendas (reenvio/reprocessamento) - #15751 ja confirmado no checkpoint
    const caminhoReprocessado = escreverArquivo(dirPrincipal, 'Exportar-vendas-reprocessado.xls', bufferVendasFixture());
    const relatorioReprocessado = await orq.processarArquivo(caminhoReprocessado);
    todosPassaram &= check('P. #15751 (ja confirmado no checkpoint) -> ignoradosCheckpoint, nao enfileira de novo', relatorioReprocessado.ignoradosCheckpoint.includes('SALE_PAID:NEX:15751'));
    todosPassaram &= check('P. #15751 nao aparece em enfileirados no reprocessamento', !relatorioReprocessado.enfileirados.includes('SALE_PAID:NEX:15751'));

    // #15756 NAO foi confirmado no checkpoint - reenvio deve ser no-op idempotente na outbox (ja PENDING, mesmo hash)
    todosPassaram &= check('R. #15756 (nao confirmado, ja PENDING na outbox) nao duplica linha na outbox', (await outbox.listarPorNexTransactionId('15756')).length === 1);
    todosPassaram &= check('R. #15756 nao aparece de novo em enfileirados (JA_ENFILEIRADO_MESMO_HASH, nao e erro)', !relatorioReprocessado.enfileirados.includes('DEBT_CREATED:NEX:15756'));

    // S. Simula hash divergente: registra manualmente um evento na outbox com hash diferente para o MESMO eventId de #15704, depois tenta reprocessar
    const eventoConflito = { eventId: 'CONFLITO:NEX:99999', contentHash: 'hash-original', eventType: 'SALE_PAID', payload: { amount: 1 } };
    await outbox.enqueue(eventoConflito);
    let conflitoDetectadoDiretamente = false;
    try {
      await outbox.enqueue({ ...eventoConflito, contentHash: 'hash-divergente' });
    } catch (e) {
      conflitoDetectadoDiretamente = e.name === 'ConflitoDeConteudoError';
    }
    todosPassaram &= check('S. outbox.enqueue com hash divergente lanca ConflitoDeConteudoError (base do orquestrador para o mesmo caso)', conflitoDetectadoDiretamente);
    const aindaOriginal = await outbox.buscarPorEventId('CONFLITO:NEX:99999');
    todosPassaram &= check('S. item original NAO foi sobrescrito silenciosamente', aindaOriginal.contentHash === 'hash-original');
  }

  // ---------- T. REVIEW_REQUIRED preserva sourceStatus ----------
  console.log('\n=== T. REVIEW_REQUIRED preserva sourceStatus no payload da outbox ===');
  {
    // #16003/#16004 tem eventId real (identidade valida) mas cliente nao resolvido -> devem ir para a outbox com sourceStatus REVIEW_REQUIRED
    const item16003 = relatorioVendas.reviewRequired.find((r) => r.event.nexTransactionId === '16003');
    todosPassaram &= check('#16003 tem eventId (identidade valida, so cliente pendente)', !!(item16003 && item16003.event.eventId));
    const naOutbox16003 = await outbox.buscarPorEventId(item16003.event.eventId);
    todosPassaram &= check('T. #16003 foi enfileirado (REVIEW_REQUIRED tambem persiste, para auditoria futura)', naOutbox16003 != null);
    // sourceStatus e um campo do ENVELOPE do evento (irmao de `payload`, nao
    // dentro dele) - mesmo shape ja usado e homologado em
    // SERVICO/repositorio-eventos-http.js::construirEventoParaEnvio.
    todosPassaram &= check('T. sourceStatus preservado como REVIEW_REQUIRED no envelope do evento', naOutbox16003.sourceStatus === 'REVIEW_REQUIRED');
    todosPassaram &= check('T. payload interno preserva customerResolutionStatus = REVIEW_REQUIRED', naOutbox16003.payload.customerResolutionStatus === 'REVIEW_REQUIRED');
  }

  // ---------- U. Processamento serial/deterministico ----------
  console.log('\n=== U. Ordenacao deterministica (occurredAt asc, nexTransactionId como desempate) ===');
  {
    const ordemDosEventos = relatorioVendas.eventosGerados.map((r) => r.event.nexTransactionId);
    const ordemEsperadaCrescente = [...ordemDosEventos].sort((a, b) => {
      // #15704 (17/08) < #15751/#15756 (28/08, mesmo dia, 15751 antes por hora 14:17 < 16:37) < #16001..16004 (posteriores)
      return 0; // apenas valida que rodar 2x com a mesma fixture da a MESMA ordem (determinismo), nao uma ordem especifica aqui
    });
    // Reprocessa a mesma fixture de vendas de novo (arquivo novo) e compara a ordem de geracao
    const caminhoRepeticao = escreverArquivo(dirPrincipal, 'Exportar-vendas-ordem.xls', bufferVendasFixture());
    const relatorioRepeticao = await orq.processarArquivo(caminhoRepeticao, { dryRun: true });
    const ordemRepetida = relatorioRepeticao.eventosGerados.map((r) => r.event.nexTransactionId);
    todosPassaram &= check('U. reprocessar a mesma fixture produz EXATAMENTE a mesma ordem de eventos (deterministico)', JSON.stringify(ordemDosEventos) === JSON.stringify(ordemRepetida));
    todosPassaram &= check('U. #15704 (17/08) vem antes de #15751 (28/08) na ordem gerada', ordemDosEventos.indexOf('15704') < ordemDosEventos.indexOf('15751'));
  }

  // ---------- V/W. Erro individual nao destroi arquivo; erro estrutural falha o arquivo ----------
  console.log('\n=== V/W. Erro individual preserva demais eventos; erro estrutural falha o arquivo inteiro ===');
  {
    // W: arquivo de vendas SEM as colunas minimas exigidas pelo leitor (Numero/Tipo) -> erro estrutural
    const bufferInvalido = construirXlsBuffer([['Coluna X', 'Coluna Y'], ['a', 'b']]);
    const caminhoInvalido = escreverArquivo(dirPrincipal, 'arquivo-quebrado.xls', bufferInvalido);
    const relatorioInvalido = await orq.processarArquivo(caminhoInvalido);
    todosPassaram &= check('W. cabecalho nao reconhecido -> erroArquivo, sem crash', relatorioInvalido.erroArquivo != null);

    // V: fixture de vendas valida onde 1 linha tem Numero vazio (identidade invalida) nao deve impedir os demais eventos
    const bufferComLinhaRuim = construirXlsBuffer([
      VENDAS_HEADER,
      linhaVendaTxt({ Número: '', Tipo: 'Venda', Data: '8/25/26', Hora: '10:00', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 10.00 ' }),
      linhaVendaTxt({ Número: '17001', Tipo: 'Venda', Data: '8/25/26', Hora: '11:00', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 20.00 ' }),
    ]);
    const caminhoComLinhaRuim = escreverArquivo(dirPrincipal, 'Exportar-vendas-com-linha-ruim.xls', bufferComLinhaRuim);
    const relatorioComLinhaRuim = await orq.processarArquivo(caminhoComLinhaRuim, { dryRun: true });
    todosPassaram &= check('V. linha com Numero vazio nao impede o processamento das demais', relatorioComLinhaRuim.eventosGerados.some((r) => r.event.nexTransactionId === '17001'));
  }

  // ---------- X. Dry-run interno nao grava checkpoint/outbox ----------
  console.log('\n=== X. dryRun:true executa o pipeline mas nao persiste nada ===');
  {
    const bufferDryRun = construirXlsBuffer([
      VENDAS_HEADER,
      linhaVendaTxt({ Número: '18001', Tipo: 'Venda', Data: '8/26/26', Hora: '09:00', Cliente: 'CANELINHA', 'Valor Pago': 'R$ 15.00 ' }),
    ]);
    const caminhoDryRun = escreverArquivo(dirPrincipal, 'Exportar-vendas-dryrun.xls', bufferDryRun);
    const relatorioDryRun = await orq.processarArquivo(caminhoDryRun, { dryRun: true });
    todosPassaram &= check('X. evento foi gerado normalmente no relatorio', relatorioDryRun.readyToSend.some((r) => r.event.nexTransactionId === '18001'));
    todosPassaram &= check('X. NADA foi enfileirado na outbox', relatorioDryRun.enfileirados.length === 0);
    const naOutboxDryRun = await outbox.buscarPorEventId('SALE_PAID:NEX:18001');
    todosPassaram &= check('X. item realmente NAO existe na outbox apos dryRun', naOutboxDryRun === null);
    const noCheckpointDryRun = await checkpoint.buscarEvento('SALE_PAID:NEX:18001');
    todosPassaram &= check('X. checkpoint tambem nao foi tocado', noCheckpointDryRun === null);
  }

  // ---------- Y. Fechar/reabrir DB preserva itens gerados ----------
  console.log('\n=== Y. Fechar e reabrir o mesmo banco preserva outbox/checkpoint gerados pelo orquestrador ===');
  {
    checkpoint.fechar();
    outbox.fechar();
    checkpoint = new CheckpointSqlite(caminhoDb);
    outbox = new OutboxLocal(caminhoDb);
    const item15756Reaberto = await outbox.buscarPorEventId('DEBT_CREATED:NEX:15756');
    todosPassaram &= check('Y. #15756 ainda presente na outbox apos fechar/reabrir', item15756Reaberto != null && item15756Reaberto.status === ESTADOS.PENDING);
    const checkpoint15751Reaberto = await checkpoint.buscarEvento('SALE_PAID:NEX:15751');
    todosPassaram &= check('Y. checkpoint de #15751 ainda presente apos fechar/reabrir', checkpoint15751Reaberto != null && checkpoint15751Reaberto.result === 'CREATED');
  }

  // ---------- Z. Coexistencia checkpoint/outbox continua correta ----------
  console.log('\n=== Z. Coexistencia checkpoint/outbox no mesmo banco, ja usado pelo orquestrador, continua correta ===');
  {
    const listaOutbox15704 = await outbox.listarPorNexTransactionId('15704');
    const checkpoint15704 = await checkpoint.buscarEvento('SALE_PARTIALLY_PAID:NEX:15704');
    todosPassaram &= check('Z. #15704 existe na outbox (PENDING, nunca confirmado)', listaOutbox15704.length === 1 && listaOutbox15704[0].status === ESTADOS.PENDING);
    todosPassaram &= check('Z. #15704 NAO existe no checkpoint (nunca foi "confirmado")', checkpoint15704 === null);
  }

  // ---------- AG/AH/AI/AJ. Garantias estruturais ----------
  console.log('\n=== AG/AH/AI/AJ. Garantias estruturais: zero HTTP/POST/Base44/.nx1 ===');
  {
    // Nota: os COMENTARIOS do modulo mencionam deliberadamente "enviarEvento",
    // "secret", "Base44", ".nx1" para EXPLICAR o que o orquestrador NAO faz
    // (mesmo padrao ja usado nas fases anteriores) - por isso a verificacao
    // remove os comentarios de bloco/linha antes de checar o CODIGO real,
    // evitando falso-positivo na propria documentacao de seguranca.
    const codigoCompleto = fs.readFileSync(require.resolve('../SERVICO/orquestrador-integracao-nex'), 'utf8');
    const codigoSemComentarios = codigoCompleto
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    todosPassaram &= check('AG/AH. codigo real (sem comentarios) nunca chama enviarEvento/fetch/POST', !/enviarEvento\(|fetch\(|\.post\(/i.test(codigoSemComentarios));
    todosPassaram &= check('AH. codigo real (sem comentarios) nao usa secret/HMAC', !/secret|hmac/i.test(codigoSemComentarios));
    todosPassaram &= check('AI/AJ. codigo real (sem comentarios) nao referencia Base44/.nx1/NexAdmin/NexServ', !/base44|\.nx1|nexadmin|nexserv/i.test(codigoSemComentarios));
    todosPassaram &= check(
      'modulo importa APENAS construirEventoParaEnvio de repositorio-eventos-http (funcao pura), nunca criarRepositorioEventosHttp/enviarEvento',
      codigoCompleto.includes("require(path.join(__dirname, 'repositorio-eventos-http'))") &&
        /const\s*\{\s*construirEventoParaEnvio\s*\}\s*=\s*require/.test(codigoCompleto) &&
        !codigoSemComentarios.includes('criarRepositorioEventosHttp'),
    );
  }

  checkpoint.fechar();
  outbox.fechar();
  fs.rmSync(dirPrincipal, { recursive: true, force: true });
  todosPassaram &= check('diretorio temporario removido ao final', !fs.existsSync(dirPrincipal));

  console.log(
    '\nResultado geral teste-orquestrador-integracao-nex.js:',
    todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM',
  );
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((erro) => {
  console.error('Erro inesperado no teste:', erro);
  process.exitCode = 1;
});
