$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Write-Output ('PSVersion=' + $PSVersionTable.PSVersion.ToString())
Write-Output ('root=' + $root)
$mirror = 'https://ghfast.top/'
$base = 'https://github.com/pnxenopoulos/awpy-data/releases/download/2000930'
$target = Join-Path $root 'mapdata\2000930'
New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach($n in @('geometry.zip','navs.zip','manifest.json','map_data.json')){
  $out = Join-Path $target $n
  if((Test-Path $out) -and (Get-Item $out).Length -gt 0){ Write-Output ('skip ' + $n); continue }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Invoke-WebRequest -Uri ($mirror + $base + '/' + $n) -OutFile $out -UseBasicParsing -TimeoutSec 1800
  $sw.Stop()
  Write-Output ('{0}  {1} bytes  {2}s' -f $n, (Get-Item $out).Length, [math]::Round($sw.Elapsed.TotalSeconds,1))
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach($pair in @(@('geometry.zip','geometry'), @('navs.zip','navs'))){
  $zip = Join-Path $target $pair[0]
  $dest = Join-Path $target $pair[1]
  if(-not (Test-Path $zip)){ Write-Output ('missing ' + $zip); continue }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)
  Write-Output ('extracted ' + $pair[0])
}
foreach($k in @('geometry.zip','navs.zip')){ Set-Content -Path (Join-Path $target ('.' + $k + '.done')) -Value '' -Encoding ascii }
Write-Output 'DONE'
Get-ChildItem -Directory $target | ForEach-Object { $c = (Get-ChildItem $_.FullName -File -Recurse | Measure-Object).Count; Write-Output ('{0}/  {1} files' -f $_.Name, $c) }
$md = Join-Path $target 'map_data.json'
if(Test-Path $md){ Write-Output ('map_data.json ' + (Get-Item $md).Length + ' bytes') }
$mf = Join-Path $target 'manifest.json'
if(Test-Path $mf){ Write-Output ('manifest.json ' + (Get-Item $mf).Length + ' bytes') }