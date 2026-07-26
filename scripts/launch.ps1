# 모션 메이커 실행기
#
# 더블클릭 한 번으로 끝나게 하는 것이 목적이다. 그래서 다음을 전부 알아서 한다.
#   1. Node 가 있는지 확인하고, 없으면 어디서 받는지 알려 준다
#   2. 처음이면 의존성을 설치한다
#   3. 소스가 바뀌었으면 다시 빌드한다 (안 바뀌었으면 건너뛰어 즉시 열린다)
#   4. 빈 포트를 찾아 서버를 띄우고 브라우저를 연다
#
# 개발 서버(npm run dev)가 아니라 빌드 결과를 서비스한다. 시작이 훨씬 빠르고
# 실제 배포와 같은 코드가 돈다.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$Host.UI.RawUI.WindowTitle = '모션 메이커'

function Write-Step($text) { Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  $text" -ForegroundColor Yellow }
function Write-Err($text)  { Write-Host "  $text" -ForegroundColor Red }

Write-Host ''
Write-Host '  모션 메이커' -ForegroundColor White
Write-Host '  ───────────────────────────────' -ForegroundColor DarkGray
Write-Host ''

# --- 1. Node 확인 -----------------------------------------------------------

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Err 'Node.js 가 설치되어 있지 않습니다.'
  Write-Host ''
  Write-Host '  https://nodejs.org 에서 LTS 버전을 받아 설치한 뒤' -ForegroundColor Gray
  Write-Host '  이 파일을 다시 실행해 주세요.' -ForegroundColor Gray
  Write-Host ''
  Read-Host '  엔터를 누르면 창이 닫힙니다'
  exit 1
}

# --- 2. 의존성 --------------------------------------------------------------

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Step '처음 실행이라 준비를 좀 합니다. 1~2분 걸립니다...'
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Err '준비에 실패했습니다. 인터넷 연결을 확인해 주세요.'
    Read-Host '  엔터를 누르면 창이 닫힙니다'
    exit 1
  }
  Write-Ok '준비 완료'
}

# --- 3. 빌드 (소스가 바뀌었을 때만) ------------------------------------------

function Get-NewestWriteTime([string[]]$paths) {
  $newest = [datetime]::MinValue
  foreach ($p in $paths) {
    if (-not (Test-Path $p)) { continue }
    $item = Get-Item $p
    if ($item.PSIsContainer) {
      $files = Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue
      foreach ($f in $files) { if ($f.LastWriteTimeUtc -gt $newest) { $newest = $f.LastWriteTimeUtc } }
    } else {
      if ($item.LastWriteTimeUtc -gt $newest) { $newest = $item.LastWriteTimeUtc }
    }
  }
  return $newest
}

$distIndex = Join-Path $root 'dist\index.html'
$needBuild = $true

if (Test-Path $distIndex) {
  $srcTime = Get-NewestWriteTime @(
    (Join-Path $root 'src'),
    (Join-Path $root 'index.html'),
    (Join-Path $root 'vite.config.ts'),
    (Join-Path $root 'package.json')
  )
  $distTime = (Get-Item $distIndex).LastWriteTimeUtc
  if ($distTime -ge $srcTime) { $needBuild = $false }
}

if ($needBuild) {
  Write-Step '준비 중입니다. 잠시만요...'
  # 타입 검사는 건너뛰고 번들만 만든다. 실행하려는 사람에게 타입 오류는 관심사가 아니다.
  & npx vite build
  if ($LASTEXITCODE -ne 0) {
    Write-Err '준비에 실패했습니다.'
    Read-Host '  엔터를 누르면 창이 닫힙니다'
    exit 1
  }
} else {
  Write-Ok '바뀐 것이 없어 바로 엽니다'
}

# --- 4. 빈 포트 찾기 --------------------------------------------------------

function Test-PortFree([int]$port) {
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch {
    return $false
  }
}

$port = 0
foreach ($candidate in 4173..4199) {
  if (Test-PortFree $candidate) { $port = $candidate; break }
}
if ($port -eq 0) {
  Write-Err '쓸 수 있는 포트를 찾지 못했습니다.'
  Read-Host '  엔터를 누르면 창이 닫힙니다'
  exit 1
}

$url = "http://localhost:$port"

# --- 5. 서버 시작 + 브라우저 열기 -------------------------------------------

Write-Step '여는 중...'

$serve = Start-Process -FilePath 'npx.cmd' `
  -ArgumentList @('vite', 'preview', '--port', "$port", '--strictPort') `
  -WorkingDirectory $root -PassThru -WindowStyle Hidden

# 서버가 실제로 응답할 때까지 기다린다. 고정 시간 대기는 느린 기기에서 빈 화면을 띄운다.
$ready = $false
foreach ($i in 1..60) {
  Start-Sleep -Milliseconds 250
  if ($serve.HasExited) { break }
  try {
    $res = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    if ($res.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
}

if (-not $ready) {
  Write-Err '서버를 시작하지 못했습니다.'
  if (-not $serve.HasExited) { $serve.Kill() }
  Read-Host '  엔터를 누르면 창이 닫힙니다'
  exit 1
}

Start-Process $url

Write-Host ''
Write-Ok "브라우저에서 열렸습니다  ($url)"
Write-Host ''
Write-Host '  ┌───────────────────────────────────────────────┐' -ForegroundColor DarkGray
Write-Host '  │  이 창을 닫으면 프로그램도 종료됩니다.        │' -ForegroundColor DarkGray
Write-Host '  │  쓰는 동안은 최소화해 두세요.                 │' -ForegroundColor DarkGray
Write-Host '  └───────────────────────────────────────────────┘' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  주소창에 뜨는 설치 아이콘을 누르면 앱처럼 쓸 수 있습니다.' -ForegroundColor Gray
Write-Host ''
Write-Host '  종료하려면 이 창에서 Ctrl+C 를 누르거나 창을 닫으세요.' -ForegroundColor DarkGray
Write-Host ''

# 창이 닫히면 서버도 같이 죽어야 한다. 안 그러면 포트가 물린 채 남는다.
try {
  Wait-Process -Id $serve.Id
} finally {
  if (-not $serve.HasExited) { $serve.Kill() }
}
