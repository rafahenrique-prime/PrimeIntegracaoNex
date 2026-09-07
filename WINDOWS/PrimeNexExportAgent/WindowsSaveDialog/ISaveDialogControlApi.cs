namespace PrimeNexExportAgent.WindowsSaveDialog;

/// <summary>
/// Fronteira mockavel, semantica e restrita para operar controles do
/// dialogo "Salvar como" (F6.14B2, ampliada em F6.14B2.2, corrigida em
/// F6.14B2.8). Nunca expoe SendMessage/PostMessage genericos - cada
/// metodo tem um proposito unico e documentado. Escrita real e restrita a
/// exatamente 2 pontos: SetEditText (usado SOMENTE no Edit filho do 1148,
/// via WM_SETTEXT) e TrySelectComboBoxItemExact (usado SOMENTE no 1136) -
/// nunca no 1137.
///
/// F6.14B2.8 - CORRECAO: ReadDialogFilePath/ReadDialogFolderPath (via
/// CDM_GETFILEPATH/CDM_GETFOLDERPATH, mensagens >= WM_USER sem
/// marshalling automatico cross-process - ver auditoria F6.14B2.7) foram
/// REMOVIDAS PERMANENTEMENTE. SetEditText/ReadEditText (WM_SETTEXT/
/// WM_GETTEXT, ambas < WM_USER, com marshalling automatico documentado)
/// sao agora o UNICO mecanismo de escrita/releitura do Edit do 1148.
/// </summary>
public interface ISaveDialogControlApi
{
    /// <summary>GetDlgItem(dialogHwnd, ctrlId) - retorna 0 se ausente.</summary>
    nint GetControl(nint dialogHwnd, int ctrlId);

    /// <summary>TODOS os descendentes (filhos, netos, etc. - subarvore
    /// inteira) de uma janela, via EnumChildWindows nativo (F6.14B2.3 -
    /// corrigido apos evidencia real mostrar que o Edit do CtrlId 1148 e
    /// NETO do ComboBoxEx32, nao filho direto: ComboBoxEx32 -> ComboBox ->
    /// Edit). NUNCA filtrar o resultado por "GetParent(h) == parentHwnd" -
    /// isso reintroduziria a regressao de F6.14B2.2 (exigiria filho
    /// IMEDIATO e descartaria o Edit real). A seguranca vem de FILTRAR POR
    /// CLASSNAME + CARDINALIDADE depois de chamar este metodo (ver
    /// FileNameEditResolver), nunca de limitar a profundidade da busca.</summary>
    IReadOnlyList<nint> GetDescendants(nint containerHwnd);

    /// <summary>IsWindowEnabled(controlHwnd).</summary>
    bool IsControlEnabled(nint controlHwnd);

    /// <summary>ACAO: escreve o texto do Edit via WM_SETTEXT (F6.14B2.8 -
    /// substitui SetWindowText). Usada EXCLUSIVAMENTE no Edit filho real do
    /// CtrlId 1148 - nunca no ComboBoxEx32 container, nunca em 1137/1136.
    /// Uma unica tentativa, zero retry.</summary>
    bool SetEditText(nint editHwnd, string value);

    /// <summary>Releitura do texto do Edit via WM_GETTEXTLENGTH+WM_GETTEXT
    /// (F6.14B2.8 - substitui GetWindowText/CDM_GETFILEPATH). Usada
    /// EXCLUSIVAMENTE no Edit filho real do CtrlId 1148, no ReadBack.
    /// Retorna null se a mensagem falhar - tratado fail-closed pelo
    /// chamador, nunca como "deve estar ok".</summary>
    string? ReadEditText(nint editHwnd);

    /// <summary>Quantidade de itens de um ComboBox (CB_GETCOUNT) - somente
    /// leitura/diagnostico.</summary>
    int GetComboItemCount(nint comboHwnd);

    /// <summary>Texto do item de indice `index` de um ComboBox
    /// (CB_GETLBTEXT) - somente leitura/diagnostico.</summary>
    string? GetComboItemText(nint comboHwnd, int index);

    /// <summary>Texto do item atualmente selecionado de um ComboBox
    /// (CB_GETCURSEL + CB_GETLBTEXT) - a forma correta de ler o valor
    /// efetivo de um ComboBox nao-editavel (F6.14B2.1: GetWindowText nao
    /// funciona para isso). Retorna null se nada estiver selecionado ou a
    /// consulta falhar.</summary>
    string? GetSelectedComboItemText(nint comboHwnd);

    /// <summary>ACAO: localiza (CB_FINDSTRINGEXACT) e seleciona
    /// (CB_SETCURSEL) o item de um ComboBox cujo texto seja EXATAMENTE
    /// `value` (comparacao nao-sensível a maiusculas/minusculas, conforme
    /// o proprio CB_FINDSTRINGEXACT). Retorna false se nenhum item exato
    /// for encontrado OU se CB_SETCURSEL falhar - NUNCA ha fallback para
    /// WriteControlText (F6.14B2.1).</summary>
    bool TrySelectComboBoxItemExact(nint controlHwnd, string value);

    /// <summary>ACAO: envia BM_CLICK (F6.14B2.9A) ao HWND de um Button -
    /// EXCLUSIVAMENTE usada pelo probe diagnostico isolado sobre o CtrlId 1
    /// (Salvar) ja validado. Deliberadamente SEM semantica de "salvou com
    /// sucesso": este metodo representa somente o DISPATCH da unica
    /// tentativa da acao - a mensagem sendo processada pelo Windows nao e
    /// prova de que o arquivo foi salvo. A prova real vem exclusivamente do
    /// sistema de arquivos (IExportStageWatcher), nunca do retorno desta
    /// chamada. NUNCA exposta por ISaveDialogController.ClickSave() (que
    /// continua lancando NotSupportedException incondicionalmente).</summary>
    void ClickButton(nint buttonHwnd);
}
