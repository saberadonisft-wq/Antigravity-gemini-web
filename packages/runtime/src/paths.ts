import path from "node:path";
import os from "node:os";

export interface StoragePaths {
  mode: "demo" | "live";
  appDataDir: string;
  browserProfileDir: string;
  configFilePath: string;
}

export function canonicalizePath(p: string): string {
  const resolved = path.resolve(p);
  // On Windows, filesystem paths are case-insensitive
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrNested(p1: string, p2: string): boolean {
  const c1 = canonicalizePath(p1);
  const c2 = canonicalizePath(p2);
  if (c1 === c2) return true;
  const sep = path.sep;
  if (c1.startsWith(c2.endsWith(sep) ? c2 : c2 + sep)) return true;
  if (c2.startsWith(c1.endsWith(sep) ? c1 : c1 + sep)) return true;
  return false;
}

/**
 * Returns isolated storage paths depending on execution mode.
 * DEV / demo mode uses a separate ephemeral sandbox and NEVER overlaps with live paths.
 * Neither mode ever writes to .git or touches the user's active VS Code configuration.
 */
export function getStoragePaths(
  mode: "demo" | "live",
  customBaseDir?: string,
  instanceId?: string
): StoragePaths {
  const base = customBaseDir ?? os.homedir();

  if (mode === "demo") {
    const demoRoot = path.join(
      os.tmpdir(),
      "antigravity-gemini-web-demo",
      instanceId ?? `inst-${process.pid}`
    );
    return {
      mode: "demo",
      appDataDir: path.join(demoRoot, "app_data"),
      browserProfileDir: path.join(demoRoot, "browser_profile"),
      configFilePath: path.join(demoRoot, "config.json"),
    };
  }

  // Live mode: isolated under .gemini/antigravity-gemini-web-live
  const liveRoot = path.join(base, ".gemini", "antigravity-gemini-web-live");
  return {
    mode: "live",
    appDataDir: path.join(liveRoot, "app_data"),
    browserProfileDir: path.join(liveRoot, "browser_profile"),
    configFilePath: path.join(liveRoot, "config.json"),
  };
}

/**
 * Validates that DEV and Live paths never overlap, checking:
 * 1. Exact equality after canonicalization (including Windows case-insensitivity).
 * 2. Cross-field equality (e.g. DEV profile vs Live appDataDir).
 * 3. Parent-child containment (neither is a subdirectory of the other).
 */
export function assertNoPathOverlap(devPaths: StoragePaths, livePaths: StoragePaths): void {
  const devEntries: [string, string][] = [
    ["dev.appDataDir", devPaths.appDataDir],
    ["dev.browserProfileDir", devPaths.browserProfileDir],
    ["dev.configFilePath", devPaths.configFilePath],
  ];

  const liveEntries: [string, string][] = [
    ["live.appDataDir", livePaths.appDataDir],
    ["live.browserProfileDir", livePaths.browserProfileDir],
    ["live.configFilePath", livePaths.configFilePath],
  ];

  for (const [devKey, devVal] of devEntries) {
    for (const [liveKey, liveVal] of liveEntries) {
      if (isSameOrNested(devVal, liveVal)) {
        throw new Error(
          `Path collision or containment violation between ${devKey} ('${devVal}') and ${liveKey} ('${liveVal}')`
        );
      }
    }
  }
}
