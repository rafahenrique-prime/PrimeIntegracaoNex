namespace PrimeNexExportAgent.Tests.Fakes;

/// <summary>
/// Spy compartilhado entre todos os fakes de um teste - registra a ORDEM
/// real das chamadas entre interfaces diferentes (F6.13 secao 14: provar
/// sequencia, nao so contagem). Cada fake recebe a mesma instancia de
/// CallSpy no construtor do teste.
/// </summary>
public sealed class CallSpy
{
    private readonly List<string> _calls = new();

    public IReadOnlyList<string> Calls => _calls;

    public void Record(string name) => _calls.Add(name);

    public int CountOf(string name) => _calls.Count(c => c == name);

    /// <summary>Confirma que `before` aparece antes de `after` na sequencia
    /// registrada (falha se algum dos dois nunca foi chamado).</summary>
    public bool Before(string before, int beforeOccurrence, string after, int afterOccurrence)
    {
        int beforeIndex = IndexOfOccurrence(before, beforeOccurrence);
        int afterIndex = IndexOfOccurrence(after, afterOccurrence);
        if (beforeIndex < 0 || afterIndex < 0) return false;
        return beforeIndex < afterIndex;
    }

    private int IndexOfOccurrence(string name, int occurrence)
    {
        int seen = 0;
        for (int i = 0; i < _calls.Count; i++)
        {
            if (_calls[i] == name)
            {
                seen++;
                if (seen == occurrence) return i;
            }
        }
        return -1;
    }
}
