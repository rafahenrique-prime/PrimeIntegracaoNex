# Fase 4A — Arquitetura da Persistência

> Documento de arquitetura. Nenhum código de persistência foi criado nesta fase.

## 1. Arquitetura proposta

Quatro camadas, cada uma com uma responsabilidade única:

| Camada | Conhece tecnologia de storage? | Contém regra de negócio? | Estado atual |
|---|---|---|---|
| **Domínio** (`SRC/`) | Não | Sim (toda ela) | Já existe, pronta (Fases 2A-2E) |
| **Serviço/Orquestração** | Não (só conhece a interface do Repository) | Não (só orquestra) | Parcialmente misturada em `SERVICO/servidor-local.js` |
| **Repository** (interface) | Não (é a interface) | Não | Não existe ainda |
| **Persistência** (implementação do Repository) | Sim — é a única camada que pode | Não | Não existe ainda (proposital) |

Princípio central: só a implementação concreta do Repository pode saber se o destino é Base44, Supabase ou outro. Nenhuma outra camada pode ter um `require`/import de SDK de backend.

## 2. Diagrama de responsabilidades

```
WEB/ (interface - Fase 3A/3B)
  upload, revisao visual, (futuro: botao Importar)
        |  HTTP
SERVICO/ (adapters + orquestracao)
  HTTP adapter (servidor-local.js)
     -> ServicoImportacao (NOVO - extrair de servidor-local.js)
     -> ServicoSincronizacao (NOVO)
        |
SRC/ (dominio - Fases 2A-2E, INTOCADO)
  parser-financeiro -> parser-observacoes -> normalizar-clientes
  -> validar-normalizados -> simular-importacao
  comparar-clientes -> executar-plano-importacao
        |
REPOSITORY (interface, NOVO) - RepositorioClientes
  buscarTodos() / buscarPorNexCodigo() / salvarLote()
        |
  (implementacao escolhida DEPOIS)
  RepositorioMemoria (referencia/teste) | RepositorioBase44 (futuro) | RepositorioSupabase (futuro)
```

## 3. Fluxo completo mapeado aos módulos

| Etapa | Módulo responsável | Situação |
|---|---|---|
| NEX -> Planilha | `EXPORTADOS/*.xls` | existe |
| Leitura | `XLSX.read` hoje embutido em `servidor-local.js` | deveria virar parte do `ServicoImportacao` |
| Normalização | `SRC/normalizar-clientes.js` | pronto, reutilizado sem mudança |
| Validação | `SRC/validar-normalizados.js` | pronto, reutilizado sem mudança |
| Simulação | `SRC/simular-importacao.js` | pronto, reutilizado sem mudança |
| Revisão | `WEB/` (Fase 3B) | pronto - humano decide antes de persistir |
| Persistência | Repository (NOVO) | não existe - objeto desta fase |
| Sincronização futura | `SRC/comparar-clientes.js` + `SRC/executar-plano-importacao.js` | já prontos, já desacoplados de storage |

## 4. Interface sugerida para o Repository

```
RepositorioClientes
  buscarTodos()                    -> Promise<PrimeCliente[]>   // = BASE_ATUAL
  buscarPorNexCodigo(nex_codigo)   -> Promise<PrimeCliente|null>
  salvarLote(clientes)             -> Promise<void>              // = persistir nova_base
```

Decisões de design:
- Todos os métodos retornam `Promise`, mesmo hoje tudo sendo síncrono em memória, porque qualquer backend real será assíncrono.
- Sem lógica de negócio dentro do Repository - isso é 100% do domínio (`SRC/`).
- Injeção de dependência, não `require` direto - mesmo padrão já usado em `executar-plano-importacao.js` (Fase 2E) para `geradorPrimeId`/`dataExecucao`.

## 5. Módulos existentes reutilizáveis sem alteração

Todos os 8 módulos de `SRC/` - nenhuma mudança necessária. `comparar-clientes.js` e `executar-plano-importacao.js` já recebem `BASE_ATUAL` como argumento simples, ou seja, já são persistence-agnostic.

`WEB/` também é reutilizável como está - só vai ganhar um botão "Importar" numa fase futura.

## 6. Módulos futuros necessários

- `SERVICO/repositorio-clientes.js` - contrato/interface + implementação de referência em memória.
- `SERVICO/servico-importacao.js` - extrai a orquestração leitura->normalização->validação->simulação do handler HTTP.
- `SERVICO/servico-sincronizacao.js` - orquestra `Repository.buscarTodos()` -> `comparar-clientes` -> `executar-plano-importacao` -> `Repository.salvarLote()`.
- (Fora do escopo agora) `REPOSITORIO/repositorio-base44.js`, `repositorio-supabase.js` etc.

## 7. Riscos arquiteturais

1. `BASE_ATUAL` hoje é sempre fictícia nos testes - primeiro uso real expõe o caso "primeira sincronização, base vazia" pela primeira vez fora de teste.
2. Vazamento de acoplamento se a disciplina de "só o adapter concreto conhece o backend" não for mantida.
3. Concorrência/atomicidade de `salvarLote` não modelada ainda.
4. Geração de `prime_id` - hoje determinística só para teste; em produção depende de quem atribui o ID.
5. Tamanho de payload (1.386 registros completos em JSON já são alguns MB) - pode exigir lotes menores dependendo do backend.

## 8. Dívidas técnicas atuais

1. `SERVICO/servidor-local.js` mistura leitura de arquivo + orquestração de negócio + roteamento HTTP numa função só (`tratarAnalisar`).
2. Não existe "lugar canônico" para o estado atual do PRIME - cada teste recria `BASE_ATUAL` manualmente.
3. `precisaRevisaoManual` (Fase 3B) depende de uma regex fixa sobre os avisos de `validar-normalizados.js`, sem teste que force sincronia entre os dois.

Esta fase (4A) não cria nenhuma dívida técnica nova - é só documentação.

## 9. Melhorias recomendadas antes da primeira importação real

1. Implementar `RepositorioClientes` com referência em memória para validar o fluxo completo ponta a ponta antes de escolher backend.
2. Extrair `ServicoImportacao`/`ServicoSincronizacao` do servidor HTTP.
3. Decidir a estratégia de `prime_id` antes de escolher o backend.
4. Definir a semântica de erro de `salvarLote` (atômico vs. parcial) como parte do contrato.
5. Criar teste de regressão para `precisaRevisaoManual` cobrir todos os avisos gerados por `validar-normalizados.js`.

## Auditoria técnica desta fase

- Duplicação de código: nenhuma - fase somente de documentação.
- Separação de responsabilidades: é o objeto da fase; 4 camadas com fronteiras explícitas.
- Reutilização: 100% dos módulos de `SRC/` reaproveitáveis sem alteração.
- Regressões nas fases anteriores: nenhuma - nenhum arquivo de código foi tocado.
- Cobertura de testes: N/A nesta fase; arquitetura já indica onde os próximos testes precisarão existir.
- Riscos conhecidos: listados no item 7 (5 riscos).
- Dívida técnica criada: zero nesta fase; 3 dívidas pré-existentes documentadas (nenhuma nova).
- Melhorias adiáveis: adapters concretos (Base44/Supabase) explicitamente adiados até a decisão de backend.
