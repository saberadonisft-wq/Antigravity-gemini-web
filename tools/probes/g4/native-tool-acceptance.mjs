import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = path.join(repoRoot, ".tmp", "native-g4-acceptance");
const sourcePath = path.join(fixtureRoot, "read-me.txt");
const resultPath = path.join(fixtureRoot, "result.txt");
const checkerPath = path.join(fixtureRoot, "check.mjs");
const expectedSource = "AG_NATIVE_G4_FIXTURE_READ_ONLY_MARKER";
const checker = [
  'import assert from "node:assert/strict";',
  'import fs from "node:fs";',
  'const source = fs.readFileSync(new URL("./read-me.txt", import.meta.url), "utf8");',
  'const output = fs.readFileSync(new URL("./result.txt", import.meta.url), "utf8");',
  'assert.equal(output, source + "_PATCHED");',
  'console.log("AG_NATIVE_TEST_PASS");',
  "",
].join("\n");

function assertNoLinks(target) {
  let current = path.parse(path.resolve(target)).root;
  for (const part of path.resolve(target).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Fixture path contains a symlink or junction."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function assertContained(target) {
  const relative = path.relative(fixtureRoot, path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Fixture path escaped its dedicated directory.");
  assertNoLinks(target);
}

function createExclusive(filename, contents) {
  assertContained(filename);
  const descriptor = fs.openSync(filename, "wx", 0o600);
  try { fs.writeFileSync(descriptor, contents); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

const command = process.argv[2] ?? "help";
if (command === "prepare") {
  assertNoLinks(fixtureRoot);
  if (fs.existsSync(fixtureRoot)) throw new Error("Fixture folder already exists. Inspect it manually; this script will not overwrite user files.");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  try {
    createExclusive(sourcePath, expectedSource);
    createExclusive(checkerPath, checker);
  } catch (error) {
    throw new Error("Fixture setup stopped without overwriting existing files. Inspect .tmp/native-g4-acceptance before retrying.", { cause: error });
  }
  console.log(JSON.stringify({ prepared: true, fixture: fixtureRoot, expectedOutput: expectedSource + "_PATCHED", checker: "check.mjs" }, null, 2));
} else if (command === "verify") {
  assertNoLinks(fixtureRoot);
  if (!fs.statSync(fixtureRoot).isDirectory()) throw new Error("Acceptance fixture directory is missing.");
  const source = fs.readFileSync(sourcePath, "utf8");
  const result = fs.readFileSync(resultPath, "utf8");
  assert.equal(source, expectedSource, "Fixture source was changed outside this acceptance case.");
  assert.equal(result, source + "_PATCHED", "Native edit did not produce the exact expected file contents.");
  const output = execFileSync(process.execPath, [checkerPath], { cwd: fixtureRoot, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(output.trim(), "AG_NATIVE_TEST_PASS");
  console.log(JSON.stringify({ verified: true, exactFileContents: true, commandOutput: output.trim(), fixture: fixtureRoot }, null, 2));
} else {
  console.log("Usage: node tools/probes/g4/native-tool-acceptance.mjs prepare|verify");
}
