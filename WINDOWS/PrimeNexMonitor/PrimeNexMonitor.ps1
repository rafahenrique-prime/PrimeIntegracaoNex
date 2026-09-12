#requires -Version 5.1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# This type intentionally exposes query-only Win32 functions.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PrimeNexMonitorReadOnlyWin32
{
    public delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr window, StringBuilder className, int capacity);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    public static List<IntPtr> GetTopLevelWindows()
    {
        var windows = new List<IntPtr>();
        EnumWindows((window, parameter) =>
        {
            windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    public static string QueryClassName(IntPtr window)
    {
        var className = new StringBuilder(512);
        GetClassName(window, className, className.Capacity);
        return className.ToString();
    }

    public static int QueryProcessId(IntPtr window)
    {
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        return unchecked((int)processId);
    }
}
'@

$script:TaskName = 'PrimeNexVendasExport'
$script:LogDirectory = 'C:\Nex\PrimeIntegracaoNex\LOGS'
$script:ExportDirectory = 'C:\Nex\PrimeIntegracaoNex\EXPORTADOS'
$script:ExpectedNexPath = 'C:\Nex\NexAdmin.exe'
$script:RefreshMilliseconds = 12000
$script:StaleExportMinutes = 15
$script:TerminalStages = @(
    'Success',
    'Failed',
    'SkippedBusy',
    'SkippedSessionUnavailable',
    'NexNotFound',
    'UnsafeState',
    'SkippedNotForeground',
    'NEX_CLOSED',
    'NEX_MINIMIZED',
    'NEX_BLOCKING_UNKNOWN'
)
$script:UnsafeCodes = @('UnsafeState', 'NEX_CLOSED', 'NEX_MINIMIZED')

function Get-DisplayValue {
    param(
        [AllowNull()]
        [object]$Value,
        [string]$Fallback = '-'
    )

    if ($null -eq $Value) { return $Fallback }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $Fallback }
    return $text
}

function Format-DateTime {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return '-' }
    try { return ([datetime]$Value).ToString('dd/MM/yyyy HH:mm:ss') }
    catch { return (Get-DisplayValue -Value $Value) }
}

function Format-FileSize {
    param([AllowNull()][object]$Bytes)

    if ($null -eq $Bytes) { return '-' }
    $size = [double]$Bytes
    if ($size -ge 1MB) { return ('{0:N1} MB' -f ($size / 1MB)) }
    if ($size -ge 1KB) { return ('{0:N1} KB' -f ($size / 1KB)) }
    return ('{0:N0} bytes' -f $size)
}

function Get-TaskSnapshot {
    try {
        $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop
        $taskInfo = Get-ScheduledTaskInfo -TaskName $script:TaskName -ErrorAction Stop
        return [pscustomobject]@{
            Available      = $true
            Enabled        = [bool]$task.Settings.Enabled
            State          = [string]$task.State
            LastRunTime    = $taskInfo.LastRunTime
            LastTaskResult = $taskInfo.LastTaskResult
            NextRunTime    = $taskInfo.NextRunTime
            Error          = $null
        }
    }
    catch {
        return [pscustomobject]@{
            Available      = $false
            Enabled        = $null
            State          = 'Indisponivel'
            LastRunTime    = $null
            LastTaskResult = $null
            NextRunTime    = $null
            Error          = $_.Exception.Message
        }
    }
}

function Get-PipelineSnapshot {
    $result = [ordered]@{
        Available       = $false
        LogPath         = $null
        LatestTerminal  = $null
        PreviousTerminal = $null
        InProgress      = $false
        InvalidLines    = 0
        Error           = $null
    }

    try {
        $logFiles = @(Get-ChildItem -LiteralPath $script:LogDirectory -File -Filter 'prime-nex-export-agent-scheduled-*.jsonl' -ErrorAction Stop |
            Sort-Object LastWriteTime -Descending)

        if ($logFiles.Count -eq 0) {
            $result.Error = 'Nenhum JSONL encontrado.'
            return [pscustomobject]$result
        }

        $result.LogPath = $logFiles[0].FullName
        $latestFileRecords = [System.Collections.Generic.List[object]]::new()
        $terminalRecords = [System.Collections.Generic.List[object]]::new()
        $terminalRunIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        $validRecordCount = 0

        foreach ($logFile in $logFiles) {
            $fileRecords = [System.Collections.Generic.List[object]]::new()
            $stream = $null
            $reader = $null

            try {
                $stream = [System.IO.FileStream]::new(
                    $logFile.FullName,
                    [System.IO.FileMode]::Open,
                    [System.IO.FileAccess]::Read,
                    [System.IO.FileShare]::ReadWrite
                )
                $reader = [System.IO.StreamReader]::new($stream)

                while (-not $reader.EndOfStream) {
                    $line = $reader.ReadLine()
                    if ([string]::IsNullOrWhiteSpace($line)) { continue }
                    try { $fileRecords.Add(($line | ConvertFrom-Json -ErrorAction Stop)) }
                    catch { $result.InvalidLines++ }
                }
            }
            finally {
                if ($null -ne $reader) { $reader.Dispose() }
                elseif ($null -ne $stream) { $stream.Dispose() }
            }

            $validRecordCount += $fileRecords.Count
            if ($logFile.FullName -eq $logFiles[0].FullName) {
                $latestFileRecords = $fileRecords
            }

            for ($index = $fileRecords.Count - 1; $index -ge 0; $index--) {
                $record = $fileRecords[$index]
                $runId = Get-DisplayValue -Value $record.runId -Fallback ''
                $stage = Get-DisplayValue -Value $record.stage -Fallback ''
                if ($runId -and ($script:TerminalStages -contains $stage) -and $terminalRunIds.Add($runId)) {
                    $terminalRecords.Add($record)
                }
                if ($terminalRecords.Count -ge 2) { break }
            }

            if ($terminalRecords.Count -ge 2) { break }
        }

        if ($validRecordCount -eq 0) {
            $result.Error = 'JSONL sem linhas validas.'
            return [pscustomobject]$result
        }

        $terminalRecords = @($terminalRecords | Sort-Object { [datetimeoffset]$_.timestamp })
        if ($terminalRecords.Count -gt 0) {
            $result.LatestTerminal = $terminalRecords[-1]
            if ($terminalRecords.Count -gt 1) {
                $result.PreviousTerminal = $terminalRecords[-2]
            }
        }

        if ($latestFileRecords.Count -gt 0) {
            $lastRecord = $latestFileRecords[$latestFileRecords.Count - 1]
            $lastRunId = Get-DisplayValue -Value $lastRecord.runId -Fallback ''
            $terminalRunId = if ($null -ne $result.LatestTerminal) {
                Get-DisplayValue -Value $result.LatestTerminal.runId -Fallback ''
            } else { '' }
            $lastStage = Get-DisplayValue -Value $lastRecord.stage -Fallback ''
            $result.InProgress = ($lastRunId -ne $terminalRunId) -and -not ($script:TerminalStages -contains $lastStage)
        }
        $result.Available = $null -ne $result.LatestTerminal

        if (-not $result.Available -and -not $result.InProgress) {
            $result.Error = 'Nenhum resultado terminal encontrado.'
        }
    }
    catch {
        $result.Error = $_.Exception.Message
    }

    return [pscustomobject]$result
}

function Get-ExportSnapshot {
    try {
        $file = Get-ChildItem -LiteralPath $script:ExportDirectory -File -ErrorAction Stop |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1

        if ($null -eq $file) {
            return [pscustomobject]@{ Available = $false; File = $null; IsStale = $true; Error = 'Nenhum arquivo exportado.' }
        }

        return [pscustomobject]@{
            Available = $true
            File      = $file
            IsStale   = ((Get-Date) - $file.LastWriteTime).TotalMinutes -gt $script:StaleExportMinutes
            Error     = $null
        }
    }
    catch {
        return [pscustomobject]@{ Available = $false; File = $null; IsStale = $true; Error = $_.Exception.Message }
    }
}

function Get-NexSnapshot {
    $result = [ordered]@{
        Available    = $false
        ProcessCount = 0
        ValidPids    = @()
        Position     = 'UNKNOWN'
        MainWindow   = $null
        Application  = $null
        Error        = $null
    }

    try {
        $processes = @(Get-CimInstance Win32_Process -Filter "Name='NexAdmin.exe'" -ErrorAction Stop)
        $result.ProcessCount = $processes.Count
        $validProcesses = @($processes | Where-Object {
            $_.ExecutablePath -and
            [string]::Equals($_.ExecutablePath, $script:ExpectedNexPath, [System.StringComparison]::OrdinalIgnoreCase)
        })

        $result.ValidPids = @($validProcesses | ForEach-Object { [int]$_.ProcessId })
        if ($validProcesses.Count -eq 0) {
            $result.Available = $true
            $result.Position = 'CLOSED'
            return [pscustomobject]$result
        }

        $windows = [System.Collections.Generic.List[object]]::new()
        foreach ($handle in [PrimeNexMonitorReadOnlyWin32]::GetTopLevelWindows()) {
            $windowPid = [PrimeNexMonitorReadOnlyWin32]::QueryProcessId($handle)
            if ($result.ValidPids -notcontains $windowPid) { continue }

            $windows.Add([pscustomobject]@{
                Handle    = $handle
                ProcessId = $windowPid
                ClassName = [PrimeNexMonitorReadOnlyWin32]::QueryClassName($handle)
                Owner     = [PrimeNexMonitorReadOnlyWin32]::GetWindow($handle, 4)
                Visible   = [PrimeNexMonitorReadOnlyWin32]::IsWindowVisible($handle)
                Iconic    = [PrimeNexMonitorReadOnlyWin32]::IsIconic($handle)
                IsWindow  = [PrimeNexMonitorReadOnlyWin32]::IsWindow($handle)
            })
        }

        $candidates = [System.Collections.Generic.List[object]]::new()
        foreach ($validProcess in $validProcesses) {
            $processId = [int]$validProcess.ProcessId
            $applications = @($windows | Where-Object {
                $_.ProcessId -eq $processId -and
                $_.IsWindow -and
                $_.Owner -eq [IntPtr]::Zero -and
                [string]::Equals($_.ClassName, 'TApplication', [System.StringComparison]::OrdinalIgnoreCase)
            })
            $mainWindows = @($windows | Where-Object {
                $_.ProcessId -eq $processId -and
                $_.IsWindow -and
                $_.Visible -and
                [string]::Equals($_.ClassName, 'TfrmPri', [System.StringComparison]::OrdinalIgnoreCase)
            })

            if ($applications.Count -eq 1 -and $mainWindows.Count -eq 1) {
                $candidates.Add([pscustomobject]@{
                    ProcessId  = $processId
                    Application = $applications[0]
                    MainWindow = $mainWindows[0]
                })
            }
        }

        $result.Available = $true
        if ($candidates.Count -ne 1) {
            $result.Position = 'UNKNOWN'
            return [pscustomobject]$result
        }

        $candidate = $candidates[0]
        $result.Application = $candidate.Application
        $result.MainWindow = $candidate.MainWindow

        if ($candidate.Application.Iconic) {
            $result.Position = 'MINIMIZED'
            return [pscustomobject]$result
        }

        $foregroundWindow = [PrimeNexMonitorReadOnlyWin32]::GetForegroundWindow()
        $foregroundPid = [PrimeNexMonitorReadOnlyWin32]::QueryProcessId($foregroundWindow)
        if ($foregroundWindow -eq $candidate.MainWindow.Handle -or $foregroundPid -eq $candidate.ProcessId) {
            $result.Position = 'FOREGROUND'
        }
        else {
            $result.Position = 'BACKGROUND'
        }
    }
    catch {
        $result.Error = $_.Exception.Message
        $result.Position = 'UNKNOWN'
    }

    return [pscustomobject]$result
}

function Get-TerminalCode {
    param([AllowNull()][object]$Record)

    if ($null -eq $Record) { return '' }
    $stage = Get-DisplayValue -Value $Record.stage -Fallback ''
    $errorCode = Get-DisplayValue -Value $Record.errorCode -Fallback ''
    if ($stage -eq 'Failed' -and $errorCode) { return $errorCode }
    return $stage
}

function Get-OverallStatus {
    param(
        [object]$Task,
        [object]$Pipeline,
        [object]$Export,
        [object]$Nex
    )

    $level = 'NORMAL'
    $details = [System.Collections.Generic.List[string]]::new()

    if (-not $Task.Available) {
        $level = 'PROBLEMA'
        $details.Add('Task indisponivel')
    }
    elseif (-not $Task.Enabled) {
        $level = 'ATENCAO'
        $details.Add('Task desabilitada')
    }

    if (-not $Nex.Available -or $Nex.Position -eq 'UNKNOWN') {
        if ($level -eq 'NORMAL') { $level = 'ATENCAO' }
        $details.Add('Estado do NEX desconhecido')
    }
    elseif ($Nex.Position -eq 'CLOSED') {
        if ($level -eq 'NORMAL') { $level = 'ATENCAO' }
        $details.Add('NEX fechado')
    }
    elseif ($Nex.Position -eq 'MINIMIZED') {
        if ($level -eq 'NORMAL') { $level = 'ATENCAO' }
        $details.Add('NEX minimizado')
    }

    if (-not $Pipeline.Available) {
        if ($level -eq 'NORMAL') { $level = 'ATENCAO' }
        $details.Add('Resultado do pipeline indisponivel')
    }
    else {
        $code = Get-TerminalCode -Record $Pipeline.LatestTerminal
        switch ($code) {
            'Success' { }
            'NEX_BLOCKING_UNKNOWN' {
                $level = 'PROBLEMA'
                $details.Add('NEX em estado bloqueante desconhecido')
            }
            'UnsafeState' {
                $previousCode = Get-TerminalCode -Record $Pipeline.PreviousTerminal
                if ($previousCode -eq 'UnsafeState' -and $Export.IsStale) {
                    $level = 'PROBLEMA'
                    $details.Add('UnsafeState persistente e exportacao atrasada')
                }
                elseif ($level -eq 'NORMAL') {
                    $level = 'ATENCAO'
                    $details.Add('UnsafeState isolado')
                }
            }
            { $script:UnsafeCodes -contains $_ } {
                if ($level -eq 'NORMAL') { $level = 'ATENCAO' }
                $details.Add($_)
            }
            { @('SkippedBusy', 'SkippedSessionUnavailable', 'SkippedNotForeground', 'NexNotFound') -contains $_ } {
                if ($level -eq 'NORMAL') { $level = 'ATENCAO' }
                $details.Add($_)
            }
            default {
                $level = 'PROBLEMA'
                $details.Add(('Falha do pipeline: ' + (Get-DisplayValue -Value $code -Fallback 'desconhecida')))
            }
        }
    }

    if (-not $Export.Available) {
        if ($level -eq 'NORMAL') { $level = 'ATENCAO' }
        $details.Add('Arquivo exportado indisponivel')
    }
    elseif ($Export.IsStale -and $level -eq 'NORMAL') {
        $level = 'ATENCAO'
        $details.Add('Ultimo XLS com mais de 15 minutos')
    }

    if ($Pipeline.InProgress) {
        $details.Add('Execucao em andamento')
    }

    if ($details.Count -eq 0) { $details.Add('Leituras coerentes e ultimo pipeline concluido com sucesso') }
    return [pscustomobject]@{ Level = $level; Detail = ($details -join ' | ') }
}

function New-ValueLabel {
    $label = [System.Windows.Forms.Label]::new()
    $label.AutoSize = $true
    $label.Font = [System.Drawing.Font]::new('Segoe UI', 9.5)
    $label.ForeColor = [System.Drawing.Color]::FromArgb(35, 42, 52)
    $label.Margin = [System.Windows.Forms.Padding]::new(3, 5, 3, 5)
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
    $box.Margin = [System.Windows.Forms.Padding]::new(0, 0, 0, 8)

    $table = [System.Windows.Forms.TableLayoutPanel]::new()
    $table.Dock = 'Fill'
    $table.ColumnCount = 2
    [void]$table.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Absolute, 150))
    [void]$table.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
    $box.Controls.Add($table)
    return [pscustomobject]@{ Box = $box; Table = $table }
}

$form = [System.Windows.Forms.Form]::new()
$form.Text = 'PRIME NEX Monitor V1'
$form.StartPosition = 'CenterScreen'
$form.Size = [System.Drawing.Size]::new(670, 690)
$form.MinimumSize = [System.Drawing.Size]::new(620, 650)
$form.BackColor = [System.Drawing.Color]::FromArgb(244, 246, 249)
$form.Font = [System.Drawing.Font]::new('Segoe UI', 9.5)

$root = [System.Windows.Forms.Panel]::new()
$root.Dock = 'Fill'
$root.Padding = [System.Windows.Forms.Padding]::new(16)
$root.AutoScroll = $true
$form.Controls.Add($root)

$statusPanel = [System.Windows.Forms.Panel]::new()
$statusPanel.Dock = 'Top'
$statusPanel.Height = 90
$statusPanel.Padding = [System.Windows.Forms.Padding]::new(14, 10, 14, 8)
$root.Controls.Add($statusPanel)

$statusTitle = [System.Windows.Forms.Label]::new()
$statusTitle.AutoSize = $true
$statusTitle.Font = [System.Drawing.Font]::new('Segoe UI Semibold', 20)
$statusTitle.Text = 'CARREGANDO'
$statusPanel.Controls.Add($statusTitle)

$statusDetail = [System.Windows.Forms.Label]::new()
$statusDetail.AutoEllipsis = $true
$statusDetail.Location = [System.Drawing.Point]::new(17, 52)
$statusDetail.Size = [System.Drawing.Size]::new(600, 24)
$statusDetail.Font = [System.Drawing.Font]::new('Segoe UI', 9)
$statusPanel.Controls.Add($statusDetail)

$updatedLabel = [System.Windows.Forms.Label]::new()
$updatedLabel.Dock = 'Bottom'
$updatedLabel.Height = 25
$updatedLabel.TextAlign = 'MiddleRight'
$updatedLabel.ForeColor = [System.Drawing.Color]::FromArgb(100, 108, 120)
$root.Controls.Add($updatedLabel)

$errorSection = New-Section -Title 'ULTIMO ERRO / MOTIVO' -Height 78
$errorValue = Add-InformationRow -Table $errorSection.Table -Caption 'Resumo' -Name 'ErrorSummary'
$root.Controls.Add($errorSection.Box)

$exportSection = New-Section -Title 'ULTIMO ARQUIVO EXPORTADO' -Height 112
$exportName = Add-InformationRow -Table $exportSection.Table -Caption 'Arquivo' -Name 'ExportName'
$exportTime = Add-InformationRow -Table $exportSection.Table -Caption 'Data/hora' -Name 'ExportTime'
$exportSize = Add-InformationRow -Table $exportSection.Table -Caption 'Tamanho' -Name 'ExportSize'
$root.Controls.Add($exportSection.Box)

$pipelineSection = New-Section -Title 'ULTIMA EXECUCAO DO PIPELINE' -Height 142
$pipelineTime = Add-InformationRow -Table $pipelineSection.Table -Caption 'Timestamp' -Name 'PipelineTime'
$pipelineStage = Add-InformationRow -Table $pipelineSection.Table -Caption 'Stage' -Name 'PipelineStage'
$pipelineCode = Add-InformationRow -Table $pipelineSection.Table -Caption 'Error code' -Name 'PipelineCode'
$pipelineReason = Add-InformationRow -Table $pipelineSection.Table -Caption 'Reason' -Name 'PipelineReason'
$root.Controls.Add($pipelineSection.Box)

$taskSection = New-Section -Title 'TASK' -Height 142
$taskEnabled = Add-InformationRow -Table $taskSection.Table -Caption 'Status' -Name 'TaskEnabled'
$taskState = Add-InformationRow -Table $taskSection.Table -Caption 'Estado' -Name 'TaskState'
$taskLast = Add-InformationRow -Table $taskSection.Table -Caption 'Ultima execucao' -Name 'TaskLast'
$taskResult = Add-InformationRow -Table $taskSection.Table -Caption 'LastTaskResult' -Name 'TaskResult'
$taskNext = Add-InformationRow -Table $taskSection.Table -Caption 'Proxima execucao' -Name 'TaskNext'
$root.Controls.Add($taskSection.Box)

$nexSection = New-Section -Title 'NEX' -Height 90
$nexState = Add-InformationRow -Table $nexSection.Table -Caption 'Estado' -Name 'NexState'
$nexPosition = Add-InformationRow -Table $nexSection.Table -Caption 'Posicao' -Name 'NexPosition'
$root.Controls.Add($nexSection.Box)

# Dock=Top lays out in reverse insertion order; restore the intended visual order.
$root.Controls.SetChildIndex($statusPanel, 5)
$root.Controls.SetChildIndex($nexSection.Box, 4)
$root.Controls.SetChildIndex($taskSection.Box, 3)
$root.Controls.SetChildIndex($pipelineSection.Box, 2)
$root.Controls.SetChildIndex($exportSection.Box, 1)
$root.Controls.SetChildIndex($errorSection.Box, 0)
$root.Controls.SetChildIndex($updatedLabel, 6)

$refreshAction = {
    $timer.Enabled = $false
    try {
        $taskSnapshot = Get-TaskSnapshot
        $pipelineSnapshot = Get-PipelineSnapshot
        $exportSnapshot = Get-ExportSnapshot
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

        $taskEnabled.Text = if (-not $taskSnapshot.Available) { 'Indisponivel' } elseif ($taskSnapshot.Enabled) { 'Ativa' } else { 'Desabilitada' }
        $taskState.Text = Get-DisplayValue -Value $taskSnapshot.State
        $taskLast.Text = Format-DateTime -Value $taskSnapshot.LastRunTime
        $taskResult.Text = Get-DisplayValue -Value $taskSnapshot.LastTaskResult
        $taskNext.Text = Format-DateTime -Value $taskSnapshot.NextRunTime

        $terminal = $pipelineSnapshot.LatestTerminal
        if ($null -ne $terminal) {
            $pipelineTime.Text = Format-DateTime -Value $terminal.timestamp
            $pipelineStage.Text = Get-DisplayValue -Value $terminal.stage
            if ($pipelineSnapshot.InProgress) { $pipelineStage.Text += ' (nova execucao em andamento)' }
            $pipelineCode.Text = Get-DisplayValue -Value $terminal.errorCode
            $pipelineReason.Text = Get-DisplayValue -Value $terminal.reason
        }
        else {
            $pipelineTime.Text = '-'
            $pipelineStage.Text = if ($pipelineSnapshot.InProgress) { 'Execucao em andamento; sem terminal anterior' } else { 'Indisponivel' }
            $pipelineCode.Text = '-'
            $pipelineReason.Text = Get-DisplayValue -Value $pipelineSnapshot.Error
        }

        if ($exportSnapshot.Available) {
            $exportName.Text = $exportSnapshot.File.Name
            $exportTime.Text = Format-DateTime -Value $exportSnapshot.File.LastWriteTime
            $exportSize.Text = Format-FileSize -Bytes $exportSnapshot.File.Length
        }
        else {
            $exportName.Text = 'Indisponivel'
            $exportTime.Text = '-'
            $exportSize.Text = '-'
        }

        $reason = if ($null -ne $terminal) {
            $terminalReason = Get-DisplayValue -Value $terminal.reason -Fallback ''
            $terminalCode = Get-DisplayValue -Value $terminal.errorCode -Fallback ''
            if ($terminalReason) { $terminalReason } elseif ($terminalCode) { $terminalCode } else { $overall.Detail }
        }
        else { $overall.Detail }
        $errorValue.Text = $reason
        $updatedLabel.Text = 'Atualizado em ' + (Get-Date).ToString('dd/MM/yyyy HH:mm:ss') + '  |  refresh 12s'
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
