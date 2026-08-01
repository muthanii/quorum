# Make the Quorum dev stack reachable from another device (phone, tablet).
#
# WSL2 runs behind NAT: Windows forwards *localhost* into the Linux VM, but not
# any of its other addresses, so a second device needs an explicit port proxy.
#
# The proxy listens on 0.0.0.0, so it serves every interface at once — Tailscale
# and LAN alike. What differs is the firewall rule, hence -Mode.
#
#   -Mode Tailscale  (default) reachable only from your own tailnet devices,
#                    over encrypted WireGuard, from anywhere. Preferred: the
#                    dev server has no rate limiting, so it should not sit on a
#                    network you do not control.
#   -Mode Lan        reachable by anything on the same Wi-Fi. Only do this on a
#                    network you trust.
#
# RUN AS ADMINISTRATOR (right-click PowerShell -> Run as administrator):
#   powershell -ExecutionPolicy Bypass -File \\wsl$\Ubuntu\home\muthanii\projects\quorum\scripts\expose-to-lan.ps1
#
# Undo with:  ... expose-to-lan.ps1 -Remove
param(
  [ValidateSet("Tailscale", "Lan")] [string]$Mode = "Tailscale",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$ports = @(3000, 3001)   # 3000 = web, 3001 = realtime websocket
$ruleName = "Quorum dev (WSL)"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "This script must run in an ELEVATED PowerShell (Run as administrator)."
}

if ($Remove) {
  foreach ($p in $ports) {
    netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 2>$null | Out-Null
  }
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Host "Removed port proxies and firewall rule." -ForegroundColor Green
  netsh interface portproxy show v4tov4
  return
}

# The WSL VM's address changes on most restarts — read it live.
$wslIp = (wsl.exe -e sh -c "ip -4 -o addr show eth0 | awk '{print \$4}' | cut -d/ -f1").Trim()
if (-not $wslIp) { Write-Error "Could not determine the WSL IP address." }
Write-Host "WSL address: $wslIp"

foreach ($p in $ports) {
  netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 2>$null | Out-Null
  netsh interface portproxy add v4tov4 listenport=$p listenaddress=0.0.0.0 `
        connectport=$p connectaddress=$wslIp
  Write-Host "Forwarding 0.0.0.0:$p -> ${wslIp}:$p"
}

Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

if ($Mode -eq "Tailscale") {
  # Scope the opening to the tailnet subnet so the ports stay closed to the
  # local network even when Wi-Fi is on a Public profile.
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $ports -RemoteAddress 100.64.0.0/10 | Out-Null
  $addr = (Get-NetIPAddress -AddressFamily IPv4 |
           Where-Object { $_.InterfaceAlias -like "*Tailscale*" } |
           Select-Object -First 1).IPAddress
  Write-Host "Firewall opened to the tailnet only (100.64.0.0/10)." -ForegroundColor Green
} else {
  # Match every profile: Windows often classifies Wi-Fi as Public, and a
  # Private-only rule would silently fail to apply.
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $ports -Profile Any | Out-Null
  $addr = (Get-NetIPAddress -AddressFamily IPv4 |
           Where-Object { $_.InterfaceAlias -like "*Wi-Fi*" -and $_.IPAddress -notlike "169.254.*" } |
           Select-Object -First 1).IPAddress
  Write-Host "Firewall opened on ALL profiles — anyone on this network can reach it." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Open this on your phone:  http://${addr}:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "Set NEXT_PUBLIC_APP_URL in .env to the same address so invite links" -ForegroundColor Yellow
Write-Host "point somewhere the phone can reach. NEXT_PUBLIC_WS_URL can stay on" -ForegroundColor Yellow
Write-Host "localhost: the client follows whatever host served the page." -ForegroundColor Yellow
netsh interface portproxy show v4tov4
