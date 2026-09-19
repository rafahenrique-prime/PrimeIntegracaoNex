#requires -Version 5.1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Funcoes de leitura e constantes vivem no Core para permitir dot-source em teste.
. (Join-Path $PSScriptRoot 'PrimeNexMonitor.Core.ps1')

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
$rightColumn.AutoScroll = $false
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

$rightColumn.Controls.Add($pipelineSection.Box)
$rightColumn.Controls.Add($exportSection.Box)
$rightColumn.Controls.Add($lastSuccessSection.Box)
$rightColumn.Controls.Add($blockSection.Box)
$rightColumn.Controls.Add($errorSection.Box)
$rightColumn.Controls.SetChildIndex($pipelineSection.Box, 4)
$rightColumn.Controls.SetChildIndex($exportSection.Box, 3)
$rightColumn.Controls.SetChildIndex($lastSuccessSection.Box, 2)
$rightColumn.Controls.SetChildIndex($blockSection.Box, 1)
$rightColumn.Controls.SetChildIndex($errorSection.Box, 0)

$script:AgentRuntimeId = Get-AgentRuntimeId
$updatedLabel = [System.Windows.Forms.Label]::new()
$updatedLabel.Dock = 'Bottom'
$updatedLabel.Height = 25
$updatedLabel.TextAlign = 'MiddleRight'
$updatedLabel.ForeColor = [System.Drawing.Color]::FromArgb(100, 108, 120)

$root.Controls.Add($statusPanel)
$root.Controls.Add($currentRunSection.Box)
$root.Controls.Add($content)
$root.Controls.Add($updatedLabel)
$root.Controls.SetChildIndex($statusPanel, 3)
$root.Controls.SetChildIndex($currentRunSection.Box, 2)
$root.Controls.SetChildIndex($content, 1)
$root.Controls.SetChildIndex($updatedLabel, 0)

$refreshAction = {
    $timer.Enabled = $false
    try {
        $taskSnapshot = Get-TaskSnapshot
        $pipelineSnapshot = Get-PipelineSnapshot
        $exportSnapshot = Get-ExportSnapshot
        $stageSnapshot = Get-ExportStageSnapshot
        $nexSnapshot = Get-NexSnapshot
        $overall = Get-OverallStatus -Task $taskSnapshot -Pipeline $pipelineSnapshot -Export $exportSnapshot -Nex $nexSnapshot

        $palette = switch ($overall.Level) {
            'NORMAL'   { @([System.Drawing.Color]::FromArgb(25, 135, 84), [System.Drawing.Color]::FromArgb(225, 244, 234)) }
            'ATENCAO'  { @([System.Drawing.Color]::FromArgb(164, 112, 0), [System.Drawing.Color]::FromArgb(255, 244, 204)) }
            default    { @([System.Drawing.Color]::FromArgb(190, 45, 55), [System.Drawing.Color]::FromArgb(252, 228, 230)) }
        }
        $statusTitle.Text = $overall.Level
        $statusTitle.ForeColor = $palette[0]
        $statusPanel.BackColor = $palette[1]
        $statusDetail.Text = $overall.Detail

        $nexState.Text = if ($nexSnapshot.Position -eq 'CLOSED') { 'Fechado' } elseif ($nexSnapshot.Available) { 'Aberto' } else { 'Indisponivel' }
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

        $isG13Blocked = Test-G13CurrentBlock -Stage $stageSnapshot -Pipeline $pipelineSnapshot
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
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run($form)
