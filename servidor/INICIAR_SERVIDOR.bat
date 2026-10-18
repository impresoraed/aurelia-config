@echo off
chcp 65001 >nul
title Servidor de Legados de Aurelia
cd /d "%~dp0"
where node >nul 2>nul || (echo Necesitas instalar Node.js desde https://nodejs.org & pause & exit /b)
:inicio
node servidor.js
rem codigo 3 = el servidor se ha actualizado solo: se vuelve a arrancar
if %errorlevel%==3 (echo. & echo Reiniciando el servidor actualizado... & timeout /t 2 >nul & goto inicio)
echo.
echo El servidor se ha cerrado.
pause