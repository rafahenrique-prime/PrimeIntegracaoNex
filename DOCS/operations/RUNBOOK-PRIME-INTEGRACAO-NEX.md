# RUNBOOK OPERACIONAL — PrimeIntegracaoNex

> Documento operacional. Baseado exclusivamente no comportamento real implementado e homologado no repositório `PrimeIntegracaoNex` (branch `main`). Nenhum valor de secret é incluído em nenhum ponto deste documento.

---

## 1. Visão geral

Fluxo oficial:

```
NEX → export oficial (.xls) → PrimeIntegracaoNex → PRIME COBRANÇAS (Base44) → futuro espelhamento no IGNITE PRIME
```

- O NEX **não** envia diretamente ao IGNITE PRIME.
- O `PrimeIntegracaoNex` envia exclusivamente ao **PRIME COBRANÇAS** (Base44), via HTTP.
- O MCP **não** faz parte do transporte financeiro automático — nenhum módulo de produção deste transporte depende de MCP.
- O transporte oficial é **HTTP para uma backend function** (`webhookNex`), autenticado por HMAC. Não há transporte via `.nx1` nem acesso direto ao banco do NEX.

---

## 2. O que é automático hoje

- **Serviço Windows** (`PrimeIntegracaoNex`), gerenciado por **NSSM**, com **inicialização automática atrasada** (Delayed Auto Start) e **restart automático** do processo Node em caso de queda (`AppExit Default=Restart`).
- **Secret** (`NEX_PRIME_INTEGRATION_SECRET`) carregado automaticamente pelo processo via `AppEnvironmentExtra` do NSSM — nenhuma digitação manual no startup do serviço.
- **Detector de exports** (`SERVICO/detector-exports-nex.js`): observa a pasta de exports, aguarda estabilidade do arquivo (tamanho/mtime parados) e dispara processamento por hash de conteúdo novo (nunca por nome/mtime isolado).
- **Processamento**: leitura → normalização → resolução de cliente → geração de eventos → gate de envio — todo o pipeline de domínio já homologado, reaproveitado sem alteração pelo orquestrador (`SERVICO/orquestrador-integracao-nex.js`).
- **Outbox local** (`SERVICO/outbox-local.js`, SQLite): fila persistente de eventos com máquina de estados (seção 7).
- **Retry automático** para falhas transitórias (seção 8), com backoff persistido em disco (sobrevive a restart).
- **Checkpoint local** (`SERVICO/checkpoint-sqlite.js`): registra o resultado confirmado de cada evento, via upsert — nunca perde nem duplica esse registro entre reinícios.
- **Idempotência** por `eventId`+`contentHash`, tanto local (outbox/checkpoint) quanto remota (Base44).
- **Logs estruturados** (JSONL, `SERVICO/logger-estruturado.js`), com rotação e sanitização de campos sensíveis.
- **Recuperação após restart/reboot**: itens `SENDING` órfãos são reclassificados no startup (`outbox.recuperarOrfaos()`); a outbox/checkpoint retomam exatamente do ponto onde pararam, sem reprocessar histórico já confirmado.

---

## 3. O que NÃO é automático hoje

**A geração do export oficial do NEX ainda é manual.**

O serviço detecta e processa o arquivo `.xls` **depois** que ele aparece na pasta observada — mas não interage com o NEX para gerá-lo. O operador continua responsável por, dentro do NEX, gerar e salvar o export oficial de Vendas (e, quando necessário, o export de Clientes e o extrato individual de transações) na pasta observada.

Isso impede classificar o fluxo atual como 100% *unattended* — é automação a partir do momento em que o arquivo existe, não automação de ponta a ponta desde a operação no NEX.

---

## 4. Serviço Windows

Configuração real, homologada em F5.2A-C/F5.3/F5.4:

| Campo | Valor |
|---|---|
| Service Name | `PrimeIntegracaoNex` |
| Display | `PRIME - Integração NEX` |
| Application | `C:\Program Files\nodejs\node.exe` |
| Arguments | `C:\Nex\PrimeIntegracaoNex\SCRIPTS\rodar-integracao-nex.js` |
| AppDirectory | `C:\Nex\PrimeIntegracaoNex` |
| Startup | Automatic (Delayed Start) |
| Process manager | NSSM |
| Conta atual | `LocalSystem` |
| Restart automático | `AppExit Default=Restart`, `AppThrottle=5000ms`, `AppRestartDelay=10000ms` |
| Parada graciosa | `AppStopMethodConsole=20000ms` (SIGINT simulado, mesmo handler do processo) |

A conta `LocalSystem` é aceitável no estado atual; uma conta de serviço dedicada com privilégios mínimos é um **item de hardening futuro**, não uma pendência bloqueante.

---

## 5. Secret

- Nome: `NEX_PRIME_INTEGRATION_SECRET`
- Locais onde este secret existe: **Base44** (configuração do backend) e **NSSM** (`AppEnvironmentExtra` do serviço `PrimeIntegracaoNex`).
- **O valor nunca é incluído em nenhum relatório, log, commit ou documento deste projeto.**

Regras operacionais:
- O serviço carrega o secret automaticamente no startup — o operador nunca digita nada na inicialização normal.
- Qualquer rotação deve ser **coordenada nos dois lados** (Base44 e NSSM) — nunca alterar apenas um lado.
- Após qualquer rotação, validar com **um evento controlado** antes de considerar a rotação concluída (ver seção 21).
- **Não usar `nssm dump`/`nssm get AppEnvironmentExtra` em relatórios ou logs** — esse comando exibe o valor em texto puro para quem tiver acesso ao terminal.
- Administradores do Windows com acesso a uma sessão elevada podem, por natureza do NSSM, ler esse valor — isso é uma limitação conhecida e aceita do mecanismo atual (ver seção 23 sobre hardening futuro).

---

## 6. Endpoint

```
POST https://primecobrancas.base44.app/functions/webhookNex
```

- `origin`: `prime-store-udi-nex-01`
- Assinatura: **HMAC-SHA256** sobre `"${timestamp}.${rawBody}"`, com o secret como chave (confirmado em `SERVICO/repositorio-eventos-http.js`).
- `timestamp`: milissegundos desde epoch (`Date.now()`), enviado no header `X-Nex-Timestamp`.
- Janela de aceitação do backend: **±5 minutos** — depende do relógio do Windows estar sincronizado via NTP (ver incidente histórico documentado na seção 15/24).
- Assinatura enviada no header `X-Nex-Signature`.

Nenhum valor de secret é incluído aqui.

---

## 7. Estados da outbox

Confirmado em `SERVICO/outbox-local.js`:

| Estado | Significado |
|---|---|
| `PENDING` | Evento gerado pelo pipeline, aguardando envio. |
| `SENDING` | Em voo — marcado antes do POST, numa transação já confirmada. |
| `SENT` | Confirmado com sucesso (`CREATED`/`UNCHANGED`/`UPDATED` — todos tratados como sucesso idempotente). |
| `REVIEW_STORED` | Confirmado como armazenado para revisão manual no Base44 (evento com `sourceStatus:REVIEW_REQUIRED`). |
| `RETRY` | Falha transitória, aguardando a próxima tentativa (backoff persistido). |
| `REJECTED` | Rejeitado pelo backend (ex.: HTTP 400) — não reprocessado automaticamente. |
| `FAILED` | Esgotou as tentativas automáticas, ou erro técnico permanente (HTTP 401, comprovado; HTTP 403, esperado pela política mas não homologado — ver seção 8) — **terminal**, requer intervenção manual explícita para reabrir. |

Transições permitidas (matriz real do código): `PENDING→SENDING`, `RETRY→SENDING`, `SENDING→{SENT, REVIEW_STORED, RETRY, REJECTED, FAILED}`, e a única saída de um estado terminal: `FAILED→PENDING` (exclusivamente via o mecanismo da seção 9).

---

## 8. Retry

- Falhas transitórias (rede, timeout, HTTP 5xx) geram `RETRY`, com backoff exponencial persistido na própria outbox:
  - `maxTentativas: 5`
  - `backoffBaseMs: 30000` (30s)
  - `backoffFatorExponencial: 2`
  - `backoffMaxMs: 240000` (4min, teto)
- HTTP `401` **nunca** gera retry automático — vai direto para `FAILED`. Tem tratamento **dedicado** em `interpretarResposta()` (`SERVICO/repositorio-eventos-http.js`), confirmado em produção real durante o incidente de autenticação (seção 15/24).
- HTTP `403` está incluído em `HTTP_STATUS_TERMINAL_SEM_RETRY` no processador (`SERVICO/processador-outbox-nex.js`), mas **não possui branch dedicado** em `interpretarResposta()` — diferente de `401`/`400`. No contrato esperado, um `403` sem um corpo `results[]` válido cai no fallback genérico de "contrato inesperado", que produz `result:'ERROR'`, e por isso termina em `FAILED` sem retry. Este é o comportamento **esperado pela política atual**, não um caso homologado — **nunca ocorreu em produção real**.
- Ao esgotar `maxTentativas`, o item também vai para `FAILED`.
- `FAILED` é terminal até uma recuperação administrativa explícita (seção 9) — nunca é reclamado automaticamente pelo processador (`claimNext()` só seleciona `PENDING`/`RETRY`).

---

## 9. Recuperação manual de eventos FAILED

CLI oficial: [`SCRIPTS/reabrir-evento-failed.js`](../../SCRIPTS/reabrir-evento-failed.js)

Fluxo obrigatório:

```
BEFORE (exibido pelo próprio CLI, sem payload)
  → verificação do evento (existe? está FAILED? eventType permitido?)
  → motivo obrigatório (não vazio)
  → confirmação exata: digitar "REABRIR"
  → FAILED → PENDING
  → o serviço (se RUNNING) processa normalmente no próximo ciclo do processador
```

Regras (impostas pelo próprio código, fail-closed):
- **Um evento por execução** — sem lote, sem wildcard.
- Só reabre itens hoje em `FAILED`.
- `eventType` precisa estar na allowlist de tipos liberados para automação (`EVENT_TYPES_LIBERADOS_PARA_ENVIO_AUTOMATICO`, importada diretamente do orquestrador — nunca duplicada).
- Sem chamada HTTP direta, sem escrita direta no checkpoint — a reabertura só move `FAILED→PENDING`; o próprio processador já em execução cuida do reenvio.
- `payload`/`contentHash`/`eventId`/`tentativas` são preservados — nunca resetados ou recriados.
- O serviço pode permanecer `RUNNING` durante a operação (SQLite em modo WAL suporta a concorrência).

Exemplo conceitual (placeholders, nunca um evento real fixo):

```bash
node SCRIPTS\reabrir-evento-failed.js --eventId "<EVENT_ID>" --motivo "<MOTIVO>" --operador "<OPERADOR>"
```

---

## 10. REVIEW_REQUIRED

Um evento com `sourceStatus:REVIEW_REQUIRED` **não deve ser promovido localmente** para outro status — a decisão de resolver o cliente cabe ao backend/operação manual, nunca a uma heurística automática deste código.

Resultado remoto esperado (confirmado em produção real, casos `#15768`/`#15769`):

```
HTTP 200
result: REVIEW_STORED
```

Sem nenhuma aplicação financeira automática — não há consumer financeiro para esse resultado no lado local. O cliente não resolvido continua pendente de revisão humana no Base44.

---

## 11. Idempotência

Confirmado por homologação real e pelo contrato já usado pelo repositório HTTP:

| Situação | Resultado |
|---|---|
| Mesmo `origin`/`eventId` + mesmo `contentHash` | `UNCHANGED` |
| Mesmo `origin`/`eventId` + `contentHash` diferente | `UPDATED` |
| Evento novo normal | `CREATED` |
| Evento novo com `sourceStatus:REVIEW_REQUIRED` | `REVIEW_STORED` |

`CREATED`/`UNCHANGED`/`UPDATED` são todos tratados como sucesso local (`SENT`) — só o log distingue qual foi.

---

## 12. Bootstrap / baseline

Estados de `EstadoBootstrapSqlite` (`SERVICO/estado-bootstrap-sqlite.js`):

```
NOT_STARTED → DRY_RUN → BASELINED → APPROVED
```

- `NOT_STARTED`: nenhum bootstrap rodado ainda.
- `DRY_RUN`: pipeline rodado sobre os exports existentes, sem nenhum POST, só para dimensionar o histórico.
- `BASELINED`: um cutoff (`BOOTSTRAP_CUTOFF`) foi definido e o histórico anterior a ele foi marcado como baseline (nunca enviado).
- `APPROVED`: estado operacional real — o runner só inicia o processamento automático se o estado for exatamente `APPROVED` (fail-closed, verificado no startup).

O runner **se recusa a iniciar** se `status !== APPROVED` — não tenta avançar o bootstrap sozinho.

---

## 13. Logs

- Formato: **JSON Lines** (`SERVICO/logger-estruturado.js`), um objeto por linha.
- Rotação: diária, com retenção configurável (default do módulo).
- Sanitização: campos como `secret`/`hmac`/`token` são removidos recursivamente antes de logar — nunca aparecem em texto puro no log estruturado.
- Nunca logados: secret, assinatura HMAC completa, payload de cliente sensível.
- Em troubleshooting, procurar por: `RUNNER_INICIADO`, `RUNNER_PARADO`, eventos de erro por `eventId`.
- O CLI de recuperação manual (`SCRIPTS/reabrir-evento-failed.js`, seção 9) usa `console.log`/`console.error` diretos, não o `LoggerEstruturado` — exibe BEFORE/AFTER sem payload na própria saída do terminal. Hoje **não existe** um evento estruturado dedicado no `LoggerEstruturado` para essa autorização manual. A execução pode ser observada: (a) pela saída de console no momento em que o operador roda o comando; (b) pelos efeitos persistidos na própria outbox (`status`, `ultimo_erro`, `updated_at` do item reaberto); (c) se o CLI for executado num contexto cujo stdout/stderr seja capturado pela infraestrutura de logs do serviço (ex.: redirecionado pelo NSSM), essa saída fica registrada ali — mas isso depende de como o CLI é invocado, não é um evento JSONL garantido por padrão.
- `stdout`/`stderr` do processo (banners de startup, exceções antes do logger estar pronto) são redirecionados pelo NSSM para arquivos próprios (`LOGS/nssm-stdout.log`/`nssm-stderr.log`, com rotação por tamanho).

---

## 14. Procedimento de troubleshooting

### A. Serviço parado
- Verificar: `Get-Service PrimeIntegracaoNex`.
- Não fazer: reiniciar repetidamente sem checar o log de erro anterior.
- Escalar se: o serviço não sobe após um `Start-Service` limpo com o log mostrando erro de configuração (endpoint/origin/secret ausente, diretório de exports inacessível, índice de clientes indisponível).

### B. Export não detectado
- Verificar: se o arquivo está na pasta correta observada pelo detector; se o arquivo parou de ser escrito (detector só processa arquivo estável); logs do detector por hash já conhecido (arquivo com mesmo conteúdo de um já processado não gera novo evento — não é bug).
- Não fazer: copiar o arquivo várias vezes tentando forçar detecção.
- Escalar se: um arquivo genuinamente novo (hash novo) não aparece nos logs após alguns minutos.

### C. Evento em RETRY
- Verificar: `ultimoErro` do item, `tentativas`, `next_attempt_at` — é esperado que fique nesse estado até o backoff vencer.
- Não fazer: reabrir manualmente (o mecanismo da seção 9 é só para `FAILED`, não `RETRY` — `RETRY` já é reclamado automaticamente).
- Escalar se: o item chegar a `maxTentativas` (5) e virar `FAILED`.

### D. Evento em FAILED
- Verificar: `ultimoErro`, `httpStatus` — geralmente `401`/`403` ou esgotamento de tentativas.
- Não fazer: reabrir sem antes confirmar a causa raiz (ver E/F/G abaixo) — reabrir sem corrigir a causa reproduz o mesmo erro.
- Escalar/agir: usar o CLI da seção 9, **um evento por vez**, só depois de confirmar que a causa foi corrigida.

### E. HTTP 401
- Ver seção 15 — procedimento específico.

### F. HTTP 403
- Verificar: `403` está na mesma lista de status terminais do processador (`HTTP_STATUS_TERMINAL_SEM_RETRY`), então **por política** também vai direto a `FAILED`, sem retry. Diferente de `401`, o Repository HTTP (`interpretarResposta()`) **não tem um branch dedicado** para `403` — o resultado terminal depende do corpo da resposta não trazer um `results[]` válido (fallback de "contrato inesperado"). Este cenário **nunca foi observado em produção real**.
- Não fazer: reenviar em massa; não assumir que este caso já foi validado como o `401` foi.
- Escalar: tratar como possível erro de autorização (permissão, não credencial) e revisar manualmente a resposta real recebida (corpo/headers) antes de qualquer ação — por não haver homologação prévia deste caso específico, uma investigação mais cuidadosa que a do `401` é recomendada.

### G. HTTP 5xx
- Verificar: já é tratado automaticamente como falha transitória — o item deve ir para `RETRY` sozinho.
- Não fazer: intervir manualmente enquanto ainda há tentativas automáticas restantes.
- Escalar se: 5xx persistente por muitas tentativas (indica indisponibilidade real e prolongada do backend, não uma falha pontual).

### H. REVIEW_STORED
- Verificar: é o resultado esperado e correto para `sourceStatus:REVIEW_REQUIRED` — não é um erro.
- Não fazer: tentar "promover" o evento localmente para forçar reenvio como se fosse um erro.
- Escalar: a resolução do cliente (matching manual) é uma decisão administrativa no Base44, fora deste código.

### I. Divergência outbox↔checkpoint
- Verificar: rodar `auditarConsistencia()` (função já existente em `SERVICO/bootstrap-integracao-nex.js`) — reporta divergências em nível `WARN` no startup, sem bloquear o serviço.
- Não fazer: editar SQLite manualmente para "corrigir" a divergência.
- Escalar: ver seção 17 — hoje não existe auto-repair; é uma decisão pendente de política.

### J. Restart inesperado
- Verificar: Event Log do Windows (`Get-WinEvent`) para distinguir reboot manual de reboot forçado por atualização; logs do serviço para confirmar `itensRecuperados` no novo `runId`.
- Não fazer: assumir duplicação sem antes checar `auditarConsistencia()` e a contagem da outbox — o mecanismo de `recuperarOrfaos()` já foi homologado para cobrir exatamente esse cenário.
- Escalar se: `itensRecuperados` maior que zero de forma inesperada, ou qualquer HTTP disparado imediatamente após o restart sem um export novo.

---

## 15. HTTP 401 — lição do incidente real

Confirmado por incidente real (F5.5): 401 é **terminal** — vai direto para `FAILED`, sem retry. Este procedimento é **comprovado por homologação em produção**, não apenas por leitura de código.

Procedimento:
1. **Não reenviar em massa.**
2. Validar o secret dos dois lados (Base44 e NSSM) — sem nunca comparar/expor o valor em texto.
3. Corrigir a autenticação (restaurar o valor correto, ou rotacionar coordenadamente — ver seção 21).
4. Homologar a correção com **1 evento** antes de qualquer outra ação.
5. **Só depois**, reabrir manualmente os demais eventos `FAILED`, **um de cada vez** (seção 9), nunca em lote.

**Nota sobre HTTP 403**: o mesmo procedimento serve como ponto de partida razoável para um `403` real, mas esse caso **nunca ocorreu em produção** e o Repository HTTP não tem tratamento dedicado para ele (ver seção 8/14F) — tratar qualquer `403` real como um caso novo a investigar com mais cautela, não como uma repetição já validada do incidente de `401`.

---

## 16. Ordem operacional de testes/ações reais

Regra fixa usada em todo o projeto:

```
CLAUDE BEFORE → ação controlada → aguardar processamento → CLAUDE AFTER
```

**Nunca executar várias recuperações/ações reais simultaneamente.** Cada ação real (rotação de secret, reabertura de `FAILED`, teste de retry) é isolada e auditada antes/depois, uma de cada vez.

---

## 17. Consistência outbox ↔ checkpoint

Honestamente, hoje:
- Outbox e checkpoint são **conexões SQLite separadas** sobre o mesmo arquivo `.db`.
- `auditarConsistencia()` (em `SERVICO/bootstrap-integracao-nex.js`) **detecta** divergências (ex.: item `SENT` sem checkpoint correspondente) e loga em `WARN` no startup.
- **Não existe auto-repair.** A decisão de investigar/corrigir uma divergência é sempre manual, revisando os logs.
- Uma política definitiva de reconciliação de longo prazo **ainda está pendente** — não fingir que está resolvida.

---

## 18. Exportação oficial do NEX — GAP OPERACIONAL ATUAL

**`PrimeIntegracaoNex` não gera o export do NEX.**

O operador ainda precisa gerar/salvar manualmente o export oficial (Vendas, e quando necessário Clientes/extrato individual) na pasta observada pelo detector.

Este é um dos principais itens restantes antes de considerar a automação verdadeiramente 100% *unattended*.

---

## 19. Checklist diário

- [ ] Serviço `PrimeIntegracaoNex` = `RUNNING`
- [ ] `FAILED` = 0 (ou cada item explicado/em tratamento)
- [ ] `RETRY` = 0, ou justificado por indisponibilidade temporária conhecida
- [ ] `auditarConsistencia()` = sem divergências, ou divergências já conhecidas e explicadas
- [ ] Logs recentes sem erro crítico não tratado
- [ ] Exports chegando normalmente na pasta observada

---

## 20. Checklist após reboot

- [ ] Serviço `RUNNING`
- [ ] Processo `node.exe` existe com `ParentProcessId` apontando para um processo `nssm.exe`
- [ ] Varredura inicial (startup scan) concluída nos logs
- [ ] Zero replay indevido (nenhum evento histórico já baselinado gerou novo HTTP)
- [ ] Outbox e checkpoint preservados (contagens batem com o estado anterior ao reboot)

---

## 21. Checklist após rotação de secret

- [ ] Serviço parado antes de qualquer alteração (evita janela de credenciais desencontradas)
- [ ] Base44 atualizado com o novo valor
- [ ] NSSM (`AppEnvironmentExtra`) atualizado com o **mesmo** novo valor
- [ ] Serviço reiniciado
- [ ] Evento controlado testado (reenvio de 1 evento real ou novo evento pequeno) → HTTP 200
- [ ] Só depois, se houver eventos `FAILED` pendentes de uma falha de auth anterior, seguir a recuperação manual (seção 9), um de cada vez

---

## 22. Git / versionamento

- Repositório: `PrimeIntegracaoNex`
- Branch: `main`
- Checkpoint atual (no momento da redação deste runbook): `904ae722e82d71ddb86f9c2a8aac6ca596c269cd`

Nenhuma credencial é ou deve ser versionada — `.env`, `OUTPUT/*.db` e `LOGS/` estão fora do controle de versão (`.gitignore`).

---

## 23. Pendências conhecidas

- Política definitiva de reconciliação outbox ↔ checkpoint (seção 17).
- Automação da geração do export oficial do NEX (seção 18) — ainda manual.
- Monitoramento/heartbeat externo do serviço — não implementado.
- Conta de serviço dedicada (hoje `LocalSystem`) — hardening futuro, não bloqueante.
- Remediação histórica de `#15762`/`#15763`/`#15765` (eventos antigos afetados por um defeito de índice de clientes já corrigido) — decisão administrativa ainda pendente, separada do incidente de autenticação já encerrado.

---

## 24. Evidências de homologação (resumo, sem PII)

- `SALE_PAID` normal → `CREATED`/`SENT` (múltiplas homologações reais).
- Evento com `sourceStatus:REVIEW_REQUIRED` → `REVIEW_STORED` (nunca aplicação financeira automática).
- Retry transitório real: falha de transporte → `RETRY` com backoff persistido → sobrevivência a restart → sucesso posterior → `SENT`.
- Restart automático via NSSM: processo morto à força → NSSM reinicia sozinho, sem intervenção humana, zero replay/duplicação.
- Reboot real do Windows: dois reboots reais observados (manual + forçado por atualização), Delayed Auto Start cobriu ambos, zero replay.
- Secret rotacionado coordenadamente (Base44 + NSSM), validado com evento real.
- Recuperação manual de `FAILED`: mecanismo dedicado e auditável, homologado com 3 eventos reais (`#15768`, `#15769`, `#15770`), todos alcançando o estado terminal correto.
- `FAILED` global reduzido a zero após a recuperação, com regressão completa (50/50 suítes) mantida em todos os checkpoints.
