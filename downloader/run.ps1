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
    Write-Host "Environnement Python absent. Creation..." -ForegroundColor Yellow
    py -3 -m venv (Join-Path $root ".venv")
    & $python -m pip install --quiet --upgrade pip "yt-dlp[default]"
}

if (-not (Test-Path $envFile)) {
    Write-Host "Premier lancement. Colle ton WORKER_TOKEN"
    Write-Host "(celui envoye avec 'npx wrangler secret put WORKER_TOKEN')." -ForegroundColor DarkGray
    $token = Read-Host "WORKER_TOKEN"
    Set-Content -Path $envFile -Value "WORKER_TOKEN=$token" -Encoding ascii
    Write-Host "Enregistre dans downloader\.env - ignore par git." -ForegroundColor DarkGray
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
