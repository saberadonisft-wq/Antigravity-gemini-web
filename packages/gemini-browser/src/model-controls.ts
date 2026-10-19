import type { CdpClient } from "./cdp-client.js";
import { GEMINI_SELECTORS, getDomInspectionSnippet, type DomInspectionOptions } from "./gemini-selectors.js";
import type { BrowserModelSelection } from "./progress.js";
import type { ModelSelectionDiagnostic } from "@antigravity-gemini-web/contracts";

export interface BrowserModelCatalog {
  selected: BrowserModelSelection;
  options: Array<{ model: string; disabled: boolean }>;
}

/** Read the selected menu rows, rather than guessing a model from its short button label. */
export async function inspectBrowserModels(cdp: CdpClient, surface: DomInspectionOptions): Promise<BrowserModelCatalog> {
  let stage: ModelSelectionDiagnostic["stage"] = "open_model";
  const deadline = performance.now() + 10000;
  const inspect = async <T>(body: string): Promise<T> => {
    const value = await cdp.evaluate<T>(`(() => {
      const dom = ${getDomInspectionSnippet(surface)};
      if (!dom.isAllowedSurface || dom.accountState !== 'signed_in' || !dom.hasComposer || dom.isGenerating) throw Error('Model inspection requires an idle signed-in surface.');
      const visible = e => e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden';
      const label = e => (e.querySelector('.label')?.textContent || e.getAttribute('data-model-option') || e.textContent || '').trim().replace(/\\s+/g, ' ');
      const selected = e => e.classList.contains('selected') || e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true';
      const buttons = [...document.querySelectorAll(${JSON.stringify(GEMINI_SELECTORS.MODEL_INDICATOR)})].filter(visible);
      if (buttons.length !== 1) throw Error('Model picker is ambiguous.');
      ${body}
    })()`, true, 2500);
    if (value === undefined) throw Error('Model inspection returned no observation.');
    return value;
  };
  try {
    // Fresh conversations can expose the composer before mounting the picker.
    let ready = false;
    while (performance.now() < deadline) {
      ready = await cdp.evaluate<boolean>(`(() => {
        const dom = ${getDomInspectionSnippet(surface)};
        return dom.isAllowedSurface && dom.accountState === 'signed_in' && dom.hasComposer && !dom.isGenerating && [...document.querySelectorAll(${JSON.stringify(GEMINI_SELECTORS.MODEL_INDICATOR)})].filter(e => e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden').length === 1;
      })()`, true, 2500) === true;
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw Error('Model picker did not become ready.');
    let catalog: BrowserModelCatalog | undefined;
    let hasEffort = false;
    while (performance.now() < deadline) {
      const observation = await inspect<{ catalog?: BrowserModelCatalog; hasEffort?: boolean }>(`
        const rows = [...document.querySelectorAll('[data-test-id^="bard-mode-option-"],[data-model-option]')].filter(visible);
        if (!rows.length) {
          if (buttons[0].getAttribute('aria-expanded') !== 'true') buttons[0].click();
          return {};
        }
        const chosen = rows.filter(selected);
        if (chosen.length !== 1 || rows.some(e => !label(e) || label(e).length > 100) || new Set(rows.map(label)).size !== rows.length) throw Error('Model rows are ambiguous.');
        return { catalog: { selected: { model: label(chosen[0]) }, options: rows.map(e => ({ model: label(e), disabled: e.disabled || e.getAttribute('aria-disabled') === 'true' })) },
          hasEffort: [...document.querySelectorAll('[role=menuitem],[data-effort-picker]')].filter(visible).some(e => !e.disabled && e.getAttribute('aria-disabled') !== 'true' && (e.getAttribute('value') === 'thinking_level' || e.hasAttribute('data-effort-picker') || label(e) === 'Thinking level')) };
      `);
      if (observation.catalog) { catalog = observation.catalog; hasEffort = observation.hasEffort === true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!catalog) throw Error('Model inspection timed out.');
    stage = "verify_model";
    if (hasEffort) {
      stage = "open_effort";
      await inspect(`
        const controls = [...document.querySelectorAll('[role=menuitem],[data-effort-picker]')].filter(visible).filter(e => e.getAttribute('value') === 'thinking_level' || e.hasAttribute('data-effort-picker') || label(e) === 'Thinking level');
        if (controls.length !== 1 || controls[0].disabled || controls[0].getAttribute('aria-disabled') === 'true') throw Error('Thinking level control changed.');
        controls[0].click(); return true;
      `);
      stage = "verify_effort";
      let effort: string | undefined;
      while (performance.now() < deadline) {
        effort = await inspect<string | null>(`
          const rows = [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option]')].filter(visible);
          const chosen = rows.filter(e => selected(e) && !e.matches('[data-test-id^="bard-mode-option-"],[data-model-option]'));
          if (chosen.length > 1) throw Error('Thinking level is ambiguous.');
          if (chosen.length === 1) { const text = label(chosen[0]); if (!text || text.length > 60) throw Error('Invalid thinking level.'); return text; }
          return null;
        `) ?? undefined;
        if (effort) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!effort) throw Error('Thinking level could not be captured.');
      stage = "verify_effort";
      catalog.selected.effort = effort;
    }
    return catalog;
  } catch {
    let modelCaptureObservation: unknown;
    try { modelCaptureObservation = await inspect(`return [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option]')].filter(visible).slice(0,25).map(e => ({ label:label(e).slice(0,100), selected:selected(e), disabled:!!e.disabled || e.getAttribute('aria-disabled') === 'true', expanded:e.getAttribute('aria-expanded'), value:e.getAttribute('value'), testId:e.getAttribute('data-test-id') }));`); } catch { /* No usable menu observation. */ }
    throw { code: "MODEL_UNAVAILABLE", message: "The current Web model/effort could not be captured. Nothing was sent.", retryable: false, modelSelection: { stage, verificationOnly: true }, modelCaptureObservation };
  } finally {
    try {
      await inspect(`if (buttons[0].getAttribute('aria-expanded') === 'true' || [...document.querySelectorAll('[data-test-id^="bard-mode-option-"],[data-model-option]')].some(visible)) buttons[0].click(); return true;`);
      const closed = await inspect<boolean>(`return buttons[0].getAttribute('aria-expanded') !== 'true' && ![...document.querySelectorAll('[data-test-id^="bard-mode-option-"],[data-model-option]')].some(visible);`);
      if (!closed) throw Error('Model menu remained open.');
    } catch {
      throw { code: "MODEL_UNAVAILABLE", message: "Web model menu closure could not be confirmed. Nothing was sent.", retryable: false, modelSelection: { stage: "close_menu", verificationOnly: true } };
    }
  }
}

/** Observed Gemini controls: model option .label + .selected, and Thinking level submenu. */
export async function selectBrowserModel(cdp: CdpClient, policy: BrowserModelSelection, surface: DomInspectionOptions, verifyOnly = false): Promise<BrowserModelSelection> {
  let stage: ModelSelectionDiagnostic["stage"] = "open_model";
  let verified = false;
  const deadline = performance.now() + 10000;
  if (!policy.model.trim() || policy.model.length > 100 || policy.effort && policy.effort.length > 60) throw { code: "INVALID_MODEL_SELECTION", message: "Invalid Web model selection.", retryable: false };
  const run = async <T>(body: string, until = deadline): Promise<T> => {
    if (performance.now() >= until) throw Error("Model controls timed out.");
    const result = await cdp.evaluate<T>(`(() => {
      const dom = ${getDomInspectionSnippet(surface)};
      if (!dom.isAllowedSurface || dom.accountState !== 'signed_in' || !dom.hasComposer || dom.isGenerating) throw Error('Model selection requires a ready owned surface.');
      const visible = e => e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden';
      const label = e => (e.querySelector('.label')?.textContent || e.getAttribute('data-model-option') || e.textContent || '').trim().replace(/\\s+/g, ' ');
      const selected = e => e.classList.contains('selected') || e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true';
      const models = () => [...document.querySelectorAll('[data-test-id^="bard-mode-option-"],[data-model-option]')].filter(visible);
      ${body}
    })()`, true, Math.max(1, Math.min(2500, until - performance.now())));
    if (result === undefined) throw Error("Model controls returned no observation.");
    return result as T;
  };
  const pause = () => new Promise(resolve => setTimeout(resolve, 50));
  const until = async (predicate: () => Promise<boolean>) => {
    while (performance.now() < deadline) { if (await predicate()) return; await pause(); }
    throw Error("Model selection was not positively confirmed.");
  };
  const open = async () => {
    // Submenus can hide model rows while the root remains open. Do not toggle
    // the complete menu tree closed merely because those rows are absent.
    await until(() => run<boolean>(`const buttons = [...document.querySelectorAll(${JSON.stringify(GEMINI_SELECTORS.MODEL_INDICATOR)})].filter(visible); if (buttons.length !== 1) throw Error('Model picker is ambiguous.'); const expanded = buttons[0].getAttribute('aria-expanded'); if (expanded === 'false' || expanded === null && !models().length) { buttons[0].click(); return false; } return models().length > 0;`));
  };
  const choose = async (kind: "model" | "effort", desired: string): Promise<void> => {
    const rowSource = kind === "model" ? "models()" : "[...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option]')].filter(visible)";
    await until(async () => {
      if (kind === "model") await open(); else await effortMenu();
      const result = await run<{ found: boolean; selected: boolean }>(`
        const matches = ${rowSource}.filter(e => label(e) === ${JSON.stringify(desired)});
        if (matches.length !== 1 || matches[0].getAttribute('aria-disabled') === 'true' || matches[0].disabled) return {found:false,selected:false};
        const wasSelected = selected(matches[0]);
        if (!wasSelected && !${verifyOnly}) matches[0].click();
        return {found:true,selected:wasSelected};`);
      if (!result.found) return false;
      if (verifyOnly && !result.selected) throw { code: "MODEL_UNAVAILABLE", message: "The requested Web model/effort changed. Nothing was sent.", retryable: false };
      return true;
    });
  };
  const effortMenu = async () => {
    await until(() => run<boolean>(`
      if ([...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option]')].filter(visible).filter(e => label(e) === ${JSON.stringify(policy.effort)}).length === 1) return true;
      const buttons = [...document.querySelectorAll(${JSON.stringify(GEMINI_SELECTORS.MODEL_INDICATOR)})].filter(visible);
      if (buttons.length !== 1) throw Error('Model picker is ambiguous.');
      const expanded = buttons[0].getAttribute('aria-expanded');
      if (expanded === 'false' || expanded === null && !models().length) { buttons[0].click(); return false; }
      const rows = [...document.querySelectorAll('[role=menuitem],[data-effort-picker]')].filter(visible).filter(e => e.getAttribute('value') === 'thinking_level' || e.hasAttribute('data-effort-picker') || label(e) === 'Thinking level');
      if (rows.length === 1 && rows[0].getAttribute('aria-expanded') !== 'true' && rows[0].getAttribute('aria-disabled') !== 'true' && !rows[0].disabled) rows[0].click();
      return false;`));
  };
  try {
    // A fresh Gemini page can mount its composer before the mode picker.
    await until(() => run<boolean>(`return [...document.querySelectorAll(${JSON.stringify(GEMINI_SELECTORS.MODEL_INDICATOR)})].filter(visible).length === 1;`));
    await open(); stage = "choose_model"; await choose("model", policy.model);
    stage = "verify_model";
    await open();
    await until(async () => { await open(); return run<boolean>(`return models().filter(e => label(e) === ${JSON.stringify(policy.model)} && selected(e)).length === 1;`); });
    if (policy.effort) {
      stage = "open_effort"; await effortMenu(); stage = "choose_effort";
      await choose("effort", policy.effort);
      stage = "verify_effort";
      await until(async () => { await effortMenu(); return run<boolean>(`return [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option]')].filter(visible).filter(e => label(e) === ${JSON.stringify(policy.effort)} && selected(e)).length === 1;`); });
    }
    verified = true; return { ...policy };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw { code: error.code, message: "Requested Web model/effort could not be verified at " + stage + ". Nothing was sent.", retryable: false, modelSelection: { stage, verificationOnly: verifyOnly } };
    throw { code: "MODEL_UNAVAILABLE", message: "Could not verify Web model/effort at " + stage + ". Nothing was sent.", retryable: false, modelSelection: { stage, verificationOnly: verifyOnly } };
  } finally {
    const cleanupDeadline = performance.now() + 1500;
    try {
      await run(`const b = [...document.querySelectorAll(${JSON.stringify(GEMINI_SELECTORS.MODEL_INDICATOR)})].filter(visible); if (b.length === 1 && (b[0].getAttribute('aria-expanded') === 'true' || b[0].getAttribute('aria-expanded') === null && models().length)) b[0].click(); return true;`, cleanupDeadline);
      for (;;) {
        if (await run<boolean>(`const b = [...document.querySelectorAll(${JSON.stringify(GEMINI_SELECTORS.MODEL_INDICATOR)})].filter(visible); return b.length === 1 && b[0].getAttribute('aria-expanded') !== 'true' && !models().length;`, cleanupDeadline)) break;
        await pause();
      }
    } catch {
      if (verified) throw { code: "MODEL_UNAVAILABLE", message: "Web model menu closure could not be confirmed. Nothing was sent.", retryable: false, modelSelection: { stage: "close_menu", verificationOnly: verifyOnly } };
    }
  }
}
