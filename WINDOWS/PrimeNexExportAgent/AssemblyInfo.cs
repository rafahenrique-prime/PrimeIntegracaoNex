using System.Runtime.CompilerServices;

// F6.14B2.9C - permite ao projeto de testes offline acessar tipos/membros
// internal (ex.: ConfigureSaveDialogClickSaveOnceProbe.RunCore e
// ClickSaveProbeOutcome) para testar a orquestracao do probe com fakes
// injetados, sem expor nada disso publicamente fora do assembly. Nao
// afeta nenhum comportamento de producao - so relaxa visibilidade em
// tempo de compilacao para o assembly de teste nomeado explicitamente.
[assembly: InternalsVisibleTo("PrimeNexExportAgent.Tests")]
