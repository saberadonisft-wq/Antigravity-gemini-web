// Exclusive browser-owner spike. It pauses an idle native owner, opens one
// disposable tab, inspects upload controls, then restores the native service.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { acquireOwnership } from "../../packages/mcp-server/dist/ownership.js";
import { LiveGeminiBrowserAdapter, assertBrowserAccountIdentity } from "../../packages/gemini-browser/dist/index.js";
import { AccountRegistry } from "../../packages/native-antigravity/dist/account-registry.js";
import { ensureNativeBrowserReady } from "../../packages/native-antigravity/dist/browser-readiness.js";

const root = process.cwd(), endpoint = "http://127.0.0.1:9236";
const native = path.join(os.homedir(), ".gemini/antigravity-gemini-web-live/app_data/native-route");
const health = () => fetch(endpoint + "/__native/health", { signal: AbortSignal.timeout(2000) }).then(response => response.json());
const initial = await health(); assert.equal(initial.counters.active, 0);
if (!process.argv.includes("--live")) console.log(JSON.stringify({ livePromptsSent: 0, nativeRevision: initial.runtimeRevision }));
else {
  const account = new AccountRegistry(path.join(native, "accounts.json")).getActive();
  assert.ok(account?.identityFingerprint);
  const owner = JSON.parse(fs.readFileSync(path.join(native, "proxy-owner.json"), "utf8"));
  assert.equal(owner.pid, initial.pid); assert.equal(owner.endpoint, endpoint);
  const result = { checkedAt: new Date().toISOString(), accountId: account.accountId, status: "RUNNING", promptSent: false, inspectedOwnedTab: false };
  let mutex, browser, lease, temporaryDirectory, temporaryFile;
  try {
    result.stage = "stop_native";
    const stopped = await fetch(endpoint + "/__native/stop", { method: "POST", headers: { "x-native-control-token": owner.controlToken }, signal: AbortSignal.timeout(3000) }); assert.equal(stopped.ok, true);
    result.stage = "acquire_browser_owner";
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      try { mutex = await acquireOwnership("browser:" + account.profilePath); break; }
      catch (error) { if (error.code !== "EADDRINUSE") throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(mutex, "The existing browser owner must release its reservation before the spike.");
    result.stage = "open_browser";
    browser = new LiveGeminiBrowserAdapter({ userDataDir: account.profilePath, debugPort: account.debugPort, headless: false, requireProfileIdentity: true });
    assert.equal((await browser.openBrowser()).opened, true);
    result.stage = "verify_identity";
    const ready = await ensureNativeBrowserReady(async name => ({ ...(name === "gemini_open_browser" ? await browser.openBrowser() : {}), ...await browser.checkStatus() }), new AbortController().signal, 20000, account.identityFingerprint);
    assertBrowserAccountIdentity(ready.accountIdentity, account.identityFingerprint);
    result.modelDetected = ready.displayLabel;
    result.stage = "open_owned_tab";
    lease = await browser.openFreshConversation(); result.inspectedOwnedTab = true;
    result.stage = "inspect_upload_menu";
    const cdp = browser.driver.cdp;
    await cdp.evaluate(`(() => { window.__agUploadProbeEvents=[]; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) document.addEventListener(type,event=>{ const b=event.target.closest?.('button');window.__agUploadProbeEvents.push({type,x:event.clientX,y:event.clientY,trusted:event.isTrusted,buttons:event.buttons,button:event.button,target:b?.getAttribute('aria-label')==='Upload & tools'?'upload':event.target.tagName}); },{capture:true});return true; })()`);
    const point = await cdp.evaluate(`(() => { const candidates=[...document.querySelectorAll('button[aria-label]')].filter(e=>/^(Upload & tools|Add files|Thêm tệp|Tải lên và công cụ)$/i.test(e.getAttribute('aria-label')||'')&&e.getBoundingClientRect().height); if(candidates.length!==1)return false;const button=candidates[0];button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return button.contains(document.elementFromPoint(x,y))?{x,y}:false; })()`);
    assert.ok(point, "Exactly one unobscured upload control must be available on the owned tab.");
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    const menusUntil = performance.now() + 5000;
    let observation;
    while (performance.now() < menusUntil) {
      observation = await cdp.evaluate(`(() => {
        const labels=['upload files','upload file','add from drive','import code','notebooks','tải tệp lên','tải tệp','thêm từ drive','nhập mã'];
        const visible=e=>!!e.getBoundingClientRect().height;
        const controls=[...document.querySelectorAll('button,[role=button],[role=menuitem],span')].filter(visible).map(e=>({node:e,text:(e.getAttribute('aria-label')||e.textContent||'').trim().toLowerCase().replace(/\\s+/g,' ')})).filter(e=>labels.includes(e.text)).map(e=>({label:e.text,tag:e.node.tagName,cls:e.node.className}));
        return {inputs:[...document.querySelectorAll('input[type=file]')].map(e=>({accept:e.accept,multiple:e.multiple})),controls,overlays:[...document.querySelectorAll('.cdk-overlay-pane')].map(e=>({cls:e.className,visible:visible(e),children:[...e.querySelectorAll('*')].slice(0,30).map(n=>({tag:n.tagName,cls:typeof n.className==='string'?n.className:''}))}))};
      })()`);
      if (observation.controls.some(control => ["upload files", "upload file", "tải tệp lên", "tải tệp"].includes(control.label)) || observation.inputs.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    result.observation = observation; result.status = observation.controls.some(control => ["upload files", "upload file", "tải tệp lên", "tải tệp"].includes(control.label)) || observation.inputs.length ? "PASS_MENU_INSPECTION_ONLY" : "OBSERVED_UPLOAD_CONTROL_ONLY";
    if (process.argv.includes("--upload")) {
      result.stage = "upload_synthetic_file";
      assert.equal(result.status, "PASS_MENU_INSPECTION_ONLY");
      const roots = await cdp.send("DOM.getDocument", { depth: 0 });
      const inputs = await cdp.send("DOM.querySelectorAll", { nodeId: roots.root.nodeId, selector: '.cdk-overlay-pane images-files-uploader input[type="file"][accept*=".txt"]' });
      assert.equal(inputs.nodeIds.length, 1, "Exactly one text upload input must belong to the active upload menu.");
      temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-native-snapshot-"));
      const id = randomUUID().replaceAll("-", ""), filename = "ag-native-spike-" + id.slice(0, 12) + ".txt";
      const markers = ["START", "MIDDLE", "END"].map(prefix => "UPLOAD_" + prefix + "_" + id.slice(0, 12) + "_Việt_😀");
      const padding = "Synthetic file data 0123456789. ".repeat(1250);
      const content = markers[0] + "\n" + padding + "\n" + markers[1] + "\n" + padding + "\n" + markers[2];
      temporaryFile = path.join(temporaryDirectory, filename);
      fs.writeFileSync(temporaryFile, content, { flag: "wx", mode: 0o600 });
      result.file = { name: filename, chars: content.length, utf8Bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
      await cdp.send("DOM.setFileInputFiles", { files: [temporaryFile], nodeId: inputs.nodeIds[0] });
      const uploadUntil = performance.now() + 60000;
      while (performance.now() < uploadUntil) {
        result.fileUi = await cdp.evaluate(`(() => {
          const filename=${JSON.stringify(filename)};
          const stem=filename.replace(/\\.txt$/,'');
          const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.height>2&&r.width>2&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&s.visibility!=='hidden'&&s.opacity!=='0'&&!e.closest('.cdk-visually-hidden,[hidden],[role=\"tooltip\"]');};
          const descriptions=[...document.querySelectorAll('[id][role=tooltip]')].filter(e=>e.textContent?.includes(stem)).map(e=>e.id);
          const e=[...document.querySelectorAll('[aria-describedby]')].find(e=>(e.getAttribute('aria-describedby')||'').split(/\\s+/).some(id=>descriptions.includes(id))&&visible(e)) || [...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent?.includes(stem)&&visible(e)&&!e.closest('mat-tooltip-component,.mat-mdc-tooltip-panel'));
          if(!e)return null;
          let n=e;const ancestors=[];for(let i=0;n&&i<7;i++,n=n.parentElement)ancestors.push({tag:n.tagName,cls:typeof n.className==='string'?n.className:'',role:n.getAttribute('role'),busy:n.getAttribute('aria-busy')});
          const chip=e.closest('uploader-file-preview')||e.parentElement;return {filenameVisible:visible(e),ancestors,error:!!chip.querySelector('.error-icon,[fonticon=error],[data-mat-icon-name=error]'),progress:[...chip.querySelectorAll('[role=progressbar],mat-spinner,mat-progress-spinner,mat-progress-bar')].map(p=>({tag:p.tagName,cls:p.className}))};
        })()`);
        if (result.fileUi?.filenameVisible && !result.fileUi.progress.length) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      result.fileCandidates = await cdp.evaluate(`(() => {
        const stem=${JSON.stringify(filename.replace(/\.txt$/, ""))};
        return [...document.querySelectorAll('*')].filter(e=>(e.textContent?.includes(stem)&&e.textContent.length<stem.length+12)||(e.getAttribute('aria-label')||'').includes(stem)||(e.getAttribute('title')||'').includes(stem)).slice(0,20).map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,cls:typeof e.className==='string'?e.className:'',rect:{x:r.x,y:r.y,w:r.width,h:r.height},display:s.display,visibility:s.visibility,hiddenAncestor:e.closest('.cdk-visually-hidden,[hidden],[role=tooltip]')?.tagName,ancestors:[e.parentElement,e.parentElement?.parentElement,e.parentElement?.parentElement?.parentElement].filter(Boolean).map(p=>({tag:p.tagName,cls:p.className}))};});
      })()`);
      const attachmentReady = result.fileUi?.filenameVisible && !result.fileUi.progress.length && !result.fileUi.error;
      result.status = attachmentReady ? "OBSERVED_ATTACHMENT_READY" : "FILE_CHIP_NOT_VERIFIED";
      if (attachmentReady && process.argv.includes("--send")) {
        result.stage = "marker_retrieval";
        const started = performance.now(), turnId = "upload_spike_" + id;
        const submission = await browser.submitPrompt(turnId, `Read the attached text file ${filename}. Return exactly one JSON object with a markers array containing the three UPLOAD marker strings in their original order, preserving every Unicode character. The three values must come from the file, not from this prompt. No prose or other fields.`, { expectedAccountFingerprint: account.identityFingerprint, timeoutMs: 120000 });
        result.promptSent = true;
        const response = await browser.pollResponse(turnId, { deadlineMs: 120000, stallTimeoutMs: 60000 });
        const raw = (response.codeBlocks?.length === 1 ? response.codeBlocks[0] : response.text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        result.retrieval = { browserStatus: response.status, elapsedMs: Math.round(performance.now() - started), responseChars: response.text.length, responseSha256: createHash("sha256").update(response.text).digest("hex"), submission: submission.submissionDiagnostic };
        assert.equal(response.status, "completed"); assert.deepEqual(JSON.parse(raw), { markers });
        result.retrieval.markersMatch = true; result.status = "PASS_UPLOAD_MARKER_RETRIEVAL";
      }
    }
    result.uploadState = await cdp.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')==='Upload & tools');return {disabled:b?.disabled,ariaDisabled:b?.getAttribute('aria-disabled'),expanded:b?.getAttribute('aria-expanded'),popup:b?.getAttribute('aria-haspopup'),roleMenus:document.querySelectorAll('[role*=menu],[popover]').length,shadowRoots:[...document.querySelectorAll('*')].filter(e=>e.shadowRoot).map(e=>e.tagName),width:innerWidth,height:innerHeight};})()`);
    result.pointer = { intended: point, observed: await cdp.evaluate("window.__agUploadProbeEvents"), metrics: await cdp.send("Page.getLayoutMetrics") };
    if (["OBSERVED_UPLOAD_CONTROL_ONLY", "FILE_CHIP_NOT_VERIFIED"].includes(result.status)) {
      const viewport = result.uploadState;
      const x = Math.min(Math.max(100, point.x - 50), Math.max(0, viewport.width - 450)), y = Math.max(0, point.y - 400);
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: { x, y, width: Math.min(650, viewport.width - x), height: Math.min(460, viewport.height - y), scale: 1 } });
      fs.writeFileSync(".tmp/native-upload-popup.png", Buffer.from(screenshot.data, "base64"));
    }
  } catch (error) { result.status = "FAILED"; result.error = error.code ?? "SPIKE_FAILED"; result.reason = typeof error.message === "string" ? error.message.replace(/(?:https?|wss?):\/\/\S+/g, "[url]").slice(0, 160) : undefined; process.exitCode = 1; }
  finally {
    try { await lease?.close(); await browser?.cleanup(); } catch { result.cleanup = "FAILED"; process.exitCode = 1; }
    if (temporaryFile) {
      const deadline = performance.now() + 5000;
      for (;;) {
        try {
          assert.equal(path.dirname(temporaryDirectory), os.tmpdir()); assert.ok(path.basename(temporaryDirectory).startsWith("gemini-native-snapshot-")); assert.equal(fs.lstatSync(temporaryDirectory).isSymbolicLink(), false);
          fs.rmSync(temporaryFile, { force: true }); fs.rmdirSync(temporaryDirectory); result.temporaryFileRemoved = true; break;
        } catch { if (performance.now() >= deadline) { result.temporaryFileRemoved = false; process.exitCode = 1; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
      }
    }
    if (mutex) await new Promise(resolve => mutex.close(resolve));
    if (!await health().catch(() => undefined)) {
      const child = spawn(process.execPath, [path.join(root, "packages/native-antigravity/dist/native-cli.js"), "start"], { cwd: root, detached: true, windowsHide: true, stdio: "ignore" }); child.on("error", () => {}); child.unref();
      const deadline = performance.now() + 10000;
      while (performance.now() < deadline) { const ready = await health().catch(() => undefined); if (ready?.service === "gemini-native-proxy") { result.nativeRestored = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
    } else result.nativeRestored = true;
    if (!result.nativeRestored) { result.status = "FAILED_NATIVE_RESTORE"; process.exitCode = 1; }
    fs.writeFileSync(".tmp/native-upload-menu-spike.json", JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
  }
}
