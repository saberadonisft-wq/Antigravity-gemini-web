import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.NODE_OPTIONS;
// This is an interactive GUI process. SW_HIDE can suppress its first native window on Windows.
const child = spawn(require("electron"), [".", ...process.argv.slice(2)], { env: environment, stdio: "inherit", windowsHide: false });
child.on("error", () => { console.error("Launcher could not start."); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
