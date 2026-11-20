$ErrorActionPreference = 'Stop'
$token = $env:FASTP2P_INSTALL_TOKEN
Remove-Item Env:FASTP2P_INSTALL_TOKEN
$directory = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid()))).FullName
$file = Join-Path $directory "fastp2p-windows-v$version-$token.exe"
try {
    Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -Headers @{Authorization = "FastP2P $token"} -MaximumRedirection 0 -TimeoutSec 300 -OutFile $file
    if ((Get-Item -LiteralPath $file).Length -ne $expectedSize -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expectedSha) {
        throw 'FastP2P installer checksum verification failed.'
    }
    $process = Start-Process -FilePath $file -Verb RunAs -Wait -PassThru
    exit $process.ExitCode
} finally {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $directory -ErrorAction SilentlyContinue
}
