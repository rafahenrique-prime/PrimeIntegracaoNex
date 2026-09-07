# NEX Individual Statement Automation — V1 (Homologado)

> Documento de arquitetura e homologação. Registra a arquitetura que **realmente funcionou** em produção real (comprovada contra o NEX), não as hipóteses intermediárias investigadas ao longo do caminho. Nenhum valor de secret é incluído em nenhum ponto deste documento.

---

## 1. Objetivo

Automatizar a obtenção do extrato individual oficial de transações de um cliente no NEX:

```
Clientes → localizar cliente → abrir cadastro → Transações
  → Exportar lista de transações → XLS oficial → validar → publicar em EXPORTADOS
```

A automação **termina** no XLS validado e publicado. Nada além disso.

## 2. Não-escopo

Explicitamente fora da V1:

- Aplicar pagamento
- Ignorar pagamento
- Restaurar pagamento
- Alterar Parcela
- Alterar Venda
- Alterar EventoNex
- Importar automaticamente para Base44
- Escrever em Supabase
- Acessar `.nx1`
- Acessar `CDM_*`
- Acessar o banco interno do NEX (NexusDB) por qualquer via
- Ler memória/process memory do NEX

O princípio **EXPORT-FIRST** (já em vigor para o pipeline de Vendas) permanece obrigatório: a única fonte de dados é o arquivo `.xls` oficial exportado pelo próprio NEX.

## 3. Arquitetura final homologada

Fluxo real, ponta a ponta, comprovado contra o NEX:

```
Clientes
  → WM_SETTEXT(clientCode)
  → settlement 1000ms
  → reacquire do único TcxGridSite visível/válido
  → geometry profile (grid)
  → direct grid PostMessage
  → identity gate (Código/Nome)
  → aba Transações
  → DPI_UNAWARE thread-local no overflow
  → geometry stability (overflow)
  → PostMessage no "..."
  → validar popup
  → scan MSAA
  → deduplicação por fingerprint semântico
  → accDoDefaultAction exatamente 1x
  → Save Dialog (Configure → ReadBack → CommitOnce)
  → file stable
  → validator (RecordCount > 0)
  → atomic publish (EXPORT_STAGE → EXPORTADOS)
```

Cada seta é um gate fail-closed com estado próprio (`AgentStage`), sem aresta de retorno — o mesmo princípio arquitetural já usado no pipeline de Vendas.

## 4. Abertura do cliente — decisão final

**F2 não faz parte do fluxo final.**

Histórico: `WM_SETTEXT` filtrava visualmente o grid corretamente para o cliente buscado (confirmado visualmente, sem qualquer clique/tecla). Porém F2 atuava sobre a seleção *interna* anterior do grid, não sobre a linha visualmente filtrada — em duas execuções reais supervisionadas, F2 abriu o cliente 743 em vez do cliente buscado, de forma consistente e reprodutível.

Solução homologada: reacquire do `TcxGridSite` visível → validar geometria → `PostMessage` direto no ponto client-local calibrado da linha filtrada.

Profile V1 atual (`NexClientsGridOpenProfile`):

| Campo | Valor |
|---|---|
| TFrmPri rect | `(-10,-10,1930,1030)` |
| Grid window rect | `(245,204,1920,1020)` |
| Grid client rect | `(0,0,1675,816)` |
| EditClientPoint | `(83,88)` |

O HWND do grid nunca é cacheado entre chamadas — é sempre reencontrado, filtrado por visibilidade e validado contra o processo alvo antes de qualquer ação. Divergência de geometria: **fail closed**, sem clique.

`F2_USED_BY_INDIVIDUAL_STATEMENT = NO`.

## 5. Identidade do cliente

- `ClientCode` é obrigatório.
- `ExpectedClientName` é obrigatório na V1 (sem esse dado, o navigator não abre nenhum cliente).
- Após abrir a `TFrmCadCli`: o Código deve bater **exatamente**; o Nome deve ter **exatamente uma** correspondência ao `ExpectedClientName` entre os controles relevantes.
- Outros controles `TcxDBTextEdit` (ex.: telefone, DDI) não contam como ambiguidade — a identidade é decidida por correspondência de texto exato, nunca por cardinalidade de campos não-vazios.
- Cliente errado (Código ou Nome não batem): **fail closed**, sem segundo clique, sem retry.

## 6. Search

`WM_SETTEXT` no campo de busca funciona e foi comprovado visualmente filtrando o grid (`Clientes (1)` → cliente correto), sem qualquer F2/clique/Enter.

Settlement V1: **1000ms**.

Honestidade sobre esse número: é uma **calibração temporal** do comportamento assíncrono do grid DevExpress observado nesta máquina — não é uma prova estrutural de que o grid terminou de filtrar. O gate que realmente decide se a automação pode prosseguir é sempre a **identidade pós-abertura** (seção 5), nunca o tempo de espera em si.

## 7. DPI / Overflow — causa raiz e correção

**Causa raiz comprovada em runtime real** (não hipotética): o NEX é `DPI_AWARENESS_UNAWARE`, DPI=96. O Agent C#/WPF herdava, por padrão, um contexto de DPI awareness diferente do processo de calibração original (ferramentas PowerShell, sempre `UNAWARE`).

Medição controlada, mesmo HWND vivo, mesmo instante:

| Contexto do chamador | `GetWindowRect` da `TFrmCadCli` |
|---|---|
| `DPI_AWARENESS_CONTEXT_UNAWARE` | `(0,0,1536,864)` |
| Qualquer contexto DPI-aware (System/PerMonitor/PerMonitorV2) | `(0,0,1920,1080)` |

Fator exato: `1.25` em X e Y — `GetWindowRect` é documentadamente virtualizado por DPI (Microsoft Learn); a mesma janela real, sem nenhuma mudança de geometria, é reportada de forma diferente dependendo unicamente do contexto de DPI da thread chamadora. Essa divergência era a causa direta do `OverflowGeometryMismatch`.

Solução final: `DpiAwarenessScope` — escopo **thread-local**, aplicado **somente** às operações Win32 do fluxo calibrado de overflow (`GetWindowRect`, `WindowFromPhysicalPoint`, `ScreenToClient`, `PostMouseDown`/`PostMouseUp`). Nunca altera o DPI do processo inteiro (`SetProcessDpiAwareness`/`SetProcessDpiAwarenessContext` nunca são chamados) — apenas `SetThreadDpiAwarenessContext` na thread atual, sempre restaurado ao contexto original em `finally`, inclusive em caminho de exceção.

Profile final permanece exatamente o já homologado — **não** foi criado um profile alternativo em pixels físicos:

| Campo | Valor |
|---|---|
| `ExpectedCadCliWindowRect` | `(0,0,1536,864)` |
| `ValidatedOverflowScreenPoint` | `(1489,146)` |

## 8. Geometry stability gate

Uma única leitura de geometria imediatamente após a aba Transações ficar ativa não é suficiente. Parâmetros homologados:

| Parâmetro | Valor |
|---|---|
| `POLL_INTERVAL_MS` | 100 |
| `MAX_GEOMETRY_WAIT_MS` | 1500 |
| `REQUIRED_CONSECUTIVE_MATCHES` | 2 |

Nenhum clique ocorre antes de 2 leituras **consecutivas** batendo com o profile. O polling de geometria é puramente de leitura — não é retry de ação (nenhum `PostMessage` de mouse ocorre durante o gate). Timeout sem estabilização: **fail closed**.

## 9. MSAA do item "Exportar" — deduplicação

Bug real comprovado (Probe 13A): a varredura vertical do popup usa passo de 15px; o botão "Exportar lista de transações" mede 36px de altura. Dois pontos de scan diferentes (Y=242 e Y=257) atingiam o **mesmo** elemento acessível real.

Evidência real: `RAW_EXPORT_HIT_COUNT=2`, mas `UNIQUE_EXPORT_ELEMENT_COUNT=1` — os dois hits tinham fingerprint idêntico (mesmo Name, Role, ChildId e `accLocation`).

Fingerprint de deduplicação usado: `Name + Role + ChildId + accLocation (Left,Top,Width,Height)`. Identidade **nunca** é julgada por ponteiro/referência COM — `AccessibleObjectFromPoint` pode legitimamente retornar interfaces distintas para o mesmo elemento lógico (documentado pela própria Microsoft).

Cardinalidade após deduplicação:

- **0** elementos únicos → `ExportItemNotFound`
- **1** elemento único → `accDoDefaultAction` exatamente 1 vez (sobre um representante MSAA reobtido fresco, nunca o handle do scan)
- **>1** elementos únicos → `ExportItemAmbiguous`, zero ação — nunca "pegar o primeiro"

## 10. Save Dialog / arquivo

A automação reutiliza a **infraestrutura de execução/validação compartilhada** já homologada pelo pipeline de Vendas: Save Dialog (identificar → configurar → readback → `CommitOnce`), watcher de estabilidade de arquivo e publicador atômico (`EXPORT_STAGE` → `EXPORTADOS`).

O que **não** é compartilhado: o extrato individual usa seu próprio contrato de validação, específico para o formato de transações por cliente:

- `SCRIPTS/validar-export-transacoes-cliente.js` (CLI-ponte, mesmo contrato de saída `{"ok":...}` já usado por Vendas)
- `SERVICO/leitor-export-transacoes-cliente.js` (parser já existente, reaproveitado sem alteração)

`RecordCount` deve ser maior que 0 antes de qualquer publicação — um XLS estruturalmente válido mas vazio nunca é publicado.

## 11. Concorrência

Vendas e Individual Statement usam o **mesmo** mutex nomeado:

```
Local\PrimeNexExportAgent.Lock
```

Motivo: ambos operam a mesma sessão/UI global do NexAdmin — o lock protege a UI compartilhada, não "o tipo de exportação". As duas automações nunca podem rodar simultaneamente. Lock indisponível: zero ação contra o NEX.

## 12. Regras fail-closed

- HWND é sempre reencontrado fresco quando a etapa exige (grid, popup, elemento MSAA) — nunca cacheado entre chamadas quando isso importa para a validade da ação.
- Zero retry cego em qualquer estágio.
- Toda ação mutante (clique, tecla, `accDoDefaultAction`, `CommitOnce`) ocorre no máximo 1 vez por estágio.
- Timeout/estado ambíguo → parar, nunca adivinhar.
- `PostMessage`/`SendMessage` retornando sucesso **nunca** é interpretado sozinho como prova de efeito — todo estágio valida o estado real resultante.
- F2 não é usado no fluxo de abertura de cliente.
- Export exatamente uma vez.
- `CommitOnce` exatamente uma vez.
- Um arquivo que aparecer após um estado ambíguo é **preservado**, nunca apagado/sobrescrito automaticamente.
- Nunca escolher o primeiro candidato quando há ambiguidade real.

## 13. Componentes

**Específicos da V1:**

| Componente | Responsabilidade |
|---|---|
| `IndividualStatementExportOrchestrator` | Máquina de estados fim-a-fim, mesma disciplina do `ExportAgentOrchestrator` de Vendas |
| `WindowsNexClientNavigator` | Busca do cliente + abertura via grid + identidade + ativação da aba Transações |
| `WindowsNexOverflowMenuOpener` | Geometry stability gate + clique no "..." + validação do popup |
| `WindowsNexExportTrigger` | Scan MSAA + deduplicação por fingerprint + `accDoDefaultAction` |
| `DpiAwarenessScope` | Escopo thread-local de DPI awareness (entrar/restaurar, fail-closed em NULL) |
| `NexClientsGridOpenProfile` | Calibração geométrica homologada da abertura direta do grid |
| `NexOverflowButtonProfile` | Calibração geométrica homologada do botão "..." |
| `IndividualStatementOnceProbe` | Probe supervisionado one-shot, único caminho de execução real fora de produção |
| `SCRIPTS/validar-export-transacoes-cliente.js` | Contrato de validação específico do extrato individual |

**Compartilhados com Vendas (não modificados nesta Arc):** `Win32ExecutionLock` (lock), pipeline de Save Dialog (`WindowsSaveDialogController`/`WindowsSaveDialogInspector`/`WindowsConfirmedSaveDialogCommitter`), `PollingExportStageWatcher`, `Win32ProcessRunner`, `FileMoveAtomicPublisher`.

## 14. Homologação real

Cliente usado na homologação: **292 / MATHEUS HENRIQUE DEPRE** — este é um dado de **fixture/evidência de homologação**, não um hardcode de produção (a automação real recebe `ClientCode`/`ExpectedClientName` como parâmetros, sempre).

Caminho até o PASS: seis execuções reais supervisionadas anteriores **falharam de modo fail-closed**, cada uma revelando um gap real e específico (F2 abrindo cliente errado; ambiguidade de visibilidade do grid; `OverflowGeometryMismatch` por divergência de contexto DPI; ambiguidade MSAA no item Exportar) — nenhuma delas teve retry cego, e cada gap foi diagnosticado por auditoria read-only antes de qualquer correção de código. Essas seis falhas são evidência de *hardening* do sistema, não six tentativas de sucesso end-to-end.

A **sétima** execução supervisionada foi o primeiro **PASS oficial ponta a ponta**:

| Campo | Valor |
|---|---|
| `EXIT_CODE` | 0 |
| Arquivo publicado | `extrato-cliente-292-20260907-102848.xls` |
| Tamanho | 12288 bytes |
| SHA256 | `e23cbe43ffc4bd0c99d103c4d7a446fa411b477ec36a52201e7428e015a0bca2` |
| `EXPORT_STAGE` após publish | vazio |
| Base44/Supabase/financeiro tocados | Não |

## 15. Testes (estado no fechamento desta Arc)

- **462/462 PASS**, build com **0 erros / 0 avisos**.
- Vendas (`ExportAgentOrchestratorTests`, isolado): **32/32 PASS** — nenhuma regressão.

Categorias cobertas pela suíte (sem listar os 462 testes individualmente):

- Navigator (busca, abertura direta do grid, identidade)
- Visibilidade/geometria do grid (filtragem por visibilidade antes de cardinalidade)
- Identidade do cliente (Código/Nome, ambiguidade, campos não-relevantes)
- Contenção do shared lock (Vendas × Individual Statement)
- `DpiAwarenessScope` (entrar/restaurar, fail-closed em NULL, restauração em exceção)
- Geometry stability do overflow (matches consecutivos, timeout, zero ação antes de estável)
- Deduplicação MSAA (fingerprint idêntico → 1 ação; fingerprint distinto → ambíguo)
- Save Dialog (identificação, configuração, readback)
- Validator (arquivo válido, zero registros, arquivo inválido)
- Publisher atômico
- Orquestração fail-closed (lock ocupado, sessão indisponível, estados intermediários)
- Regressão de Vendas (nenhum estágio/comportamento alterado)

## 16. Limitações da V1

- Os profiles de geometria (`NexClientsGridOpenProfile`, `NexOverflowButtonProfile`) são **calibrados** para a resolução/posição de janela observadas nesta homologação — não são universais.
- Mudança de layout, resolução ou posição relevante da janela do NEX deve causar **fail-closed** e exigir nova homologação manual — não há heurística automática de recalibração.
- O settlement de busca de 1000ms é uma calibração temporal, não uma prova estrutural.
- `ExpectedClientName` é obrigatório nesta V1 (sem ele, a automação não abre nenhum cliente).
- O grid de Clientes permanece estruturalmente opaco a UIA/MSAA — a identidade do cliente só é confirmada **depois** da abertura, nunca antes.
- O fluxo depende inteiramente da UI oficial do NEX (Win32/DevExpress) — não há API oficial subjacente.
- Não há garantia de funcionamento contra uma versão futura do NEX/DevExpress sem nova homologação.
- Não existe import financeiro automático nesta V1 — a automação termina no arquivo publicado.

## 17. Estado final

**STATUS: HOMOLOGADO V1**

Fronteira da automação: XLS oficial validado e publicado em `EXPORTADOS`.

Evolução futura possível — **não implementada nem documentada como existente**: integração do arquivo publicado com o fluxo assistido do Payment Inbox. Isso permanece exclusivamente como direção futura.
