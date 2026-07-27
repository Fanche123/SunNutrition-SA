@echo off
setlocal
cd /d "%~dp0"
echo Flujo directo: se inicia unicamente el ERP.
echo El Coordinador es una herramienta heredada y no forma parte del arranque normal.
echo El launcher verifica ownership, puerto e identidad antes de iniciar.
start "ERP SunNutrition" /D "%~dp0" cmd /k npm.cmd start
