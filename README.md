# PrimeIntegracaoNex

POC para validar a viabilidade de alimentar o PRIME Cobranças a partir das exportações oficiais (.xls) do sistema NEX.

## Decisões já tomadas

- Não há acesso ao banco interno do NEX (.nx1) — fora de escopo deste projeto.
- Não é usado o NexAdmin nem qualquer ferramenta de leitura direta do NexusDB.
- Fonte de dados exclusiva: arquivos exportados pelo próprio NEX (menu de exportação para Excel).
- Nenhuma integração real, sincronização ou automação é feita nesta fase — apenas leitura, normalização e geração de um JSON de exemplo.

## Estrutura

- `EXPORTADOS/` — cópias dos arquivos .xls exportados pelo NEX que serão processados.
- `PROCESSADOS/` — arquivos já processados/importados (uso futuro).
- `SRC/` — código-fonte (Node.js).
- `OUTPUT/` — JSONs e relatórios gerados pela POC.
- `LOGS/` — logs de execução da POC.
- `DOCS/` — anotações técnicas e decisões do projeto.

## Fases planejadas

1. Leitor de arquivos Excel
2. Normalização dos dados
3. Geração de JSON padronizado
4. Importação para o PRIME Cobranças (fora do escopo desta POC)
