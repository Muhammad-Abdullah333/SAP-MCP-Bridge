@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" -Payload "%~dp0payload.zip" -ShowSuccess -Launch
