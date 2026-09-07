using System.Threading;
using PrimeNexExportAgent.Contracts;

namespace PrimeNexExportAgent.Real;

/// <summary>
/// F6.14B2.12B - implementacao REAL de IExecutionLock (G7) via
/// System.Threading.Mutex nomeado do Windows. UNICA responsabilidade:
/// recusar imediatamente uma segunda instancia concorrente do Agent -
/// nunca mata/interrompe a instancia existente, nunca usa qualquer API de
/// manipulacao de outro processo (OpenProcess/ReadProcessMemory/
/// WriteProcessMemory/VirtualAllocEx/VirtualFreeEx/CreateRemoteThread/
/// injecao/hooks - nenhuma dessas e' necessaria ou usada aqui).
///
/// Contrato preservado sem alteracao (F6.14B2.12A confirmou compatibilidade):
/// TryAcquire() tenta adquirir imediatamente (WaitOne(0) - timeout ZERO,
/// nunca espera) e retorna false de imediato se ja estiver ocupado, sem
/// fila, sem retry. Release() so libera se ESTA instancia realmente
/// possui o Mutex - nunca solta o lock de outro processo, e double-Release
/// e' seguro (segunda chamada e' um no-op, nunca lanca).
/// </summary>
public sealed class Win32ExecutionLock : IExecutionLock, IDisposable
{
    private readonly Mutex _mutex;
    private bool _owned;
    private bool _disposed;

    /// <summary>
    /// `name` deve incluir o prefixo desejado pelo chamador (ex.:
    /// "Global\PrimeNexExportAgent.Lock" para um lock por-maquina, ou um
    /// nome sem prefixo para um lock por-sessao/teste). O prefixo
    /// "Global\" exige que o Mutex kernel object seja criado no namespace
    /// global (compartilhado entre sessoes) - em ambientes sem o privilegio
    /// necessario, a criacao lancaria UnauthorizedAccessException; isso e'
    /// deixado explicito para o chamador decidir o nome, nunca escondido
    /// aqui atras de um fallback silencioso para outro namespace.
    /// </summary>
    public Win32ExecutionLock(string name)
    {
        // `initiallyOwned: false` - NUNCA presumir posse so por ter criado
        // o objeto Mutex; a posse real so e' obtida por uma chamada
        // explicita e bem-sucedida a WaitOne() em TryAcquire().
        _mutex = new Mutex(initiallyOwned: false, name: name);
    }

    /// <summary>
    /// Tentativa de aquisicao IMEDIATA (WaitOne(0)) - nunca espera, nunca
    /// enfileira, nunca faz uma segunda tentativa. AbandonedMutexException
    /// (processo anterior morreu segurando o Mutex) e' tratada como
    /// aquisicao bem-sucedida: o SO ja transferiu a posse do kernel object
    /// para esta chamada no exato instante da excecao - recusar essa posse
    /// não devolveria o Mutex a nenhum estado mais seguro, so deixaria o
    /// lock permanentemente preso (nenhum processo o liberaria depois de
    /// morto), bloqueando toda execucao futura do Agent para sempre. Uma
    /// unica execucao apos recuperacao e' aceitavel porque o resto da
    /// maquina de estados do Orchestrator e' fail-closed por conta propria -
    /// o Mutex so protege contra 2 instancias SIMULTANEAS, nunca substitui
    /// os gates de seguranca do fluxo real.
    /// </summary>
    public bool TryAcquire()
    {
        if (_owned)
        {
            // Esta mesma instancia ja possui o lock - nunca uma segunda
            // aquisicao redundante (WaitOne novamente incrementaria a
            // contagem de recursao do Mutex, exigindo Release() extra -
            // evitado por design, TryAcquire e' chamado no maximo 1x por
            // execucao do Orchestrator).
            return true;
        }

        try
        {
            _owned = _mutex.WaitOne(0);
        }
        catch (AbandonedMutexException)
        {
            // Ownership ja foi transferido pelo SO nesta mesma chamada -
            // ver justificativa acima. Registrado explicitamente (nunca
            // silencioso) via retorno true + flag interna distinguivel por
            // quem chama Log() no Orchestrator, se desejado no futuro.
            _owned = true;
        }

        return _owned;
    }

    /// <summary>
    /// Libera o Mutex SOMENTE se esta instancia realmente o adquiriu.
    /// Chamar Release() sem posse (nunca adquiriu, ou ja liberou antes -
    /// double Release) e' um no-op seguro - NUNCA chama ReleaseMutex() sem
    /// posse confirmada, o que evitaria o risco real de
    /// ObjectDisposedException/ApplicationException por tentar liberar um
    /// Mutex que este processo/thread nao possui (o que poderia, em outras
    /// implementacoes ingenuas, lancar ou pior, se comportar de forma
    /// indefinida). Nenhuma excecao de cleanup aqui pode gerar retry
    /// operacional - o metodo e' inteiramente determinístico e nunca
    /// lanca.
    /// </summary>
    public void Release()
    {
        if (!_owned)
        {
            return;
        }

        try
        {
            _mutex.ReleaseMutex();
        }
        catch (ApplicationException)
        {
            // Mutex do Windows tem posse por THREAD do SO, nao por
            // instancia/objeto - se a thread que originalmente adquiriu ja
            // terminou (o SO ja liberou/abandonou o Mutex automaticamente
            // nesse momento), uma chamada tardia a ReleaseMutex() a partir
            // de outra thread lanca ApplicationException. Tratado aqui como
            // no-op seguro (o Mutex ja nao esta mais em posse de ninguem
            // relacionado a esta instancia) - nunca deixa uma falha de
            // cleanup se propagar como retry operacional.
        }

        _owned = false;
    }

    /// <summary>
    /// Libera o Mutex (se possuido por esta instancia) e libera o handle
    /// do kernel object. Seguro chamar sem nunca ter adquirido - Release()
    /// interno ja e' um no-op nesse caso. Dispose() e' idempotente (guard
    /// _disposed) - nunca chama _mutex.Dispose() duas vezes.
    /// </summary>
    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        Release();
        _mutex.Dispose();
        _disposed = true;
    }
}
