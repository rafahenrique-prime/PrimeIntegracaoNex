using System.IO;
using PrimeNexExportAgent.Contracts;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// Implementacao REAL (F6.14B2.11A) de IFileMover - `File.Move`, sem
/// nenhuma opcao de overwrite. Se o destino ja existir, o .NET ja lanca
/// IOException por si so - isso e' exatamente o comportamento fail-closed
/// desejado, nunca contornado com Copy+Delete ou qualquer outro fallback.
/// </summary>
public sealed class Win32FileMover : IFileMover
{
    public void Move(string sourcePath, string destinationPath) => File.Move(sourcePath, destinationPath);
}
