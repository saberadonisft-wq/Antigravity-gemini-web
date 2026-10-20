import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { NativeRouteError, sha256 } from "./native-protocol.js";

export const nativeHome = path.join(os.homedir(), ".gemini", "antigravity-gemini-web-live", "app_data", "native-route");
export const isolatedIdeProfile = path.join(nativeHome, "ide-profile");
const SETTING = "jetski.cloudCodeUrl";
const VERIFIED_COMMIT = "ecfbad74d93962fc8ca485d93ab9b4f3d4cb6cf8";
export function assertNoLinks(filename: string) {
  const resolved = path.resolve(filename);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new NativeRouteError("UNSAFE_PATH", "Native route refuses symlinks or junctions."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

type AccountStorage = { profilePath: string; statePath: string };
type StagedAccountStorageDeletion = { commit(): void; rollback(): void };

/**
 * Stage deletion only for account directories created by this bridge. Custom paths
 * (including normal Chrome user profiles) are deliberately left untouched.
 */
export function stageManagedAccountStorageDeletion(account: AccountStorage, stateDirectory: string): StagedAccountStorageDeletion {
  const stateRoot = path.resolve(stateDirectory);
  const profile = path.resolve(account.profilePath);
  const state = path.resolve(account.statePath);
  const equals = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const accountsRoot = path.join(stateRoot, "accounts");
  const profileParent = path.dirname(profile);
  const stateParent = path.dirname(state);
  let targets: string[] = [];

  const profileParentRelative = path.relative(accountsRoot, profileParent);
  const isolatedParent = profileParent === stateParent && !path.isAbsolute(profileParentRelative) &&
    profileParentRelative !== "" && !profileParentRelative.startsWith(`..${path.sep}`) &&
    !profileParentRelative.startsWith("..") &&
    (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileParentRelative) || /^[a-z0-9_-]+$/i.test(profileParentRelative));

  if (isolatedParent && ((path.basename(profile) === "profile" && path.basename(state) === "mcp") ||
      (path.basename(profile) === "browser_profile" && path.basename(state) === "mcp"))) {
    targets = [profileParent];
  } else {
    // Legacy Default Account paths created by native-cli.ts under app_data.
    const appData = path.dirname(stateRoot);
    if (equals(profile, path.join(appData, "browser_profile")) && equals(state, path.join(appData, "mcp"))) {
      targets = [profile, state];
    }
  }

  const staged: Array<{ original: string; quarantine: string }> = [];
  const rollback = () => {
    for (const item of [...staged].reverse()) {
      if (!fs.existsSync(item.quarantine)) continue;
      if (fs.existsSync(item.original)) throw new NativeRouteError("ACCOUNT_CLEANUP_FAILED", "Account data could not be restored safely after a failed removal.", 500);
      fs.renameSync(item.quarantine, item.original);
    }
    staged.length = 0;
  };

  try {
    for (const target of [...new Set(targets)]) {
      assertNoLinks(target);
      if (!fs.existsSync(target)) continue;
      const stat = fs.lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NativeRouteError("UNSAFE_PATH", "Bridge account data is not a regular directory; refusing to delete it.", 409);
      const quarantine = path.join(path.dirname(target), `.ag-account-delete-${randomUUID()}`);
      assertNoLinks(quarantine);
      fs.renameSync(target, quarantine);
      staged.push({ original: target, quarantine });
    }
  } catch (error) {
    rollback();
    throw error;
  }

  return {
    rollback,
    commit() {
      try {
        for (const item of staged) fs.rmSync(item.quarantine, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        staged.length = 0;
      } catch {
        throw new NativeRouteError("ACCOUNT_CLEANUP_FAILED", "The account was removed, but Windows could not finish deleting its local bridge data. Close Chrome windows opened by the bridge and retry cleanup.", 500);
      }
    },
  };
}

export function atomicPrivateFile(filename: string, bytes: string | Buffer) {
  assertNoLinks(filename); fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = filename + "." + randomUUID() + ".tmp";
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filename);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function inspectIde(installRoot = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Antigravity IDE")) {
  const root = path.resolve(installRoot), app = path.join(root, "resources", "app");
  assertNoLinks(app);
  const metadata = JSON.parse(fs.readFileSync(path.join(app, "product.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(app, "extensions", "antigravity", "package.json"), "utf8"));
  const core = fs.readFileSync(path.join(app, "out", "main.js"), "utf8");
  const launcher = fs.readFileSync(path.join(app, "extensions", "antigravity", "dist", "extension.js"), "utf8");
  if (metadata.ideVersion !== "2.5.5" || pkg.version !== "1.107.0" || metadata.commit !== VERIFIED_COMMIT ||
    metadata.nameShort !== "Antigravity IDE" || metadata.applicationName !== "antigravity-ide" ||
    manifest.name !== "antigravity" || manifest.publisher !== "google" ||
    !core.includes('cloudCodeUrlOverride:this._configurationService.getValue("jetski.cloudCodeUrl")') ||
    !core.includes('this.makePostRequest("v1internal:fetchAvailableModels",') ||
    !launcher.includes('"--cloud_code_endpoint"')) throw new NativeRouteError("UNSUPPORTED_IDE", "This IDE build has not been verified for the native endpoint adapter.");
  const executable = path.join(root, "Antigravity IDE.exe");
  assertNoLinks(executable);
  if (!fs.statSync(executable).isFile()) throw new NativeRouteError("IDE_NOT_FOUND", "IDE executable is missing.");
  return { executable, installRoot: root, ideVersion: metadata.ideVersion as string, vscodeVersion: pkg.version as string, commit: metadata.commit as string, endpointSetting: SETTING };
}
/** Manage a dedicated profile only; never copy main IDE settings or authentication stores. */
export function configureIsolatedProfile(profile: string, endpoint: string, action: "setup" | "restore" = "setup") {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.search || url.hash || url.username || url.password || !url.port) throw new NativeRouteError("INVALID_ENDPOINT", "Native endpoint must be an explicit loopback origin.");
  const settings = path.join(path.resolve(profile), "User", "settings.json");
  const state = path.join(path.resolve(profile), ".native-route-settings.json");
  assertNoLinks(settings); assertNoLinks(state);
  const current = fs.existsSync(settings) ? fs.readFileSync(settings) : undefined;
  const previous = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : undefined;
  if (previous) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(current?.toString("utf8") ?? ""); } catch { throw new NativeRouteError("CONFIG_CONFLICT", "Isolated settings are not readable JSON; no changes were made."); }
    if (previous.version !== 1 || previous.endpoint !== url.origin || parsed[SETTING] !== url.origin) throw new NativeRouteError("CONFIG_CONFLICT", "The owned native endpoint was changed externally; refusing to overwrite it.");
    if (action === "restore") {
      if (current && sha256(current.toString("utf8")) === previous.installedHash) {
        if (previous.original === null) fs.unlinkSync(settings);
        else atomicPrivateFile(settings, Buffer.from(previous.original, "base64"));
      } else {
        const managed = previous.managed ?? { [SETTING]: url.origin, "workbench.startupEditor": "none", "window.title": "Gemini Web Native Test" };
        for (const [key, value] of Object.entries(managed)) if (JSON.stringify(parsed[key]) === JSON.stringify(value)) delete parsed[key];
        if (Object.keys(parsed).length) atomicPrivateFile(settings, JSON.stringify(parsed, null, 2) + "\n");
        else fs.unlinkSync(settings);
      }
      fs.unlinkSync(state);
      return { profile: path.resolve(profile), settings, action: "restored" };
    }
    return { profile: path.resolve(profile), settings, action: "unchanged" };
  }
  if (action === "restore") return { profile: path.resolve(profile), settings, action: "unchanged" };
  if (current) throw new NativeRouteError("UNOWNED_PROFILE", "Refusing to manage an existing unowned settings file. Use a fresh isolated profile.");
  const managed = { [SETTING]: url.origin, "workbench.startupEditor": "none", "window.title": "Gemini Web Native Test" };
  const bytes = JSON.stringify(managed, null, 2) + "\n";
  atomicPrivateFile(state, JSON.stringify({ version: 1, endpoint: url.origin, installedHash: sha256(bytes), original: null, managed }) + "\n");
  try { atomicPrivateFile(settings, bytes); } catch (error) { fs.unlinkSync(state); throw error; }
  return { profile: path.resolve(profile), settings, action: "configured" };
}
