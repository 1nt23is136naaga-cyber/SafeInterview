@echo off
title VeritasAI — Make Public
color 0A

echo.
echo   =========================================
echo    VeritasAI  -  Public Deployment
echo   =========================================
echo.
echo   This will:
echo    1. Build the React frontend
echo    2. Start the backend (serves frontend + API)
echo    3. Create a public tunnel via Cloudflare
echo.

cd /d "%~dp0"

:: ── Step 1: Build the frontend ─────────────────────────────────────────────
echo   [1/3]  Building frontend...
cd frontend
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo   ERROR: Frontend build failed. Check the output above.
    pause
    exit /b 1
)
cd ..
echo   Frontend built successfully.
echo.

:: ── Step 2: Start the backend in PUBLIC mode ──────────────────────────────
echo   [2/3]  Starting backend (public mode)...
start "VeritasAI Backend [Public]" cmd /k "cd backend && call venv\Scripts\activate.bat && set PUBLIC_MODE=true && python -m uvicorn main:app --host 0.0.0.0 --port 8000"
timeout /t 5 /nobreak >nul

:: ── Step 3: Start Cloudflare Tunnel ───────────────────────────────────────
echo   [3/3]  Creating public tunnel...
echo.
echo   Installing cloudflared if not present...
where cloudflared >nul 2>&1
if %errorlevel% neq 0 (
    echo   Downloading cloudflared...
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe'"
    set CLOUDFLARED=cloudflared.exe
) else (
    set CLOUDFLARED=cloudflared
)

echo.
echo   ========================================================
echo    Your PUBLIC URL will appear below in a few seconds...
echo    Share that URL with HR managers and candidates!
echo   ========================================================
echo.

%CLOUDFLARED% tunnel --url http://localhost:8000

pause
