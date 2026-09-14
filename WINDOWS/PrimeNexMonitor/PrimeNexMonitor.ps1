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
$script:ExportStageDirectory = 'C:\Nex\PrimeIntegracaoNex\EXPORT_STAGE'
$script:AgentRuntimePath = 'C:\Nex\PrimeIntegracaoNex\WINDOWS\PrimeNexExportAgent\bin\Debug\net10.0-windows\PrimeNexExportAgent.exe'
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

function Get-AgentRuntimeId {
    try {
        $hash = (Get-FileHash -LiteralPath $script:AgentRuntimePath -Algorithm SHA256 -ErrorAction Stop).Hash
        if ([string]::IsNullOrWhiteSpace($hash)) { return 'indisponivel' }
        return $hash.Substring(0, [math]::Min(8, $hash.Length)) + '...'
    }
    catch { return 'indisponivel' }
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

function Format-Countdown {
    param([AllowNull()][object]$TargetTime)

    if ($null -eq $TargetTime) { return '-' }
    try {
        $remaining = ([datetime]$TargetTime) - (Get-Date)
        if ($remaining.TotalSeconds -le 0) { return 'agora' }
        [int64]$minutes = [math]::Floor($remaining.TotalMinutes)
        [int64]$seconds = [math]::Floor($remaining.TotalSeconds % 60)
        return ('faltam {0:D2}min {1:D2}s' -f $minutes, $seconds)
    }
    catch { return '-' }
}

function Format-Duration {
    param([AllowNull()][object]$StartTime, [AllowNull()][object]$EndTime)

    if ($null -eq $StartTime -or $null -eq $EndTime) { return '-' }
    try {
        $duration = ([datetimeoffset]$EndTime) - ([datetimeoffset]$StartTime)
        [int64]$totalSeconds = [math]::Max(0, [math]::Floor($duration.TotalSeconds))
        [int64]$totalMinutes = [math]::Floor($totalSeconds / 60)
        [int64]$seconds = $totalSeconds % 60
        return ('{0:D2}:{1:D2}' -f $totalMinutes, $seconds)
    }
    catch { return '-' }
}

function Get-FriendlyStage {
    param([AllowNull()][object]$Stage)

    switch (Get-DisplayValue -Value $Stage -Fallback '') {
        'ExportTriggered' { return 'Exportacao iniciada' }
        'SaveDialogIdentified' { return 'Janela de salvamento identificada' }
        'SaveDialogConfigured' { return 'Salvamento configurado' }
        'FileSaveTriggered' { return 'Salvando arquivo' }
        'FileStable' { return 'Arquivo estabilizado' }
        'ReaderValidated' { return 'XLS validado' }
        'Published' { return 'Arquivo publicado' }
        default { return (Get-DisplayValue -Value $Stage) }
    }
}

function Format-FileAge {
    param([AllowNull()][object]$Time)

    if ($null -eq $Time) { return '-' }
    try {
        $age = (Get-Date) - ([datetime]$Time)
        if ($age.TotalMinutes -lt 1) { return 'ha menos de 1 min' }
        if ($age.TotalHours -lt 1) { return ('ha {0:N0} min' -f [math]::Floor($age.TotalMinutes)) }
        return ('ha {0:N0} h {1:D2} min' -f [math]::Floor($age.TotalHours), $age.Minutes)
    }
    catch { return '-' }
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
        LastSuccess      = $null
        LatestCycle      = $null
        CurrentRun       = $null
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
        $successRunIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        $terminalRunRecords = @{}
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
                    $terminalRunRecords[$runId] = @($fileRecords | Where-Object { (Get-DisplayValue -Value $_.runId -Fallback '') -eq $runId })
                }
                if ($runId -and $stage -eq 'Success' -and $successRunIds.Add($runId) -and $null -eq $result.LastSuccess) {
                    $result.LastSuccess = $record
                }
                if ($terminalRecords.Count -ge 2 -and $null -ne $result.LastSuccess) { break }
            }

            if ($terminalRecords.Count -ge 2 -and $null -ne $result.LastSuccess) { break }
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
            $terminalRunId = Get-DisplayValue -Value $result.LatestTerminal.runId -Fallback ''
            $cycleEvents = @($terminalRunRecords[$terminalRunId] | Sort-Object { [datetimeoffset]$_.timestamp })
            if ($cycleEvents.Count -gt 0) {
                $routeEvent = @($cycleEvents | Where-Object { Get-DisplayValue -Value $_.hybridRoute -Fallback '' } | Select-Object -Last 1)
                $result.LatestCycle = [pscustomobject]@{
                    Start = $cycleEvents[0].timestamp
                    End = $result.LatestTerminal.timestamp
                    Events = $cycleEvents
                    Terminal = $result.LatestTerminal
                    RouteEvent = if ($routeEvent.Count -gt 0) { $routeEvent[0] } else { $null }
                }
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
            if ($result.InProgress -and $lastRunId) {
                $runEvents = @($latestFileRecords | Where-Object { (Get-DisplayValue -Value $_.runId -Fallback '') -eq $lastRunId } | Sort-Object { [datetimeoffset]$_.timestamp })
                $routeEvent = @($runEvents | Where-Object { Get-DisplayValue -Value $_.hybridRoute -Fallback '' } | Select-Object -Last 1)
                $result.CurrentRun = [pscustomobject]@{
                    Start = if ($runEvents.Count -gt 0) { $runEvents[0].timestamp } else { $null }
                    LastRecord = $lastRecord
                    RouteEvent = if ($routeEvent.Count -gt 0) { $routeEvent[0] } else { $null }
                }
            }
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

function Get-ExportStageSnapshot {
    try {
        $files = @(Get-ChildItem -LiteralPath $script:ExportStageDirectory -File -ErrorAction Stop | Sort-Object LastWriteTime -Descending)
        return [pscustomobject]@{ Available = $true; Count = $files.Count; Files = $files; Error = $null }
    }
    catch {
        return [pscustomobject]@{ Available = $false; Count = 0; Files = @(); Error = $_.Exception.Message }
    }
}

function Get-SuccessExportSnapshot {
    param([AllowNull()][object]$Terminal)

    if ($null -eq $Terminal) { return [pscustomobject]@{ Available = $false; File = $null } }
    $fileName = Get-DisplayValue -Value $Terminal.fileName -Fallback ''
    if ([string]::IsNullOrWhiteSpace($fileName)) { return [pscustomobject]@{ Available = $false; File = $null } }
    try {
        $file = Get-Item -LiteralPath (Join-Path $script:ExportDirectory $fileName) -ErrorAction Stop
        return [pscustomobject]@{ Available = $true; File = $file }
    }
    catch { return [pscustomobject]@{ Available = $false; File = $null } }
}

function Test-G13CurrentBlock {
    param([object]$Stage, [object]$Pipeline)

    if (-not $Stage.Available -or $Stage.Count -eq 0 -or $null -eq $Pipeline.LatestCycle) { return $false }
    $terminal = $Pipeline.LatestCycle.Terminal
    $hasSafeState = @($Pipeline.LatestCycle.Events | Where-Object { $_.stage -eq 'SafeStateValidated' }).Count -gt 0
    $hasExport = @($Pipeline.LatestCycle.Events | Where-Object { $_.stage -eq 'ExportTriggered' }).Count -gt 0
    return $hasSafeState -and -not $hasExport -and $terminal.stage -eq 'Failed' -and $terminal.errorCode -eq 'UnsafeState'
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
