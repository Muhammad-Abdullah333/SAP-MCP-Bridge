param(
  [Parameter(Mandatory=$true)][string]$SignTool,
  [Parameter(Mandatory=$true)][string]$CertificateThumbprint,
  [Parameter(Mandatory=$true)][string[]]$Files,
  [string]$TimestampUrl='http://timestamp.digicert.com'
)
$ErrorActionPreference='Stop'
foreach($file in $Files) {
  if(!(Test-Path -LiteralPath $file -PathType Leaf)) {throw "File not found: $file"}
  & $SignTool sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $file
  if($LASTEXITCODE -ne 0) {throw "Signing failed: $file"}
  & $SignTool verify /pa $file
  if($LASTEXITCODE -ne 0) {throw "Signature verification failed: $file"}
}
