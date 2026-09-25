<#
.SYNOPSIS
  Installs (or updates) BPMix from the extracted Windows release zip.

.DESCRIPTION
  Shipped next to the .msixbundle in the release's sideload zip (see
  .github/workflows/native-builds.yml). The package is signed with a
  self-signed certificate (scripts/windows/New-SigningCertificate.ps1), so
  Windows only accepts it once that certificate is in the machine's Trusted
  People store. This script:

    1. trusts BPMix.cer if it isn't already - the only step that needs admin,
       so only that step is elevated (one UAC prompt, first install only);
    2. installs the .msixbundle for the current, non-elevated user, together
       with the framework dependencies (VCLibs, Windows App Runtime) shipped
       in Dependencies\.

  Launched through Install.cmd so a double-click works regardless of the
  machine's PowerShell execution policy.
#>
param(
  # Internal: set when the script re-launches itself elevated just to import
  # the certificate.
  [switch]$TrustCertificateOnly
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$cerPath = Join-Path $here 'BPMix.cer'
$storePath = 'Cert:\LocalMachine\TrustedPeople'

function Test-CertificateTrusted {
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $cerPath
  return [bool](Get-ChildItem $storePath | Where-Object Thumbprint -eq $cert.Thumbprint)
}

if ($TrustCertificateOnly) {
  Import-Certificate -FilePath $cerPath -CertStoreLocation $storePath | Out-Null
  exit 0
}

try {
  if (-not (Test-Path $cerPath)) { throw "BPMix.cer not found next to this script ($here)." }
  $bundle = Get-ChildItem $here -Filter '*.msixbundle' | Select-Object -First 1
  if (-not $bundle) { throw "No .msixbundle found next to this script ($here)." }

  if (-not (Test-CertificateTrusted)) {
    Write-Host 'Trusting the BPMix signing certificate (Windows will ask for admin permission)...'
    $proc = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', "`"$PSCommandPath`"", '-TrustCertificateOnly'
    )
    if ($proc.ExitCode -ne 0 -or -not (Test-CertificateTrusted)) {
      throw 'Could not add the BPMix certificate to Trusted People.'
    }
  }

  $dependencies = @(Get-ChildItem (Join-Path $here 'Dependencies') -Include '*.appx', '*.msix' -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object FullName)

  $addArgs = @{ Path = $bundle.FullName; ForceApplicationShutdown = $true }
  if ($dependencies.Count -gt 0) { $addArgs.DependencyPath = $dependencies }

  Write-Host "Installing $($bundle.Name)..."
  Add-AppxPackage @addArgs
  Write-Host 'BPMix is installed - find it in the Start menu.' -ForegroundColor Green
} catch {
  Write-Host "Installation failed: $_" -ForegroundColor Red
  exit 1
}
