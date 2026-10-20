import { LiveGeminiBrowserAdapter } from "@antigravity-gemini-web/gemini-browser";

export class AcceptanceControls {
  pendingExport?: { promise: Promise<string | null>; resolve(value: string | null): void };
  pendingBrowser?: { promise: Promise<void>; resolve(): void };
  secondInstances = 0;
  nativeDialog?: { action: "save" | "cancel"; destination: string };
  queueExport() {
    let resolve!: (value: string | null) => void;
    const promise = new Promise<string | null>(done => { resolve = done; });
    return this.pendingExport = { promise, resolve };
  }
  queueBrowser() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return this.pendingBrowser = { promise, resolve };
  }
}
export class AcceptanceBrowser extends LiveGeminiBrowserAdapter {
  constructor(private readonly controls: AcceptanceControls, options: ConstructorParameters<typeof LiveGeminiBrowserAdapter>[0]) { super(options); }
  override async openBrowser() {
    const pending = this.controls.pendingBrowser;
    if (pending) { this.controls.pendingBrowser = undefined; await pending.promise; return { opened: false, actionReason: "Controlled fixture browser completion." }; }
    return super.openBrowser();
  }
}
