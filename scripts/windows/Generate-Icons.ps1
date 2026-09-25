<#
.SYNOPSIS
  Regenerates the Windows app icon (.ico) and every MSIX logo asset from the
  shared app icon, apps/web/public/icons/icon-512.png.

.DESCRIPTION
  Run after the app icon changes. PowerShell + System.Drawing only. Writes
  apps/mobile/windows/BPMix/BPMix.ico (embedded as the exe's IDI_ICON1 and
  set on the window in BPMix.cpp) and apps/mobile/windows/BPMix.Package/Images/*.png
  (picked up by BPMix.Package.wapproj's Images\*.png wildcard; the manifest's
  unqualified names resolve to these scale-*/targetsize-* variants). The
  taskbar uses Square44x44Logo.targetsize-*_altform-unplated specifically.
#>
param(
  [string]$Source = (Join-Path $PSScriptRoot '..\..\apps\web\public\icons\icon-512.png'),
  [string]$ImagesOut = (Join-Path $PSScriptRoot '..\..\apps\mobile\windows\BPMix.Package\Images'),
  [string]$IcoOut = (Join-Path $PSScriptRoot '..\..\apps\mobile\windows\BPMix\BPMix.ico')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $ImagesOut | Out-Null
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source).Path)

# Render the source centered on a transparent w x h canvas, with the disc occupying `fill` of the shorter side.
function Render([int]$w, [int]$h, [double]$fill) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'
  $g.PixelOffsetMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = [int][Math]::Round([Math]::Min($w, $h) * $fill)
  $g.DrawImage($src, [int](($w - $s) / 2), [int](($h - $s) / 2), $s, $s)
  $g.Dispose(); return $bmp
}
function Save($bmp, $name) { $bmp.Save((Join-Path $ImagesOut $name), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose() }

# Square44x44Logo (app list / taskbar / Start). targetsize-* are what the taskbar picks; unplated = no tile plate behind it.
foreach ($sc in @{100=44;125=55;150=66;200=88;400=176}.GetEnumerator()) { Save (Render $sc.Value $sc.Value 1.0) "Square44x44Logo.scale-$($sc.Key).png" }
foreach ($t in 16,20,24,30,32,36,40,48,60,64,72,80,96,256) {
  Save (Render $t $t 1.0) "Square44x44Logo.targetsize-$t.png"
  Save (Render $t $t 1.0) "Square44x44Logo.targetsize-${t}_altform-unplated.png"
  Save (Render $t $t 1.0) "Square44x44Logo.targetsize-${t}_altform-lightunplated.png"
}
# Tiles / store / lock screen / splash (logo padded inside the plate).
foreach ($sc in @{100=1;125=1.25;150=1.5;200=2;400=4}.GetEnumerator()) {
  $f = $sc.Value
  Save (Render ([int](150*$f)) ([int](150*$f)) 0.66) "Square150x150Logo.scale-$($sc.Key).png"
  Save (Render ([int](310*$f)) ([int](150*$f)) 0.66) "Wide310x150Logo.scale-$($sc.Key).png"
  Save (Render ([int](50*$f))  ([int](50*$f))  1.0)  "StoreLogo.scale-$($sc.Key).png"
  Save (Render ([int](24*$f))  ([int](24*$f))  1.0)  "LockScreenLogo.scale-$($sc.Key).png"
  Save (Render ([int](620*$f)) ([int](300*$f)) 0.5)  "SplashScreen.scale-$($sc.Key).png"
}

# Multi-size .ico with PNG-compressed entries (valid since Vista), written by hand since System.Drawing can't.
$sizes = 16,20,24,32,40,48,64,256
$pngs = New-Object System.Collections.Generic.List[byte[]]
foreach ($s in $sizes) {
  $b = Render $s $s 1.0; $ms = New-Object IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose(); $pngs.Add($ms.ToArray())
}
$fs = [IO.File]::Create([IO.Path]::GetFullPath($IcoOut)); $w = New-Object IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $d = $pngs[$i]
  $w.Write([byte]($s % 256)); $w.Write([byte]($s % 256)); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$d.Length); $w.Write([UInt32]$offset)
  $offset += $d.Length
}
foreach ($d in $pngs) { $w.Write($d) }
$w.Close(); $src.Dispose()
