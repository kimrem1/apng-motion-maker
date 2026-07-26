@echo off
chcp 65001 >nul 2>&1
rem Creates a desktop shortcut. Run once.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-shortcut.ps1"
