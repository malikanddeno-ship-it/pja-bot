@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [PJA Host] Creating Python environment...
  py -m venv .venv || goto :error
)
call ".venv\Scripts\activate.bat"
echo [PJA Host] Installing/updating requirements...
python -m pip install --disable-pip-version-check -q -r requirements.txt || goto :error
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo [PJA Host] Created .env from .env.example.
  echo [PJA Host] Open .env and fill in your secrets, then run this file again.
  start "" notepad ".env"
  pause
  exit /b 0
)
start "" "http://127.0.0.1:9100"
echo [PJA Host] Dashboard: http://127.0.0.1:9100
echo [PJA Host] Keep this window open. Press Ctrl+C to stop the host.
python -m uvicorn host.host:app --host 127.0.0.1 --port 9100
exit /b %errorlevel%
:error
echo.
echo [PJA Host] Setup failed. Make sure Python 3.11+ is installed and "py" works.
pause
exit /b 1
