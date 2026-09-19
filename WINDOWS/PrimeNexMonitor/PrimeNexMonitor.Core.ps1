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

$script:NodeExePath = 'C:\Program Files\nodejs\node.exe'
$script:OutboxDbPath = 'C:\Nex\PrimeIntegracaoNex\OUTPUT\integracao-nex.db'
$script:OutboxQueryTimeoutMs = 3000
$script:OutboxRefreshMilliseconds = 60000
$script:OutboxUnavailableGraceReads = 3
$script:TransientGraceMinutes = 2
$script:OutboxOpenActionMinutes = 10
$script:StageActionMinutes = 30
$script:SuccessAttentionCycles = 3
$script:SuccessActionCycles = 10
$script:ErrorDetailMaxChars = 200
$script:OutboxOpenStates = @('PENDING', 'RETRY', 'SENDING', 'FAILED')
$script:CycleFileNamePattern = '^vendas-auto-\d{8}-\d{6}\.(xls|csv)$'

# Ciclos que indicam "o sistema estava pronto e mesmo assim nao exportou".
# NEX_CLOSED/NEX_MINIMIZED/NexNotFound/SkippedBusy/SkippedSessionUnavailable/
# SkippedNotForeground ficam de fora de proposito: nao contam e nao zeram, para
# que noite e usuario operando o NEX nunca virem alarme.
$script:AnomalousStages = @('UnsafeState', 'Failed', 'NEX_BLOCKING_UNKNOWN')

# Somente SELECT. O caminho do banco chega por argv (node le o script por stdin,
# entao argv[2]), nunca concatenado no texto. Ver Get-OutboxSnapshot.
$script:OutboxQueryScript = @'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const out = {
  byStatus: db.prepare("SELECT status, COUNT(*) n FROM outbox GROUP BY status").all(),
  oldestOpen: db.prepare("SELECT event_id, nex_transaction_id, status, tentativas, created_at, updated_at, ultimo_erro FROM outbox WHERE status IN ('PENDING','RETRY','SENDING','FAILED') ORDER BY created_at ASC LIMIT 1").get() ?? null,
  lastDone: db.prepare("SELECT event_id, status, result, http_status, updated_at FROM outbox WHERE status IN ('SENT','REVIEW_STORED') ORDER BY updated_at DESC LIMIT 1").get() ?? null
};
db.close();
process.stdout.write(JSON.stringify(out));
'@

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
        AnomalousStreak = 0
        StreakDominantCode = $null
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
        # Streak calculado no mesmo laco, do terminal mais recente para tras.
        # Fecha no primeiro Success; estagios neutros nao contam e nao zeram.
        $streakClosed = $false
        $streakCodes = @{}

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

                    if (-not $streakClosed) {
                        if ($stage -eq 'Success') {
                            $streakClosed = $true
                        }
                        elseif ($script:AnomalousStages -contains $stage) {
                            $result.AnomalousStreak++
                            $code = Get-TerminalCode -Record $record
                            $streakCodes[$code] = 1 + $(if ($streakCodes.ContainsKey($code)) { $streakCodes[$code] } else { 0 })
                        }
                    }
                }
                if ($runId -and $stage -eq 'Success' -and $successRunIds.Add($runId) -and $null -eq $result.LastSuccess) {
                    $result.LastSuccess = $record
                }
                if ($terminalRecords.Count -ge 2 -and $null -ne $result.LastSuccess) { break }
            }

            if ($terminalRecords.Count -ge 2 -and $null -ne $result.LastSuccess) { break }
        }

        if ($streakCodes.Count -gt 0) {
            $result.StreakDominantCode = ($streakCodes.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 1).Key
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
    param([string]$Directory = $script:ExportStageDirectory)

    try {
        $files = @(Get-ChildItem -LiteralPath $Directory -File -ErrorAction Stop | Sort-Object LastWriteTime -Descending)
        $oldest = if ($files.Count -gt 0) { $files[-1] } else { $null }
        $oldestAge = if ($null -ne $oldest) { ((Get-Date) - $oldest.LastWriteTime).TotalMinutes } else { $null }
        $unexpected = @($files | Where-Object { $_.Name -notmatch $script:CycleFileNamePattern })
        return [pscustomobject]@{
            Available        = $true
            Count            = $files.Count
            Files            = $files
            Oldest           = $oldest
            OldestAgeMinutes = $oldestAge
            # Measure-Object sobre pipeline VAZIO retorna $null no PowerShell 5.1
            # (nao um objeto com Sum = 0); sob Set-StrictMode, ler .Sum de $null
            # lanca "A propriedade 'Sum' nao foi encontrada neste objeto".
            TotalBytes       = $(if ($files.Count -gt 0) { ($files | Measure-Object -Property Length -Sum).Sum } else { 0 })
            UnexpectedNames  = @($unexpected | ForEach-Object { $_.Name })
            Error            = $null
        }
    }
    catch {
        return [pscustomobject]@{
            Available        = $false
            Count            = 0
            Files            = @()
            Oldest           = $null
            OldestAgeMinutes = $null
            TotalBytes       = 0
            UnexpectedNames  = @()
            Error            = $_.Exception.Message
        }
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

function Get-OutboxStatusCount {
    param([object]$Outbox, [string]$Status)

    if ($null -eq $Outbox -or $null -eq $Outbox.Counts) { return 0 }
    if ($Outbox.Counts.ContainsKey($Status)) { return [int]$Outbox.Counts[$Status] }
    return 0
}

<#
Le a outbox local em SOMENTE LEITURA. O PowerShell 5.1 nao possui driver SQLite
e o arquivo .db-wal costuma estar dias a frente do .db, entao ler o arquivo cru
mostraria estado vencido - apenas o motor SQLite (.db + -wal + -shm) devolve o
estado real. O script vai por stdin (nenhum escaping de linha de comando) e o
caminho do banco por argv. Somente SELECT, nunca payload_json.
#>
function Get-OutboxSnapshot {
    param(
        [string]$NodeExePath = $script:NodeExePath,
        [string]$DbPath = $script:OutboxDbPath
    )

    $result = [ordered]@{
        Available  = $false
        Counts     = @{}
        OldestOpen = $null
        LastDone   = $null
        Error      = $null
    }

    $process = $null
    try {
        if (-not (Test-Path -LiteralPath $NodeExePath -PathType Leaf)) {
            $result.Error = 'node.exe nao encontrado'
            return [pscustomobject]$result
        }
        if (-not (Test-Path -LiteralPath $DbPath -PathType Leaf)) {
            $result.Error = 'banco da outbox nao encontrado'
            return [pscustomobject]$result
        }

        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $NodeExePath
        $psi.Arguments = '- "' + $DbPath + '"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true

        $process = [System.Diagnostics.Process]::Start($psi)
        $process.StandardInput.Write($script:OutboxQueryScript)
        $process.StandardInput.Close()

        # Leitura assincrona: ReadToEnd sincrono bloquearia antes do WaitForExit
        # e anularia o timeout.
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $null = $process.StandardError.ReadToEndAsync()

        if (-not $process.WaitForExit($script:OutboxQueryTimeoutMs)) {
            $process.Kill()
            $result.Error = 'timeout na leitura da outbox'
            return [pscustomobject]$result
        }
        if ($process.ExitCode -ne 0) {
            $result.Error = 'leitura da outbox retornou codigo ' + $process.ExitCode
            return [pscustomobject]$result
        }

        $stdout = $stdoutTask.Result
        if ([string]::IsNullOrWhiteSpace($stdout)) {
            $result.Error = 'leitura da outbox sem retorno'
            return [pscustomobject]$result
        }

        $parsed = $stdout | ConvertFrom-Json -ErrorAction Stop
        $counts = @{}
        foreach ($row in @($parsed.byStatus)) {
            if ($null -ne $row) { $counts[[string]$row.status] = [int]$row.n }
        }
        $result.Counts = $counts
        $result.OldestOpen = $parsed.oldestOpen
        $result.LastDone = $parsed.lastDone
        $result.Available = $true
    }
    catch {
        $result.Error = $_.Exception.Message
    }
    finally {
        if ($null -ne $process) { $process.Dispose() }
    }

    return [pscustomobject]$result
}

function Get-OutboxHealth {
    param(
        [object]$Outbox,
        [int]$ConsecutiveFailures = 0,
        [AllowNull()][object]$Now = $null
    )

    $reference = if ($null -ne $Now) { [datetime]$Now } else { Get-Date }

    if ($null -eq $Outbox -or -not $Outbox.Available) {
        $erro = if ($null -ne $Outbox) { Get-DisplayValue -Value $Outbox.Error -Fallback 'fonte indisponivel' } else { 'fonte indisponivel' }
        # Falha isolada nao eleva o banner: so apos N leituras consecutivas.
        $level = if ($ConsecutiveFailures -ge $script:OutboxUnavailableGraceReads) { 'ATENCAO' } else { 'NORMAL' }
        return [pscustomobject]@{ Level = $level; Summary = 'Leitura indisponivel'; Detail = $erro }
    }

    $failed = Get-OutboxStatusCount -Outbox $Outbox -Status 'FAILED'
    $retry = Get-OutboxStatusCount -Outbox $Outbox -Status 'RETRY'
    $pending = Get-OutboxStatusCount -Outbox $Outbox -Status 'PENDING'
    $sending = Get-OutboxStatusCount -Outbox $Outbox -Status 'SENDING'
    $sent = Get-OutboxStatusCount -Outbox $Outbox -Status 'SENT'
    $review = Get-OutboxStatusCount -Outbox $Outbox -Status 'REVIEW_STORED'
    $abertos = $failed + $retry + $pending + $sending

    $openAge = $null
    if ($null -ne $Outbox.OldestOpen) {
        try { $openAge = ($reference - ([datetimeoffset]$Outbox.OldestOpen.created_at).LocalDateTime).TotalMinutes }
        catch { $openAge = $null }
    }

    $level = 'NORMAL'
    if ($failed -gt 0) { $level = 'PROBLEMA' }
    elseif ($null -ne $openAge -and $openAge -gt $script:OutboxOpenActionMinutes) { $level = 'PROBLEMA' }
    elseif ($retry -gt 0) { $level = 'ATENCAO' }
    elseif ($null -ne $openAge -and $openAge -ge $script:TransientGraceMinutes) { $level = 'ATENCAO' }

    $detail = ''
    if ($level -ne 'NORMAL' -and $null -ne $Outbox.OldestOpen) {
        $aberto = $Outbox.OldestOpen
        $erroTexto = Get-DisplayValue -Value $aberto.ultimo_erro -Fallback ''
        if ($erroTexto.Length -gt $script:ErrorDetailMaxChars) {
            $erroTexto = $erroTexto.Substring(0, $script:ErrorDetailMaxChars) + '...'
        }
        $partes = @(
            (Get-DisplayValue -Value $aberto.event_id),
            ('NEX ' + (Get-DisplayValue -Value $aberto.nex_transaction_id)),
            (Get-DisplayValue -Value $aberto.status),
            ('tentativas ' + (Get-DisplayValue -Value $aberto.tentativas))
        )
        if ($null -ne $openAge) { $partes += ('aberto ha {0:N0} min' -f [math]::Floor($openAge)) }
        $detail = ($partes -join ' | ')
        if ($erroTexto) { $detail += ' | ' + $erroTexto }
    }

    return [pscustomobject]@{
        Level   = $level
        Summary = ('{0} SENT | {1} REVIEW_STORED | {2} aberto{3}' -f $sent, $review, $abertos, $(if ($abertos -eq 1) { '' } else { 's' }))
        Detail  = $detail
    }
}

function Get-StageHealth {
    param(
        [object]$Stage,
        [bool]$G13Blocked = $false
    )

    if ($null -eq $Stage -or -not $Stage.Available) {
        $erro = if ($null -ne $Stage) { Get-DisplayValue -Value $Stage.Error -Fallback 'leitura indisponivel' } else { 'leitura indisponivel' }
        return [pscustomobject]@{ Level = 'ATENCAO'; Summary = 'Leitura indisponivel'; Detail = $erro }
    }

    if ($Stage.Count -eq 0) {
        return [pscustomobject]@{ Level = 'NORMAL'; Summary = 'vazio'; Detail = '' }
    }

    $idade = $Stage.OldestAgeMinutes
    $nome = if ($null -ne $Stage.Oldest) { $Stage.Oldest.Name } else { '-' }
    $detalhe = '{0} | {1} | {2}' -f $nome, (Format-FileAge -Time $(if ($null -ne $Stage.Oldest) { $Stage.Oldest.LastWriteTime } else { $null })), (Format-FileSize -Bytes $Stage.TotalBytes)

    $level = 'ATENCAO'
    if ($G13Blocked) { $level = 'PROBLEMA' }
    elseif ($Stage.Count -gt 1) { $level = 'PROBLEMA' }
    elseif (@($Stage.UnexpectedNames).Count -gt 0) { $level = 'PROBLEMA' }
    elseif ($null -ne $idade -and $idade -gt $script:StageActionMinutes) { $level = 'PROBLEMA' }
    elseif ($null -ne $idade -and $idade -lt $script:TransientGraceMinutes) { $level = 'NORMAL' }

    $resumo = '{0} arquivo{1}' -f $Stage.Count, $(if ($Stage.Count -eq 1) { '' } else { 's' })
    if ($level -eq 'NORMAL') { $resumo += ' (ciclo em andamento)' }

    return [pscustomobject]@{
        Level   = $level
        Summary = $resumo
        Detail  = $(if ($level -eq 'NORMAL') { '' } else { $detalhe })
    }
}

function Get-SuccessHealth {
    param(
        [object]$Pipeline,
        [object]$Nex
    )

    $streak = if ($null -ne $Pipeline) { [int]$Pipeline.AnomalousStreak } else { 0 }
    $posicao = if ($null -ne $Nex) { Get-DisplayValue -Value $Nex.Position -Fallback 'UNKNOWN' } else { 'UNKNOWN' }

    if ($posicao -eq 'CLOSED' -or $posicao -eq 'MINIMIZED') {
        return [pscustomobject]@{ Level = 'NORMAL'; Summary = 'suspenso - NEX indisponivel'; Detail = '' }
    }

    $idade = '-'
    if ($null -ne $Pipeline -and $null -ne $Pipeline.LastSuccess) {
        try { $idade = Format-FileAge -Time ([datetimeoffset]$Pipeline.LastSuccess.timestamp).LocalDateTime } catch { $idade = '-' }
    }

    $level = 'NORMAL'
    if ($streak -ge $script:SuccessActionCycles) { $level = 'PROBLEMA' }
    elseif ($streak -ge $script:SuccessAttentionCycles) { $level = 'ATENCAO' }

    $resumo = if ($streak -gt 0) {
        '{0} | {1} ciclo{2} sem exportar' -f $idade, $streak, $(if ($streak -eq 1) { '' } else { 's' })
    } else { $idade }

    $detalhe = ''
    if ($level -ne 'NORMAL') {
        $detalhe = 'streak {0} | motivo dominante: {1}' -f $streak, (Get-DisplayValue -Value $Pipeline.StreakDominantCode -Fallback 'desconhecido')
    }

    return [pscustomobject]@{ Level = $level; Summary = $resumo; Detail = $detalhe }
}

function Get-OverallStatus {
    param(
        [object]$Task,
        [object]$Pipeline,
        [object]$Export,
        [object]$Nex,
        [AllowNull()][object]$OutboxHealth = $null,
        [AllowNull()][object]$StageHealth = $null,
        [AllowNull()][object]$SuccessHealth = $null
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

    # Saude operacional: PROBLEMA sempre eleva; ATENCAO eleva apenas a partir de
    # NORMAL. Os estados 'amarelos' ja possuem piso de tempo proprio, entao um
    # transitorio de poucos segundos nunca chega aqui.
    foreach ($health in @(
        @{ Nome = 'PRIME COBRANCAS'; Valor = $OutboxHealth },
        @{ Nome = 'EXPORT_STAGE'; Valor = $StageHealth },
        @{ Nome = 'ULTIMO SUCCESS'; Valor = $SuccessHealth }
    )) {
        $atual = $health.Valor
        if ($null -eq $atual) { continue }
        if ($atual.Level -eq 'PROBLEMA') {
            $level = 'PROBLEMA'
            $details.Add($health.Nome + ': ' + $atual.Summary)
        }
        elseif ($atual.Level -eq 'ATENCAO') {
            if ($level -eq 'NORMAL') { $level = 'ATENCAO' }
            $details.Add($health.Nome + ': ' + $atual.Summary)
        }
    }

    if ($details.Count -eq 0) { $details.Add('Leituras coerentes e ultimo pipeline concluido com sucesso') }
    return [pscustomobject]@{ Level = $level; Detail = ($details -join ' | ') }
}
