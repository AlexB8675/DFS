@echo off
rem Re-encodes videos in place so they seek fast in DFS: see dfs-reencode.ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0dfs-reencode.ps1" %*
exit /b %ERRORLEVEL%
