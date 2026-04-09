@echo off
title VeritasAI Launcher
color 0B

echo.
echo   =========================================
echo    VeritasAI  -  Interview Platform v2
echo   =========================================
echo.

cd /d "%~dp0"

:: ── Step 1: Start FastAPI backend ──────────────────────────────────────────
echo   [1/3]  Starting backend server...
start "VeritasAI Backend" cmd /c "cd backend && call venv\Scripts\activate.bat && python -m uvicorn main:app --host 0.0.0.0 --port 8000"
timeout /t 3 /nobreak >nul

:: ── Step 2: Start Vite dev server ──────────────────────────────────────────
echo   [2/3]  Starting frontend (Vite)...
start "VeritasAI Vite" cmd /c "cd frontend && npm run dev"

:: ── Step 3: Wait for Vite to be ready, then launch Electron ───────────────
echo   [3/3]  Waiting for Vite, then launching desktop app...
timeout /t 6 /nobreak >nul

:check_vite
powershell -Command "try { Invoke-WebRequest -Uri http://localhost:5173 -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    timeout /t 2 /nobreak >nul
    goto check_vite
)

echo.
echo   Vite is ready. Launching VeritasAI...
echo.

cd frontend
start "" npm run electron

echo   App launched! You can close this window.
timeout /t 3 /nobreak >nul
