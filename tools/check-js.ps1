$ErrorActionPreference = "Stop"

$nodePath = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path $nodePath)) {
  $nodePath = "node"
}

& $nodePath --check "server.js"
& $nodePath --check "backend/bank-rules.js"
& $nodePath --check "backend/http-config.js"
& $nodePath --check "assets/js/dom-utils.js"
& $nodePath --check "assets/js/app.js"
