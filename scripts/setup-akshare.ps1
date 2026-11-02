param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskVenv = Join-Path $taskRoot '.cache\akshare-venv'
$taskPython = Join-Path $taskVenv 'Scripts\python.exe'
& $Python -m venv --without-pip $taskVenv
if ($LASTEXITCODE -ne 0) { throw 'Python 3.10+ is required. Pass -Python with its executable path.' }
# pip from the selected base runtime can install into a venv without ensurepip.
& $Python -m pip --python $taskPython install -r (Join-Path $PSScriptRoot 'requirements-akshare.txt')
if ($LASTEXITCODE -ne 0) { throw 'AKShare installation failed. Check network/proxy and retry.' }
& $taskPython -c 'import akshare; print("AKShare " + akshare.__version__)'
if ($LASTEXITCODE -ne 0) { throw 'AKShare import failed.' }
