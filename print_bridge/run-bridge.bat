@echo off
cd /d "%~dp0"
py -3 bridge.py
if errorlevel 1 (
  echo.
  echo Bryggan avslutades med ett fel. Se bridge.log i den har mappen.
  pause
)
