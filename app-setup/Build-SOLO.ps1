$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$bunExe = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
if (-not (Test-Path -LiteralPath $bunExe)) {
    throw "Bun 1.3.5 is required for maintenance builds: $bunExe"
}

Push-Location $repoRoot
try {
    & $bunExe run build
    if ($LASTEXITCODE -ne 0) { throw "The isolated production web build failed." }

    Push-Location (Join-Path $repoRoot "apps\desktop")
    try {
        & $bunExe run package
        if ($LASTEXITCODE -ne 0) { throw "Windows x64 packaging failed." }
    }
    finally {
        Pop-Location
    }
}
finally {
    Pop-Location
}

Write-Host "Windows installer and portable app are in $repoRoot\release"
Write-Host "Packaging builds use the isolated database/media locations managed by the web build script."
