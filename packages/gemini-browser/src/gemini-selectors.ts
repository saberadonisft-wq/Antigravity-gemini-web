/**
 * DOM selectors and script snippets for Gemini Web and compatible DOM fixtures.
 * Uses positive evidence: requires explicit presence of required elements rather than
 * inferring state from negative checks.
 */

export const GEMINI_SELECTORS = {
  // Composer selectors (Gemini Web uses rich-textarea or contenteditable div)
  COMPOSER: "rich-textarea",
  COMPOSER_INPUT: "rich-textarea div[contenteditable='true'], rich-textarea textarea",

  // Send button (paper plane icon or aria-label 'Send')
  SEND_BUTTON: "button[aria-label='Send message' i], button[aria-label='Send' i], button[aria-label='Gửi tin nhắn' i], button[aria-label='Gửi' i], button.send-button, [data-test-id='send-button']",

  // Stop / Cancel button during generation
  STOP_BUTTON: "button[aria-label*='Stop' i], button[aria-label*='Dừng' i], button[aria-label*='Hủy câu trả lời' i], button[aria-label*='Huỷ câu trả lời' i], button.stop-button, [data-test-id='stop-button'], button:has(mat-icon[fonticon='stop']), button:has(mat-icon[data-mat-icon-name='stop'])",

  // Assistant response containers
  MODEL_RESPONSE: "model-response, .model-response, .model-response-text, .response-container, [data-test-id='model-response']",
  CODE_BLOCK: "pre code, pre, .code-block",

  // Account indicators
  ACCOUNT_AVATAR: "img[aria-label*='Google Account' i], [data-test-id='user-avatar'], .gb_A, a[href*='accounts.google.com/SignOut']",
  SIGN_IN_BUTTON: "a[href*='accounts.google.com/ServiceLogin'], a[href*='accounts.google.com/signin'], [data-test-id='sign-in-button']",

  // Model indicator
  MODEL_INDICATOR: "[data-test-id='model-selector'], .model-picker-button, [data-test-id='bard-mode-menu-button']",
};

export interface DomInspectionOptions {
  fixtureMode?: boolean;
  allowedOrigins?: string[];
}

// Standalone so the identical policy can also run inside the CDP DOM snippet.
export function isAllowedSurfaceUrl(url: string, options: DomInspectionOptions = {}): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    if (!options.fixtureMode) {
      return parsed.origin === "https://gemini.google.com" && (parsed.pathname === "/app" || parsed.pathname.startsWith("/app/"));
    }
    return (options.allowedOrigins ?? []).some(entry => {
      const allowed = new URL(entry);
      if (allowed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(allowed.hostname)) return false;
      return parsed.origin === allowed.origin && (allowed.pathname === "/" || parsed.pathname === allowed.pathname || parsed.pathname.startsWith(allowed.pathname.replace(/\/$/, "") + "/"));
    });
  } catch {
    return false;
  }
}

export interface DomInspectionResult {
  url: string;
  origin: string;
  pathname: string;
  title: string;
  isAllowedSurface: boolean;
  hasComposer: boolean;
  hasSendButton: boolean;
  isGenerating: boolean;
  accountState: "signed_in" | "needs_user_action" | "unknown";
  accountIdentity?: string;
  modelDetected?: string;
  responseCount: number;
  lastResponseText: string;
  lastResponseCodeBlocks?: string[];
  lastResponseKey?: string;
  lastUserQueryKey?: string;
  /** Visible feedback controls belonging to the newest answer, after generation. */
  hasResponseCompletion?: boolean;
  hasCodeBlock: boolean;
  progressLabel?: string;
  composerChars?: number;
}

export function getDomInspectionSnippet(options?: DomInspectionOptions): string {
  const fixtureMode = Boolean(options?.fixtureMode);
  const allowedOriginsJson = JSON.stringify(options?.allowedOrigins ?? []);

  return `
(() => {
  const url = window.location.href;
  const origin = window.location.origin;
  const pathname = window.location.pathname;
  const title = document.title;
  
  const fixtureMode = ${fixtureMode};
  const allowedOrigins = ${allowedOriginsJson};

  // Surface check: strictly require exact allowed origin
  const isAllowedSurface = (${isAllowedSurfaceUrl.toString()})(url, { fixtureMode, allowedOrigins });

  const visible = el => Boolean(el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none' && el.getAttribute('aria-hidden') !== 'true');

  // Account state and identity use visible indicators only. Gemini may put its
  // email in title/alt while aria-label contains only a generic account label.
  const avatars = Array.from(document.querySelectorAll("${GEMINI_SELECTORS.ACCOUNT_AVATAR}")).filter(visible);
  let signInBtn = document.querySelector("${GEMINI_SELECTORS.SIGN_IN_BUTTON}");
  if (!signInBtn) {
    signInBtn = Array.from(document.querySelectorAll("button, a")).find(el => (el.textContent || '').trim().toLowerCase() === "sign in");
  }

  let accountState = "unknown";
  if (origin === "https://accounts.google.com" || signInBtn) {
    accountState = "needs_user_action";
  } else if (isAllowedSurface && avatars.length > 0) {
    accountState = "signed_in";
  } else {
    accountState = "unknown";
  }
  const accountEmails = new Set();
  for (const avatar of avatars) {
    for (const attribute of ["aria-label", "title", "alt", "data-email"]) {
      const raw = avatar.getAttribute(attribute) || "";
      for (const email of raw.match(/[a-zA-Z0-9.!#$%&'*+/=?^_\\x60{|}~-]+@[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)+/g) || []) {
        accountEmails.add(email.toLowerCase());
      }
    }
  }
  const accountIdentity = accountEmails.size === 1 ? [...accountEmails][0] : undefined;

  // Composer and controls are only valid on allowed surface
  const composer = isAllowedSurface ? document.querySelector("${GEMINI_SELECTORS.COMPOSER}") : null;
  const sendBtn = isAllowedSurface ? document.querySelector("${GEMINI_SELECTORS.SEND_BUTTON}") : null;
  const isGenerating = isAllowedSurface && Array.from(document.querySelectorAll("${GEMINI_SELECTORS.STOP_BUTTON}")).some(visible);
  const hasComposer = Boolean(composer);
  const hasSendButton = Boolean(sendBtn);

  // Model detection: only from positive evidence, never default or invent
  let modelDetected = undefined;
  if (isAllowedSurface) {
    const modelEl = document.querySelector("${GEMINI_SELECTORS.MODEL_INDICATOR}");
    if (modelEl && modelEl.textContent && modelEl.textContent.trim()) {
      modelDetected = modelEl.textContent.trim();
    }
  }

  // Responses
  // Fallback selectors can match nested nodes of the same response. Count one
  // content surface per answer, rather than treating its wrapper as another turn.
  const responses = isAllowedSurface ? [...document.querySelectorAll("${GEMINI_SELECTORS.MODEL_RESPONSE}")].filter(e => !e.querySelector("${GEMINI_SELECTORS.MODEL_RESPONSE}")) : [];
  const responseCount = responses.length;
  let lastResponseText = "";
  let hasCodeBlock = false;

  if (responseCount > 0) {
    const last = responses[responseCount - 1];
    lastResponseText = last.innerText || last.textContent || "";
    hasCodeBlock = Boolean(last.querySelector("pre, code"));
  }

  const lastResponseCodeBlocks = responseCount > 0
    ? Array.from(responses[responseCount - 1].querySelectorAll('pre')).map(pre => (pre.querySelector('code') || pre).textContent || '')
    : [];
  // Code-block Copy buttons appear while tokens are still arriving. Only the
  // answer's feedback controls are terminal evidence, including localized UI.
  // Look in this answer's wrapper, never a previous answer's action row.
  const lastResponse = responses[responseCount - 1];
  const actionScope = lastResponse?.closest('model-response, .model-response, [data-test-id="model-response"]') || lastResponse;
  // Gemini can virtualize older answers when a large prompt scrolls them away.
  // A count alone cannot distinguish the new answer from the previous one.
  const keys = window.__agGeminiDomKeys || (window.__agGeminiDomKeys = { nodes: new WeakMap(), next: 0 });
  const nodeKey = element => {
    if (!element) return undefined;
    if (!keys.nodes.has(element)) keys.nodes.set(element, String(++keys.next));
    return keys.nodes.get(element);
  };
  const fingerprint = value => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16);
  };
  const userQueries = isAllowedSurface ? [...document.querySelectorAll('user-query, .user-query')] : [];
  const lastUserQuery = userQueries[userQueries.length - 1];
  const hasResponseCompletion = Boolean(actionScope && Array.from(actionScope.querySelectorAll('button')).some(button => {
    if (!visible(button)) return false;
    const label = button.getAttribute('aria-label') || '';
    if (/^(?:Good response|Bad response|Phản hồi tốt|Phản hồi không tốt|Câu trả lời hay|Câu trả lời không hay)$/i.test(label)) return true;
    return Array.from(button.querySelectorAll('mat-icon, [data-mat-icon-name], [fonticon]')).some(icon =>
      /^(?:thumb_up|thumb_down|thumb_up_off_alt|thumb_down_off_alt)$/.test((icon.getAttribute('data-mat-icon-name') || icon.getAttribute('fonticon') || icon.textContent || '').trim()));
  }));
  return {
    url,
    origin,
    pathname,
    title,
    isAllowedSurface,
    hasComposer,
    hasSendButton,
    isGenerating,
    accountState,
    accountIdentity,
    modelDetected,
    responseCount,
    lastResponseText,
    lastResponseCodeBlocks,
    lastResponseKey: actionScope ? nodeKey(actionScope) + ':' + fingerprint(lastResponseText) : undefined,
    lastUserQueryKey: lastUserQuery ? nodeKey(lastUserQuery) + ':' + fingerprint(lastUserQuery.textContent || '') : undefined,
    hasResponseCompletion,
    hasCodeBlock,
    progressLabel: isAllowedSurface ? ([...document.querySelectorAll('[data-test-id="generation-status"], .thinking-indicator, [role="status"]')].find(e => e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden')?.innerText || '').trim().slice(0, 200) : '',
    composerChars: composer ? (() => { const e = composer.matches('[contenteditable="true"],textarea') ? composer : composer.querySelector('[contenteditable="true"],textarea'); return (e?.value || e?.textContent || '').replace(/[\\s\\u200b]/g, '').length; })() : 0
  };
})()
`;
}

export const DOM_INSPECTION_SNIPPET = getDomInspectionSnippet();
