@echo off
setlocal
cd /d "%~dp0"
echo Flujo directo: se inicia unicamente el ERP.
echo El Coordinador es una herramienta heredada y no forma parte del arranque normal.
start "ERP SunNutrition" /D "%~dp0" cmd /k npm start
