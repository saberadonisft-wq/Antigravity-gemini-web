import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (process.platform !== "win32" || process.arch !== "x64") throw Error("Build the Windows x64 release on Windows x64.");
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const pkg = readJson(path.join(root, "package.json"));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(version)) throw Error("Invalid release version");
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== "v" + version) throw Error("Release tag must match package.json version");
const output = path.join(root, "release");
const name = `Antigravity-Gemini-Web-${version}-windows-x64`;
const directory = path.join(output, name);
fs.mkdirSync(output, { recursive: true });
if (fs.existsSync(directory)) throw Error("Release directory already exists. Build in a clean checkout or move the previous package first.");
const resources = path.join(directory, "resources");
const application = path.join(resources, "app");
const require = createRequire(import.meta.url);
const electronDir = path.dirname(require("electron"));
fs.cpSync(electronDir, directory, { recursive: true });
fs.renameSync(path.join(directory, "electron.exe"), path.join(directory, "Antigravity Gemini Web.exe"));
fs.renameSync(path.join(directory, "LICENSE"), path.join(directory, "ELECTRON-LICENSE.txt"));
fs.rmSync(path.join(resources, "default_app.asar"), { force: true });
fs.mkdirSync(application, { recursive: true });

const workspaces = ["packages/contracts", "packages/gemini-browser", "packages/mcp-server", "packages/native-antigravity", "apps/launcher"];
for (const workspace of workspaces) {
  const source = path.join(root, workspace);
  const target = path.join(application, workspace);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(source, "package.json"), path.join(target, "package.json"));
  if (!fs.existsSync(path.join(source, "dist"))) throw Error("Run npm run build first");
  fs.cpSync(path.join(source, "dist"), path.join(target, "dist"), { recursive: true, filter: file => !/\.(?:test|fixture)\.(?:js|d\.ts|js\.map)$/.test(file) && !/\.map$/.test(file) });
}
fs.cpSync(path.join(root, "apps/launcher/dist-renderer"), path.join(application, "apps/launcher/dist-renderer"), { recursive: true });
fs.mkdirSync(path.join(application, "extensions"), { recursive: true });
// Explicit files: never ship a developer profile, pairing token, test output or private state.
for (const file of ["manifest.json", "background.js", "popup.html", "popup.js", "popup.css"]) {
  const target = path.join(application, "extensions/chrome-profile-connector", file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, "extensions/chrome-profile-connector", file), target);
}
for (const file of ["package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) fs.copyFileSync(path.join(root, file), path.join(application, file));
fs.mkdirSync(path.join(application, "docs/licenses"), { recursive: true });
fs.copyFileSync(path.join(root, "docs/licenses/antigravity-add-model-APACHE-2.0.txt"), path.join(application, "docs/licenses/antigravity-add-model-APACHE-2.0.txt"));

// Resolve exactly the locked production dependencies in an isolated staging directory.
// npm's workspace links are then materialized so the ZIP remains relocatable.
const npmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
if (!fs.existsSync(npmCli)) throw Error("Build Node installation must include npm");
execFileSync(process.execPath, [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: application, stdio: "inherit", windowsHide: true });
for (const workspace of workspaces) {
  const manifest = readJson(path.join(application, workspace, "package.json"));
  const link = path.join(application, "node_modules", ...manifest.name.split("/"));
  if (!fs.lstatSync(link).isSymbolicLink()) throw Error("Expected an npm workspace link");
  fs.unlinkSync(link);
  fs.cpSync(path.join(application, workspace), link, { recursive: true });
}
const appManifest = { name: "antigravity-gemini-web", version, private: true, type: "module", main: "apps/launcher/dist/main/index.js", license: "Apache-2.0" };
fs.writeFileSync(path.join(application, "package.json"), JSON.stringify(appManifest, null, 2) + "\n");
fs.rmSync(path.join(application, "package-lock.json"));
fs.mkdirSync(path.join(resources, "node"));
fs.copyFileSync(process.execPath, path.join(resources, "node/node.exe"));
const licenseResponse = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30000) });
if (!licenseResponse.ok) throw Error("Could not obtain the license for the bundled Node runtime");
const nodeLicense = await licenseResponse.text();
if (!nodeLicense.includes("Node.js") || !nodeLicense.includes("Permission is hereby granted")) throw Error("Invalid Node license response");
fs.writeFileSync(path.join(resources, "node/LICENSE"), nodeLicense);
fs.copyFileSync(path.join(root, "LICENSE"), path.join(directory, "LICENSE"));
fs.copyFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(directory, "THIRD_PARTY_NOTICES.md"));
fs.mkdirSync(path.join(directory, "docs/licenses"), { recursive: true });
fs.copyFileSync(path.join(root, "docs/licenses/antigravity-add-model-APACHE-2.0.txt"), path.join(directory, "docs/licenses/antigravity-add-model-APACHE-2.0.txt"));
for (const file of ["README.md", "docs/README.md", "docs/STATUS.md", "docs/CHROME_PROFILE_CONNECTOR.md", "docs/NATIVE_RECOVERY_RUNBOOK.md"]) {
  const target = path.join(directory, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}

const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const manifest = { version, commit: revision, platform: "win32", arch: "x64", node: process.version, electron: readJson(path.join(electronDir, "../package.json")).version, supportedIde: "2.5.5", channel: "beta", signed: false };
fs.writeFileSync(path.join(directory, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
// Reject links or private/runtime files anywhere in the distributable, including dependencies.
const prohibited = /^(?:\.env(?:\..*)?|connector\.json.*|proxy-owner\.json.*|owner-pairing.*|oauth-clients\.json.*|accounts\.json|native-conversation-cache\.json)$/i;
function inspect(folder) {
  for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
    const target = path.join(folder, item.name);
    if (fs.lstatSync(target).isSymbolicLink() || prohibited.test(item.name)) throw Error("Unexpected link or private data in release package");
    if (item.isDirectory()) inspect(target);
  }
}
inspect(directory);
const archive = path.join(output, name + ".zip");
if (fs.existsSync(archive)) throw Error("Release ZIP already exists");
execFileSync("tar.exe", ["-a", "-c", "-f", path.basename(archive), name], { cwd: output, stdio: "inherit", windowsHide: true });
const sha256 = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.writeFileSync(path.join(output, "SHA256SUMS.txt"), `${sha256}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ archive, directory, sha256, ...manifest }));
