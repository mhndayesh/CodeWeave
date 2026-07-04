# CodeWeave Live Context Compiler — accuracy / speed / token benchmark runner.
# Crafted to be launched manually. Nothing here runs until you invoke this script.
#
#   powershell -ExecutionPolicy Bypass -File bench\run.ps1
#
# Edit the CONFIG block, then run. Results land in bench\results\*.json and print to console.
$ErrorActionPreference = "Stop"

# ---------------- CONFIG ----------------
$Node       = "C:\Users\mhnda\tools\nodejs\node.exe"
$Cli        = "C:\projects\CodeWeave\packages\opencode\dist\opencode-windows-x64\lib\live-context-compiler\cli.js"
$BenchDir   = "C:\projects\CodeWeave\bench"
$ReposDir   = "C:\projects\bench-repos"
$DenseRepo  = "$ReposDir\sqlalchemy"          # speed + tokens target (dense repo)
$PyCGDir    = "$ReposDir\PyCG"                 # labeled accuracy ground truth
$Snippets   = "$PyCGDir\micro-benchmark\snippets"
$ResultsDir = "$BenchDir\results"
$RunOracle  = $false                           # set $true after: pip install jedi
$OracleSample = 300
# ----------------------------------------

$env:OPENCODE_LIVE_CONTEXT_NODE = $Node
$env:OPENCODE_LIVE_CONTEXT_CLI  = $Cli
$env:OPENCODE_LIVE_CONTEXT_TIMEOUT_MS = "300000"
$env:NODE_OPTIONS = "--max-old-space-size=8192"

if (-not (Test-Path $ResultsDir)) { New-Item -ItemType Directory -Path $ResultsDir | Out-Null }
if (-not (Test-Path $Cli)) { throw "compiler CLI not found at $Cli - build CodeWeave first" }

# clone benchmark repos if missing
if (-not (Test-Path $DenseRepo)) {
  Write-Host "cloning SQLAlchemy (dense repo)..."
  git clone --depth 1 --single-branch https://github.com/sqlalchemy/sqlalchemy.git $DenseRepo
}
if (-not (Test-Path $Snippets)) {
  Write-Host "cloning PyCG (accuracy ground truth)..."
  git clone --depth 1 --single-branch https://github.com/vitsalis/PyCG.git $PyCGDir
}

Write-Host "`n==================== SPEED ====================" -ForegroundColor Cyan
& $Node "$BenchDir\speed.mjs" --root $DenseRepo --cli $Cli --queries 40 --out "$ResultsDir\speed-sqlalchemy.json"

Write-Host "`n==================== TOKENS (graph vs no-graph) ====================" -ForegroundColor Cyan
& $Node "$BenchDir\tokens.mjs" --root $DenseRepo --cli $Cli --topN 12 --readK 5 --out "$ResultsDir\tokens-sqlalchemy.json"

Write-Host "`n==================== ACCURACY: PyCG (LSP ON, tier-4) ====================" -ForegroundColor Cyan
& $Node "$BenchDir\accuracy_pycg.mjs" --snippets $Snippets --cli $Cli --out "$ResultsDir\accuracy-pycg-lsp.json"

Write-Host "`n==================== ACCURACY: PyCG (LSP OFF, tier-2 only) ====================" -ForegroundColor Cyan
& $Node "$BenchDir\accuracy_pycg.mjs" --snippets $Snippets --cli $Cli --no-lsp --out "$ResultsDir\accuracy-pycg-nolsp.json"

if ($RunOracle) {
  Write-Host "`n==================== ACCURACY: real-repo vs Jedi (recall) ====================" -ForegroundColor Cyan
  $oracleJson = "$ResultsDir\oracle-sqlalchemy.json"
  python "$BenchDir\oracle_jedi.py" --root $DenseRepo --sample $OracleSample --out $oracleJson
  $graphDb = Join-Path $env:TEMP "tokens-bench-sqlalchemy.sqlite"  # reuse the graph tokens.mjs built
  if (-not (Test-Path $graphDb)) { & $Node "$BenchDir\speed.mjs" --root $DenseRepo --cli $Cli --queries 0 | Out-Null }
  & $Node "$BenchDir\accuracy_oracle.mjs" --db $graphDb --oracle $oracleJson --tol 2 --out "$ResultsDir\accuracy-oracle.json"
}

Write-Host "`nDone. JSON results in $ResultsDir" -ForegroundColor Green
