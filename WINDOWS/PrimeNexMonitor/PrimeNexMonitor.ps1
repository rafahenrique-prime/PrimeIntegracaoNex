#requires -Version 5.1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Funcoes de leitura e constantes vivem no Core para permitir dot-source em teste.
. (Join-Path $PSScriptRoot 'PrimeNexMonitor.Core.ps1')
# Telemetry V1: payloads em memoria; envio best-effort somente se
# %LOCALAPPDATA%\PrimeNex\telemetry.json tiver enabled=true (senao, zero rede).
. (Join-Path $PSScriptRoot 'PrimeNexMonitor.Telemetry.ps1')
. (Join-Path $PSScriptRoot 'PrimeNexMonitor.TelemetryTransport.ps1')
$script:TelemetryState = New-TelemetryDedupeState
$script:TelemetrySender = $null
try { $script:TelemetrySender = New-TelemetrySender } catch { $script:TelemetrySender = $null }
$script:TelemetryLastStatus = $null
$script:TelemetryLastCycle = $null
$script:TelemetryLastGuardian = $null
$script:TelemetryLastErrors = @()

function New-ValueLabel {
    $label = [System.Windows.Forms.Label]::new()
    $label.AutoSize = $true
    $label.Font = [System.Drawing.Font]::new('Segoe UI', 9.5)
    $label.ForeColor = [System.Drawing.Color]::FromArgb(35, 42, 52)
    $label.Margin = [System.Windows.Forms.Padding]::new(3, 2, 3, 2)
    return $label
}

function Add-InformationRow {
    param(
        [System.Windows.Forms.TableLayoutPanel]$Table,
        [string]$Caption,
        [string]$Name
    )

    $row = $Table.RowCount
    $Table.RowCount++
    $captionLabel = New-ValueLabel
    $captionLabel.Text = $Caption
    $captionLabel.ForeColor = [System.Drawing.Color]::FromArgb(95, 105, 118)
    $valueLabel = New-ValueLabel
    $valueLabel.Name = $Name
    $valueLabel.Text = '-'
    $Table.Controls.Add($captionLabel, 0, $row)
    $Table.Controls.Add($valueLabel, 1, $row)
    return $valueLabel
}

function New-Section {
    param(
        [string]$Title,
        [int]$Height
    )

    $box = [System.Windows.Forms.GroupBox]::new()
    $box.Text = $Title
    $box.Dock = 'Top'
    $box.Height = $Height
    $box.Padding = [System.Windows.Forms.Padding]::new(12, 8, 12, 8)
    $box.Font = [System.Drawing.Font]::new('Segoe UI Semibold', 9.5)
    $box.ForeColor = [System.Drawing.Color]::FromArgb(55, 65, 78)
    $box.Margin = [System.Windows.Forms.Padding]::new(0, 0, 0, 4)

    $table = [System.Windows.Forms.TableLayoutPanel]::new()
    $table.Dock = 'Fill'
    $table.ColumnCount = 2
    [void]$table.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Absolute, 150))
    [void]$table.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
    $box.Controls.Add($table)
    return [pscustomobject]@{ Box = $box; Table = $table }
}

function Add-HealthRow {
    param(
        [System.Windows.Forms.TableLayoutPanel]$Table,
        [string]$Caption
    )

    $row = $Table.RowCount
    $Table.RowCount++

    $captionLabel = New-ValueLabel
    $captionLabel.Text = $Caption
    $captionLabel.ForeColor = [System.Drawing.Color]::FromArgb(95, 105, 118)

    $summaryLabel = New-ValueLabel
    $summaryLabel.Text = '-'

    $Table.Controls.Add($captionLabel, 0, $row)
    $Table.Controls.Add($summaryLabel, 1, $row)

    $detailRow = $Table.RowCount
    $Table.RowCount++
    $detailLabel = New-ValueLabel
    $detailLabel.Font = [System.Drawing.Font]::new('Segoe UI', 8.5)
    $detailLabel.ForeColor = [System.Drawing.Color]::FromArgb(120, 90, 30)
    $detailLabel.AutoEllipsis = $true
    $detailLabel.Text = ''
    $detailLabel.Visible = $false
    $Table.Controls.Add($detailLabel, 1, $detailRow)

    return [pscustomobject]@{ Summary = $summaryLabel; Detail = $detailLabel }
}

function Set-HealthRow {
    param(
        [object]$Row,
        [object]$Health
    )

    if ($null -eq $Health) {
        $Row.Summary.Text = '-'
        $Row.Detail.Visible = $false
        return
    }

    $icone = switch ($Health.Level) {
        'PROBLEMA' { [char]0x25CF + ' ' }
        'ATENCAO'  { [char]0x25CF + ' ' }
        default    { [char]0x25CF + ' ' }
    }
    $cor = switch ($Health.Level) {
        'PROBLEMA' { [System.Drawing.Color]::FromArgb(190, 45, 55) }
        'ATENCAO'  { [System.Drawing.Color]::FromArgb(164, 112, 0) }
        default    { [System.Drawing.Color]::FromArgb(25, 135, 84) }
    }

    $Row.Summary.Text = $icone + (Get-DisplayValue -Value $Health.Summary)
    $Row.Summary.ForeColor = $cor

    $detalhe = Get-DisplayValue -Value $Health.Detail -Fallback ''
    $mostrar = ($Health.Level -ne 'NORMAL') -and -not [string]::IsNullOrWhiteSpace($detalhe)
    $Row.Detail.Text = $detalhe
    $Row.Detail.Visible = $mostrar
}

$form = [System.Windows.Forms.Form]::new()
$form.Text = 'PRIME NEX Monitor V2'
$form.StartPosition = 'CenterScreen'
$form.Size = [System.Drawing.Size]::new(1120, 720)
$form.MinimumSize = [System.Drawing.Size]::new(980, 650)
$form.BackColor = [System.Drawing.Color]::FromArgb(244, 246, 249)
$form.Font = [System.Drawing.Font]::new('Segoe UI', 9.5)

$root = [System.Windows.Forms.Panel]::new()
$root.Dock = 'Fill'
$root.Padding = [System.Windows.Forms.Padding]::new(12)
$root.AutoScroll = $true
$form.Controls.Add($root)

$statusPanel = [System.Windows.Forms.Panel]::new()
$statusPanel.Dock = 'Top'
$statusPanel.Height = 112
$statusPanel.Padding = [System.Windows.Forms.Padding]::new(14, 10, 14, 8)
$root.Controls.Add($statusPanel)

$statusTitle = [System.Windows.Forms.Label]::new()
$statusTitle.AutoSize = $true
$statusTitle.Font = [System.Drawing.Font]::new('Segoe UI Semibold', 20)
$statusTitle.Text = 'CARREGANDO'
$statusPanel.Controls.Add($statusTitle)

$statusDetail = [System.Windows.Forms.Label]::new()
$statusDetail.AutoEllipsis = $true
$statusDetail.Location = [System.Drawing.Point]::new(17, 48)
$statusDetail.Size = [System.Drawing.Size]::new(1060, 24)
$statusDetail.Font = [System.Drawing.Font]::new('Segoe UI', 9)
$statusPanel.Controls.Add($statusDetail)

$foregroundWarning = [System.Windows.Forms.Label]::new()
$foregroundWarning.AutoEllipsis = $true
$foregroundWarning.Location = [System.Drawing.Point]::new(17, 74)
$foregroundWarning.Size = [System.Drawing.Size]::new(1060, 24)
$foregroundWarning.Font = [System.Drawing.Font]::new('Segoe UI', 8.5)
$foregroundWarning.ForeColor = [System.Drawing.Color]::FromArgb(164, 112, 0)
$foregroundWarning.Visible = $false
$statusPanel.Controls.Add($foregroundWarning)

$currentRunSection = New-Section -Title 'EXECUCAO ATUAL' -Height 104
$currentRunStart = Add-InformationRow -Table $currentRunSection.Table -Caption 'Inicio' -Name 'CurrentRunStart'
$currentRunStage = Add-InformationRow -Table $currentRunSection.Table -Caption 'Ultimo stage' -Name 'CurrentRunStage'
$currentRunRoute = Add-InformationRow -Table $currentRunSection.Table -Caption 'Rota / posicao' -Name 'CurrentRunRoute'
$currentRunSection.Box.Visible = $false

$healthSection = New-Section -Title 'SAUDE OPERACIONAL' -Height 128
$healthOutbox = Add-HealthRow -Table $healthSection.Table -Caption 'PRIME COBRANCAS'
$healthStage = Add-HealthRow -Table $healthSection.Table -Caption 'EXPORT_STAGE'
$healthSuccess = Add-HealthRow -Table $healthSection.Table -Caption 'ULTIMO SUCCESS'

$content = [System.Windows.Forms.TableLayoutPanel]::new()
$content.Dock = 'Fill'
$content.ColumnCount = 2
$content.RowCount = 1
[void]$content.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 50))
[void]$content.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 50))

$leftColumn = [System.Windows.Forms.Panel]::new()
$leftColumn.Dock = 'Fill'
$leftColumn.AutoScroll = $false
$leftColumn.Margin = [System.Windows.Forms.Padding]::new(0, 0, 8, 0)

$rightColumn = [System.Windows.Forms.Panel]::new()
$rightColumn.Dock = 'Fill'
$rightColumn.AutoScroll = $true
$rightColumn.Margin = [System.Windows.Forms.Padding]::new(8, 0, 0, 0)

$content.Controls.Add($leftColumn, 0, 0)
$content.Controls.Add($rightColumn, 1, 0)

$nexSection = New-Section -Title 'NEX' -Height 78
$nexState = Add-InformationRow -Table $nexSection.Table -Caption 'Estado' -Name 'NexState'
$nexPosition = Add-InformationRow -Table $nexSection.Table -Caption 'Posicao' -Name 'NexPosition'

$stageSection = New-Section -Title 'EXPORT_STAGE' -Height 78
$stageCount = Add-InformationRow -Table $stageSection.Table -Caption 'Quantidade' -Name 'StageCount'
$stageState = Add-InformationRow -Table $stageSection.Table -Caption 'Estado' -Name 'StageState'

$taskSection = New-Section -Title 'TASK / PROXIMA TENTATIVA' -Height 210
$taskEnabled = Add-InformationRow -Table $taskSection.Table -Caption 'Status' -Name 'TaskEnabled'
$taskState = Add-InformationRow -Table $taskSection.Table -Caption 'Estado' -Name 'TaskState'
$taskLast = Add-InformationRow -Table $taskSection.Table -Caption 'Ultima execucao' -Name 'TaskLast'
$taskResult = Add-InformationRow -Table $taskSection.Table -Caption 'LastTaskResult' -Name 'TaskResult'
$taskNext = Add-InformationRow -Table $taskSection.Table -Caption 'Proxima tentativa' -Name 'TaskNext'
$taskCountdown = Add-InformationRow -Table $taskSection.Table -Caption 'Countdown' -Name 'TaskCountdown'

$lastAttemptSection = New-Section -Title 'ULTIMA TENTATIVA' -Height 90
$lastAttemptTime = Add-InformationRow -Table $lastAttemptSection.Table -Caption 'Data/hora' -Name 'LastAttemptTime'
$lastAttemptResult = Add-InformationRow -Table $lastAttemptSection.Table -Caption 'Resultado' -Name 'LastAttemptResult'

$nextActionSection = New-Section -Title 'PROXIMA ACAO DO SISTEMA' -Height 60
$nextActionValue = Add-InformationRow -Table $nextActionSection.Table -Caption 'Acao' -Name 'NextAction'

$leftColumn.Controls.Add($nexSection.Box)
$leftColumn.Controls.Add($stageSection.Box)
$leftColumn.Controls.Add($taskSection.Box)
$leftColumn.Controls.Add($lastAttemptSection.Box)
$leftColumn.Controls.Add($nextActionSection.Box)
$leftColumn.Controls.SetChildIndex($nexSection.Box, 4)
$leftColumn.Controls.SetChildIndex($stageSection.Box, 3)
$leftColumn.Controls.SetChildIndex($taskSection.Box, 2)
$leftColumn.Controls.SetChildIndex($lastAttemptSection.Box, 1)
$leftColumn.Controls.SetChildIndex($nextActionSection.Box, 0)

$pipelineSection = New-Section -Title 'ULTIMO CICLO' -Height 250
$pipelineStart = Add-InformationRow -Table $pipelineSection.Table -Caption 'Inicio' -Name 'PipelineStart'
$pipelineTime = Add-InformationRow -Table $pipelineSection.Table -Caption 'Fim' -Name 'PipelineTime'
$pipelineDuration = Add-InformationRow -Table $pipelineSection.Table -Caption 'Duracao' -Name 'PipelineDuration'
$pipelineStage = Add-InformationRow -Table $pipelineSection.Table -Caption 'Stage' -Name 'PipelineStage'
$pipelineCode = Add-InformationRow -Table $pipelineSection.Table -Caption 'Error code' -Name 'PipelineCode'
$pipelineRoute = Add-InformationRow -Table $pipelineSection.Table -Caption 'Rota' -Name 'PipelineRoute'
$pipelinePosition = Add-InformationRow -Table $pipelineSection.Table -Caption 'Posicao NEX' -Name 'PipelinePosition'
$pipelineRouteReason = Add-InformationRow -Table $pipelineSection.Table -Caption 'Motivo rota' -Name 'PipelineRouteReason'
$exportSection = New-Section -Title 'ULTIMO ARQUIVO EXPORTADO' -Height 125
$exportName = Add-InformationRow -Table $exportSection.Table -Caption 'Arquivo' -Name 'ExportName'
$exportTime = Add-InformationRow -Table $exportSection.Table -Caption 'Data/hora' -Name 'ExportTime'
$exportAge = Add-InformationRow -Table $exportSection.Table -Caption 'Idade' -Name 'ExportAge'
$exportSize = Add-InformationRow -Table $exportSection.Table -Caption 'Tamanho' -Name 'ExportSize'

$lastSuccessSection = New-Section -Title 'ULTIMO SUCESSO' -Height 135
$lastSuccessTime = Add-InformationRow -Table $lastSuccessSection.Table -Caption 'Conclusao' -Name 'LastSuccessTime'
$lastSuccessFile = Add-InformationRow -Table $lastSuccessSection.Table -Caption 'Arquivo' -Name 'LastSuccessFile'
$lastSuccessAge = Add-InformationRow -Table $lastSuccessSection.Table -Caption 'Idade' -Name 'LastSuccessAge'
$lastSuccessSize = Add-InformationRow -Table $lastSuccessSection.Table -Caption 'Tamanho' -Name 'LastSuccessSize'

$blockSection = New-Section -Title 'BLOQUEIO ATUAL' -Height 78
$blockValue = Add-InformationRow -Table $blockSection.Table -Caption 'Status' -Name 'CurrentBlock'
$blockSection.Box.Visible = $false

$errorSection = New-Section -Title 'ULTIMO ERRO / MOTIVO' -Height 94
$errorCodeValue = Add-InformationRow -Table $errorSection.Table -Caption 'Codigo' -Name 'ErrorCode'
$errorValue = Add-InformationRow -Table $errorSection.Table -Caption 'Motivo' -Name 'ErrorSummary'
$errorSection.Box.Visible = $false

# O arquivo e lido como ANSI pelo Windows PowerShell 5.1; textos acentuados e emojis
# sao montados por escape Unicode para evitar mojibake.
function ConvertFrom-UnicodeEscape {
    param([string]$Text)
    return [regex]::Unescape($Text)
}

function Add-GuardianTextBoxRow {
    param(
        [System.Windows.Forms.TableLayoutPanel]$Table,
        [string]$Caption,
        [string]$Name,
        [int]$Height
    )

    $row = $Table.RowCount
    $Table.RowCount++

    $captionLabel = New-ValueLabel
    $captionLabel.Text = $Caption
    $captionLabel.ForeColor = [System.Drawing.Color]::FromArgb(95, 105, 118)

    $textBox = [System.Windows.Forms.TextBox]::new()
    $textBox.Name = $Name
    $textBox.Multiline = $true
    $textBox.WordWrap = $true
    $textBox.ReadOnly = $true
    $textBox.ScrollBars = 'Vertical'
    $textBox.BackColor = [System.Drawing.Color]::FromArgb(248, 249, 251)
    $textBox.Font = [System.Drawing.Font]::new('Segoe UI', 9)
    $textBox.Height = $Height
    $textBox.Anchor = 'Left, Right'
    $textBox.Margin = [System.Windows.Forms.Padding]::new(0, 2, 0, 2)
    $textBox.Text = '-'

    $Table.Controls.Add($captionLabel, 0, $row)
    $Table.Controls.Add($textBox, 1, $row)
    return $textBox
}

$guardianSection = New-Section -Title 'GUARDIAN IA' -Height 460
$guardianClassification = Add-InformationRow -Table $guardianSection.Table -Caption (ConvertFrom-UnicodeEscape 'Classifica\u00e7\u00e3o') -Name 'GuardianClassification'
$guardianConfidence = Add-InformationRow -Table $guardianSection.Table -Caption (ConvertFrom-UnicodeEscape 'Confian\u00e7a') -Name 'GuardianConfidence'
$guardianClassification.Font = [System.Drawing.Font]::new('Segoe UI Semibold', 10)
$guardianConfidence.Font = [System.Drawing.Font]::new('Segoe UI Semibold', 10)
$guardianState = Add-InformationRow -Table $guardianSection.Table -Caption 'Estado' -Name 'GuardianState'
$guardianSource = Add-InformationRow -Table $guardianSection.Table -Caption 'Origem' -Name 'GuardianSource'
$guardianSummary = Add-GuardianTextBoxRow -Table $guardianSection.Table -Caption 'Resumo' -Name 'GuardianSummary' -Height 48
$guardianEvidence = Add-GuardianTextBoxRow -Table $guardianSection.Table -Caption (ConvertFrom-UnicodeEscape 'Evid\u00eancias') -Name 'GuardianEvidence' -Height 72
$guardianAction = Add-GuardianTextBoxRow -Table $guardianSection.Table -Caption (ConvertFrom-UnicodeEscape 'Recomenda\u00e7\u00e3o') -Name 'GuardianAction' -Height 48
$guardianNeedsHuman = Add-InformationRow -Table $guardianSection.Table -Caption 'Humano' -Name 'GuardianNeedsHuman'
$guardianAutoFix = Add-InformationRow -Table $guardianSection.Table -Caption 'Auto-fix' -Name 'GuardianAutoFix'
$guardianLastAnalysis = Add-InformationRow -Table $guardianSection.Table -Caption (ConvertFrom-UnicodeEscape '\u00daltima an\u00e1lise') -Name 'GuardianLastAnalysis'
$guardianNotice = Add-InformationRow -Table $guardianSection.Table -Caption 'Aviso' -Name 'GuardianNotice'
$guardianState.Text = 'Aguardando clique manual'
$guardianNotice.Text = ConvertFrom-UnicodeEscape 'Nenhuma a\u00e7\u00e3o autom\u00e1tica \u00e9 executada.'
$guardianButtonRow = $guardianSection.Table.RowCount
$guardianSection.Table.RowCount++
$guardianButtonPanel = [System.Windows.Forms.FlowLayoutPanel]::new()
$guardianButtonPanel.AutoSize = $true
$guardianButtonPanel.WrapContents = $false
$guardianButtonPanel.Anchor = 'Left'
$guardianButton = [System.Windows.Forms.Button]::new()
$guardianButton.Text = [char]::ConvertFromUtf32(0x1F9E0) + ' Analisar com Guardian'
$guardianButton.AutoSize = $true
$guardianCopyButton = [System.Windows.Forms.Button]::new()
$guardianCopyButton.Text = [char]::ConvertFromUtf32(0x1F4CB) + (ConvertFrom-UnicodeEscape ' Copiar diagn\u00f3stico')
$guardianCopyButton.AutoSize = $true
$guardianButtonPanel.Controls.Add($guardianButton)
$guardianButtonPanel.Controls.Add($guardianCopyButton)
$guardianSection.Table.Controls.Add($guardianButtonPanel, 1, $guardianButtonRow)

function Get-GuardianClipboardText {
    $yesNo = { param($v) if ($v -eq 'SIM') { 'Sim' } elseif ($v -eq 'NAO') { ConvertFrom-UnicodeEscape 'N\u00e3o' } else { $v } }
    $evidenceLines = @($guardianEvidence.Lines | Where-Object { $_.Trim() -ne '' } | ForEach-Object {
        $line = $_.Trim()
        if ($line.StartsWith('- ')) { $line } else { '- ' + $line }
    })
    $text = @(
        'PRIME NEX GUARDIAN'
        ''
        'Estado: ' + $guardianState.Text
        'Origem: ' + $guardianSource.Text
        (ConvertFrom-UnicodeEscape 'Classifica\u00e7\u00e3o: ') + $guardianClassification.Text
        (ConvertFrom-UnicodeEscape 'Confian\u00e7a: ') + $guardianConfidence.Text
        ''
        'Resumo:'
        $guardianSummary.Text
        ''
        (ConvertFrom-UnicodeEscape 'Evid\u00eancias:')
        ($evidenceLines -join "`r`n")
        ''
        (ConvertFrom-UnicodeEscape 'Recomenda\u00e7\u00e3o:')
        $guardianAction.Text
        ''
        (ConvertFrom-UnicodeEscape 'Humano necess\u00e1rio: ') + (& $yesNo $guardianNeedsHuman.Text)
        'Auto-fix: ' + (& $yesNo $guardianAutoFix.Text)
        ''
        (ConvertFrom-UnicodeEscape '\u00daltima an\u00e1lise:')
        $guardianLastAnalysis.Text
    ) -join "`r`n"

    # Defesa extra: nunca levar chaves, tokens ou caminhos internos para o clipboard.
    $text = [regex]::Replace($text, '(?i)\bsk-[A-Za-z0-9_\-]{8,}', '[omitido]')
    $text = [regex]::Replace($text, '(?i)\b(bearer|authorization|api[_-]?key|x-api-key)\b\s*[:=]?\s*\S+', '$1 [omitido]')
    $text = [regex]::Replace($text, '(?i)(?<![A-Za-z])[A-Z]:\\[^\s"'']*', '[caminho omitido]')
    $text = [regex]::Replace($text, '\\\\[^\s"'']+', '[caminho omitido]')
    return $text
}

$guardianCopyButton.Add_Click({
    try {
        [System.Windows.Forms.Clipboard]::SetText((Get-GuardianClipboardText))
    }
    catch {
        [void][System.Windows.Forms.MessageBox]::Show('Falha ao copiar: ' + $_.Exception.Message, 'Guardian')
    }
})

$rightColumn.Controls.Add($pipelineSection.Box)
$rightColumn.Controls.Add($exportSection.Box)
$rightColumn.Controls.Add($lastSuccessSection.Box)
$rightColumn.Controls.Add($blockSection.Box)
$rightColumn.Controls.Add($errorSection.Box)
$rightColumn.Controls.Add($guardianSection.Box)
$rightColumn.Controls.SetChildIndex($pipelineSection.Box, 4)
$rightColumn.Controls.SetChildIndex($exportSection.Box, 3)
$rightColumn.Controls.SetChildIndex($lastSuccessSection.Box, 2)
$rightColumn.Controls.SetChildIndex($blockSection.Box, 1)
$rightColumn.Controls.SetChildIndex($errorSection.Box, 0)
$rightColumn.Controls.SetChildIndex($guardianSection.Box, 5)

$script:AgentRuntimeId = Get-AgentRuntimeId
$updatedLabel = [System.Windows.Forms.Label]::new()
$updatedLabel.Dock = 'Bottom'
$updatedLabel.Height = 25
$updatedLabel.TextAlign = 'MiddleRight'
$updatedLabel.ForeColor = [System.Drawing.Color]::FromArgb(100, 108, 120)

$root.Controls.Add($statusPanel)
$root.Controls.Add($healthSection.Box)
$root.Controls.Add($currentRunSection.Box)
$root.Controls.Add($content)
$root.Controls.Add($updatedLabel)
$root.Controls.SetChildIndex($statusPanel, 4)
$root.Controls.SetChildIndex($healthSection.Box, 3)
$root.Controls.SetChildIndex($currentRunSection.Box, 2)
$root.Controls.SetChildIndex($content, 1)
$root.Controls.SetChildIndex($updatedLabel, 0)

$script:OutboxCache = $null
$script:OutboxCacheAt = [datetime]::MinValue
$script:OutboxFailureStreak = 0
$script:GuardianProcess = $null
$script:LastTaskSnapshotState = $null
$script:GuardianStdOutTask = $null
$script:GuardianStdErrTask = $null

function Reset-GuardianPresentation {
    $guardianSource.Text = '-'
    $guardianClassification.Text = '-'
    $guardianConfidence.Text = '-'
    $guardianSummary.Text = '-'
    $guardianEvidence.Text = '-'
    $guardianAction.Text = '-'
    $guardianNeedsHuman.Text = '-'
    $guardianAutoFix.Text = '-'
    $guardianLastAnalysis.Text = '-'
}

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

        $guardianState.Text = 'Concluido'
        $guardianSource.Text = if ($guardian.DiagnosticSource -eq 'RULE') { 'REGRA' } else { 'IA' }
        $guardianClassification.Text = $guardian.Classification
        $guardianConfidence.Text = $guardian.Confidence.ToString() + '%'
        $guardianSummary.Text = $guardian.Summary
        $guardianEvidence.Text = (@([string]$guardian.Evidence -split ' \| ' | Where-Object { $_.Trim() -ne '' } | ForEach-Object { '- ' + $_.Trim() }) -join "`r`n")
        $guardianAction.Text = $guardian.RecommendedAction
        $guardianNeedsHuman.Text = if ($guardian.NeedsHuman) { 'SIM' } else { 'NAO' }
        $guardianAutoFix.Text = if ($guardian.SafeToAutoFixFinal) { 'SIM' } else { 'NAO' }
        $guardianLastAnalysis.Text = Format-DateTime -Value $guardian.GeneratedAt
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
        $guardianState.Text = 'Erro: ' + $_.Exception.Message
    }
    finally {
        if ($null -ne $script:GuardianProcess) { $script:GuardianProcess.Dispose() }
        $script:GuardianProcess = $null
        $script:GuardianStdOutTask = $null
        $script:GuardianStdErrTask = $null
        $guardianButton.Enabled = $true
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
    $guardianState.Text = 'Analisando...'
    $guardianButton.Enabled = $false
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
        $guardianState.Text = 'Erro: ' + $_.Exception.Message
        $guardianButton.Enabled = $true
    }
})

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

        Set-HealthRow -Row $healthOutbox -Health $outboxHealth
        Set-HealthRow -Row $healthStage -Health $stageHealth
        Set-HealthRow -Row $healthSuccess -Health $successHealth

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

        $palette = switch ($overall.Level) {
            'NORMAL'   { @([System.Drawing.Color]::FromArgb(25, 135, 84), [System.Drawing.Color]::FromArgb(225, 244, 234)) }
            'ATENCAO'  { @([System.Drawing.Color]::FromArgb(164, 112, 0), [System.Drawing.Color]::FromArgb(255, 244, 204)) }
            default    { @([System.Drawing.Color]::FromArgb(190, 45, 55), [System.Drawing.Color]::FromArgb(252, 228, 230)) }
        }
        $statusTitle.Text = $overall.Level
        $statusTitle.ForeColor = $palette[0]
        $statusPanel.BackColor = $palette[1]
        $statusDetail.Text = $overall.Detail

        $nexState.Text = if ($nexSnapshot.Position -eq 'CLOSED') { 'Fechado' } elseif ($nexSnapshot.PathUnconfirmed) { 'Indeterminado' } elseif ($nexSnapshot.Available) { 'Aberto' } else { 'Indisponivel' }
        $nexPosition.Text = $nexSnapshot.Position

        $stageCount.Text = if ($stageSnapshot.Available) { $stageSnapshot.Count.ToString() + ' arquivo' + $(if ($stageSnapshot.Count -eq 1) { '' } else { 's' }) } else { 'Indisponivel' }
        if (-not $stageSnapshot.Available) {
            $stageState.Text = 'Leitura indisponivel'
        }
        elseif ($stageSnapshot.Count -eq 0) {
            $stageState.Text = 'Sem residuos'
        }
        elseif ($stageSnapshot.Count -eq 1) {
            $stageState.Text = 'Pendente: ' + $stageSnapshot.Files[0].Name
        }
        else {
            $stageState.Text = 'Ha arquivos pendentes'
        }

        $taskEnabled.Text = if (-not $taskSnapshot.Available) { 'Indisponivel' } elseif ($taskSnapshot.Enabled) { 'Ativa' } else { 'Desabilitada' }
        $taskState.Text = Get-DisplayValue -Value $taskSnapshot.State
        $taskLast.Text = Format-DateTime -Value $taskSnapshot.LastRunTime
        $taskResult.Text = Get-DisplayValue -Value $taskSnapshot.LastTaskResult
        $taskNext.Text = Format-DateTime -Value $taskSnapshot.NextRunTime
        $taskCountdown.Text = Format-Countdown -TargetTime $taskSnapshot.NextRunTime

        $terminal = $pipelineSnapshot.LatestTerminal
        $lastAttemptTime.Text = if ($null -ne $terminal) { Format-DateTime -Value $terminal.timestamp } else { '-' }
        $lastAttemptResult.Text = if ($null -ne $terminal) { Get-DisplayValue -Value $terminal.stage } else { '-' }
        $cycle = $pipelineSnapshot.LatestCycle
        if ($null -ne $cycle) {
            $pipelineStart.Text = Format-DateTime -Value $cycle.Start
            $pipelineTime.Text = Format-DateTime -Value $cycle.End
            $pipelineDuration.Text = Format-Duration -StartTime $cycle.Start -EndTime $cycle.End
            $pipelineStage.Text = Get-DisplayValue -Value $terminal.stage
            $pipelineCode.Text = Get-DisplayValue -Value $terminal.errorCode
            $cycleRouteEvent = $cycle.RouteEvent
            $pipelineRoute.Text = Get-DisplayValue -Value $(if ($null -ne $cycleRouteEvent) { $cycleRouteEvent.hybridRoute } else { $null }) -Fallback '-'
            $pipelinePosition.Text = Get-DisplayValue -Value $(if ($null -ne $cycleRouteEvent) { $cycleRouteEvent.nexPosition } else { $null }) -Fallback '-'
            $pipelineRouteReason.Text = Get-DisplayValue -Value $(if ($null -ne $cycleRouteEvent) { $cycleRouteEvent.routeReason } else { $null }) -Fallback '-'
        }
        else {
            $pipelineStart.Text = '-'
            $pipelineTime.Text = '-'
            $pipelineDuration.Text = '-'
            $pipelineStage.Text = if ($pipelineSnapshot.InProgress) { 'Execucao em andamento; sem terminal anterior' } else { 'Indisponivel' }
            $pipelineCode.Text = '-'
            $pipelineRoute.Text = '-'
            $pipelinePosition.Text = '-'
            $pipelineRouteReason.Text = '-'
        }

        $currentRunSection.Box.Visible = $pipelineSnapshot.InProgress -and $null -ne $pipelineSnapshot.CurrentRun
        if ($currentRunSection.Box.Visible) {
            $currentRun = $pipelineSnapshot.CurrentRun
            $currentRunStart.Text = Format-DateTime -Value $currentRun.Start
            $currentRunStage.Text = Get-FriendlyStage -Stage $currentRun.LastRecord.stage
            $currentRouteEvent = $currentRun.RouteEvent
            $route = Get-DisplayValue -Value $(if ($null -ne $currentRouteEvent) { $currentRouteEvent.hybridRoute } else { $null }) -Fallback '-'
            $position = Get-DisplayValue -Value $(if ($null -ne $currentRouteEvent) { $currentRouteEvent.nexPosition } else { $null }) -Fallback '-'
            $currentRunRoute.Text = $route + ' / ' + $position
        }

        if ($exportSnapshot.Available) {
            $exportName.Text = $exportSnapshot.File.Name
            $exportTime.Text = Format-DateTime -Value $exportSnapshot.File.LastWriteTime
            $exportAge.Text = Format-FileAge -Time $exportSnapshot.File.LastWriteTime
            $exportSize.Text = Format-FileSize -Bytes $exportSnapshot.File.Length
        }
        else {
            $exportName.Text = 'Indisponivel'
            $exportTime.Text = '-'
            $exportAge.Text = '-'
            $exportSize.Text = '-'
        }

        $lastSuccess = $pipelineSnapshot.LastSuccess
        $lastSuccessTime.Text = if ($null -ne $lastSuccess) { Format-DateTime -Value $lastSuccess.timestamp } else { '-' }
        $lastSuccessFile.Text = if ($null -ne $lastSuccess) { Get-DisplayValue -Value $lastSuccess.fileName } else { '-' }
        $successExport = Get-SuccessExportSnapshot -Terminal $lastSuccess
        if ($successExport.Available) {
            $lastSuccessAge.Text = Format-FileAge -Time $successExport.File.LastWriteTime
            $lastSuccessSize.Text = Format-FileSize -Bytes $successExport.File.Length
        }
        else {
            $lastSuccessAge.Text = '-'
            $lastSuccessSize.Text = '-'
        }

        $blockSection.Box.Visible = $isG13Blocked
        if ($isG13Blocked) {
            $blockValue.Text = 'Exportacao bloqueada: existe arquivo pendente em EXPORT_STAGE.'
            if ($stageSnapshot.Count -eq 1) { $blockValue.Text += ' (' + $stageSnapshot.Files[0].Name + ')' }
        }

        $reason = if ($null -ne $terminal) {
            $terminalReason = Get-DisplayValue -Value $terminal.reason -Fallback ''
            $terminalCode = Get-DisplayValue -Value $terminal.errorCode -Fallback ''
            if ($terminalReason) { $terminalReason } elseif ($terminalCode) { $terminalCode } else { $overall.Detail }
        }
        else { $overall.Detail }
        $errorValue.Text = $reason
        $errorCodeValue.Text = if ($null -ne $terminal) { Get-DisplayValue -Value $terminal.errorCode } else { '-' }
        $errorSection.Box.Visible = $null -ne $terminal -and ($terminal.stage -ne 'Success' -or (Get-DisplayValue -Value $terminal.reason -Fallback ''))

        if ($pipelineSnapshot.InProgress) {
            $nextActionValue.Text = 'Execucao em andamento'
        }
        elseif ($isG13Blocked) {
            $nextActionValue.Text = 'Proxima tentativa bloqueada pelo G13'
        }
        elseif ($taskSnapshot.Available -and $taskSnapshot.Enabled -and $null -ne $taskSnapshot.NextRunTime) {
            $nextActionValue.Text = 'Aguardar proxima tentativa automatica as ' + ([datetime]$taskSnapshot.NextRunTime).ToString('HH:mm:ss')
        }
        else {
            $nextActionValue.Text = 'Nenhuma proxima acao objetiva disponivel'
        }

        $foregroundWindow = [PrimeNexMonitorReadOnlyWin32]::GetForegroundWindow()
        $foregroundWarning.Visible = ($foregroundWindow -eq $form.Handle) -and $nexSnapshot.Position -eq 'BACKGROUND'
        if ($foregroundWarning.Visible) {
            $foregroundWarning.Text = 'Monitor esta em primeiro plano. O NEX esta em BACKGROUND e um ciclo iniciado agora tendera a usar V2.'
        }

        $nextRefresh = (Get-Date).AddMilliseconds($script:RefreshMilliseconds)
        $updatedLabel.Text = 'Atualizado as ' + (Get-Date).ToString('dd/MM/yyyy HH:mm:ss') + '  |  Proxima atualizacao: ' + $nextRefresh.ToString('HH:mm:ss') + ' (' + (Format-Countdown -TargetTime $nextRefresh) + ')  |  Monitor V2  |  Agent runtime: ' + $script:AgentRuntimeId + '  |  Read-only'
    }
    catch {
        $statusTitle.Text = 'PROBLEMA'
        $statusTitle.ForeColor = [System.Drawing.Color]::FromArgb(190, 45, 55)
        $statusPanel.BackColor = [System.Drawing.Color]::FromArgb(252, 228, 230)
        $statusDetail.Text = 'Informacao indisponivel. Nenhuma acao corretiva foi executada.'
        $errorValue.Text = $_.Exception.Message
        $updatedLabel.Text = 'Falha de leitura em ' + (Get-Date).ToString('dd/MM/yyyy HH:mm:ss')
    }
    finally {
        $timer.Enabled = $true
    }
}

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = $script:RefreshMilliseconds
$timer.Add_Tick($refreshAction)
$form.Add_Shown($refreshAction)
$form.Add_FormClosed({
    $timer.Stop()
    $timer.Dispose()
    $guardianTimer.Stop()
    $guardianTimer.Dispose()
    if ($null -ne $script:GuardianProcess -and $script:GuardianProcess.HasExited) { $script:GuardianProcess.Dispose() }
})

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run($form)
