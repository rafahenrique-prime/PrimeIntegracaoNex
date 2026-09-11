namespace PrimeNexExportAgent.WindowsNative;

/// <summary>Handle opaco de um elemento MSAA - vale SOMENTE dentro da
/// chamada sincrona que o obteve (HitTest). NUNCA e' armazenado em um
/// tipo de resultado que atravesse a fronteira entre componentes
/// (OverflowMenuResult/ExportTriggerResult nao carregam isto) - cada
/// componente que precisa acionar MSAA sempre chama HitTest de novo.</summary>
public sealed class MsaaElementHandle
{
    internal object AccessibleObject { get; }
    internal object ChildId { get; }

    internal MsaaElementHandle(object accessibleObject, object childId)
    {
        AccessibleObject = accessibleObject;
        ChildId = childId;
    }
}

/// <summary>
/// Fronteira mockavel para MSAA (oleacc.dll) - usada por
/// INexOverflowMenuOpener (validar os 3 itens do popup, somente leitura)
/// e por INexExportTrigger (reencontrar e acionar "Exportar lista de
/// transacoes", unica operacao de acao desta interface).
/// </summary>
public interface IMsaaAccessibilityApi
{
    /// <summary>AccessibleObjectFromPoint no ponto fisico informado
    /// (com SetThreadDpiAwarenessContext(UNAWARE) already aplicado
    /// internamente pela implementacao real - achado necessario nesta
    /// investigacao), ou null se nada for encontrado.</summary>
    MsaaElementHandle? HitTest(int screenX, int screenY);

    /// <summary>Scheduler V2 - AccessibleObjectFromWindow(hWnd,
    /// OBJID_CLIENT) seguido de accHitTest DIRETAMENTE no IAccessible
    /// retornado (nunca AccessibleObjectFromPoint/hit-test de desktop) -
    /// imune a oclusao por outra janela em primeiro plano. Usado para
    /// localizar "Todas vendas" na barra da aba Historico e "Exportar"
    /// dentro do popup TdxBarSubMenuControl, ambos com o NexAdmin em
    /// background. `screenX`/`screenY` permanecem em coordenadas de TELA
    /// (accHitTest exige isso mesmo operando sobre um objeto ancorado a
    /// um HWND especifico - comportamento documentado da API MSAA).
    /// Retorna null se AccessibleObjectFromWindow falhar ou accHitTest nao
    /// encontrar nada nesse ponto (VT_EMPTY).</summary>
    MsaaElementHandle? HitTestWithinWindow(nint hWnd, int screenX, int screenY);

    string? GetName(MsaaElementHandle element);
    int GetRole(MsaaElementHandle element);
    int GetState(MsaaElementHandle element);

    /// <summary>accLocation (correcao pos-Probe 13A) - usado para compor o
    /// fingerprint semantico de deduplicacao de candidatos MSAA (nunca
    /// identidade por ponteiro COM - AccessibleObjectFromPoint pode
    /// retornar interfaces distintas para o mesmo elemento logico,
    /// conforme documentacao oficial). Retorna null se a chamada COM
    /// falhar.</summary>
    (int left, int top, int width, int height)? GetLocation(MsaaElementHandle element);

    /// <summary>Descricao textual estavel do childId (pvarChild) do
    /// elemento - parte do fingerprint de deduplicacao (correcao
    /// pos-Probe 13A). Nunca expõe o VARIANT bruto para fora desta
    /// fronteira.</summary>
    string DescribeChildId(MsaaElementHandle element);

    /// <summary>accDoDefaultAction - UNICA operacao de acao desta
    /// interface. Retorna true se a chamada COM nao lancou excecao.</summary>
    bool DoDefaultAction(MsaaElementHandle element);
}
