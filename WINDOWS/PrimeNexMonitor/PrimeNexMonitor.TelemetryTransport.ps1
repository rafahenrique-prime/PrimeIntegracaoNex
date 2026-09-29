# PRIME NEX Telemetry V1 - transporte best-effort, one-way (Windows -> cloud).
#
# Regras:
# - config fora do repositorio (%LOCALAPPDATA%\PrimeNex\telemetry.json);
#   enabled != true => ZERO rede;
# - POST somente ao endpoint allowlisted abaixo;
# - segredo de ingestao somente via DPAPI CurrentUser, lido no momento do envio
#   e nunca impresso, logado ou gravado em texto puro;
# - timeout 5 s, TLS 1.2, sem retry, sem fila persistente;
# - nunca bloqueia a UI (SendAsync + verificacao no tick do Monitor);
# - o corpo da resposta e' ignorado: nenhum comando volta ao Windows;
# - nenhuma falha aqui altera Overall Status, NEX, Task, Agent, G13 ou V1/V2.
#
# Depende de PrimeNexMonitor.Telemetry.ps1 (Test-TelemetryPayload/ConvertTo-TelemetryJson).

$script:TelemetryAllowedEndpoint = 'https://mbbgqasvssueirynnoyk.supabase.co/functions/v1/nex-telemetry-ingest'
$script:TelemetryIngestHeader = 'x-prime-nex-ingest'
$script:TelemetryTimeoutSeconds = 5
$script:TelemetryHighPriorityQueueMax = 20
$script:TelemetryDpapiEntropy = [System.Text.Encoding]::UTF8.GetBytes('PrimeNex.Telemetry.V1')
$script:TelemetryLocalDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PrimeNex'
$script:TelemetryConfigPath = Join-Path $script:TelemetryLocalDirectory 'telemetry.json'
$script:TelemetrySecretPath = Join-Path $script:TelemetryLocalDirectory 'telemetry.secret'

Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Net.Http

function Get-TelemetryTransportConfig {
    param([string]$Path = $script:TelemetryConfigPath)

    $disabled = { param($reason) [pscustomobject]@{ Enabled = $false; Endpoint = $null; Reason = $reason } }
    try {
        if (-not [System.IO.File]::Exists($Path)) { return & $disabled 'CONFIG_MISSING' }
        $config = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop
        $names = @($config | Get-Member -MemberType NoteProperty | ForEach-Object { $_.Name })
        foreach ($required in @('enabled', 'endpoint', 'source_id')) {
            if ($names -notcontains $required) { return & $disabled 'CONFIG_INVALID' }
        }
        if ($config.enabled -isnot [bool] -or $config.enabled -ne $true) { return & $disabled 'DISABLED' }
        if (-not [string]::Equals([string]$config.endpoint, $script:TelemetryAllowedEndpoint, [System.StringComparison]::Ordinal)) {
            return & $disabled 'ENDPOINT_NOT_ALLOWED'
        }
        if (-not [string]::Equals([string]$config.source_id, $script:TelemetrySourceId, [System.StringComparison]::Ordinal)) {
            return & $disabled 'SOURCE_ID_INVALID'
        }
        return [pscustomobject]@{ Enabled = $true; Endpoint = $script:TelemetryAllowedEndpoint; Reason = 'ENABLED' }
    }
    catch { return & $disabled 'CONFIG_UNREADABLE' }
}

function Set-TelemetryOwnerOnlyAcl {
    param([string]$Path)

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $isDirectory = [System.IO.Directory]::Exists($Path)
    $acl = if ($isDirectory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = if ($isDirectory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
    $acl.SetOwner($identity)
    if ($isDirectory) { [System.IO.Directory]::SetAccessControl($Path, $acl) } else { [System.IO.File]::SetAccessControl($Path, $acl) }
}

# Gera o segredo (32 bytes CSPRNG => 64 hex lowercase), grava SOMENTE os bytes
# protegidos por DPAPI CurrentUser e devolve SOMENTE o SHA-256 do segredo.
function New-TelemetryIngestSecret {
    param([string]$Path = $script:TelemetrySecretPath)

    if ([System.IO.File]::Exists($Path)) { throw 'Segredo de ingestao ja existe; nada foi sobrescrito.' }
    $directory = [System.IO.Path]::GetDirectoryName($Path)
    if (-not [System.IO.Directory]::Exists($directory)) {
        [void][System.IO.Directory]::CreateDirectory($directory)
        Set-TelemetryOwnerOnlyAcl -Path $directory
    }

    $random = [byte[]]::new(32)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $plainBytes = $null
    try {
        $rng.GetBytes($random)
        $secret = -join ($random | ForEach-Object { $_.ToString('x2') })
        $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($secret)
        $protected = [System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $script:TelemetryDpapiEntropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        [System.IO.File]::WriteAllBytes($Path, $protected)
        Set-TelemetryOwnerOnlyAcl -Path $Path
        return Get-TelemetrySha256 -Text $secret
    }
    finally {
        [Array]::Clear($random, 0, $random.Length)
        if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
        $secret = $null
        $rng.Dispose()
    }
}

# Uso interno do transporte: devolve o segredo em memoria ou $null. Nunca loga.
function Read-TelemetryIngestSecret {
    param([string]$Path = $script:TelemetrySecretPath)

    $plainBytes = $null
    try {
        if (-not [System.IO.File]::Exists($Path)) { return $null }
        $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect([System.IO.File]::ReadAllBytes($Path), $script:TelemetryDpapiEntropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $secret = [System.Text.Encoding]::UTF8.GetString($plainBytes)
        if ($secret -notmatch '^[0-9a-f]{64}$') { return $null }
        return $secret
    }
    catch { return $null }
    finally { if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) } }
}

function New-TelemetryHttpClient {
    # TLS 1.2 somente neste processo (Windows PowerShell 5.1 / .NET Framework).
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds($script:TelemetryTimeoutSeconds)
    return $client
}

# Estado do transporte (somente memoria). ClientFactory permite mock em teste.
function New-TelemetrySender {
    param(
        [string]$ConfigPath = $script:TelemetryConfigPath,
        [string]$SecretPath = $script:TelemetrySecretPath,
        [scriptblock]$ClientFactory = { New-TelemetryHttpClient }
    )

    return [pscustomobject]@{
        Config        = Get-TelemetryTransportConfig -Path $ConfigPath
        SecretPath    = $SecretPath
        ClientFactory = $ClientFactory
        Client        = $null
        Pending       = $null
        PendingType   = $null
        PendingRequest = $null
        Queue         = [System.Collections.Generic.Queue[System.Collections.IDictionary]]::new()
        Sent          = 0
        Failed        = 0
        Dropped       = 0
        Rejected      = 0
        LastResult    = 'IDLE'
    }
}

function Start-TelemetryRequest {
    param([object]$Sender, [System.Collections.IDictionary]$Payload)

    $secret = Read-TelemetryIngestSecret -Path $Sender.SecretPath
    if ($null -eq $secret) { $Sender.LastResult = 'SECRET_UNAVAILABLE'; $Sender.Rejected++; return $false }

    $request = $null
    try {
        if ($null -eq $Sender.Client) { $Sender.Client = & $Sender.ClientFactory }
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $script:TelemetryAllowedEndpoint)
        $request.Content = [System.Net.Http.StringContent]::new((ConvertTo-TelemetryJson -Payload $Payload), [System.Text.Encoding]::UTF8, 'application/json')
        [void]$request.Headers.TryAddWithoutValidation($script:TelemetryIngestHeader, $secret)
        $secret = $null
        $Sender.Pending = $Sender.Client.SendAsync($request)
        $Sender.PendingRequest = $request
        $Sender.PendingType = [string]$Payload['type']
        $Sender.LastResult = 'SENDING'
        return $true
    }
    catch {
        $secret = $null
        if ($null -ne $request) { $request.Dispose() }
        $Sender.Failed++
        $Sender.LastResult = 'SEND_ERROR'
        return $false
    }
}

# Entrada unica. Devolve $true se o payload foi aceito (enviado ou enfileirado
# em memoria). Payload invalido ou transporte desabilitado => $false, zero rede.
function Submit-TelemetryPayload {
    param([object]$Sender, [AllowNull()][System.Collections.IDictionary]$Payload)

    try {
        if ($null -eq $Sender -or -not $Sender.Config.Enabled) { return $false }
        if ($null -eq $Payload) { $Sender.Rejected++; return $false }
        # Test-TelemetryPayload devolve o array de erros como um unico objeto.
        $validationErrors = Test-TelemetryPayload -Payload $Payload
        if ($validationErrors.Count -gt 0) { $Sender.Rejected++; return $false }

        $type = [string]$Payload['type']
        if ($null -ne $Sender.Pending) {
            # GUARDIAN/CYCLE > STATUS: status e' descartado se ha envio em andamento;
            # cycle/guardian aguardam em fila de memoria limitada.
            if ($type -eq 'status') { $Sender.Dropped++; return $false }
            if ($Sender.Queue.Count -ge $script:TelemetryHighPriorityQueueMax) { $Sender.Dropped++; return $false }
            $Sender.Queue.Enqueue($Payload)
            return $true
        }
        return (Start-TelemetryRequest -Sender $Sender -Payload $Payload)
    }
    catch { return $false }
}

# Chamado no tick do Monitor. Nunca bloqueia: so' le Tasks ja concluidas.
function Step-TelemetrySender {
    param([object]$Sender)

    try {
        if ($null -eq $Sender -or $null -eq $Sender.Pending) { return }
        if (-not $Sender.Pending.IsCompleted) { return }

        $task = $Sender.Pending
        if ($task.IsFaulted -or $task.IsCanceled) {
            $Sender.Failed++
            # .NET Framework reporta o timeout do HttpClient como falha com TaskCanceledException.
            $isTimeout = $task.IsCanceled -or ($null -ne $task.Exception -and $task.Exception.GetBaseException() -is [System.OperationCanceledException])
            $Sender.LastResult = if ($isTimeout) { 'TIMEOUT' } else { 'NETWORK_ERROR' }
        }
        else {
            $response = $task.Result
            try {
                $code = [int]$response.StatusCode
                if ($response.IsSuccessStatusCode) { $Sender.Sent++; $Sender.LastResult = 'HTTP_' + $code }
                else { $Sender.Failed++; $Sender.LastResult = 'HTTP_' + $code }
            }
            finally { $response.Dispose() }
        }
    }
    catch { $Sender.Failed++; $Sender.LastResult = 'STEP_ERROR' }
    finally {
        if ($null -ne $Sender -and $null -ne $Sender.Pending -and $Sender.Pending.IsCompleted) {
            if ($null -ne $Sender.PendingRequest) { $Sender.PendingRequest.Dispose() }
            $Sender.Pending = $null
            $Sender.PendingRequest = $null
            $Sender.PendingType = $null
        }
    }

    try {
        # Sem retry: o que falhou e' descartado. Fila so' anda para o proximo item.
        if ($null -eq $Sender.Pending -and $Sender.Queue.Count -gt 0) {
            [void](Start-TelemetryRequest -Sender $Sender -Payload $Sender.Queue.Dequeue())
        }
    }
    catch { $Sender.LastResult = 'STEP_ERROR' }
}
