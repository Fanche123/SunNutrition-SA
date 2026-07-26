@echo off
setlocal
cd /d "%~dp0"
echo AVISO: herramienta heredada de uso manual y opcional.
echo No es necesaria para el flujo normal de trabajo del ERP.
echo.
call npm run coordinator
if errorlevel 1 (
  echo.
  echo La herramienta heredada termino con error. Revisa la configuracion y la salida anterior.
  pause
)
