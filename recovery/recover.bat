@echo off
chcp 65001 >nul 2>&1
setlocal

echo ============================================
echo  Kakusu Offline Recovery Tool
echo ============================================
echo.
echo  Layout:
echo    recover.bat / decrypt.py
echo    downloaded-vault-root/
echo        data/              (Drive data folder)
echo        DO_NOT_DELETE.json  (from Drive root)
echo    rawdata/               (output directory)
echo.
echo  The downloaded vault root folder name can be changed.
echo  This tool will try to detect it automatically.
echo.
echo  This tool runs in interactive mode.
echo  Follow the on-screen prompts to proceed.
echo.

:: Check Python
where python >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found.
    echo Please install Python 3.9 or later:
    echo https://www.python.org/downloads/
    pause
    exit /b 1
)

:: Setup venv if not exists
set VENV_DIR=%~dp0.venv
if not exist "%VENV_DIR%\Scripts\activate.bat" (
    echo.
    echo Python virtual environment is not set up yet.
    set /p SETUP_CONFIRM="Do you want to set it up now? (Y/n): "
    if /I "%SETUP_CONFIRM%"=="n" (
        echo Setup cancelled.
        pause
        exit /b 1
    )
    if /I "%SETUP_CONFIRM%"=="no" (
        echo Setup cancelled.
        pause
        exit /b 1
    )
    echo Setting up Python virtual environment...
    python -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo ERROR: Failed to create virtual environment
        pause
        exit /b 1
    )
    call "%VENV_DIR%\Scripts\activate.bat"
    echo Installing cryptography...
    pip install cryptography
    if errorlevel 1 (
        echo ERROR: Failed to install cryptography
        pause
        exit /b 1
    )
    echo.
    echo Setup complete. Press any key to start recovery.
    pause >nul
    cls
) else (
    call "%VENV_DIR%\Scripts\activate.bat"
)

echo.

:: Run the script -- no arguments triggers interactive mode
if "%~1"=="" (
    python "%~dp0decrypt.py"
) else (
    python "%~dp0decrypt.py" %*
)

echo.
pause
