# Lance le telechargeur en natif, sans Docker.
# Prerequis : Python 3.12+, ffmpeg, deno sur le PATH.
#   npm run dl
#
# ASCII uniquement : Windows PowerShell 5.1 lit les fichiers sans BOM en
# codepage systeme, et des accents ici casseraient l'analyse du script.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $root ".env"
$python = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Host "Python environment missing. Creating..." -ForegroundColor Yellow
    py -3 -m venv (Join-Path $root ".venv")
    & $python -m pip install --quiet --upgrade pip "yt-dlp[default]"
}

if (-not (Test-Path $envFile)) {
    Write-Host "First run. Paste your WORKER_TOKEN"
    Write-Host "(the one you set with 'npx wrangler secret put WORKER_TOKEN')." -ForegroundColor DarkGray
    $token = Read-Host "WORKER_TOKEN"
    Set-Content -Path $envFile -Value "WORKER_TOKEN=$token" -Encoding ascii
    Write-Host "Saved to downloader\.env - git ignored." -ForegroundColor DarkGray
}

foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') {
        Set-Item "env:$($Matches[1])" $Matches[2].Trim()
    }
}
if (-not $env:APP_URL) { $env:APP_URL = "https://music.example.com" }

# UTF-8 pour les titres accentues, et sortie non bufferisee pour que les
# lignes [poll] s'affichent en direct au lieu d'arriver par paquets.
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUNBUFFERED = "1"

& $python (Join-Path $root "downloader.py")
