@echo off
rem Double-click entry point for the Windows sideload zip - runs Install.ps1
rem regardless of the machine's PowerShell execution policy.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1"
pause
