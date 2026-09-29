#requires -Version 5.1
# PRIME NEX Monitor V3 - Fase 1 (presentation-only).
#
# Mesmas leituras, mesmo Overall Status, mesma telemetria e mesmo Guardian da V2
# (PrimeNexMonitor.ps1, que continua intacta e e' o rollback imediato). A V3 so'
# muda a apresentacao: tema dark, headline, cards e detalhes recolhidos.
# Arquivo somente ASCII: acentos/simbolos via escape Unicode (ConvertFrom-V3Text).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

. (Join-Path $PSScriptRoot 'PrimeNexMonitor.Core.ps1')
. (Join-Path $PSScriptRoot 'PrimeNexMonitor.Telemetry.ps1')
. (Join-Path $PSScriptRoot 'PrimeNexMonitor.TelemetryTransport.ps1')
. (Join-Path $PSScriptRoot 'PrimeNexMonitor.ViewModel.ps1')

# ------------------------------------------------------------------ instancia unica
# Somente leitura: se outro Monitor (V2 ou V3) ja estiver aberto, avisa e sai
# ANTES de criar o transporte de telemetria. Nunca encerra outro processo.
$otherMonitors = @()
try {
    $monitorProcesses = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop | Select-Object ProcessId, CommandLine)
    $otherMonitors = Find-V3OtherMonitorInstances -Processes $monitorProcesses -SelfPid $PID
}
catch { $otherMonitors = @() }
if ($otherMonitors.Count -gt 0) {
    [void][System.Windows.Forms.MessageBox]::Show(
        (ConvertFrom-V3Text 'J\u00e1 existe um PRIME NEX Monitor aberto (PID ') + ($otherMonitors -join ', ') + (ConvertFrom-V3Text ').\r\n\r\nEsta janela V3 ser\u00e1 fechada sem iniciar telemetria. Nenhum processo foi encerrado.'),
        'PRIME NEX Monitor V3')
    return
}

# Telemetry V1: payloads em memoria; envio best-effort somente se
# %LOCALAPPDATA%\PrimeNex\telemetry.json tiver enabled=true (senao, zero rede).
$script:TelemetryState = New-TelemetryDedupeState
$script:TelemetrySender = $null
try { $script:TelemetrySender = New-TelemetrySender } catch { $script:TelemetrySender = $null }
$script:TelemetryLastStatus = $null
$script:TelemetryLastCycle = $null
$script:TelemetryLastGuardian = $null
$script:TelemetryLastErrors = @()

# ------------------------------------------------------------------ tema
$script:V3Colors = @{
    Background = [System.Drawing.Color]::FromArgb(21, 24, 29)
    Card       = [System.Drawing.Color]::FromArgb(30, 35, 43)
    Input      = [System.Drawing.Color]::FromArgb(24, 28, 34)
    Text       = [System.Drawing.Color]::FromArgb(230, 233, 238)
    Muted      = [System.Drawing.Color]::FromArgb(139, 148, 158)
    OK         = [System.Drawing.Color]::FromArgb(63, 185, 80)
    WARN       = [System.Drawing.Color]::FromArgb(210, 153, 34)
    BAD        = [System.Drawing.Color]::FromArgb(248, 81, 73)
    INFO       = [System.Drawing.Color]::FromArgb(88, 166, 255)
    OFF        = [System.Drawing.Color]::FromArgb(110, 118, 129)
}
$script:V3Dot = [string][char]0x25CF

function Get-V3LevelColor {
    param([string]$Level)
    if ($script:V3Colors.ContainsKey($Level)) { return $script:V3Colors[$Level] }
    return $script:V3Colors.Muted
}

function New-V3Label {
    param([string]$Text = '', [float]$Size = 9.5, [switch]$Bold, [System.Drawing.Color]$Color = $script:V3Colors.Text)

    $label = [System.Windows.Forms.Label]::new()
    $label.Text = $Text
    $label.AutoSize = $false
    $label.AutoEllipsis = $true
    $label.ForeColor = $Color
    $label.BackColor = [System.Drawing.Color]::Transparent
    $fontName = if ($Bold) { 'Segoe UI Semibold' } else { 'Segoe UI' }
    $label.Font = [System.Drawing.Font]::new($fontName, $Size)
    return $label
}

function New-V3CardControl {
    param([string]$Title)

    $panel = [System.Windows.Forms.Panel]::new()
    $panel.Dock = 'Fill'
    $panel.BackColor = $script:V3Colors.Card
    $panel.Margin = [System.Windows.Forms.Padding]::new(6)
    $panel.Padding = [System.Windows.Forms.Padding]::new(14, 10, 14, 8)

    $secondary = New-V3Label -Size 9 -Color $script:V3Colors.Muted
    $secondary.Dock = 'Top'
    $secondary.Height = 36
    $primary = New-V3Label -Size 13 -Bold
    $primary.Dock = 'Top'
    $primary.Height = 30
    # (nomes locais diferentes do parametro $Title: variaveis do PowerShell nao diferenciam maiusculas)
    $titleLabel = New-V3Label -Text ($script:V3Dot + ' ' + $Title) -Size 9 -Bold -Color $script:V3Colors.Muted
    $titleLabel.Dock = 'Top'
    $titleLabel.Height = 22
    # Dock Top: o ultimo adicionado fica no topo.
    $panel.Controls.Add($secondary)
    $panel.Controls.Add($primary)
    $panel.Controls.Add($titleLabel)
    return [pscustomobject]@{ Panel = $panel; Title = $titleLabel; Primary = $primary; Secondary = $secondary; Name = $Title }
}

function New-V3TextBox {
    param([int]$Height)

    $box = [System.Windows.Forms.TextBox]::new()
    $box.Multiline = $true
    $box.WordWrap = $true
    $box.ReadOnly = $true
    $box.ScrollBars = 'Vertical'
    $box.BorderStyle = 'FixedSingle'
    $box.BackColor = $script:V3Colors.Input
    $box.ForeColor = $script:V3Colors.Text
    $box.Font = [System.Drawing.Font]::new('Segoe UI', 9)
    $box.Height = $Height
    $box.Dock = 'Fill'
    $box.Text = '-'
    return $box
}

# ------------------------------------------------------------------ layout
$form = [System.Windows.Forms.Form]::new()
$form.Text = 'PRIME NEX Monitor V3'
$form.StartPosition = 'CenterScreen'
$form.Size = [System.Drawing.Size]::new(1120, 720)
$form.MinimumSize = [System.Drawing.Size]::new(980, 650)
$form.BackColor = $script:V3Colors.Background
$form.ForeColor = $script:V3Colors.Text
$form.Font = [System.Drawing.Font]::new('Segoe UI', 9.5)

$root = [System.Windows.Forms.TableLayoutPanel]::new()
$root.Dock = 'Fill'
$root.ColumnCount = 1
$root.AutoScroll = $true
$root.Padding = [System.Windows.Forms.Padding]::new(12, 10, 12, 6)
[void]$root.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
$form.Controls.Add($root)

# Cabecalho: headline + subtitulo; a direita, atualizacao e Supervisor.
$header = [System.Windows.Forms.TableLayoutPanel]::new()
$header.Anchor = 'Left, Right'
$header.Height = 96
$header.ColumnCount = 2
$header.RowCount = 2
$header.Margin = [System.Windows.Forms.Padding]::new(6, 0, 6, 4)
[void]$header.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 65))
[void]$header.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 35))
[void]$header.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 56))
[void]$header.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 36))
# Indicador de estado: Label proprio com U+25CF colorido (o texto fica na cor normal).
$headlineDot = New-V3Label -Text ([string][char]0x25CF) -Size 22 -Color $script:V3Colors.OFF
$headlineDot.Dock = 'Fill'
$headlineDot.TextAlign = 'MiddleCenter'
$headlineLabel = New-V3Label -Text ('PRIME NEX ' + (ConvertFrom-V3Text '\u2014') + ' CARREGANDO') -Size 22 -Bold
$headlineLabel.Dock = 'Fill'
$headlineLabel.TextAlign = 'MiddleLeft'
$headlinePanel = [System.Windows.Forms.TableLayoutPanel]::new()
$headlinePanel.Dock = 'Fill'
$headlinePanel.ColumnCount = 2
$headlinePanel.RowCount = 1
$headlinePanel.Margin = [System.Windows.Forms.Padding]::new(0)
[void]$headlinePanel.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Absolute, 44))
[void]$headlinePanel.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
$headlinePanel.Controls.Add($headlineDot, 0, 0)
$headlinePanel.Controls.Add($headlineLabel, 1, 0)
$subtitleLabel = New-V3Label -Size 10 -Color $script:V3Colors.Muted
$subtitleLabel.Dock = 'Fill'
$updatedLabel = New-V3Label -Text 'aguardando primeira leitura' -Size 9 -Color $script:V3Colors.Muted
$updatedLabel.Dock = 'Fill'
$updatedLabel.TextAlign = 'MiddleRight'
$supervisorLabel = New-V3Label -Text ($script:V3Dot + ' Supervisor') -Size 9.5 -Bold -Color $script:V3Colors.OFF
$supervisorLabel.Dock = 'Fill'
$supervisorLabel.TextAlign = 'MiddleRight'
$supervisorTip = [System.Windows.Forms.ToolTip]::new()
$header.Controls.Add($headlinePanel, 0, 0)
$header.Controls.Add($updatedLabel, 1, 0)
$header.Controls.Add($subtitleLabel, 0, 1)
$header.Controls.Add($supervisorLabel, 1, 1)

# Faixa "Execucao atual" - somente com ciclo em andamento.
$currentRunLabel = New-V3Label -Size 10 -Bold -Color $script:V3Colors.INFO
$currentRunLabel.Anchor = 'Left, Right'
$currentRunLabel.Height = 30
$currentRunLabel.BackColor = $script:V3Colors.Card
$currentRunLabel.Padding = [System.Windows.Forms.Padding]::new(12, 0, 0, 0)
$currentRunLabel.TextAlign = 'MiddleLeft'
$currentRunLabel.Margin = [System.Windows.Forms.Padding]::new(6, 0, 6, 4)
$currentRunLabel.Visible = $false

# Grade de cards.
$cardsGrid = [System.Windows.Forms.TableLayoutPanel]::new()
$cardsGrid.Anchor = 'Left, Right'
$cardsGrid.Height = 236
$cardsGrid.ColumnCount = 4
$cardsGrid.RowCount = 2
$cardsGrid.Margin = [System.Windows.Forms.Padding]::new(0)
foreach ($i in 1..4) { [void]$cardsGrid.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 25)) }
foreach ($i in 1..2) { [void]$cardsGrid.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 50)) }
$script:V3Cards = @{
    NEX        = New-V3CardControl -Title 'NEX'
    TASK       = New-V3CardControl -Title 'Task'
    EXPORT     = New-V3CardControl -Title 'Export'
    STAGE      = New-V3CardControl -Title 'Stage'
    G13        = New-V3CardControl -Title 'G13'
    SUPERVISOR = New-V3CardControl -Title 'Supervisor'
    GUARDIAN   = New-V3CardControl -Title 'Guardian'
}
$cardsGrid.Controls.Add($script:V3Cards.NEX.Panel, 0, 0)
$cardsGrid.Controls.Add($script:V3Cards.TASK.Panel, 1, 0)
$cardsGrid.Controls.Add($script:V3Cards.EXPORT.Panel, 2, 0)
$cardsGrid.Controls.Add($script:V3Cards.STAGE.Panel, 3, 0)
$cardsGrid.Controls.Add($script:V3Cards.G13.Panel, 0, 1)
$cardsGrid.Controls.Add($script:V3Cards.SUPERVISOR.Panel, 1, 1)
$cardsGrid.Controls.Add($script:V3Cards.GUARDIAN.Panel, 2, 1)
$cardsGrid.SetColumnSpan($script:V3Cards.GUARDIAN.Panel, 2)

# Painel Guardian: botoes + resumo/evidencias/recomendacao.
$guardianPanel = [System.Windows.Forms.TableLayoutPanel]::new()
$guardianPanel.Anchor = 'Left, Right'
$guardianPanel.Height = 210
$guardianPanel.BackColor = $script:V3Colors.Card
$guardianPanel.Margin = [System.Windows.Forms.Padding]::new(6, 4, 6, 4)
$guardianPanel.Padding = [System.Windows.Forms.Padding]::new(12, 8, 12, 8)
$guardianPanel.ColumnCount = 3
$guardianPanel.RowCount = 3
foreach ($i in 1..3) { [void]$guardianPanel.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 33.33)) }
[void]$guardianPanel.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 40))
[void]$guardianPanel.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 22))
[void]$guardianPanel.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))

$guardianButtons = [System.Windows.Forms.FlowLayoutPanel]::new()
$guardianButtons.Dock = 'Fill'
$guardianButtons.WrapContents = $false
$guardianButton = [System.Windows.Forms.Button]::new()
$guardianButton.Text = 'Analisar com Guardian'
$guardianCopyButton = [System.Windows.Forms.Button]::new()
$guardianCopyButton.Text = (ConvertFrom-V3Text 'Copiar diagn\u00f3stico')
foreach ($button in @($guardianButton, $guardianCopyButton)) {
    $button.AutoSize = $true
    $button.FlatStyle = 'Flat'
    $button.BackColor = [System.Drawing.Color]::FromArgb(45, 52, 63)
    $button.ForeColor = $script:V3Colors.Text
    $button.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(70, 80, 94)
    $guardianButtons.Controls.Add($button)
}
# Destaque discreto da acao principal com a cor INFO do tema.
$guardianButton.BackColor = [System.Drawing.Color]::FromArgb(28, 52, 84)
$guardianButton.FlatAppearance.BorderColor = $script:V3Colors.INFO
$guardianNotice = New-V3Label -Text (ConvertFrom-V3Text 'Nenhuma a\u00e7\u00e3o autom\u00e1tica \u00e9 executada.') -Size 9 -Color $script:V3Colors.Muted
$guardianNotice.Dock = 'Fill'
$guardianNotice.TextAlign = 'MiddleLeft'
$guardianPanel.Controls.Add($guardianButtons, 0, 0)
$guardianPanel.SetColumnSpan($guardianButtons, 2)
$guardianPanel.Controls.Add($guardianNotice, 2, 0)
foreach ($caption in @(@(0, 'Resumo'), @(1, (ConvertFrom-V3Text 'Evid\u00eancias')), @(2, (ConvertFrom-V3Text 'Recomenda\u00e7\u00e3o')))) {
    $captionLabel = New-V3Label -Text $caption[1] -Size 9 -Bold -Color $script:V3Colors.Muted
    $captionLabel.Dock = 'Fill'
    $guardianPanel.Controls.Add($captionLabel, $caption[0], 1)
}
$guardianSummaryBox = New-V3TextBox -Height 120
$guardianEvidenceBox = New-V3TextBox -Height 120
$guardianActionBox = New-V3TextBox -Height 120
$guardianPanel.Controls.Add($guardianSummaryBox, 0, 2)
$guardianPanel.Controls.Add($guardianEvidenceBox, 1, 2)
$guardianPanel.Controls.Add($guardianActionBox, 2, 2)

# Detalhes tecnicos (recolhidos por padrao).
$detailsToggle = [System.Windows.Forms.Button]::new()
$detailsToggle.Text = (ConvertFrom-V3Text 'Mostrar detalhes t\u00e9cnicos')
$detailsToggle.AutoSize = $true
$detailsToggle.FlatStyle = 'Flat'
$detailsToggle.BackColor = $script:V3Colors.Background
$detailsToggle.ForeColor = $script:V3Colors.Muted
$detailsToggle.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(55, 62, 72)
$detailsToggle.Margin = [System.Windows.Forms.Padding]::new(6, 4, 6, 4)
$detailsBox = New-V3TextBox -Height 260
$detailsBox.Dock = 'None'
$detailsBox.Anchor = 'Left, Right'
$detailsBox.Font = [System.Drawing.Font]::new('Consolas', 9)
$detailsBox.WordWrap = $false
$detailsBox.ScrollBars = 'Both'
$detailsBox.Margin = [System.Windows.Forms.Padding]::new(6, 0, 6, 4)
$detailsBox.Visible = $false
$detailsToggle.Add_Click({
    $detailsBox.Visible = -not $detailsBox.Visible
    $detailsToggle.Text = if ($detailsBox.Visible) { ConvertFrom-V3Text 'Ocultar detalhes t\u00e9cnicos' } else { ConvertFrom-V3Text 'Mostrar detalhes t\u00e9cnicos' }
})

$script:AgentRuntimeId = Get-AgentRuntimeId
$footerLabel = New-V3Label -Text ('Monitor V3  |  Agent runtime: ' + $script:AgentRuntimeId + '  |  Read-only  |  Telemetria somente Windows -> nuvem') -Size 8.5 -Color $script:V3Colors.OFF
$footerLabel.Anchor = 'Left, Right'
$footerLabel.Height = 22
$footerLabel.TextAlign = 'MiddleRight'

foreach ($control in @($header, $currentRunLabel, $cardsGrid, $guardianPanel, $detailsToggle, $detailsBox, $footerLabel)) {
    [void]$root.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::AutoSize))
    $root.Controls.Add($control)
}

# ------------------------------------------------------------------ render (somente UI)

function Set-V3Card {
    param([object]$Card)

    $target = $script:V3Cards[$Card.Key]
    if ($null -eq $target) { return }
    $target.Title.Text = $script:V3Dot + ' ' + $Card.Title
    $target.Title.ForeColor = Get-V3LevelColor -Level $Card.Level
    $target.Primary.Text = $Card.Primary
    $target.Secondary.Text = $Card.Secondary
}

function Set-V3Supervisor {
    param([object]$Supervisor)

    $supervisorLabel.Text = $script:V3Dot + ' ' + $Supervisor.Primary
    $supervisorLabel.ForeColor = Get-V3LevelColor -Level $Supervisor.Level
    $tip = $Supervisor.Secondary
    if ($Supervisor.Counters) { $tip += "`r`n" + $Supervisor.Counters }
    $supervisorTip.SetToolTip($supervisorLabel, $tip + "`r`nSomente envio de telemetria Windows -> nuvem; nenhum comando e' recebido.")
}

function Render-V3 {
    param([object]$ViewModel)

    $headlineDot.Text = $ViewModel.Headline.Icon
    $headlineDot.ForeColor = Get-V3LevelColor -Level $ViewModel.Headline.Level
    $headlineLabel.Text = $ViewModel.Headline.Text
    $headlineLabel.ForeColor = $script:V3Colors.Text
    $subtitleLabel.Text = $ViewModel.Subtitle
    $updatedLabel.Text = $ViewModel.Updated
    Set-V3Supervisor -Supervisor $ViewModel.Supervisor
    $currentRunLabel.Visible = $ViewModel.CurrentRun.Visible
    $currentRunLabel.Text = $ViewModel.CurrentRun.Text
    foreach ($card in $ViewModel.Cards) { Set-V3Card -Card $card }
    $detailsBox.Text = (@($ViewModel.Details | ForEach-Object { $_.Label.PadRight(28) + ' ' + $_.Value }) -join "`r`n")
}

# ------------------------------------------------------------------ Guardian (mesmo fluxo manual da V2)

$script:OutboxCache = $null
$script:OutboxCacheAt = [datetime]::MinValue
$script:OutboxFailureStreak = 0
$script:GuardianProcess = $null
$script:LastTaskSnapshotState = $null
$script:GuardianStdOutTask = $null
$script:GuardianStdErrTask = $null
$script:LastRefreshAt = $null
$script:SupervisorLastSent = 0
$script:SupervisorLastAcceptedAt = $null

function Reset-GuardianPresentation {
    $script:GuardianView = [ordered]@{
        State = 'Aguardando clique manual'; Source = '-'; Classification = '-'; Confidence = '-'
        Summary = '-'; EvidenceLines = @(); Action = '-'; NeedsHuman = '-'; AutoFix = '-'; LastAnalysis = '-'
    }
}

function Render-V3Guardian {
    $guardianSummaryBox.Text = $script:GuardianView.Summary
    $guardianEvidenceBox.Text = if (@($script:GuardianView.EvidenceLines).Count -gt 0) { @($script:GuardianView.EvidenceLines) -join "`r`n" } else { '-' }
    $guardianActionBox.Text = $script:GuardianView.Action
    Set-V3Card -Card (Get-V3GuardianCard -Guardian $script:GuardianView)
}

Reset-GuardianPresentation

function Complete-GuardianManualAnalysis {
    try {
        if ($script:GuardianProcess.ExitCode -ne 0) {
            throw ('Guardian encerrou com codigo ' + $script:GuardianProcess.ExitCode + '.')
        }

        $stdout = $script:GuardianStdOutTask.GetAwaiter().GetResult()
        $null = $script:GuardianStdErrTask.GetAwaiter().GetResult()
        $paths = Get-GuardianResultPathsFromStdOut -StdOut $stdout
        $guardian = Get-GuardianMonitorResult -AnalysisPath $paths.AnalysisPath -UsagePath $paths.UsagePath
        if (-not $guardian.Success) { throw $guardian.Error }

        $script:GuardianView.State = 'Concluido'
        $script:GuardianView.Source = if ($guardian.DiagnosticSource -eq 'RULE') { 'REGRA' } else { 'IA' }
        $script:GuardianView.Classification = $guardian.Classification
        $script:GuardianView.Confidence = $guardian.Confidence.ToString() + '%'
        $script:GuardianView.Summary = $guardian.Summary
        $script:GuardianView.EvidenceLines = @([string]$guardian.Evidence -split ' \| ' | Where-Object { $_.Trim() -ne '' } | ForEach-Object { '- ' + $_.Trim() })
        $script:GuardianView.Action = $guardian.RecommendedAction
        $script:GuardianView.NeedsHuman = if ($guardian.NeedsHuman) { 'SIM' } else { 'NAO' }
        $script:GuardianView.AutoFix = if ($guardian.SafeToAutoFixFinal) { 'SIM' } else { 'NAO' }
        $script:GuardianView.LastAnalysis = Format-DateTime -Value $guardian.GeneratedAt
        try {
            $script:TelemetryLastGuardian = New-TelemetryGuardianPayload -Guardian $guardian -CapturedAt (Get-Date)
            if (Test-TelemetryGuardianShouldSend -State $script:TelemetryState -Payload $script:TelemetryLastGuardian) {
                if (Submit-TelemetryPayload -Sender $script:TelemetrySender -Payload $script:TelemetryLastGuardian) { Register-TelemetryGuardianSent -State $script:TelemetryState -Payload $script:TelemetryLastGuardian }
            }
        }
        catch { $script:TelemetryLastGuardian = $null }
    }
    catch {
        Reset-GuardianPresentation
        $script:GuardianView.State = 'Erro: ' + $_.Exception.Message
    }
    finally {
        if ($null -ne $script:GuardianProcess) { $script:GuardianProcess.Dispose() }
        $script:GuardianProcess = $null
        $script:GuardianStdOutTask = $null
        $script:GuardianStdErrTask = $null
        $guardianButton.Enabled = $true
        Render-V3Guardian
    }
}

$guardianTimer = [System.Windows.Forms.Timer]::new()
$guardianTimer.Interval = 150
$guardianTimer.Add_Tick({
    if ($null -eq $script:GuardianProcess) {
        $guardianTimer.Stop()
        return
    }
    if (-not $script:GuardianProcess.HasExited) { return }

    $guardianTimer.Stop()
    Complete-GuardianManualAnalysis
})

$guardianButton.Add_Click({
    if ($null -ne $script:GuardianProcess) { return }

    Reset-GuardianPresentation
    $script:GuardianView.State = 'Analisando...'
    $guardianButton.Enabled = $false
    Render-V3Guardian
    try {
        $agentPath = Resolve-GuardianAgentPath
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $agentPath
        $psi.Arguments = '--guardian-analyze --task-state ' + (ConvertTo-GuardianTaskStateArgument -State $script:LastTaskSnapshotState)
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $psi
        if (-not $process.Start()) { throw 'Nao foi possivel iniciar o Guardian.' }

        $script:GuardianProcess = $process
        $script:GuardianStdOutTask = $process.StandardOutput.ReadToEndAsync()
        $script:GuardianStdErrTask = $process.StandardError.ReadToEndAsync()
        $guardianTimer.Start()
    }
    catch {
        Reset-GuardianPresentation
        $script:GuardianView.State = 'Erro: ' + $_.Exception.Message
        $guardianButton.Enabled = $true
        Render-V3Guardian
    }
})

$guardianCopyButton.Add_Click({
    try {
        [System.Windows.Forms.Clipboard]::SetText((ConvertTo-V3GuardianClipboardText -Guardian $script:GuardianView))
    }
    catch {
        [void][System.Windows.Forms.MessageBox]::Show('Falha ao copiar: ' + $_.Exception.Message, 'Guardian')
    }
})

# ------------------------------------------------------------------ refresh (mesma orquestracao da V2)

$refreshAction = {
    $timer.Enabled = $false
    try {
        $taskSnapshot = Get-TaskSnapshot
        $script:LastTaskSnapshotState = [string]$taskSnapshot.State
        $pipelineSnapshot = Get-PipelineSnapshot
        $exportSnapshot = Get-ExportSnapshot
        $stageSnapshot = Get-ExportStageSnapshot
        $nexSnapshot = Get-NexSnapshot

        # A outbox tem cadencia propria (60 s): a fila muda devagar e cada
        # leitura cria um processo filho de consulta.
        $agora = Get-Date
        if ($null -eq $script:OutboxCache -or ($agora - $script:OutboxCacheAt).TotalMilliseconds -ge $script:OutboxRefreshMilliseconds) {
            $script:OutboxCache = Get-OutboxSnapshot
            $script:OutboxCacheAt = $agora
            if ($script:OutboxCache.Available) { $script:OutboxFailureStreak = 0 }
            else { $script:OutboxFailureStreak++ }
        }

        $isG13Blocked = Test-G13CurrentBlock -Stage $stageSnapshot -Pipeline $pipelineSnapshot
        $outboxHealth = Get-OutboxHealth -Outbox $script:OutboxCache -ConsecutiveFailures $script:OutboxFailureStreak
        $stageHealth = Get-StageHealth -Stage $stageSnapshot -G13Blocked $isG13Blocked
        $successHealth = Get-SuccessHealth -Pipeline $pipelineSnapshot -Nex $nexSnapshot

        $overall = Get-OverallStatus -Task $taskSnapshot -Pipeline $pipelineSnapshot -Export $exportSnapshot -Nex $nexSnapshot -OutboxHealth $outboxHealth -StageHealth $stageHealth -SuccessHealth $successHealth

        # Best-effort e isolado: nunca afeta $overall nem a tela.
        try {
            $script:TelemetryLastStatus = New-TelemetryStatusPayload -Task $taskSnapshot -Pipeline $pipelineSnapshot -Nex $nexSnapshot -Stage $stageSnapshot -Overall $overall -G13Blocked $isG13Blocked -CapturedAt $agora
            $script:TelemetryLastCycle = New-TelemetryCyclePayload -Pipeline $pipelineSnapshot -CapturedAt $agora
            $script:TelemetryLastErrors = Test-TelemetryPayload -Payload $script:TelemetryLastStatus
            Step-TelemetrySender -Sender $script:TelemetrySender
            if (Test-TelemetryCycleShouldSend -State $script:TelemetryState -Payload $script:TelemetryLastCycle) {
                if (Submit-TelemetryPayload -Sender $script:TelemetrySender -Payload $script:TelemetryLastCycle) { Register-TelemetryCycleSent -State $script:TelemetryState -Payload $script:TelemetryLastCycle }
            }
            if (Test-TelemetryStatusShouldSend -State $script:TelemetryState -Payload $script:TelemetryLastStatus -Now $agora) {
                if (Submit-TelemetryPayload -Sender $script:TelemetrySender -Payload $script:TelemetryLastStatus) { Register-TelemetryStatusSent -State $script:TelemetryState -Payload $script:TelemetryLastStatus -Now $agora }
            }
        }
        catch { $script:TelemetryLastErrors = @('telemetria: ' + $_.Exception.Message) }

        # Apresentacao (somente leitura dos valores acima).
        $currentSent = if ($null -ne $script:TelemetrySender) { [int]$script:TelemetrySender.Sent } else { 0 }
        $script:SupervisorLastAcceptedAt = Update-V3SupervisorObservation -PreviousSent $script:SupervisorLastSent -CurrentSent $currentSent -PreviousAcceptedAt $script:SupervisorLastAcceptedAt -Now $agora
        $script:SupervisorLastSent = $currentSent
        $script:LastRefreshAt = $agora
        $successExport = Get-SuccessExportSnapshot -Terminal $pipelineSnapshot.LastSuccess
        $viewModel = Get-MonitorViewModel -Task $taskSnapshot -Pipeline $pipelineSnapshot -Export $exportSnapshot -Stage $stageSnapshot -Nex $nexSnapshot -Overall $overall -G13Blocked $isG13Blocked -OutboxHealth $outboxHealth -StageHealth $stageHealth -SuccessHealth $successHealth -SuccessExport $successExport -Sender $script:TelemetrySender -LastAcceptedSendAt $script:SupervisorLastAcceptedAt -Guardian $script:GuardianView -LastRefreshAt $script:LastRefreshAt -Now $agora
        Render-V3 -ViewModel $viewModel
    }
    catch {
        $headlineDot.ForeColor = $script:V3Colors.BAD
        $headlineLabel.Text = 'PRIME NEX ' + (ConvertFrom-V3Text '\u2014') + ' PROBLEMA'
        $headlineLabel.ForeColor = $script:V3Colors.Text
        $subtitleLabel.Text = 'Informacao indisponivel. Nenhuma acao corretiva foi executada.'
        $updatedLabel.Text = 'Falha de leitura em ' + (Get-Date).ToString('dd/MM/yyyy HH:mm:ss')
        $detailsBox.Text = 'Falha de leitura: ' + $_.Exception.Message
    }
    finally {
        $timer.Enabled = $true
    }
}

# Relogio de apresentacao (1 s): so' atualiza "atualizado ha X s" e a idade do
# ultimo envio do Supervisor. Sem leitura de disco, rede ou processos.
$clockTimer = [System.Windows.Forms.Timer]::new()
$clockTimer.Interval = 1000
$clockTimer.Add_Tick({
    try {
        $now = Get-Date
        if ($null -ne $script:LastRefreshAt) { $updatedLabel.Text = (ConvertFrom-V3Text 'atualizado h\u00e1 ') + (Format-V3Age -Since $script:LastRefreshAt -Now $now) }
        Set-V3Supervisor -Supervisor (Get-V3SupervisorIndicator -Sender $script:TelemetrySender -LastAcceptedAt $script:SupervisorLastAcceptedAt -Now $now)
    }
    catch { }
})

Render-V3Guardian
$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = $script:RefreshMilliseconds
$timer.Add_Tick($refreshAction)
$form.Add_Shown($refreshAction)
$form.Add_Shown({ $clockTimer.Start() })
$form.Add_FormClosed({
    $timer.Stop()
    $timer.Dispose()
    $clockTimer.Stop()
    $clockTimer.Dispose()
    $guardianTimer.Stop()
    $guardianTimer.Dispose()
    if ($null -ne $script:GuardianProcess -and $script:GuardianProcess.HasExited) { $script:GuardianProcess.Dispose() }
})

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run($form)
