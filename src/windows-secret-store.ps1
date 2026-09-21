param(
  [Parameter(Mandatory=$true)][ValidateSet('set','get','delete')][string]$Action,
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Z0-9_-]{1,80}$')][string]$Id,
  [Parameter(Mandatory=$true)][string]$Store
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security
[System.IO.Directory]::CreateDirectory($Store) | Out-Null
$file = Join-Path $Store ($Id + '.bin')
if ($Action -eq 'set') {
  $text = [Console]::In.ReadToEnd()
  $plain = [Text.Encoding]::UTF8.GetBytes($text)
  $protected = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes($file, $protected)
  '{"ok":true}'
} elseif ($Action -eq 'get') {
  if (-not [IO.File]::Exists($file)) { 'null'; exit 0 }
  $protected = [IO.File]::ReadAllBytes($file)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Text.Encoding]::UTF8.GetString($plain)
} else {
  if ([IO.File]::Exists($file)) { Remove-Item -LiteralPath $file -Force }
  '{"ok":true}'
}
