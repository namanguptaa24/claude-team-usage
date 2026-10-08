@echo off
rem Double-click to run the Claude Team Usage server on this Windows PC.
cd /d "%~dp0server"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and try again. & pause & exit /b 1)
node src\index.js
pause
