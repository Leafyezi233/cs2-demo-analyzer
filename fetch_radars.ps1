$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$mirror = 'https://ghfast.top/'
$base = 'https://github.com/pnxenopoulos/awpy-data/releases/download/2000930'
$target = Join-Path $root 'mapdata\2000930'
$out = Join-Path $target 'images.zip'
if(-not ((Test-Path $out) -and (Get-Item $out).Length -gt 0)){
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Invoke-WebRequest -Uri ($mirror + $base + '/images.zip') -OutFile $out -UseBasicParsing -TimeoutSec 900
  $sw.Stop()
  Write-Output ('images.zip  {0} bytes  {1}s' -f (Get-Item $out).Length, [math]::Round($sw.Elapsed.TotalSeconds,1))
} else { Write-Output 'skip images.zip' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($out, $target)
Set-Content -Path (Join-Path $target '.images.zip.done') -Value '' -Encoding ascii
$rad = Join-Path $target 'radars'
if(Test-Path $rad){ Write-Output ('radars/  ' + (Get-ChildItem $rad -File -Recurse | Measure-Object).Count + ' files') }
Write-Output 'DONE'