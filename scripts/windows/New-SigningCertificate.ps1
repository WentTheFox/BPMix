<#
.SYNOPSIS
  Generates the self-signed code-signing certificate CI signs the Windows
  MSIX with, and (optionally) uploads it as GitHub Actions secrets.

.DESCRIPTION
  The certificate's subject MUST equal the Publisher attribute in
  apps/mobile/windows/Mobile.Package/Package.appxmanifest (CN=WentTheFox) -
  MSIX refuses to sign/install a package whose publisher doesn't match its
  signing certificate.

  Writes <OutDir>\bpmix-signing.pfx (private key - keep it backed up, never
  commit it) and <OutDir>\bpmix-signing.cer (public half). Regenerating the
  certificate later is possible (updates only require the same Publisher
  string, not the same certificate), but every user would have to trust the
  new one, which Install.ps1 does automatically on their next install.

  With -SetGitHubSecrets, sets WINDOWS_SIGNING_PFX_BASE64 and
  WINDOWS_SIGNING_PFX_PASSWORD on the repo via the GitHub CLI, which is what
  .github/workflows/native-builds.yml reads.
#>
param(
  [string]$OutDir = (Join-Path $HOME 'BPMix-signing'),
  [string]$Subject = 'CN=WentTheFox',
  [int]$ValidYears = 10,
  [switch]$SetGitHubSecrets,
  [string]$GhPath = 'C:\Program Files\GitHub CLI\gh.exe'
)

$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force $OutDir | Out-Null
$pfxPath = Join-Path $OutDir 'bpmix-signing.pfx'
$cerPath = Join-Path $OutDir 'bpmix-signing.cer'
if (Test-Path $pfxPath) {
  throw "$pfxPath already exists - move it away first if you really want a new certificate."
}

# Random password for the PFX; it only protects the file in transit/at rest,
# CI gets it through a secret alongside the file itself.
$passwordBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($passwordBytes)
$passwordText = [Convert]::ToBase64String($passwordBytes)
$password = ConvertTo-SecureString $passwordText -AsPlainText -Force

$cert = New-SelfSignedCertificate `
  -Type Custom `
  -Subject $Subject `
  -FriendlyName 'BPMix sideload signing' `
  -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 3072 `
  -KeyExportPolicy Exportable `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}') `
  -NotAfter (Get-Date).AddYears($ValidYears) `
  -CertStoreLocation 'Cert:\CurrentUser\My'

try {
  Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null
  Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
} finally {
  # The PFX file is the one copy that matters; don't leave the key lying
  # around in the personal store too.
  Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)"
}

Write-Host "Certificate: $($cert.Subject), thumbprint $($cert.Thumbprint), expires $($cert.NotAfter)"
Write-Host "Wrote $pfxPath and $cerPath - back up the .pfx somewhere safe."

if ($SetGitHubSecrets) {
  $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))
  $base64 | & $GhPath secret set WINDOWS_SIGNING_PFX_BASE64
  if ($LASTEXITCODE -ne 0) { throw 'gh secret set WINDOWS_SIGNING_PFX_BASE64 failed' }
  $passwordText | & $GhPath secret set WINDOWS_SIGNING_PFX_PASSWORD
  if ($LASTEXITCODE -ne 0) { throw 'gh secret set WINDOWS_SIGNING_PFX_PASSWORD failed' }
  Write-Host 'Set WINDOWS_SIGNING_PFX_BASE64 and WINDOWS_SIGNING_PFX_PASSWORD on the GitHub repo.'
} else {
  Write-Host "PFX password (needed for the WINDOWS_SIGNING_PFX_PASSWORD secret): $passwordText"
}
