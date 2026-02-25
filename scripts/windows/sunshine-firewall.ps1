param(
  [ValidateSet('Install', 'Remove', 'Status')]
  [string]$Action = 'Install',
  [string]$RulePrefix = 'OpenDesk Sunshine Manual',
  [string]$ManagedRulePrefix = 'OpenDesk Sunshine',
  [string]$TcpPorts = '47984,47989,47990',
  [string]$UdpPorts = '47998-48010',
  [string]$RemoteAddress = 'Any',
  [switch]$ClearManagedRules
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

function Remove-RulesByPrefix([string]$prefix) {
  $rules = Get-NetFirewallRule -DisplayName "$prefix*" -ErrorAction SilentlyContinue
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
    [Parameter(Mandatory = $true)][string]$Ports
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
    -LocalPort $Ports `
    -RemoteAddress $RemoteAddress `
    | Out-Null
}

function Show-Status {
  $rules = Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue
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
    Remove-RulesByPrefix $RulePrefix
    if ($ClearManagedRules) {
      Remove-RulesByPrefix $ManagedRulePrefix
    }

    Add-OrReplaceRule -Suffix 'TCP In' -Direction 'Inbound' -Protocol 'TCP' -Ports $TcpPorts
    Add-OrReplaceRule -Suffix 'TCP Out' -Direction 'Outbound' -Protocol 'TCP' -Ports $TcpPorts
    Add-OrReplaceRule -Suffix 'UDP In' -Direction 'Inbound' -Protocol 'UDP' -Ports $UdpPorts
    Add-OrReplaceRule -Suffix 'UDP Out' -Direction 'Outbound' -Protocol 'UDP' -Ports $UdpPorts

    Write-Host "Regras Sunshine aplicadas com sucesso."
    if ($ClearManagedRules) {
      Write-Host "Regras automaticas '$ManagedRulePrefix*' foram limpas."
    }
    Show-Status
    break
  }
  'Remove' {
    Assert-Admin
    Remove-RulesByPrefix $RulePrefix
    Write-Host "Regras manuais removidas para prefixo: $RulePrefix"
    break
  }
  'Status' {
    Show-Status
    break
  }
}
