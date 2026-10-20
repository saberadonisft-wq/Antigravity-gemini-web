import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { configureElectronStorage } from "./electron-storage.js";

const root = path.resolve(process.env.AG_CACHE_SMOKE_DIR ?? "");
if (path.dirname(root).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith("launcher-cache-check-")) throw new Error("Invalid cache test sandbox.");
const phase = process.argv.includes("--restart") ? "restart" : "first";
app.setName("Owned Launcher Cache Check");
const storage = configureElectronStorage(app, "live", undefined, path.join(root, "home"));
const deadline = setTimeout(() => app.exit(1), 12000);
if (!app.requestSingleInstanceLock()) {
  clearTimeout(deadline); app.exit(0);
} else {
  app.on("second-instance", () => fs.writeFileSync(path.join(root, "second-instance.json"), "true"));
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await window.loadURL("data:text/html,<title>Owned cache fixture</title><p>Owned cache fixture</p>");
    const rendered = await window.webContents.executeJavaScript("document.body.textContent === 'Owned cache fixture'");
    if (!rendered) throw new Error("Cache fixture renderer did not load.");
    fs.writeFileSync(path.join(root, phase + ".json"), JSON.stringify({ storage, userData: app.getPath("userData"), sessionData: app.getPath("sessionData"), rendered }));
    const poll = setInterval(() => {
      if (fs.existsSync(path.join(root, "close-" + phase))) { clearInterval(poll); clearTimeout(deadline); window.close(); }
    }, 25);
    app.on("window-all-closed", () => app.quit());
  }).catch(error => { console.error(error); app.exit(1); });
}
