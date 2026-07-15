# Histometer

Histometer is a local desktop application scaffold for tracking histology projects, samples, and workflow stages on a lab workstation.

## What is included

- A product design document in [docs/histometer_design.md](/C:/Users/ihave/Documents/Histometer/docs/histometer_design.md)
- A Python desktop prototype in [src/histometer_app.py](/C:/Users/ihave/Documents/Histometer/src/histometer_app.py)
- A PowerShell build helper in [build_exe.ps1](/C:/Users/ihave/Documents/Histometer/build_exe.ps1)

## Run the prototype

```powershell
python .\src\histometer_app.py
```

The app stores its data in `data\histometer.db`.

## Build a Windows executable

Install PyInstaller first:

```powershell
python -m pip install pyinstaller
```

Then run:

```powershell
.\build_exe.ps1
```

The packaged executable will be written to `dist\Histometer.exe`.

