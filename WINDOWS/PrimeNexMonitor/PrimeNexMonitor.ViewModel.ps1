# PRIME NEX Monitor V3 - ViewModel (Fase 1).
#
# Funcoes PURAS de apresentacao: recebem os snapshots que o Monitor ja leu
# (via PrimeNexMonitor.Core.ps1) e devolvem textos, icones e niveis visuais.
# Sem I/O, sem disco, sem rede, sem processos, sem alterar Task/NEX/arquivos.
# Nunca alteram $overall: o nivel exibido vem de $overall.Level como esta.
#
# O arquivo e lido como ANSI pelo Windows PowerShell 5.1 (sem BOM): textos
# acentuados e simbolos sao montados por escape Unicode (fonte somente ASCII).
#
# Usa apenas helpers puros do Core: Get-DisplayValue, Format-DateTime,
# Format-Duration, Format-Countdown, Format-FileSize, Format-FileAge,
# Get-FriendlyStage.

$script:V3SupervisorRecentSeconds = 600

function ConvertFrom-V3Text {
    param([string]$Text)
    return [regex]::Unescape($Text)
}

function Get-V3Property {
    param([AllowNull()][object]$Object, [string]$Name)

    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    if ($null -eq ($Object | Get-Member -Name $Name -MemberType Properties)) { return $null }
    return $Object.$Name
}

function Format-V3Age {
    param([AllowNull()][object]$Since, [datetime]$Now)

    if ($null -eq $Since) { return $null }
    $seconds = [math]::Max(0, [int][math]::Floor(($Now - [datetime]$Since).TotalSeconds))
    if ($seconds -lt 60) { return "$seconds s" }
    if ($seconds -lt 3600) { return ([math]::Floor($seconds / 60)).ToString() + ' min' }
    $hours = [math]::Floor($seconds / 3600)
    $minutes = [math]::Floor(($seconds % 3600) / 60)
    return ('{0} h {1:D2} min' -f $hours, [int]$minutes)
}

function ConvertTo-V3DateTime {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { $result = $Value }
    elseif ($Value -is [datetimeoffset]) { $result = $Value.LocalDateTime }
    else {
        $parsed = [datetimeoffset]::MinValue
        if (-not [datetimeoffset]::TryParse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$parsed)) { return $null }
        $result = $parsed.LocalDateTime
    }
    if ($result.Year -lt 2000) { return $null }
    return $result
}

function New-V3Card {
    param([string]$Key, [string]$Title, [string]$Level, [string]$Primary, [string]$Secondary = '')
    return [pscustomobject]@{ Key = $Key; Title = $Title; Level = $Level; Primary = $Primary; Secondary = $Secondary }
}

# ------------------------------------------------------------------ cabecalho

function Get-V3Headline {
    param([AllowNull()][object]$Overall)

    # Indicador: U+25CF (plano basico, presente no Segoe UI). Emojis fora do BMP
    # viram quadradinhos no GDI/WinForms; a cor do ponto carrega o estado.
    $level = [string](Get-V3Property $Overall 'Level')
    $spec = switch ($level) {
        'NORMAL'   { @('NORMAL', 'OK') }
        'ATENCAO'  { @((ConvertFrom-V3Text 'ATEN\u00c7\u00c3O'), 'WARN') }
        'PROBLEMA' { @('PROBLEMA', 'BAD') }
        default    { @('CARREGANDO', 'OFF') }
    }
    return [pscustomobject]@{
        Icon   = [string][char]0x25CF
        Text   = 'PRIME NEX ' + (ConvertFrom-V3Text '\u2014') + ' ' + $spec[0]
        Level  = $spec[1]
        Source = $level
    }
}
# ------------------------------------------------------------------ cards

function Get-V3NexCard {
    param([AllowNull()][object]$Nex)

    $position = [string](Get-V3Property $Nex 'Position')
    $unconfirmed = (Get-V3Property $Nex 'PathUnconfirmed') -eq $true
    $available = (Get-V3Property $Nex 'Available') -eq $true
    if ($position -eq 'CLOSED') { return New-V3Card 'NEX' 'NEX' 'WARN' 'Fechado' 'Nenhum NexAdmin em execucao' }
    if ($unconfirmed) { return New-V3Card 'NEX' 'NEX' 'WARN' 'Indeterminado' (ConvertFrom-V3Text 'Caminho do NexAdmin n\u00e3o confirmado (NEX elevado?)') }
    if (-not $available) { return New-V3Card 'NEX' 'NEX' 'WARN' 'Indeterminado' (ConvertFrom-V3Text 'Leitura do NEX indispon\u00edvel') }
    switch ($position) {
        'BACKGROUND' { return New-V3Card 'NEX' 'NEX' 'OK' 'Aberto' 'Em segundo plano' }
        'FOREGROUND' { return New-V3Card 'NEX' 'NEX' 'OK' 'Aberto' 'Em primeiro plano' }
        'MINIMIZED'  { return New-V3Card 'NEX' 'NEX' 'WARN' 'Minimizado' 'Restaure a janela do NEX' }
        default      { return New-V3Card 'NEX' 'NEX' 'WARN' 'Indeterminado' (ConvertFrom-V3Text 'Posi\u00e7\u00e3o da janela desconhecida') }
    }
}

function Get-V3TaskCard {
    param([AllowNull()][object]$Task, [datetime]$Now)

    if ((Get-V3Property $Task 'Available') -ne $true) { return New-V3Card 'TASK' 'Task' 'BAD' (ConvertFrom-V3Text 'Indispon\u00edvel') 'Task PrimeNexVendasExport nao encontrada' }

    $next = ConvertTo-V3DateTime (Get-V3Property $Task 'NextRunTime')
    $nextText = ''
    if ($null -ne $next) {
        $nextText = (ConvertFrom-V3Text 'Pr\u00f3xima \u00e0s ') + $next.ToString('HH:mm')
        if ($next -gt $Now) { $nextText += ' (em ' + (Format-V3Age -Since $Now -Now $next) + ')' }
    }

    if ((Get-V3Property $Task 'Enabled') -eq $false) { return New-V3Card 'TASK' 'Task' 'WARN' 'Desabilitada' $nextText }
    $state = ([string](Get-V3Property $Task 'State')).Trim().ToUpperInvariant()
    switch ($state) {
        'READY'    { return New-V3Card 'TASK' 'Task' 'OK' 'Pronta' $nextText }
        'RUNNING'  { return New-V3Card 'TASK' 'Task' 'OK' (ConvertFrom-V3Text 'Em execu\u00e7\u00e3o') $nextText }
        'QUEUED'   { return New-V3Card 'TASK' 'Task' 'OK' 'Na fila' $nextText }
        'DISABLED' { return New-V3Card 'TASK' 'Task' 'WARN' 'Desabilitada' $nextText }
        default    { return New-V3Card 'TASK' 'Task' 'WARN' 'Desconhecida' $nextText }
    }
}

function Format-V3CycleSeconds {
    param([AllowNull()][object]$Start, [AllowNull()][object]$End)

    $startAt = ConvertTo-V3DateTime $Start
    $endAt = ConvertTo-V3DateTime $End
    if ($null -eq $startAt -or $null -eq $endAt) { return $null }
    $seconds = [math]::Max(0, [int][math]::Round(($endAt - $startAt).TotalSeconds))
    if ($seconds -lt 60) { return "$seconds s" }
    return ('{0} min {1:D2} s' -f [math]::Floor($seconds / 60), [int]($seconds % 60))
}

# Linha do ultimo ciclo: "<rota> . <resultado> . <duracao>" (ex.: "V2 . sucesso . 17 s").
function Get-V3LastCycleText {
    param([AllowNull()][object]$Pipeline)

    $dot = ' ' + (ConvertFrom-V3Text '\u00b7') + ' '
    $cycle = Get-V3Property $Pipeline 'LatestCycle'
    $terminal = Get-V3Property $cycle 'Terminal'
    if ($null -eq $terminal) { return (ConvertFrom-V3Text '\u00daltimo ciclo indispon\u00edvel') }
    $stage = [string](Get-V3Property $terminal 'stage')
    $route = Get-DisplayValue -Value (Get-V3Property (Get-V3Property $cycle 'RouteEvent') 'hybridRoute') -Fallback (ConvertFrom-V3Text '\u2014')
    $result = if ($stage -eq 'Success') { 'sucesso' } else {
        $code = [string](Get-V3Property $terminal 'errorCode')
        (Get-FriendlyStage -Stage $stage) + $(if ($code) { ' (' + $code + ')' } else { '' })
    }
    $parts = @($route, $result)
    $duration = Format-V3CycleSeconds -Start (Get-V3Property $cycle 'Start') -End (Get-V3Property $cycle 'End')
    if ($duration) { $parts += $duration }
    return ($parts -join $dot)
}

function Get-V3ExportCard {
    param([AllowNull()][object]$Pipeline, [AllowNull()][object]$Export, [datetime]$Now)

    $cycleText = Get-V3LastCycleText -Pipeline $Pipeline
    $lastSuccess = ConvertTo-V3DateTime (Get-V3Property (Get-V3Property $Pipeline 'LastSuccess') 'timestamp')
    $successText = if ($null -ne $lastSuccess) {
        (ConvertFrom-V3Text '\u00daltimo sucesso \u00b7 ') + $lastSuccess.ToString('HH:mm')
    } else { 'Sem sucesso registrado' }

    if ((Get-V3Property $Export 'Available') -ne $true) { return New-V3Card 'EXPORT' 'Export' 'WARN' (ConvertFrom-V3Text 'Arquivo indispon\u00edvel') $cycleText }
    if ((Get-V3Property $Export 'IsStale') -eq $true) { return New-V3Card 'EXPORT' 'Export' 'WARN' (ConvertFrom-V3Text 'Sem exporta\u00e7\u00e3o > 15 min') $successText }
    if ($null -eq $lastSuccess) { return New-V3Card 'EXPORT' 'Export' 'WARN' $successText $cycleText }
    return New-V3Card 'EXPORT' 'Export' 'OK' $successText $cycleText
}
function Get-V3StageCard {
    param([AllowNull()][object]$Stage, [AllowNull()][object]$StageHealth)

    if ((Get-V3Property $Stage 'Available') -ne $true) { return New-V3Card 'STAGE' 'Stage' 'WARN' (ConvertFrom-V3Text 'Leitura indispon\u00edvel') 'EXPORT_STAGE' }
    $count = [int](Get-V3Property $Stage 'Count')
    if ($count -eq 0) { return New-V3Card 'STAGE' 'Stage' 'OK' 'Vazio' 'EXPORT_STAGE sem pendencias' }
    $level = switch ([string](Get-V3Property $StageHealth 'Level')) { 'PROBLEMA' { 'BAD' } 'NORMAL' { 'OK' } default { 'WARN' } }
    $primary = if ($count -eq 1) { '1 arquivo pendente' } else { "$count arquivos pendentes" }
    return New-V3Card 'STAGE' 'Stage' $level $primary ([string](Get-V3Property $StageHealth 'Summary'))
}

function Get-V3G13Card {
    param([bool]$G13Blocked)

    if ($G13Blocked) { return New-V3Card 'G13' 'G13' 'BAD' 'Bloqueando novas tentativas' 'Existe arquivo pendente em EXPORT_STAGE' }
    return New-V3Card 'G13' 'G13' 'OK' 'Sem bloqueio' 'Nenhum residuo elegivel'
}

function Get-V3GuardianCard {
    param([AllowNull()][object]$Guardian)

    $state = [string](Get-V3Property $Guardian 'State')
    if ($state -eq 'Concluido') {
        $classification = [string](Get-V3Property $Guardian 'Classification')
        $confidence = [string](Get-V3Property $Guardian 'Confidence')
        $human = if ([string](Get-V3Property $Guardian 'NeedsHuman') -eq 'SIM') { 'requer humano' } else { (ConvertFrom-V3Text 'sem a\u00e7\u00e3o humana') }
        $source = [string](Get-V3Property $Guardian 'Source')
        return New-V3Card 'GUARDIAN' 'Guardian' 'INFO' ($classification + ' ' + (ConvertFrom-V3Text '\u00b7') + ' ' + $confidence) ($human + ' ' + (ConvertFrom-V3Text '\u00b7') + ' origem ' + $source)
    }
    if ($state -eq 'Analisando...') { return New-V3Card 'GUARDIAN' 'Guardian' 'INFO' 'Analisando...' 'Somente leitura' }
    if ($state.StartsWith('Erro')) { return New-V3Card 'GUARDIAN' 'Guardian' 'WARN' (ConvertFrom-V3Text 'Falha na an\u00e1lise') $state }
    return New-V3Card 'GUARDIAN' 'Guardian' 'INFO' (ConvertFrom-V3Text 'Aguardando an\u00e1lise manual') (ConvertFrom-V3Text 'Nenhuma a\u00e7\u00e3o autom\u00e1tica \u00e9 executada')
}

# ------------------------------------------------------------------ supervisor
# Somente estado ja existente do TelemetrySender. Nenhuma rede, nenhum ping.
# "Conectado" = canal de telemetria Windows -> nuvem saudavel; nunca comando.
# Nao participa de Get-OverallStatus.

function Update-V3SupervisorObservation {
    param([int]$PreviousSent, [int]$CurrentSent, [AllowNull()][object]$PreviousAcceptedAt, [datetime]$Now)

    if ($CurrentSent -gt $PreviousSent) { return $Now }
    return $PreviousAcceptedAt
}

function Get-V3SupervisorIndicator {
    param([AllowNull()][object]$Sender, [AllowNull()][object]$LastAcceptedAt, [datetime]$Now)

    $dot = ConvertFrom-V3Text '\u00b7'
    $config = Get-V3Property $Sender 'Config'
    if ($null -eq $Sender -or (Get-V3Property $config 'Enabled') -ne $true) {
        $reason = [string](Get-V3Property $config 'Reason')
        $why = switch ($reason) {
            'CONFIG_MISSING' { (ConvertFrom-V3Text 'configura\u00e7\u00e3o ausente') }
            'DISABLED'       { 'desativado na config local' }
            ''               { 'transporte indisponivel' }
            default          { (ConvertFrom-V3Text 'configura\u00e7\u00e3o inv\u00e1lida') }
        }
        return [pscustomobject]@{ Level = 'OFF'; Primary = 'Supervisor desligado'; Secondary = $why; Counters = '' }
    }

    $counters = 'enviados ' + [int](Get-V3Property $Sender 'Sent') + " $dot falhas " + [int](Get-V3Property $Sender 'Failed') +
        " $dot descartados " + [int](Get-V3Property $Sender 'Dropped') + " $dot rejeitados " + [int](Get-V3Property $Sender 'Rejected') +
        " $dot fila " + [int](Get-V3Property (Get-V3Property $Sender 'Queue') 'Count')
    $lastResult = [string](Get-V3Property $Sender 'LastResult')
    $sending = ($lastResult -eq 'SENDING') -or ($null -ne (Get-V3Property $Sender 'Pending'))
    $accepted = ConvertTo-V3DateTime $LastAcceptedAt
    $acceptedText = if ($null -ne $accepted) { (ConvertFrom-V3Text '\u00faltimo envio aceito h\u00e1 ') + (Format-V3Age -Since $accepted -Now $Now) } else { 'nenhum envio aceito ainda' }

    $level = $null; $primary = $null; $secondary = $acceptedText
    if ($lastResult -eq 'SECRET_UNAVAILABLE') { $level = 'BAD'; $primary = (ConvertFrom-V3Text 'Segredo indispon\u00edvel') }
    elseif ($lastResult -eq 'HTTP_401' -or $lastResult -eq 'HTTP_403') { $level = 'BAD'; $primary = 'Envio recusado (credencial)' }
    elseif ($lastResult -match '^HTTP_4\d\d$') { $level = 'BAD'; $primary = 'Envio recusado (' + $lastResult.Replace('_', ' ') + ')' }
    elseif ($lastResult -match '^HTTP_5\d\d$' -or $lastResult -in @('NETWORK_ERROR', 'TIMEOUT', 'SEND_ERROR', 'STEP_ERROR')) { $level = 'WARN'; $primary = (ConvertFrom-V3Text 'Falha tempor\u00e1ria de envio') }
    elseif ($null -eq $accepted) { $level = 'INFO'; $primary = 'Aguardando primeiro envio'; $secondary = 'Somente envio Windows -> nuvem' }
    elseif (($Now - $accepted).TotalSeconds -le $script:V3SupervisorRecentSeconds) { $level = 'OK'; $primary = 'Supervisor conectado'; $secondary = (ConvertFrom-V3Text '\u00daltimo envio h\u00e1 ') + (Format-V3Age -Since $accepted -Now $Now) }
    else { $level = 'WARN'; $primary = 'Sem envio recente'; $secondary = (ConvertFrom-V3Text '\u00daltimo envio h\u00e1 ') + (Format-V3Age -Since $accepted -Now $Now) }

    if ($sending) { $primary += ' ' + $dot + ' ' + (ConvertFrom-V3Text 'enviando\u2026') }
    return [pscustomobject]@{ Level = $level; Primary = $primary; Secondary = $secondary; Counters = $counters }
}

function Get-V3SupervisorCard {
    param([AllowNull()][object]$Sender, [AllowNull()][object]$LastAcceptedAt, [datetime]$Now)

    $indicator = Get-V3SupervisorIndicator -Sender $Sender -LastAcceptedAt $LastAcceptedAt -Now $Now
    return New-V3Card 'SUPERVISOR' 'Supervisor' $indicator.Level $indicator.Primary $indicator.Secondary
}

# ------------------------------------------------------------------ execucao atual / detalhes

function Get-V3CurrentRun {
    param([AllowNull()][object]$Pipeline)

    $run = Get-V3Property $Pipeline 'CurrentRun'
    if ((Get-V3Property $Pipeline 'InProgress') -ne $true -or $null -eq $run) { return [pscustomobject]@{ Visible = $false; Text = '' } }
    $start = ConvertTo-V3DateTime (Get-V3Property $run 'Start')
    $stage = Get-FriendlyStage -Stage ([string](Get-V3Property (Get-V3Property $run 'LastRecord') 'stage'))
    $routeEvent = Get-V3Property $run 'RouteEvent'
    $route = Get-DisplayValue -Value (Get-V3Property $routeEvent 'hybridRoute') -Fallback '-'
    $position = Get-DisplayValue -Value (Get-V3Property $routeEvent 'nexPosition') -Fallback '-'
    $dot = ConvertFrom-V3Text '\u00b7'
    $text = (ConvertFrom-V3Text 'Execu\u00e7\u00e3o em andamento')
    if ($null -ne $start) { $text += ' desde ' + $start.ToString('HH:mm:ss') }
    $text += " $dot etapa: $stage $dot $route / $position"
    return [pscustomobject]@{ Visible = $true; Text = $text }
}

function Get-V3NextAction {
    param([AllowNull()][object]$Pipeline, [AllowNull()][object]$Task, [bool]$G13Blocked)

    if ((Get-V3Property $Pipeline 'InProgress') -eq $true) { return 'Execucao em andamento' }
    if ($G13Blocked) { return 'Proxima tentativa bloqueada pelo G13' }
    $next = Get-V3Property $Task 'NextRunTime'
    if ((Get-V3Property $Task 'Available') -eq $true -and (Get-V3Property $Task 'Enabled') -eq $true -and $null -ne $next) {
        return 'Aguardar proxima tentativa automatica as ' + ([datetime]$next).ToString('HH:mm:ss')
    }
    return 'Nenhuma proxima acao objetiva disponivel'
}

function Get-V3Details {
    param(
        [AllowNull()][object]$Task, [AllowNull()][object]$Pipeline, [AllowNull()][object]$Export,
        [AllowNull()][object]$Stage, [AllowNull()][object]$Nex, [AllowNull()][object]$Overall,
        [bool]$G13Blocked, [AllowNull()][object]$OutboxHealth, [AllowNull()][object]$StageHealth,
        [AllowNull()][object]$SuccessHealth, [AllowNull()][object]$SuccessExport, [AllowNull()][object]$Supervisor
    )

    $rows = [System.Collections.Generic.List[object]]::new()
    $add = { param($label, $value) $rows.Add([pscustomobject]@{ Label = $label; Value = (Get-DisplayValue -Value $value) }) }

    & $add 'Estado geral' ([string](Get-V3Property $Overall 'Level') + ' - ' + [string](Get-V3Property $Overall 'Detail'))
    foreach ($pair in @(@('PRIME COBRANCAS', $OutboxHealth), @('EXPORT_STAGE', $StageHealth), @('ULTIMO SUCCESS', $SuccessHealth))) {
        if ($null -ne $pair[1]) { & $add ('Saude ' + $pair[0]) ([string](Get-V3Property $pair[1] 'Level') + ' - ' + [string](Get-V3Property $pair[1] 'Summary')) }
    }
    & $add 'NEX posicao' (Get-V3Property $Nex 'Position')
    & $add 'Task status' $(if ((Get-V3Property $Task 'Available') -ne $true) { 'Indisponivel' } elseif ((Get-V3Property $Task 'Enabled') -eq $true) { 'Ativa' } else { 'Desabilitada' })
    & $add 'Task estado' (Get-V3Property $Task 'State')
    & $add 'Task ultima execucao' (Format-DateTime -Value (Get-V3Property $Task 'LastRunTime'))
    & $add 'LastTaskResult' (Get-V3Property $Task 'LastTaskResult')
    & $add 'Task proxima tentativa' (Format-DateTime -Value (Get-V3Property $Task 'NextRunTime'))
    & $add 'Countdown' (Format-Countdown -TargetTime (Get-V3Property $Task 'NextRunTime'))

    $cycle = Get-V3Property $Pipeline 'LatestCycle'
    $terminal = Get-V3Property $Pipeline 'LatestTerminal'
    $routeEvent = Get-V3Property $cycle 'RouteEvent'
    & $add 'Ultimo ciclo inicio' (Format-DateTime -Value (Get-V3Property $cycle 'Start'))
    & $add 'Ultimo ciclo fim' (Format-DateTime -Value (Get-V3Property $cycle 'End'))
    & $add 'Ultimo ciclo duracao' $(if ($null -ne $cycle) { Format-Duration -StartTime (Get-V3Property $cycle 'Start') -EndTime (Get-V3Property $cycle 'End') } else { '-' })
    & $add 'Ultimo ciclo stage' (Get-V3Property $terminal 'stage')
    & $add 'Ultimo ciclo error code' (Get-V3Property $terminal 'errorCode')
    & $add 'Rota' (Get-V3Property $routeEvent 'hybridRoute')
    & $add 'Posicao NEX no ciclo' (Get-V3Property $routeEvent 'nexPosition')
    & $add 'Motivo rota' (Get-V3Property $routeEvent 'routeReason')

    $file = Get-V3Property $Export 'File'
    & $add 'Ultimo arquivo exportado' $(if ((Get-V3Property $Export 'Available') -eq $true -and $null -ne $file) { $file.Name } else { 'Indisponivel' })
    if ((Get-V3Property $Export 'Available') -eq $true -and $null -ne $file) {
        & $add 'Arquivo data/hora' (Format-DateTime -Value $file.LastWriteTime)
        & $add 'Arquivo idade' (Format-FileAge -Time $file.LastWriteTime)
        & $add 'Arquivo tamanho' (Format-FileSize -Bytes $file.Length)
    }

    $lastSuccess = Get-V3Property $Pipeline 'LastSuccess'
    & $add 'Ultimo sucesso' (Format-DateTime -Value (Get-V3Property $lastSuccess 'timestamp'))
    & $add 'Ultimo sucesso arquivo' (Get-V3Property $lastSuccess 'fileName')
    $successFile = Get-V3Property $SuccessExport 'File'
    if ((Get-V3Property $SuccessExport 'Available') -eq $true -and $null -ne $successFile) {
        & $add 'Ultimo sucesso idade' (Format-FileAge -Time $successFile.LastWriteTime)
        & $add 'Ultimo sucesso tamanho' (Format-FileSize -Bytes $successFile.Length)
    }

    & $add 'EXPORT_STAGE' ([string][int](Get-V3Property $Stage 'Count') + ' arquivo(s)')
    & $add 'Bloqueio atual (G13)' $(if ($G13Blocked) { 'Exportacao bloqueada: existe arquivo pendente em EXPORT_STAGE.' } else { 'Nenhum' })

    $reason = if ($null -ne $terminal) {
        $terminalReason = Get-DisplayValue -Value (Get-V3Property $terminal 'reason') -Fallback ''
        $terminalCode = Get-DisplayValue -Value (Get-V3Property $terminal 'errorCode') -Fallback ''
        if ($terminalReason) { $terminalReason } elseif ($terminalCode) { $terminalCode } else { [string](Get-V3Property $Overall 'Detail') }
    } else { [string](Get-V3Property $Overall 'Detail') }
    & $add 'Ultimo erro / motivo' $reason
    & $add 'Proxima acao do sistema' (Get-V3NextAction -Pipeline $Pipeline -Task $Task -G13Blocked $G13Blocked)
    if ($null -ne $Supervisor) { & $add 'Supervisor (telemetria)' ($Supervisor.Primary + ' | ' + $Supervisor.Counters) }
    return , $rows.ToArray()
}

# ------------------------------------------------------------------ view model completo

function Get-MonitorViewModel {
    param(
        [AllowNull()][object]$Task, [AllowNull()][object]$Pipeline, [AllowNull()][object]$Export,
        [AllowNull()][object]$Stage, [AllowNull()][object]$Nex, [AllowNull()][object]$Overall,
        [bool]$G13Blocked, [AllowNull()][object]$OutboxHealth, [AllowNull()][object]$StageHealth,
        [AllowNull()][object]$SuccessHealth, [AllowNull()][object]$SuccessExport,
        [AllowNull()][object]$Sender, [AllowNull()][object]$LastAcceptedSendAt,
        [AllowNull()][object]$Guardian, [AllowNull()][object]$LastRefreshAt, [datetime]$Now
    )

    $supervisor = Get-V3SupervisorIndicator -Sender $Sender -LastAcceptedAt $LastAcceptedSendAt -Now $Now
    $updated = if ($null -ne $LastRefreshAt) { (ConvertFrom-V3Text 'atualizado h\u00e1 ') + (Format-V3Age -Since $LastRefreshAt -Now $Now) } else { 'aguardando primeira leitura' }
    return [pscustomobject]@{
        Headline   = Get-V3Headline -Overall $Overall
        Subtitle   = [string](Get-V3Property $Overall 'Detail')
        Updated    = $updated
        Supervisor = $supervisor
        CurrentRun = Get-V3CurrentRun -Pipeline $Pipeline
        Cards      = @(
            (Get-V3NexCard -Nex $Nex),
            (Get-V3TaskCard -Task $Task -Now $Now),
            (Get-V3ExportCard -Pipeline $Pipeline -Export $Export -Now $Now),
            (Get-V3StageCard -Stage $Stage -StageHealth $StageHealth),
            (Get-V3G13Card -G13Blocked $G13Blocked),
            (New-V3Card 'SUPERVISOR' 'Supervisor' $supervisor.Level $supervisor.Primary $supervisor.Secondary),
            (Get-V3GuardianCard -Guardian $Guardian)
        )
        Details    = Get-V3Details -Task $Task -Pipeline $Pipeline -Export $Export -Stage $Stage -Nex $Nex -Overall $Overall -G13Blocked $G13Blocked -OutboxHealth $OutboxHealth -StageHealth $StageHealth -SuccessHealth $SuccessHealth -SuccessExport $SuccessExport -Supervisor $supervisor
    }
}

# ------------------------------------------------------------------ Guardian: texto do clipboard
# Mesmo formato e mesma sanitizacao do Copiar diagnostico da V2.

function ConvertTo-V3GuardianClipboardText {
    param([AllowNull()][object]$Guardian)

    $value = { param($name) Get-DisplayValue -Value (Get-V3Property $Guardian $name) }
    $yesNo = { param($v) if ($v -eq 'SIM') { 'Sim' } elseif ($v -eq 'NAO') { ConvertFrom-V3Text 'N\u00e3o' } else { $v } }
    $evidenceLines = @(@(Get-V3Property $Guardian 'EvidenceLines') | Where-Object { $null -ne $_ -and ([string]$_).Trim() -ne '' } | ForEach-Object {
        $line = ([string]$_).Trim()
        if ($line.StartsWith('- ')) { $line } else { '- ' + $line }
    })
    $text = @(
        'PRIME NEX GUARDIAN'
        ''
        'Estado: ' + (& $value 'State')
        'Origem: ' + (& $value 'Source')
        (ConvertFrom-V3Text 'Classifica\u00e7\u00e3o: ') + (& $value 'Classification')
        (ConvertFrom-V3Text 'Confian\u00e7a: ') + (& $value 'Confidence')
        ''
        'Resumo:'
        (& $value 'Summary')
        ''
        (ConvertFrom-V3Text 'Evid\u00eancias:')
        ($evidenceLines -join "`r`n")
        ''
        (ConvertFrom-V3Text 'Recomenda\u00e7\u00e3o:')
        (& $value 'Action')
        ''
        (ConvertFrom-V3Text 'Humano necess\u00e1rio: ') + (& $yesNo (& $value 'NeedsHuman'))
        'Auto-fix: ' + (& $yesNo (& $value 'AutoFix'))
        ''
        (ConvertFrom-V3Text '\u00daltima an\u00e1lise:')
        (& $value 'LastAnalysis')
    ) -join "`r`n"

    # Defesa extra: nunca levar chaves, tokens ou caminhos internos para o clipboard.
    $text = [regex]::Replace($text, '(?i)\bsk-[A-Za-z0-9_\-]{8,}', '[omitido]')
    $text = [regex]::Replace($text, '(?i)\b(bearer|authorization|api[_-]?key|x-api-key)\b\s*[:=]?\s*\S+', '$1 [omitido]')
    $text = [regex]::Replace($text, '(?i)(?<![A-Za-z])[A-Z]:\\[^\s"'']*', '[caminho omitido]')
    $text = [regex]::Replace($text, '\\\\[^\s"'']+', '[caminho omitido]')
    return $text
}

# ------------------------------------------------------------------ instancia unica (puro)
# Recebe a lista de processos ja lida pela V3; devolve os PIDs de outros
# Monitores (V2 ou V3). Nao le processos, nao encerra nada.

function Find-V3OtherMonitorInstances {
    param([AllowNull()][object[]]$Processes, [int]$SelfPid)

    $found = [System.Collections.Generic.List[int]]::new()
    foreach ($process in @($Processes)) {
        if ($null -eq $process) { continue }
        $processId = [int](Get-V3Property $process 'ProcessId')
        $commandLine = [string](Get-V3Property $process 'CommandLine')
        if ($processId -eq $SelfPid -or [string]::IsNullOrWhiteSpace($commandLine)) { continue }
        if ($commandLine -match '(?i)[\\/"\s]PrimeNexMonitor(V3)?\.ps1\b') { $found.Add($processId) }
    }
    return , $found.ToArray()
}
