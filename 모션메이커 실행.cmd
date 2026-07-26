@echo off
chcp 65001 >nul 2>&1
rem Motion Maker launcher. Double-click to run.
rem Real logic lives in scripts\launch.ps1 (port scan, readiness check, auto-rebuild).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1"
if errorlevel 1 pause
