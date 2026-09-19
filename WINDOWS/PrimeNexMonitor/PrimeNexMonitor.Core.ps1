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
