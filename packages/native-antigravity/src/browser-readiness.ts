import { NativeRouteError, sha256, type JsonObject } from "./native-protocol.js";
import { accountIdentityEmail } from "@antigravity-gemini-web/contracts";

export type BrowserBrokerCall = (name: string, args: JsonObject, signal?: AbortSignal) => Promise<JsonObject>;

/** Use a stable email, never an avatar URL, display name or localized label. */
export function observedAccountFingerprint(identity: unknown): string | undefined {
  if (identity && typeof identity === "object" && "fingerprint" in identity && typeof identity.fingerprint === "string" && /^[a-f0-9]{64}$/.test(identity.fingerprint)) return identity.fingerprint;
  const email = accountIdentityEmail(identity);
  return email ? sha256(email) : undefined;
}

/** Identity verification is observational: it must never open a browser or recover model state. */
export async function inspectNativeBrowserIdentity(call: BrowserBrokerCall, signal: AbortSignal): Promise<JsonObject> {
  signal.throwIfAborted();
  const status = await call("gemini_status", {}, signal);
  signal.throwIfAborted();
  if (status.browserActionRequired === "google_traffic_verification") {
    throw new NativeRouteError("BROWSER_USER_ACTION_REQUIRED", "Complete Google's traffic verification in the open browser, then check the account again. No prompt was submitted.", 412);
  }
  if (status.browserState !== "ready") {
    throw new NativeRouteError("BROWSER_NOT_READY", "Open the selected Gemini Chrome profile and sign in before checking its identity. No prompt was submitted.", 412);
  }
  if (status.accountState !== "signed_in") {
    throw new NativeRouteError("BROWSER_LOGIN_REQUIRED", "Sign into the selected Google account in the open browser profile, then return to Gemini. No prompt was submitted.", 412);
  }
  return status;
}

/** Opening is an authorized generation action; gemini_status itself stays read-only. */
export async function ensureNativeBrowserReady(call: BrowserBrokerCall, signal: AbortSignal, startupMs = 20000, expectedIdentityFingerprint?: string): Promise<JsonObject> {
  const deadline = performance.now() + startupMs;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(startupMs)]);
  const invoke = (name: string) => new Promise<JsonObject>((resolve, reject) => {
    if (bounded.aborted) { reject(bounded.reason); return; }
    const abort = () => reject(bounded.reason);
    bounded.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { bounded.throwIfAborted(); return call(name, {}, bounded); }).then(resolve, reject).finally(() => bounded.removeEventListener("abort", abort));
  });
  const check = (status: JsonObject) => {
    if (status.browserActionRequired === "google_traffic_verification") throw new NativeRouteError("BROWSER_USER_ACTION_REQUIRED", "Complete Google's traffic verification in the open browser, then return to Gemini and send a new message. No prompt was submitted.", 412);
    if (status.activeRequestId) throw new NativeRouteError("BUSY", "Another request owns this Gemini profile. Fetch or cancel it before starting a new turn.", 409);
    if (status.modelRestorePending === true) return false;
    if (status.browserOperationActive === true) throw new NativeRouteError("BUSY", "Another browser operation owns this Gemini profile.", 409);
    if (status.browserState === "ready" && status.accountState === "signed_in") {
      // Undefined is the standalone broker's inspection path. Registered workers
      // pass an empty expected fingerprint until explicit account:verify enrollment.
      if (expectedIdentityFingerprint !== undefined) {
        const observedFingerprint = observedAccountFingerprint(status.accountIdentity);
        if (!expectedIdentityFingerprint || !observedFingerprint) {
          const err = new NativeRouteError("ACCOUNT_IDENTITY_UNVERIFIED", "Verify the selected account with npm run native -- account:verify <name>. A stable account identity must be visible before sending.", 412);
          err.phase = "checkpoint"; err.delivery = "not_sent"; throw err;
        }
        if (observedFingerprint !== expectedIdentityFingerprint) {
          const err = new NativeRouteError("ACCOUNT_IDENTITY_CHANGED", "Google account in browser does not match this profile's registered identity. Sign into the correct account.", 412);
          err.phase = "checkpoint";
          err.delivery = "not_sent";
          throw err;
        }
      }
      return true;
    }
    return false;
  };
  try {
    bounded.throwIfAborted();
    let status = await invoke("gemini_status");
    if (check(status)) return status;
    status = await invoke("gemini_open_browser");
    if (status.opened !== true) throw new NativeRouteError("BROWSER_NOT_READY", "Gemini Web could not open. Run npm run native:browser to inspect its profile.", 412);
    while (performance.now() < deadline) {
      bounded.throwIfAborted();
      if (check(status)) return status;
      if (status.accountState === "needs_user_action") throw new NativeRouteError("BROWSER_LOGIN_REQUIRED", "Sign in to Google in the Gemini browser that just opened, then send a new IDE message. No prompt was submitted.", 412);
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(bounded.reason); };
        const timer = setTimeout(() => { bounded.removeEventListener("abort", abort); resolve(); }, 150);
        bounded.addEventListener("abort", abort, { once: true });
        if (bounded.aborted) abort();
      });
      status = await invoke("gemini_status");
    }
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof NativeRouteError) throw error;
    throw new NativeRouteError("BROWSER_NOT_READY", "Gemini browser startup did not become ready. Check the opened browser and send a new message; no prompt was submitted.", 412);
  }
  throw new NativeRouteError("BROWSER_NOT_READY", "Gemini browser did not become ready within its startup budget. No prompt was submitted.", 412);
}
