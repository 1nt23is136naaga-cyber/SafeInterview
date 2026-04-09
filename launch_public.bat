@echo off
title VeritasAI — Public Mode
color 0A

echo.
echo   =====================================================
echo    VeritasAI — Going PUBLIC (backend on port 8000)
echo   =====================================================
echo.

cd /d "%~dp0"

:: Kill any existing uvicorn on port 8000
echo   [*] Stopping any existing backend...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000 " 2^>nul') do taskkill /PID %%a /F >nul 2>&1
timeout /t 2 /nobreak >nul

:: Start backend in PUBLIC mode (serves built frontend + API)
echo   [1/2]  Starting backend in PUBLIC mode...
start "SafeInterview Backend" cmd /k "cd /d e:\AntiGravity\Audio\backend && call venv\Scripts\activate.bat && set PUBLIC_MODE=true && python -m uvicorn main:app --host 0.0.0.0 --port 8000"

:: Wait for backend to be ready
echo   Waiting for backend to start...
:wait_backend
timeout /t 3 /nobreak >nul
powershell -Command "try { Invoke-WebRequest -Uri http://localhost:8000/health -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 goto wait_backend
echo   Backend is ready!
echo.

:: Start Cloudflare tunnel and log output
echo   [2/2]  Creating Cloudflare tunnel...
echo   =====================================================
echo    YOUR PUBLIC URL will appear below in a moment...
echo    Share that URL with the candidate on their laptop!
echo    Both HR and Candidate use the SAME URL.
echo   =====================================================
echo.

e:\AntiGravity\Audio\cloudflared.exe tunnel --url http://localhost:8000 2>&1 | tee e:\AntiGravity\Audio\tunnel.log

pause
