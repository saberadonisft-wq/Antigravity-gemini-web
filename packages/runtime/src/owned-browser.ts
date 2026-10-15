import net from "node:net";
import { LiveGeminiBrowserAdapter, type BrowserStatus, type BrowserOpenResult } from "@antigravity-gemini-web/gemini-browser";

/** The launcher never adopts an arbitrary CDP target from a shared fixed port. */
export class OwnedBrowserAdapter extends LiveGeminiBrowserAdapter {
  private async portOccupied(): Promise<boolean> {
    return new Promise(resolve => {
      const socket = net.connect({ host: "127.0.0.1", port: this.driver.debugPort });
      let settled = false;
      const finish = (occupied: boolean) => { if (settled) return; settled = true; socket.destroy(); resolve(occupied); };
      socket.setTimeout(250, () => finish(true)); // uncertain reachability is not permission to attach
      socket.once("connect", () => finish(true));
      socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code !== "ECONNREFUSED"));
    });
  }
  override async checkStatus(): Promise<BrowserStatus> {
    if (!this.driver.isOwnedProcess || !this.driver.isConnected) {
      return { browserState: "closed", accountState: "unknown", checkedAt: new Date().toISOString(), actionReason: "Open the app-owned browser before checking its account." };
    }
    return super.checkStatus();
  }
  override async openBrowser(): Promise<BrowserOpenResult> {
    if (!(this.driver.isOwnedProcess && this.driver.isConnected)) {
      if (this.driver.isOwnedProcess || this.driver.isProcessAlive) await super.cleanup();
      if (await this.portOccupied()) return { opened: false, actionReason: "Browser debugging port is occupied by an unverified process. No target was attached." };
    }
    const result = await super.openBrowser();
    if (!result.opened) return result;
    if (!this.driver.isOwnedProcess || !this.driver.isConnected) {
      // A target that raced the port probe does not confer ownership.
      await super.cleanup();
      return { opened: false, actionReason: "Browser ownership could not be verified. The external target was detached." };
    }
    try { await this.driver.cdp!.send("Page.bringToFront", {}, 2000); }
    catch { return { opened: true, actionReason: "App-owned browser opened; foreground could not be confirmed." }; }
    return { opened: true, actionReason: "App-owned browser page brought to front." };
  }
}
