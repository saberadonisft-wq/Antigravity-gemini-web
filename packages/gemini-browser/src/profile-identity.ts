import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CdpClient } from "./cdp-client.js";

const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** Verify the actual debug browser, including legacy Windows Chrome without automation flags. */
export async function verifyBrowserProfile(cdp: CdpClient, directory: string, port: number, chromePath: string): Promise<boolean> {
  try {
    const { arguments: args } = await cdp.send<{ arguments: string[] }>("Browser.getBrowserCommandLine", {}, 1500);
    const profiles = args.filter(arg => arg.startsWith("--user-data-dir="));
    if (profiles.length === 1) return samePath(profiles[0].slice("--user-data-dir=".length), directory);
  } catch { /* Older profiles were launched without --enable-automation. */ }
  if (process.platform !== "win32") return false;
  // Pass values through environment, not executable command text. Emit only a
  // boolean: process command lines can contain private conversation URLs.
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    try {
      $expectedPort = [int]$env:AG_PROFILE_VERIFY_PORT
      $owners = @(Get-NetTCPConnection -LocalPort $expectedPort -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
      if ($owners.Count -ne 1) { 'false'; exit }
      $browserProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $owners[0])
      if (![string]::Equals([IO.Path]::GetFullPath($browserProcess.ExecutablePath), [IO.Path]::GetFullPath($env:AG_PROFILE_VERIFY_CHROME), [StringComparison]::OrdinalIgnoreCase)) { 'false'; exit }
      $matches = [regex]::Matches($browserProcess.CommandLine, '(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+)|--user-data-dir\s+"([^"]+)"|--user-data-dir\s+([^\s"]+))(?=\s|$)')
      if ($matches.Count -ne 1) { 'false'; exit }
      $actualProfile = @($matches[0].Groups | Select-Object -Skip 1 | Where-Object Success | Select-Object -ExpandProperty Value)[0]
      $stillOwners = @(Get-NetTCPConnection -LocalPort $expectedPort -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
      $sameOwner = $stillOwners.Count -eq 1 -and $stillOwners[0] -eq $owners[0]
      $sameProfile = [string]::Equals([IO.Path]::GetFullPath($actualProfile).TrimEnd('\'), [IO.Path]::GetFullPath($env:AG_PROFILE_VERIFY_DIRECTORY).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
      if ($sameOwner -and $sameProfile) { 'true' } else { 'false' }
    } catch { 'false' }
  `;
  try {
    const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 5000, maxBuffer: 4096, env: { ...process.env, AG_PROFILE_VERIFY_PORT: String(port), AG_PROFILE_VERIFY_DIRECTORY: directory, AG_PROFILE_VERIFY_CHROME: chromePath } });
    return result.stdout.trim() === "true";
  } catch { return false; }
}
