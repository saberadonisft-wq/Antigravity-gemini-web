import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";

/** Configure before ready/instance locking; never inherit Chromium's default shared cache. */
export function configureElectronStorage(app: Pick<App, "setPath" | "isReady">, mode: "live" | "demo", sandbox?: string, home = os.homedir()) {
  if (app.isReady()) throw new Error("Electron storage must be configured before ready.");
  const userData = sandbox
    ? path.join(sandbox, "electron")
    : path.join(home, ".gemini", "antigravity-gemini-web-" + mode, "electron");
  const sessionData = path.join(userData, "session");
  fs.mkdirSync(sessionData, { recursive: true });
  app.setPath("userData", userData);
  app.setPath("sessionData", sessionData);
  return { userData, sessionData };
}
