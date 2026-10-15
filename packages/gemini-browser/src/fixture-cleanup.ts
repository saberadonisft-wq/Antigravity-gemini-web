import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Owned fixture cleanup only. A locked profile is a failed cleanup. */
export async function removeFixtureProfile(directory: string, budgetMs = 10000): Promise<void> {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 10000) throw new Error("Invalid cleanup budget.");
  const target = path.resolve(directory);
  const temporary = await fs.realpath(os.tmpdir());
  const parent = await fs.realpath(path.dirname(target));
  const equal = process.platform === "win32" ? parent.toLowerCase() === temporary.toLowerCase() : parent === temporary;
  if (!equal || !/^(gemini-driver-test-profile-|gemini-v3-test-profile-)/.test(path.basename(target))) throw new Error("Invalid fixture cleanup target.");
  const info = await fs.lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return;
  if (info.isSymbolicLink()) throw new Error("Fixture profile identity changed.");
  const deadline = performance.now() + budgetMs;
  for (;;) {
    try { await fs.rm(target, { recursive: true, force: true }); return; }
    catch (error) {
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "") || performance.now() >= deadline) throw new Error("Owned fixture profile cleanup failed.", { cause: error });
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - performance.now()))));
    }
  }
}
