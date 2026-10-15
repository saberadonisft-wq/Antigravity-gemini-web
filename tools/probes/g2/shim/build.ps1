# Build script for Antigravity Transparent Shim and Test Fixtures
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    Write-Error "csc.exe not found at $csc"
    exit 1
}

$shimSource = Join-Path $PSScriptRoot "AntigravityShim.cs"
$shimOutput = Join-Path $PSScriptRoot "antigravity_shim.exe"

$fakeChildSource = Join-Path $PSScriptRoot "FakeChild.cs"
$fakeChildOutput = Join-Path $PSScriptRoot "fake_child.exe"

Write-Host "Compiling AntigravityShim.cs -> antigravity_shim.exe using .NET Framework 4.8 csc..."
& $csc /target:exe /optimize+ /out:$shimOutput $shimSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $shimOutput)) {
    Write-Error "Build of antigravity_shim.exe failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host "Compiling FakeChild.cs -> fake_child.exe using .NET Framework 4.8 csc..."
& $csc /target:exe /optimize+ /out:$fakeChildOutput $fakeChildSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $fakeChildOutput)) {
    Write-Error "Build of fake_child.exe failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host "All shim binaries built successfully:"
Write-Host "  - $shimOutput"
Write-Host "  - $fakeChildOutput"
exit 0
