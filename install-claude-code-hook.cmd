@echo off
rem Double-click to connect this PC's Claude Code (VS Code and terminal) to the team server.
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and try again. & pause & exit /b 1)
node "%~dp0claude-code-hook\install.js"
pause
