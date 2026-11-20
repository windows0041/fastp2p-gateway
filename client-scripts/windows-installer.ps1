$ErrorActionPreference = 'Stop'
if ($Token -notmatch '\A[1-9][0-9]{15}\z') {
    throw 'FastP2P -Token requires a 16-digit installation token.'
}
$directory = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid()))).FullName
$file = Join-Path $directory "fastp2p-windows-v$version-$Token.exe"
try {
    Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -Headers @{Authorization = "FastP2P $Token"} -MaximumRedirection 0 -TimeoutSec 300 -OutFile $file
    if ((Get-Item -LiteralPath $file).Length -ne $expectedSize -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expectedSha) {
        throw 'FastP2P installer checksum verification failed.'
    }
    $process = Start-Process -FilePath $file -Verb RunAs -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "FastP2P installation failed (exit code $($process.ExitCode))."
    }
} finally {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $directory -ErrorAction SilentlyContinue
}
