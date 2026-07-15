param(
    [string]$PythonCommand = "python"
)

$ErrorActionPreference = "Stop"

Write-Host "Building Histometer.exe from src\\histometer_app.py..."

& $PythonCommand -m PyInstaller --version *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "PyInstaller is not installed."
    Write-Host "Install it with: python -m pip install pyinstaller"
    exit 1
}

& $PythonCommand -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name Histometer `
    .\src\histometer_app.py

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed."
    exit $LASTEXITCODE
}

Write-Host "Build complete: dist\\Histometer.exe"

