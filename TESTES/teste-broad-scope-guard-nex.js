'use strict';

/**
 * Teste de SERVICO/broad-scope-guard-nex.js e da integracao do
 * BROAD_SCOPE_GATE em SERVICO/bootstrap-integracao-nex.js (HARDENING 2E).
 * NENHUM teste deste arquivo faz rede real, altera Base44, toca o
 * NEX/.nx1, ou ESCREVE em SERVICO/baseline-transacoes-conhecidas.json
 * (o arquivo real de producao e so LIDO, nos testes T5/T8/T19 que o
 * usam de proposito para provar o comportamento contra dados reais).
 *
 * Executar com: node TESTES\teste-broad-scope-guard-nex.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));

const {
  carregarBaseline,
  avaliarEscopoAmplo,
  CAMINHO_BASELINE_PADRAO,
} = require('../SERVICO/broad-scope-guard-nex');
const { BootstrapIntegracaoNex } = require('../SERVICO/bootstrap-integracao-nex');
const { EstadoBootstrapSqlite } = require('../SERVICO/estado-bootstrap-sqlite');
const { OutboxLocal, ESTADOS } = require('../SERVICO/outbox-local');
const { CheckpointSqlite } = require('../SERVICO/checkpoint-sqlite');
const { OrquestradorIntegracaoNex } = require('../SERVICO/orquestrador-integracao-nex');
const { lerExportVendas } = require('../SERVICO/leitor-export-vendas');
const { normalizarVendaNex } = require('../SRC/normalizar-venda-nex');

function check(desc, cond) {
  const booleano = !!cond;
  console.log((booleano ? 'PASS' : 'FALHOU') + ' - ' + desc);
  return booleano;
}

function novoDiretorioTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teste-scope-guard-'));
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
  ]);
}
function linhaVenda(numero, data, hora, valorPago) {
  return linhaDe(VENDAS_HEADER, { Número: numero, Tipo: 'Venda', Data: data, Hora: hora, Cliente: 'CANELINHA', 'Valor Pago': valorPago || 'R$ 10.00 ' });
}
function vn(id, occurredAt) {
  return { nexTransactionId: id, occurredAt };
}

function escreverBaselineJson(dir, objeto) {
  const caminho = path.join(dir, 'baseline-teste.json');
  fs.writeFileSync(caminho, JSON.stringify(objeto, null, 2));
  return caminho;
}

async function main() {
  let todosPassaram = true;

  // ==================== T1-T4: carregarBaseline (validacao fail-closed) ====================
  console.log('\n=== T1-T4. carregarBaseline: validacao fail-closed ===');
  const dirBaselines = novoDiretorioTemp();
  {
    // T1: baseline canonica valida -> load PASS
    const caminhoValida = escreverBaselineJson(dirBaselines, {
      version: 1, generatedAt: '2026-09-08T12:00:00.000Z', sourceFile: 'x.xls', sourceSha256: 'abc123',
      uniqueTransactionCount: 3, ids: ['1', '2', '3'],
    });
    const resultado1 = carregarBaseline({ caminho: caminhoValida });
    todosPassaram &= check('T1. baseline canonica valida -> valida=true', resultado1.valida === true && resultado1.idsArray.length === 3);

    // T2: baseline com ID duplicado -> BLOCK_BASELINE_INVALIDA
    const caminhoDup = escreverBaselineJson(dirBaselines, {
      version: 1, generatedAt: 'x', sourceFile: 'x.xls', sourceSha256: 'abc123',
      uniqueTransactionCount: 3, ids: ['1', '2', '2'],
    });
    const resultado2 = carregarBaseline({ caminho: caminhoDup });
    todosPassaram &= check('T2. baseline com ID duplicado -> invalida (ID_BASELINE_DUPLICADO)', resultado2.valida === false && resultado2.motivo === 'ID_BASELINE_DUPLICADO');

    // T3: count declarado incorreto -> BLOCK_BASELINE_INVALIDA
    const caminhoCountErrado = escreverBaselineJson(dirBaselines, {
      version: 1, generatedAt: 'x', sourceFile: 'x.xls', sourceSha256: 'abc123',
      uniqueTransactionCount: 99, ids: ['1', '2', '3'],
    });
    const resultado3 = carregarBaseline({ caminho: caminhoCountErrado });
    todosPassaram &= check('T3. count declarado != array -> invalida (UNIQUE_TRANSACTION_COUNT_DIVERGENTE_DO_ARRAY)', resultado3.valida === false && resultado3.motivo === 'UNIQUE_TRANSACTION_COUNT_DIVERGENTE_DO_ARRAY');

    // T4: baseline vazia -> BLOCK_BASELINE_INVALIDA
    const caminhoVazia = escreverBaselineJson(dirBaselines, {
      version: 1, generatedAt: 'x', sourceFile: 'x.xls', sourceSha256: 'abc123',
      uniqueTransactionCount: 0, ids: [],
    });
    const resultado4 = carregarBaseline({ caminho: caminhoVazia });
    todosPassaram &= check('T4. baseline vazia -> invalida (IDS_BASELINE_VAZIO_OU_AUSENTE)', resultado4.valida === false && resultado4.motivo === 'IDS_BASELINE_VAZIO_OU_AUSENTE');

    // Extras de robustez
    const semArquivo = carregarBaseline({ caminho: path.join(dirBaselines, 'nao-existe.json') });
    todosPassaram &= check('Extra - arquivo ausente -> invalida (ARQUIVO_BASELINE_AUSENTE)', semArquivo.valida === false && semArquivo.motivo === 'ARQUIVO_BASELINE_AUSENTE');

    const jsonQuebrado = path.join(dirBaselines, 'quebrado.json');
    fs.writeFileSync(jsonQuebrado, '{ nao e json valido');
    const resultadoQuebrado = carregarBaseline({ caminho: jsonQuebrado });
    todosPassaram &= check('Extra - JSON corrompido -> invalida (JSON_BASELINE_INVALIDO)', resultadoQuebrado.valida === false && resultadoQuebrado.motivo === 'JSON_BASELINE_INVALIDO');

    // Confirma que o arquivo REAL de producao (se existir neste checkout) e valido segundo as mesmas regras.
    if (fs.existsSync(CAMINHO_BASELINE_PADRAO)) {
      const baselineReal = carregarBaseline({});
      todosPassaram &= check('Extra - baseline REAL de producao passa na propria validacao fail-closed', baselineReal.valida === true);
      todosPassaram &= check('Extra - baseline REAL tem 4885 IDs unicos (valor homologado HARDENING 2E)', baselineReal.idsArray.length === 4885);
    } else {
      console.log('AVISO - SERVICO/baseline-transacoes-conhecidas.json nao encontrado neste checkout - pulando checagem extra contra a baseline real.');
    }
  }

  // ==================== T9-T14: avaliarEscopoAmplo isolando cada sinal ====================
  console.log('\n=== T9-T14. avaliarEscopoAmplo: isolar cada sinal com overrides de teste ===');
  {
    const baselineFake = { valida: true, idsArray: ['100', '200', '300'], ids: new Set(['100', '200', '300']) };
    const overridesFrouxos = { rowCountFloor: 3, minTransactionIdLimite: 1000, oldestOccurredAtLimite: '2099-01-01T00:00:00.000', ancorasObrigatorias: [] };

    // T9: CURRENT contem todos baseline IDs + IDs novos -> PASS
    const vendasT9 = [vn('100', '2026-01-01T00:00:00'), vn('200', '2026-01-01T00:00:00'), vn('300', '2026-01-01T00:00:00'), vn('999', '2026-01-01T00:00:00')];
    const r9 = avaliarEscopoAmplo(Object.assign({ vendasNormalizadas: vendasT9, baseline: baselineFake }, overridesFrouxos));
    todosPassaram &= check('T9. baseline completa + ID novo extra -> PASS', r9.resultado === 'PASS');

    // T10: falta exatamente 1 baseline ID -> BLOCK
    const vendasT10 = [vn('100', '2026-01-01T00:00:00'), vn('200', '2026-01-01T00:00:00')]; // falta '300'
    const r10 = avaliarEscopoAmplo(Object.assign({ vendasNormalizadas: vendasT10, baseline: baselineFake }, overridesFrouxos));
    todosPassaram &= check('T10. falta exatamente 1 ID da baseline -> BLOCK_ESCOPO_INCOMPLETO', r10.resultado === 'BLOCK_ESCOPO_INCOMPLETO' && r10.missingBaselineCount === 1 && r10.missingBaselineSample.includes('300'));

    // T11: rowCount < floor mesmo com baseline (pequena/fake) satisfeita -> BLOCK
    const vendasT11 = [vn('100', '2026-01-01T00:00:00'), vn('200', '2026-01-01T00:00:00'), vn('300', '2026-01-01T00:00:00')];
    const r11 = avaliarEscopoAmplo({ vendasNormalizadas: vendasT11, baseline: baselineFake, rowCountFloor: 500, minTransactionIdLimite: 1000, oldestOccurredAtLimite: '2099-01-01T00:00:00.000', ancorasObrigatorias: [] });
    todosPassaram &= check('T11. rowCount abaixo do piso mesmo com baseline satisfeita -> BLOCK', r11.resultado === 'BLOCK_ESCOPO_INCOMPLETO' && r11.motivo.includes('ROW_COUNT_ABAIXO_DO_PISO'));

    // T12: minTransactionId acima do limite -> BLOCK
    const vendasT12 = [vn('100', '2026-01-01T00:00:00'), vn('200', '2026-01-01T00:00:00'), vn('300', '2026-01-01T00:00:00')];
    const r12 = avaliarEscopoAmplo(Object.assign({ vendasNormalizadas: vendasT12, baseline: baselineFake, rowCountFloor: 3, oldestOccurredAtLimite: '2099-01-01T00:00:00.000', ancorasObrigatorias: [] }, { minTransactionIdLimite: 50 }));
    todosPassaram &= check('T12. minTransactionId (100) acima do limite (50) -> BLOCK', r12.resultado === 'BLOCK_ESCOPO_INCOMPLETO' && r12.motivo.includes('MIN_TRANSACTION_ID_ACIMA_DO_LIMITE'));

    // T13: oldestOccurredAt recente demais -> BLOCK
    const vendasT13 = [vn('100', '2026-01-01T00:00:00'), vn('200', '2026-06-01T00:00:00'), vn('300', '2026-06-01T00:00:00')];
    const r13 = avaliarEscopoAmplo({ vendasNormalizadas: vendasT13, baseline: baselineFake, rowCountFloor: 3, minTransactionIdLimite: 1000, oldestOccurredAtLimite: '2021-01-01T00:00:00.000', ancorasObrigatorias: [] });
    todosPassaram &= check('T13. oldestOccurredAt (2026) mais recente que o limite (2021) -> BLOCK', r13.resultado === 'BLOCK_ESCOPO_INCOMPLETO' && r13.motivo.includes('OLDEST_OCCURRED_AT_RECENTE_DEMAIS'));

    // T14: ancora ausente -> BLOCK
    const vendasT14 = [vn('100', '2020-01-01T00:00:00'), vn('200', '2020-01-01T00:00:00'), vn('300', '2020-01-01T00:00:00')];
    const r14 = avaliarEscopoAmplo({ vendasNormalizadas: vendasT14, baseline: baselineFake, rowCountFloor: 3, minTransactionIdLimite: 1000, oldestOccurredAtLimite: '2021-01-01T00:00:00.000', ancorasObrigatorias: ['555'] });
    todosPassaram &= check('T14. ancora obrigatoria (#555) ausente -> BLOCK', r14.resultado === 'BLOCK_ESCOPO_INCOMPLETO' && r14.motivo.includes('ANCORA_AUSENTE') && r14.anchorsMissing.includes('555'));

    // Baseline invalida propaga BLOCK_BASELINE_INVALIDA (nao BLOCK_ESCOPO_INCOMPLETO)
    const rInvalida = avaliarEscopoAmplo({ vendasNormalizadas: vendasT9, baseline: { valida: false, motivo: 'TESTE_FORCADO' } });
    todosPassaram &= check('Extra - baseline invalida -> BLOCK_BASELINE_INVALIDA (categoria propria)', rInvalida.resultado === 'BLOCK_BASELINE_INVALIDA' && rInvalida.motivo === 'TESTE_FORCADO');
  }

  // ==================== T5-T8: simulacao contra XLS reais (EXPORTADOS/) ====================
  console.log('\n=== T5-T8. Simulacao real contra XLS reais de EXPORTADOS/ (se presentes neste checkout) ===');
  const EXPORTADOS_DIR = path.join(__dirname, '..', 'EXPORTADOS');
  function simularArquivoReal(nomeArquivo) {
    const caminho = path.join(EXPORTADOS_DIR, nomeArquivo);
    if (!fs.existsSync(caminho)) return null;
    const buffer = fs.readFileSync(caminho);
    const { linhas } = lerExportVendas(buffer, { nomeArquivo });
    const vendasNormalizadas = linhas.map((l) => normalizarVendaNex(l));
    const baseline = carregarBaseline({});
    return avaliarEscopoAmplo({ vendasNormalizadas, baseline });
  }

  {
    const r5 = simularArquivoReal('vendas-auto-20260908-092926.xls');
    if (r5) {
      todosPassaram &= check('T5. vendas-auto-20260908-092926.xls (4893 linhas, export amplo real homologado) -> PASS', r5.resultado === 'PASS');
    } else {
      console.log('AVISO - T5 pulado: arquivo real nao encontrado em EXPORTADOS/ neste checkout.');
    }

    const r6 = simularArquivoReal('vendas-auto-20260908-092219.xls');
    if (r6) {
      todosPassaram &= check('T6. vendas-auto-20260908-092219.xls (19 linhas, "caixa atual") -> BLOCK_ESCOPO_INCOMPLETO', r6.resultado === 'BLOCK_ESCOPO_INCOMPLETO' && r6.missingBaselineCount > 4000);
    } else {
      console.log('AVISO - T6 pulado: arquivo real nao encontrado em EXPORTADOS/ neste checkout.');
    }

    const r7 = simularArquivoReal('Exportar-venda-30-08.xls');
    if (r7) {
      todosPassaram &= check('T7. Exportar-venda-30-08.xls (~4878 linhas, export amplo mais antigo) -> BLOCK (falta baseline mais nova)', r7.resultado === 'BLOCK_ESCOPO_INCOMPLETO' && r7.missingBaselineCount > 0);
      console.log('   T7 missingBaselineCount exato =', r7.missingBaselineCount);
    } else {
      console.log('AVISO - T7 pulado: arquivo real nao encontrado em EXPORTADOS/ neste checkout.');
    }

    const r8 = simularArquivoReal('vendas-auto-20260902-164021.xls');
    if (r8) {
      todosPassaram &= check('T8. vendas-auto-20260902-164021.xls (~4883 linhas) -> BLOCK (falta baseline mais nova)', r8.resultado === 'BLOCK_ESCOPO_INCOMPLETO' && r8.missingBaselineCount > 0);
      console.log('   T8 missingBaselineCount exato =', r8.missingBaselineCount);
    } else {
      console.log('AVISO - T8 pulado: arquivo real nao encontrado em EXPORTADOS/ neste checkout.');
    }
  }

  // ==================== T15-T18: short-circuit real via BootstrapIntegracaoNex ====================
  console.log('\n=== T15-T18. Scope BLOCK -> short-circuit real (DATE_GATE/anti-replay/checkpoint/outbox nunca chamados) ===');
  {
    const dir = novoDiretorioTemp();
    const dbPath = path.join(dir, 'db.db');
    const estado = new EstadoBootstrapSqlite(dbPath);
    const outbox = new OutboxLocal(dbPath);
    const checkpoint = new CheckpointSqlite(dbPath);
    const orq = new OrquestradorIntegracaoNex({ outbox, checkpoint });

    // Baseline FAKE exigindo um ID que a fixture pequena NUNCA tera -> garante BLOCK_ESCOPO_INCOMPLETO real.
    const caminhoBaselineFake = escreverBaselineJson(dir, {
      version: 1, generatedAt: 'x', sourceFile: 'x.xls', sourceSha256: 'abc',
      uniqueTransactionCount: 1, ids: ['999999'],
    });
    const boot = new BootstrapIntegracaoNex({ estado, orquestrador: orq, diretorioExports: dir, caminhoBaselineEscopo: caminhoBaselineFake });

    escrever(dir, 'clientes.xls', bufferClientesFixture());
    const bufferPequeno = construirXlsBuffer([VENDAS_HEADER, linhaVenda('70001', '9/8/26', '10:00')]);
    const caminhoVendas = escrever(dir, 'vendas-pequeno.xls', bufferPequeno);

    await boot.executarDryRun('2026-09-01T00:00:00');
    await boot.confirmarBaseline('2026-09-01T00:00:00');
    await boot.aprovar();

    // Espioes read-only sobre os pontos que DATE_GATE/anti-replay/checkpoint/outbox tocariam.
    const chamadasAntiReplay = [];
    const avaliarOriginal = estado.avaliarEventoContraBaseline.bind(estado);
    estado.avaliarEventoContraBaseline = async (eventId, contentHash) => { chamadasAntiReplay.push(eventId); return avaliarOriginal(eventId, contentHash); };

    const chamadasCheckpoint = [];
    const eventoJaConfirmadoOriginal = checkpoint.eventoJaConfirmado.bind(checkpoint);
    checkpoint.eventoJaConfirmado = async (eventId, contentHash) => { chamadasCheckpoint.push(eventId); return eventoJaConfirmadoOriginal(eventId, contentHash); };

    const chamadasOutboxEnqueue = [];
    const enqueueOriginal = outbox.enqueue.bind(outbox);
    outbox.enqueue = async (evento) => { chamadasOutboxEnqueue.push(evento.eventId); return enqueueOriginal(evento); };

    const chamadasProcessarArquivo = [];
    const processarArquivoOriginal = orq.processarArquivo.bind(orq);
    orq.processarArquivo = async (caminho, opcoes) => { chamadasProcessarArquivo.push({ caminho, opcoes }); return processarArquivoOriginal(caminho, opcoes); };

    const relatorio = await boot.processarArquivoOperacional(caminhoVendas);

    todosPassaram &= check('Scope realmente bloqueou (pre-condicao do teste)', relatorio.scopeGate && relatorio.scopeGate.resultado === 'BLOCK_ESCOPO_INCOMPLETO');
    todosPassaram &= check('T15/T17. scope BLOCK -> orquestrador.processarArquivo() NUNCA chamado (short-circuit antes do dry-run interno, cobre DATE_GATE+checkpoint+outbox de uma vez)', chamadasProcessarArquivo.length === 0);
    todosPassaram &= check('T16. scope BLOCK -> anti-replay (avaliarEventoContraBaseline) nunca chamado', chamadasAntiReplay.length === 0);
    todosPassaram &= check('T17b. scope BLOCK -> checkpoint.eventoJaConfirmado nunca chamado', chamadasCheckpoint.length === 0);
    todosPassaram &= check('T18. scope BLOCK -> outbox.enqueue nunca chamado (zero eventos)', chamadasOutboxEnqueue.length === 0);
    todosPassaram &= check('T18b. relatorio.enfileirados vazio', relatorio.enfileirados.length === 0);

    estado.fechar(); outbox.fechar(); checkpoint.fechar();
  }

  // ==================== T19-T20: PASS -> DATE_GATE/checkpoint continuam funcionando ====================
  console.log('\n=== T19-T20. Scope PASS -> DATE_GATE e checkpoint continuam funcionando normalmente por baixo ===');
  {
    const dir = novoDiretorioTemp();
    const dbPath = path.join(dir, 'db.db');
    const estado = new EstadoBootstrapSqlite(dbPath);
    const outbox = new OutboxLocal(dbPath);
    const checkpoint = new CheckpointSqlite(dbPath);
    const orq = new OrquestradorIntegracaoNex({ outbox, checkpoint });

    // Baseline FAKE minima (so 1 ID), sinais estaticos frouxos - a fixture
    // deste teste E a propria "baseline ampla" para efeitos de scope, mas
    // contem DELIBERADAMENTE uma venda antiga (antes de DATA_OPERACIONAL_MINIMA)
    // para provar que o DATE_GATE, por baixo do scope guard, continua ativo.
    const idBaseline = '80001';
    const caminhoBaselineFake = escreverBaselineJson(dir, {
      version: 1, generatedAt: 'x', sourceFile: 'x.xls', sourceSha256: 'abc',
      uniqueTransactionCount: 1, ids: [idBaseline],
    });
    const boot = new BootstrapIntegracaoNex({
      estado, orquestrador: orq, diretorioExports: dir, caminhoBaselineEscopo: caminhoBaselineFake,
      scopeGuardOverrides: { rowCountFloor: 1, minTransactionIdLimite: 999999, oldestOccurredAtLimite: '2099-01-01T00:00:00.000', ancorasObrigatorias: [] },
    });

    escrever(dir, 'clientes.xls', bufferClientesFixture());
    const bufferMisto = construirXlsBuffer([
      VENDAS_HEADER,
      linhaVenda(idBaseline, '9/1/26', '10:00'), // ANTES de DATA_OPERACIONAL_MINIMA (2026-09-07) -> deve ser bloqueado pelo DATE_GATE
      linhaVenda('80002', '9/9/26', '11:00'), // dentro da janela -> deve seguir fluxo normal
    ]);
    const caminhoVendas = escrever(dir, 'vendas-misto.xls', bufferMisto);

    await boot.executarDryRun('2026-01-01T00:00:00');
    await boot.confirmarBaseline('2026-01-01T00:00:00');
    await boot.aprovar();

    const chamadasCheckpoint = [];
    const eventoJaConfirmadoOriginal = checkpoint.eventoJaConfirmado.bind(checkpoint);
    checkpoint.eventoJaConfirmado = async (eventId, contentHash) => { chamadasCheckpoint.push(eventId); return eventoJaConfirmadoOriginal(eventId, contentHash); };

    const relatorio = await boot.processarArquivoOperacional(caminhoVendas);

    todosPassaram &= check('Pre-condicao: scope PASS neste teste', !relatorio.scopeGate);
    todosPassaram &= check(`T19. venda #${idBaseline} (antes da janela operacional) -> BLOCK_ANTIGO (DATE_GATE continua ativo por baixo do scope guard)`, relatorio.bloqueadosPorDataOperacional.includes(`SALE_PAID:NEX:${idBaseline}`));
    todosPassaram &= check('T19b. #80002 (dentro da janela) -> enfileirado normalmente', relatorio.enfileirados.includes('SALE_PAID:NEX:80002'));
    todosPassaram &= check('T20. checkpoint.eventoJaConfirmado foi chamado para #80002 (checkpoint continua no caminho normal)', chamadasCheckpoint.includes('SALE_PAID:NEX:80002'));

    estado.fechar(); outbox.fechar(); checkpoint.fechar();
  }

  // ==================== T21: logs nao vazam baseline inteira/secrets ====================
  console.log('\n=== T21. Logs nunca vazam a baseline inteira nem secrets ===');
  {
    const dir = novoDiretorioTemp();
    const dbPath = path.join(dir, 'db.db');
    const estado = new EstadoBootstrapSqlite(dbPath);
    const outbox = new OutboxLocal(dbPath);
    const checkpoint = new CheckpointSqlite(dbPath);
    const orq = new OrquestradorIntegracaoNex({ outbox, checkpoint });

    const idsGrandes = Array.from({ length: 50 }, (_, i) => String(1000 + i));
    const caminhoBaselineGrande = escreverBaselineJson(dir, {
      version: 1, generatedAt: 'x', sourceFile: 'x.xls', sourceSha256: 'abc',
      uniqueTransactionCount: idsGrandes.length, ids: idsGrandes,
    });

    const chamadasLogger = [];
    const logger = {
      debug: (c, e, d) => chamadasLogger.push({ nivel: 'DEBUG', c, e, d }),
      info: (c, e, d) => chamadasLogger.push({ nivel: 'INFO', c, e, d }),
      warn: (c, e, d) => chamadasLogger.push({ nivel: 'WARN', c, e, d }),
      error: (c, e, d) => chamadasLogger.push({ nivel: 'ERROR', c, e, d }),
    };

    const boot = new BootstrapIntegracaoNex({
      estado, orquestrador: orq, diretorioExports: dir, caminhoBaselineEscopo: caminhoBaselineGrande, logger,
    });
    escrever(dir, 'clientes.xls', bufferClientesFixture());
    const bufferPequeno = construirXlsBuffer([VENDAS_HEADER, linhaVenda('1', '9/8/26', '10:00')]);
    const caminhoVendas = escrever(dir, 'vendas.xls', bufferPequeno);

    await boot.executarDryRun('2026-01-01T00:00:00');
    await boot.confirmarBaseline('2026-01-01T00:00:00');
    await boot.aprovar();
    await boot.processarArquivoOperacional(caminhoVendas);

    let vazouListaCompleta = false;
    for (const chamada of chamadasLogger) {
      const serializado = JSON.stringify(chamada.d || {});
      // A baseline fake tem 50 IDs "10xx" - se a lista INTEIRA vazasse, o
      // JSON serializado conteria todos os 50 IDs consecutivos. Verifica
      // que nenhum campo logado e um array com mais de 20 elementos
      // (mesmo limite de amostra usado em missingBaselineSample).
      for (const valor of Object.values(chamada.d || {})) {
        if (Array.isArray(valor) && valor.length > 20) vazouListaCompleta = true;
      }
      if (serializado.includes('secret') || serializado.includes('NEX_PRIME_INTEGRATION_SECRET')) vazouListaCompleta = true;
    }
    todosPassaram &= check('T21. nenhuma chamada de log contem array com mais de 20 elementos nem menciona secret', !vazouListaCompleta);
    todosPassaram &= check('T21b. pelo menos 1 evento de log de escopo foi emitido (confirma que o teste exercitou o caminho certo)', chamadasLogger.some((c) => c.e && c.e.startsWith('ESCOPO_AMPLO')));

    estado.fechar(); outbox.fechar(); checkpoint.fechar();
  }

  // ==================== T22: baseline V1 nunca e atualizada automaticamente ====================
  console.log('\n=== T22. Guard estrutural: nenhum caminho de codigo escreve na baseline ===');
  {
    const fonteGuard = fs.readFileSync(require.resolve('../SERVICO/broad-scope-guard-nex.js'), 'utf8');
    const fonteBootstrap = fs.readFileSync(require.resolve('../SERVICO/bootstrap-integracao-nex.js'), 'utf8');
    const padraoEscrita = /writeFileSync|fs\.writeFile\(|createWriteStream/;
    todosPassaram &= check('T22. broad-scope-guard-nex.js nunca escreve arquivo (so le)', !padraoEscrita.test(fonteGuard));
    todosPassaram &= check('T22b. bootstrap-integracao-nex.js nunca escreve na baseline (nenhuma chamada de escrita perto de "baseline")', !/baseline[\s\S]{0,80}(writeFileSync|createWriteStream)/i.test(fonteBootstrap) && !/(writeFileSync|createWriteStream)[\s\S]{0,80}baseline/i.test(fonteBootstrap));
  }

  console.log('\n' + (todosPassaram ? 'TODOS OS TESTES PASSARAM' : 'HA TESTES QUE FALHARAM'));
  process.exitCode = todosPassaram ? 0 : 1;
}

main().catch((erro) => {
  console.error('Erro inesperado no teste:', erro);
  process.exitCode = 1;
});
