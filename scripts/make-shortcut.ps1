# 바탕화면에 바로가기를 만든다.
#
# 프로젝트 폴더를 열 필요 없이 바탕화면에서 바로 실행하기 위한 것이다.
# 이 스크립트는 한 번만 실행하면 된다.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$launcher = Join-Path $root '모션메이커 실행.cmd'
$icon = Join-Path $root 'scripts\app.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop '모션 메이커.lnk'

if (-not (Test-Path $launcher)) {
  Write-Host '  실행 파일을 찾지 못했습니다.' -ForegroundColor Red
  Read-Host '  엔터를 누르면 창이 닫힙니다'
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath = $launcher
$sc.WorkingDirectory = $root
$sc.Description = '이미지를 움직이는 이미지로 만드는 도구'
if (Test-Path $icon) { $sc.IconLocation = $icon }
# 콘솔 창을 최소화한 채로 띄운다. 사용자는 브라우저만 보면 된다.
$sc.WindowStyle = 7
$sc.Save()

Write-Host ''
Write-Host '  바탕화면에 [모션 메이커] 바로가기를 만들었습니다.' -ForegroundColor Green
Write-Host '  앞으로는 그것만 더블클릭하면 됩니다.' -ForegroundColor Gray
Write-Host ''
Read-Host '  엔터를 누르면 창이 닫힙니다'
