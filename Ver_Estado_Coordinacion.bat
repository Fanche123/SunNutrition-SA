@echo off
setlocal
cd /d "%~dp0"
echo AVISO: consulta manual del protocolo heredado; no forma parte del flujo normal.
echo.
call npm run coordination:status
echo.
pause
