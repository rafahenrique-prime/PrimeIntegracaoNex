# PRIME NEX Telemetry V1 - camada LOCAL e OFFLINE.
#
# Somente monta, sanitiza, valida e decide (dedupe) payloads a partir dos
# snapshots que o Monitor ja calculou. Nao le NEX, Task, G13 nem logs; nao faz
# rede; nao grava em disco; nao exige segredo. Nenhuma falha aqui pode alterar
# o Overall Status ou a exportacao.

$script:TelemetrySchemaVersion = 1
$script:TelemetrySourceId = 'PRIME_NEX_MAIN'
$script:TelemetryStatusMinIntervalSeconds = 60
$script:TelemetryStatusHeartbeatSeconds = 300
$script:TelemetrySummaryMaxChars = 500
$script:TelemetryEvidenceMaxItems = 8
$script:TelemetryEvidenceMaxChars = 200
$script:TelemetryActionMaxChars = 300

$script:TelemetryMonitorStates = @('NORMAL', 'ATENCAO', 'PROBLEMA', 'UNKNOWN')
$script:TelemetryNexStates = @('OPEN', 'CLOSED', 'UNKNOWN')
$script:TelemetryNexPositions = @('FOREGROUND', 'BACKGROUND', 'MINIMIZED', 'CLOSED', 'UNKNOWN')
$script:TelemetryTaskStates = @('READY', 'RUNNING', 'DISABLED', 'QUEUED', 'UNKNOWN')
$script:TelemetryRoutes = @('V1', 'V2', 'NONE', 'UNKNOWN')
$script:TelemetryRouteReasons = @(
    'FOREGROUND_HWND_OR_PID_MATCHED_NEX', 'FOREGROUND_NOT_OWNED_BY_NEX',
    'NEX_CLOSED', 'NEX_MINIMIZED', 'NEX_BLOCKING_UNKNOWN', 'UNKNOWN'
)
$script:TelemetryTerminalStages = @(
    'Success', 'Failed', 'SkippedBusy', 'SkippedSessionUnavailable', 'NexNotFound',
    'UnsafeState', 'SkippedNotForeground', 'NEX_CLOSED', 'NEX_MINIMIZED', 'NEX_BLOCKING_UNKNOWN', 'UNKNOWN'
)
# Estagios terminais + AgentErrorCode (PrimeNexExportAgent/Domain/AgentErrorCode.cs).
$script:TelemetryTerminalCodes = @($script:TelemetryTerminalStages + @(
    'LockBusy', 'SessionUnavailable', 'DialogNotFound', 'DialogIdentityMismatch', 'ControlMissing',
    'ReadbackMismatch', 'FileUnstable', 'ReaderRejected', 'PublishFailed', 'UnexpectedException',
    'ExportItemNotFound', 'ExportItemAmbiguous', 'ExportItemNotActionable', 'ZeroRecords', 'NotForeground',
    'AutoRecoveryRejected', 'DurableIntentUnavailable', 'RecoveryLedgerCorrupt', 'RecoveryMoveUnknown'
) | Select-Object -Unique)
$script:TelemetryDiagnosticSources = @('RULE', 'AI', 'UNKNOWN')
$script:TelemetryClassifications = @(
    'UI_FOREGROUND', 'UI_UNSAFE_STATE', 'NEX_MINIMIZED', 'NEX_CLOSED', 'G13_RESIDUE',
    'VALIDATOR', 'TASK', 'NETWORK', 'DOWNSTREAM', 'FILE', 'AMBIGUOUS', 'UNKNOWN'
)

$script:TelemetryStatusKeys = @(
    'schema_version', 'type', 'source_id', 'captured_at',
    'monitor_state', 'nex_state', 'nex_position', 'nex_path_unconfirmed',
    'task_state', 'task_enabled', 'task_last_result', 'task_last_run', 'task_next_run',
    'last_success_at', 'last_cycle_stage', 'last_cycle_route', 'last_cycle_ended_at',
    'cycle_in_progress', 'cycles_without_export', 'dominant_reason', 'export_stage_count', 'g13_blocked'
)
$script:TelemetryCycleKeys = @(
    'schema_version', 'type', 'source_id', 'captured_at',
    'run_key', 'started_at', 'ended_at', 'duration_ms',
    'terminal_stage', 'terminal_code', 'route', 'nex_position', 'route_reason'
)
$script:TelemetryGuardianKeys = @(
    'schema_version', 'type', 'source_id', 'captured_at',
    'analysis_key', 'generated_at', 'diagnostic_source', 'ai_called', 'classification', 'confidence',
    'needs_human', 'safe_to_auto_fix_final', 'summary', 'evidence', 'recommended_action'
)
# Campos que mudam a cada leitura e, sozinhos, nao caracterizam mudanca de status.
$script:TelemetryStatusFingerprintExcluded = @('captured_at', 'task_next_run')

function Get-TelemetryProperty {
    param([AllowNull()][object]$Object, [string]$Name)

    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    if ($null -eq ($Object | Get-Member -Name $Name -MemberType Properties)) { return $null }
    return $Object.$Name
}

function ConvertTo-TelemetryEnum {
    param([AllowNull()][object]$Value, [string[]]$Allowed, [string]$Fallback = 'UNKNOWN')

    if ($null -eq $Value) { return $Fallback }
    $text = ([string]$Value).Trim()
    foreach ($candidate in $Allowed) {
        if ([string]::Equals($candidate, $text, [System.StringComparison]::OrdinalIgnoreCase)) { return $candidate }
    }
    return $Fallback
}

function ConvertTo-TelemetryTimestamp {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return $null }
    $parsed = [datetimeoffset]::MinValue
    if ($Value -is [datetimeoffset]) { $parsed = $Value }
    elseif ($Value -is [datetime]) { $parsed = [datetimeoffset]$Value }
    elseif (-not [datetimeoffset]::TryParse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$parsed)) { return $null }
    # Task sem execucao/proxima execucao devolve datas sentinela (1899/0001).
    if ($parsed.Year -lt 2000) { return $null }
    return $parsed.ToString('yyyy-MM-ddTHH:mm:ss.fffzzz', [System.Globalization.CultureInfo]::InvariantCulture)
}

function Get-TelemetrySha256 {
    param([string]$Text)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
        return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
    }
    finally { $sha.Dispose() }
}

function Protect-TelemetryText {
    param([AllowNull()][string]$Text, [int]$MaxLength)

    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $clean = [regex]::Replace($Text, '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', ' ')
    $clean = [regex]::Replace($clean, '(?i)\bsk-[A-Za-z0-9_\-]{6,}', '[omitido]')
    $clean = [regex]::Replace($clean, '(?i)\bbearer\s+\S+', '[omitido]')
    $clean = [regex]::Replace($clean, '(?i)\b(authorization|api[_-]?key|x-api-key|deepseek_api_key)\b\s*[:=]?\s*\S*', '[omitido]')
    $clean = [regex]::Replace($clean, '(?i)(?<![A-Za-z])[A-Z]:\\[^\s"'']*', '[caminho omitido]')
    $clean = [regex]::Replace($clean, '\\\\[^\s"'']+', '[caminho omitido]')
    $clean = $clean.Trim()
    if ($clean.Length -gt $MaxLength) { $clean = $clean.Substring(0, $MaxLength) }
    return $clean
}

function Get-TelemetryNexState {
    param([AllowNull()][object]$Nex)

    $position = ConvertTo-TelemetryEnum -Value (Get-TelemetryProperty $Nex 'Position') -Allowed $script:TelemetryNexPositions
    if ($position -eq 'CLOSED') { return 'CLOSED' }
    if ((Get-TelemetryProperty $Nex 'PathUnconfirmed') -eq $true) { return 'UNKNOWN' }
    if ((Get-TelemetryProperty $Nex 'Available') -ne $true -or $position -eq 'UNKNOWN') { return 'UNKNOWN' }
    return 'OPEN'
}

function Get-TelemetryTerminalCode {
    param([AllowNull()][object]$Record)

    $stage = [string](Get-TelemetryProperty $Record 'stage')
    $errorCode = [string](Get-TelemetryProperty $Record 'errorCode')
    $code = if ($stage -eq 'Failed' -and $errorCode) { $errorCode } else { $stage }
    return ConvertTo-TelemetryEnum -Value $code -Allowed $script:TelemetryTerminalCodes
}

function New-TelemetryEnvelope {
    param([string]$Type, [object]$CapturedAt)

    $payload = [ordered]@{}
    $payload['schema_version'] = $script:TelemetrySchemaVersion
    $payload['type'] = $Type
    $payload['source_id'] = $script:TelemetrySourceId
    $payload['captured_at'] = ConvertTo-TelemetryTimestamp -Value $CapturedAt
    return $payload
}

function New-TelemetryStatusPayload {
    param(
        [AllowNull()][object]$Task,
        [AllowNull()][object]$Pipeline,
        [AllowNull()][object]$Nex,
        [AllowNull()][object]$Stage,
        [AllowNull()][object]$Overall,
        [bool]$G13Blocked,
        [object]$CapturedAt = (Get-Date)
    )

    $latestCycle = Get-TelemetryProperty $Pipeline 'LatestCycle'
    $terminal = Get-TelemetryProperty $latestCycle 'Terminal'
    $routeEvent = Get-TelemetryProperty $latestCycle 'RouteEvent'
    $lastSuccess = Get-TelemetryProperty $Pipeline 'LastSuccess'
    $lastResult = Get-TelemetryProperty $Task 'LastTaskResult'
    $taskEnabled = Get-TelemetryProperty $Task 'Enabled'
    $streak = Get-TelemetryProperty $Pipeline 'AnomalousStreak'
    $stageCount = Get-TelemetryProperty $Stage 'Count'
    $dominant = Get-TelemetryProperty $Pipeline 'StreakDominantCode'

    $payload = New-TelemetryEnvelope -Type 'status' -CapturedAt $CapturedAt
    $payload['monitor_state'] = ConvertTo-TelemetryEnum -Value (Get-TelemetryProperty $Overall 'Level') -Allowed $script:TelemetryMonitorStates
    $payload['nex_state'] = Get-TelemetryNexState -Nex $Nex
    $payload['nex_position'] = ConvertTo-TelemetryEnum -Value (Get-TelemetryProperty $Nex 'Position') -Allowed $script:TelemetryNexPositions
    $payload['nex_path_unconfirmed'] = ((Get-TelemetryProperty $Nex 'PathUnconfirmed') -eq $true)
    $payload['task_state'] = ConvertTo-TelemetryEnum -Value (Get-TelemetryProperty $Task 'State') -Allowed $script:TelemetryTaskStates
    $payload['task_enabled'] = if ($taskEnabled -is [bool]) { $taskEnabled } else { $null }
    $payload['task_last_result'] = if ($lastResult -is [System.ValueType] -and $lastResult -isnot [bool]) { [long]$lastResult } else { $null }
    $payload['task_last_run'] = ConvertTo-TelemetryTimestamp -Value (Get-TelemetryProperty $Task 'LastRunTime')
    $payload['task_next_run'] = ConvertTo-TelemetryTimestamp -Value (Get-TelemetryProperty $Task 'NextRunTime')
    $payload['last_success_at'] = ConvertTo-TelemetryTimestamp -Value (Get-TelemetryProperty $lastSuccess 'timestamp')
    $payload['last_cycle_stage'] = if ($null -ne $terminal) { ConvertTo-TelemetryEnum -Value (Get-TelemetryProperty $terminal 'stage') -Allowed $script:TelemetryTerminalStages } else { $null }
    $payload['last_cycle_route'] = if ($null -ne $routeEvent) { ConvertTo-TelemetryEnum -Value (Get-TelemetryProperty $routeEvent 'hybridRoute') -Allowed $script:TelemetryRoutes } elseif ($null -ne $terminal) { 'UNKNOWN' } else { $null }
    $payload['last_cycle_ended_at'] = ConvertTo-TelemetryTimestamp -Value (Get-TelemetryProperty $terminal 'timestamp')
    $payload['cycle_in_progress'] = ((Get-TelemetryProperty $Pipeline 'InProgress') -eq $true)
    $payload['cycles_without_export'] = if ($streak -is [System.ValueType]) { [int]$streak } else { 0 }
    $payload['dominant_reason'] = if ([string]::IsNullOrWhiteSpace([string]$dominant)) { $null } else { ConvertTo-TelemetryEnum -Value $dominant -Allowed $script:TelemetryTerminalCodes }
    $payload['export_stage_count'] = if ($stageCount -is [System.ValueType]) { [int]$stageCount } else { 0 }
    $payload['g13_blocked'] = $G13Blocked
    return $payload
}

function New-TelemetryCyclePayload {
    param([AllowNull()][object]$Pipeline, [object]$CapturedAt = (Get-Date))

    $cycle = Get-TelemetryProperty $Pipeline 'LatestCycle'
    $terminal = Get-TelemetryProperty $cycle 'Terminal'
    if ($null -eq $terminal) { return $null }
    $runId = [string](Get-TelemetryProperty $terminal 'runId')
    if ([string]::IsNullOrWhiteSpace($runId)) { return $null }
    $routeEvent = Get-TelemetryProperty $cycle 'RouteEvent'

    $startedAt = ConvertTo-TelemetryTimestamp -Value (Get-TelemetryProperty $cycle 'Start')
    $endedAt = ConvertTo-TelemetryTimestamp -Value (Get-TelemetryProperty $cycle 'End')
    $duration = $null
    if ($null -ne $startedAt -and $null -ne $endedAt) {
        $ms = ([datetimeoffset]::Parse($endedAt, [System.Globalization.CultureInfo]::InvariantCulture) -
               [datetimeoffset]::Parse($startedAt, [System.Globalization.CultureInfo]::InvariantCulture)).TotalMilliseconds
        if ($ms -ge 0) { $duration = [long][math]::Round($ms) }
    }

    $payload = New-TelemetryEnvelope -Type 'cycle' -CapturedAt $CapturedAt
    $payload['run_key'] = Get-TelemetrySha256 -Text $runId.Trim().ToLowerInvariant()
    $payload['started_at'] = $startedAt
    $payload['ended_at'] = $endedAt
    $payload['duration_ms'] = $duration
    $payload['terminal_stage'] = ConvertTo-TelemetryEnum -Value (Get-TelemetryProperty $terminal 'stage') -Allowed $script:TelemetryTerminalStages
    $payload['terminal_code'] = Get-TelemetryTerminalCode -Record $terminal
    $payload['route'] = ConvertTo-TelemetryEnum -Value (Get-TelemetryProperty $routeEvent 'hybridRoute') -Allowed $script:TelemetryRoutes
    $payload['nex_position'] = ConvertTo-TelemetryEnum -Value (Get-TelemetryProperty $routeEvent 'nexPosition') -Allowed $script:TelemetryNexPositions
    $payload['route_reason'] = ConvertTo-TelemetryEnum -Value (Get-TelemetryProperty $routeEvent 'routeReason') -Allowed $script:TelemetryRouteReasons
    return $payload
}

function New-TelemetryGuardianPayload {
    param([AllowNull()][object]$Guardian, [object]$CapturedAt = (Get-Date))

    if ((Get-TelemetryProperty $Guardian 'Success') -ne $true) { return $null }
    $generatedAt = ConvertTo-TelemetryTimestamp -Value (Get-TelemetryProperty $Guardian 'GeneratedAt')
    if ($null -eq $generatedAt) { return $null }

    $source = ConvertTo-TelemetryEnum -Value (Get-TelemetryProperty $Guardian 'DiagnosticSource') -Allowed $script:TelemetryDiagnosticSources
    $classification = ConvertTo-TelemetryEnum -Value (Get-TelemetryProperty $Guardian 'Classification') -Allowed $script:TelemetryClassifications
    $confidence = Get-TelemetryProperty $Guardian 'Confidence'
    $confidenceValue = if ($confidence -is [System.ValueType] -and $confidence -isnot [bool]) { [int][math]::Max(0, [math]::Min(100, [int]$confidence)) } else { 0 }
    $aiCalled = Get-TelemetryProperty $Guardian 'AiCalled'
    $needsHuman = Get-TelemetryProperty $Guardian 'NeedsHuman'

    $rawEvidence = Get-TelemetryProperty $Guardian 'Evidence'
    $evidenceItems = if ($rawEvidence -is [System.Collections.IEnumerable] -and $rawEvidence -isnot [string]) { @($rawEvidence | ForEach-Object { [string]$_ }) } else { @(([string]$rawEvidence) -split ' \| ') }
    $evidence = @($evidenceItems |
        ForEach-Object { Protect-TelemetryText -Text $_ -MaxLength $script:TelemetryEvidenceMaxChars } |
        Where-Object { $_ -ne '' } |
        Select-Object -First $script:TelemetryEvidenceMaxItems)

    $payload = New-TelemetryEnvelope -Type 'guardian' -CapturedAt $CapturedAt
    $payload['analysis_key'] = Get-TelemetrySha256 -Text ($generatedAt + '|' + $classification + '|' + $source)
    $payload['generated_at'] = $generatedAt
    $payload['diagnostic_source'] = $source
    $payload['ai_called'] = ($aiCalled -eq $true)
    $payload['classification'] = $classification
    $payload['confidence'] = $confidenceValue
    $payload['needs_human'] = ($needsHuman -eq $true)
    # Contrato do Guardian: auto-fix nunca e' permitido.
    $payload['safe_to_auto_fix_final'] = $false
    $payload['summary'] = Protect-TelemetryText -Text ([string](Get-TelemetryProperty $Guardian 'Summary')) -MaxLength $script:TelemetrySummaryMaxChars
    $payload['evidence'] = $evidence
    $payload['recommended_action'] = Protect-TelemetryText -Text ([string](Get-TelemetryProperty $Guardian 'RecommendedAction')) -MaxLength $script:TelemetryActionMaxChars
    return $payload
}

function ConvertTo-TelemetryJson {
    param([System.Collections.IDictionary]$Payload)
    return ConvertTo-Json -InputObject $Payload -Compress -Depth 5
}

function Test-TelemetryPayload {
    param([AllowNull()][System.Collections.IDictionary]$Payload)

    $errors = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $Payload) { $errors.Add('payload nulo'); return , $errors.ToArray() }

    $type = [string]$Payload['type']
    $expected = switch ($type) {
        'status' { $script:TelemetryStatusKeys }
        'cycle' { $script:TelemetryCycleKeys }
        'guardian' { $script:TelemetryGuardianKeys }
        default { $null }
    }
    if ($null -eq $expected) { $errors.Add("type invalido: $type"); return , $errors.ToArray() }

    $actual = @($Payload.Keys | ForEach-Object { [string]$_ })
    foreach ($key in $expected) { if ($actual -notcontains $key) { $errors.Add("campo ausente: $key") } }
    foreach ($key in $actual) { if ($expected -notcontains $key) { $errors.Add("campo nao permitido: $key") } }
    if ($Payload['schema_version'] -ne $script:TelemetrySchemaVersion) { $errors.Add('schema_version invalido') }
    if ($Payload['source_id'] -ne $script:TelemetrySourceId) { $errors.Add('source_id invalido') }
    if ($null -eq $Payload['captured_at']) { $errors.Add('captured_at ausente') }

    $enumChecks = switch ($type) {
        'status' { @(
            @('monitor_state', $script:TelemetryMonitorStates, $false), @('nex_state', $script:TelemetryNexStates, $false),
            @('nex_position', $script:TelemetryNexPositions, $false), @('task_state', $script:TelemetryTaskStates, $false),
            @('last_cycle_stage', $script:TelemetryTerminalStages, $true), @('last_cycle_route', $script:TelemetryRoutes, $true),
            @('dominant_reason', $script:TelemetryTerminalCodes, $true)) }
        'cycle' { @(
            @('terminal_stage', $script:TelemetryTerminalStages, $false), @('terminal_code', $script:TelemetryTerminalCodes, $false),
            @('route', $script:TelemetryRoutes, $false), @('nex_position', $script:TelemetryNexPositions, $false),
            @('route_reason', $script:TelemetryRouteReasons, $false)) }
        'guardian' { @(
            @('diagnostic_source', $script:TelemetryDiagnosticSources, $false), @('classification', $script:TelemetryClassifications, $false)) }
    }
    foreach ($check in $enumChecks) {
        $value = $Payload[$check[0]]
        if ($null -eq $value) { if (-not $check[2]) { $errors.Add("enum nulo: $($check[0])") }; continue }
        if ($check[1] -cnotcontains [string]$value) { $errors.Add("enum fora da allowlist: $($check[0])") }
    }

    if ($type -eq 'cycle' -and ([string]$Payload['run_key']) -notmatch '^[0-9a-f]{64}$') { $errors.Add('run_key nao e SHA256') }
    if ($type -eq 'guardian') {
        if (([string]$Payload['analysis_key']) -notmatch '^[0-9a-f]{64}$') { $errors.Add('analysis_key nao e SHA256') }
        if ($Payload['safe_to_auto_fix_final'] -ne $false) { $errors.Add('safe_to_auto_fix_final deve ser false') }
        if (([string]$Payload['summary']).Length -gt $script:TelemetrySummaryMaxChars) { $errors.Add('summary acima do limite') }
        if (([string]$Payload['recommended_action']).Length -gt $script:TelemetryActionMaxChars) { $errors.Add('recommended_action acima do limite') }
        $items = @($Payload['evidence'])
        if ($items.Count -gt $script:TelemetryEvidenceMaxItems) { $errors.Add('evidence com itens demais') }
        if (@($items | Where-Object { ([string]$_).Length -gt $script:TelemetryEvidenceMaxChars }).Count -gt 0) { $errors.Add('evidence acima do limite') }
    }

    $json = ConvertTo-TelemetryJson -Payload $Payload
    if ($json -match '(?i)\bsk-[A-Za-z0-9_\-]{6,}|\bbearer\s+[A-Za-z0-9]|authorization|deepseek_api_key|api[_-]?key') { $errors.Add('possivel segredo no payload') }
    if ($json -match '(?i)[A-Z]:\\\\|\\\\\\\\') { $errors.Add('caminho local no payload') }
    return , $errors.ToArray()
}

# ------------------------------------------------------------------ dedupe
# Estado somente em memoria; o Monitor mantem uma instancia por processo.

function New-TelemetryDedupeState {
    return [pscustomobject]@{
        StatusFingerprint = $null
        StatusLastSentAt  = $null
        CycleKeys         = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        GuardianKeys      = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    }
}

function Get-TelemetryStatusFingerprint {
    param([System.Collections.IDictionary]$Payload)

    $relevant = [ordered]@{}
    foreach ($key in $Payload.Keys) {
        if ($script:TelemetryStatusFingerprintExcluded -notcontains [string]$key) { $relevant[[string]$key] = $Payload[$key] }
    }
    return Get-TelemetrySha256 -Text (ConvertTo-TelemetryJson -Payload $relevant)
}

function Test-TelemetryStatusShouldSend {
    param([object]$State, [System.Collections.IDictionary]$Payload, [datetime]$Now)

    if ($null -eq $State.StatusLastSentAt) { return $true }
    $elapsed = ($Now - [datetime]$State.StatusLastSentAt).TotalSeconds
    if ($elapsed -lt $script:TelemetryStatusMinIntervalSeconds) { return $false }
    if ((Get-TelemetryStatusFingerprint -Payload $Payload) -ne $State.StatusFingerprint) { return $true }
    return ($elapsed -ge $script:TelemetryStatusHeartbeatSeconds)
}

function Register-TelemetryStatusSent {
    param([object]$State, [System.Collections.IDictionary]$Payload, [datetime]$Now)

    $State.StatusFingerprint = Get-TelemetryStatusFingerprint -Payload $Payload
    $State.StatusLastSentAt = $Now
}

function Test-TelemetryCycleShouldSend {
    param([object]$State, [AllowNull()][System.Collections.IDictionary]$Payload)

    if ($null -eq $Payload) { return $false }
    return -not $State.CycleKeys.Contains([string]$Payload['run_key'])
}

function Register-TelemetryCycleSent {
    param([object]$State, [System.Collections.IDictionary]$Payload)
    [void]$State.CycleKeys.Add([string]$Payload['run_key'])
}

function Test-TelemetryGuardianShouldSend {
    param([object]$State, [AllowNull()][System.Collections.IDictionary]$Payload)

    if ($null -eq $Payload) { return $false }
    return -not $State.GuardianKeys.Contains([string]$Payload['analysis_key'])
}

function Register-TelemetryGuardianSent {
    param([object]$State, [System.Collections.IDictionary]$Payload)
    [void]$State.GuardianKeys.Add([string]$Payload['analysis_key'])
}
