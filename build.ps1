# 编译单文件 exe：把前端+后端作为资源内嵌进 C# 启动器
# 用法：powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 csc.exe：$csc" }

New-Item -ItemType Directory -Force -Path 'dist' | Out-Null
Remove-Item 'dist\MC-AI-Control.exe' -ErrorAction SilentlyContinue

$args = @(
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/out:dist\MC-AI-Control.exe',
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    '/resource:server.js,server.js',
    '/resource:renderer\index.html,index.html',
    '/resource:renderer\styles.css,styles.css',
    '/resource:renderer\app.js,app.js',
    '/resource:README.txt,README.txt',
    'Program.cs'
)

& $csc @args
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }

$exe = Get-Item 'dist\MC-AI-Control.exe'
Write-Host ("✅ 编译成功: {0}  ({1:N0} KB)" -f $exe.FullName, ($exe.Length / 1KB))
Write-Host ("   SHA256: {0}" -f (Get-FileHash $exe.FullName -Algorithm SHA256).Hash)
