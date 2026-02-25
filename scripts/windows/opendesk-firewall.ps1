param(
  [ValidateSet('Install', 'Remove', 'Status')]
  [string]$Action = 'Install',
  [string]$RulePrefix = 'OpenDesk Manual',
  [string]$VideoUdpPort = '5004',
  [string]$InputTcpPort = '5505',
  [string]$ApiTcpPort = '3333',
  [string]$RemoteAddress = 'Any'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-IsAdmin {
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Admin {
  if (Test-IsAdmin) {
    return
  }
  throw "Este script precisa ser executado como Administrador."
}

function Get-RuleName([string]$suffix) {
  return "$RulePrefix $suffix"
}

function Remove-OpenDeskRules {
  $rules = Get-NetFirewallRule -DisplayName "$RulePrefix *" -ErrorAction SilentlyContinue
  if ($null -eq $rules) {
    return
  }
  $rules | Remove-NetFirewallRule -ErrorAction SilentlyContinue | Out-Null
}

function Add-OrReplaceRule {
  param(
    [Parameter(Mandatory = $true)][string]$Suffix,
    [Parameter(Mandatory = $true)][string]$Direction,
    [Parameter(Mandatory = $true)][string]$Protocol,
    [Parameter(Mandatory = $true)][string]$LocalPort
  )

  $name = Get-RuleName $Suffix
  $existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    $existing | Remove-NetFirewallRule -ErrorAction SilentlyContinue | Out-Null
  }

  New-NetFirewallRule `
    -DisplayName $name `
    -Direction $Direction `
    -Action Allow `
    -Enabled True `
    -Profile Any `
    -Protocol $Protocol `
    -LocalPort $LocalPort `
    -RemoteAddress $RemoteAddress `
    | Out-Null
}

function Show-Status {
  $rules = Get-NetFirewallRule -DisplayName "$RulePrefix *" -ErrorAction SilentlyContinue
  if ($null -eq $rules) {
    Write-Host "Nenhuma regra encontrada para prefixo: $RulePrefix"
    return
  }

  $rules | Sort-Object DisplayName | ForEach-Object {
    $portFilter = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $_
    $addressFilter = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $_
    [PSCustomObject]@{
      Name          = $_.DisplayName
      Enabled       = $_.Enabled
      Direction     = $_.Direction
      Action        = $_.Action
      Protocol      = $portFilter.Protocol
      LocalPort     = $portFilter.LocalPort
      RemoteAddress = $addressFilter.RemoteAddress
      Profile       = $_.Profile
    }
  } | Format-Table -AutoSize
}

switch ($Action) {
  'Install' {
    Assert-Admin
    Remove-OpenDeskRules

    Add-OrReplaceRule -Suffix 'UDP Video In' -Direction 'Inbound' -Protocol 'UDP' -LocalPort $VideoUdpPort
    Add-OrReplaceRule -Suffix 'UDP Video Out' -Direction 'Outbound' -Protocol 'UDP' -LocalPort $VideoUdpPort

    Add-OrReplaceRule -Suffix 'TCP Input In' -Direction 'Inbound' -Protocol 'TCP' -LocalPort $InputTcpPort
    Add-OrReplaceRule -Suffix 'TCP Input Out' -Direction 'Outbound' -Protocol 'TCP' -LocalPort $InputTcpPort

    Add-OrReplaceRule -Suffix 'TCP API In' -Direction 'Inbound' -Protocol 'TCP' -LocalPort $ApiTcpPort
    Add-OrReplaceRule -Suffix 'TCP API Out' -Direction 'Outbound' -Protocol 'TCP' -LocalPort $ApiTcpPort

    Write-Host "Regras aplicadas com sucesso."
    Show-Status
    break
  }
  'Remove' {
    Assert-Admin
    Remove-OpenDeskRules
    Write-Host "Regras removidas para prefixo: $RulePrefix"
    break
  }
  'Status' {
    Show-Status
    break
  }
}
