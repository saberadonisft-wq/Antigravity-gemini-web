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
  SEND_BUTTON: "button[aria-label*='Send' i], button.send-button, [data-test-id='send-button']",

  // Stop / Cancel button during generation
  STOP_BUTTON: "button[aria-label*='Stop' i], button.stop-button, [data-test-id='stop-button']",

  // Assistant response containers
  MODEL_RESPONSE: "model-response, .model-response, .model-response-text, .response-container, [data-test-id='model-response']",
  CODE_BLOCK: "pre code, pre, .code-block",

  // Account indicators
  ACCOUNT_AVATAR: "img[aria-label*='Google Account' i], [data-test-id='user-avatar'], .gb_A, a[href*='accounts.google.com/SignOut']",
  SIGN_IN_BUTTON: "a[href*='accounts.google.com/ServiceLogin'], a[href*='accounts.google.com/signin'], [data-test-id='sign-in-button']",

  // Model indicator
  MODEL_INDICATOR: "[data-test-id='model-selector'], .model-picker-button",
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
  modelDetected?: string;
  responseCount: number;
  lastResponseText: string;
  lastResponseCodeBlocks?: string[];
  hasCodeBlock: boolean;
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

  // Account state positive evidence
  const avatar = document.querySelector("${GEMINI_SELECTORS.ACCOUNT_AVATAR}");
  let signInBtn = document.querySelector("${GEMINI_SELECTORS.SIGN_IN_BUTTON}");
  if (!signInBtn) {
    signInBtn = Array.from(document.querySelectorAll("button, a")).find(el => (el.textContent || '').trim().toLowerCase() === "sign in");
  }

  let accountState = "unknown";
  if (origin === "https://accounts.google.com" || signInBtn) {
    accountState = "needs_user_action";
  } else if (isAllowedSurface && avatar) {
    accountState = "signed_in";
  } else {
    accountState = "unknown";
  }

  // Composer and controls are only valid on allowed surface
  const composer = isAllowedSurface ? document.querySelector("${GEMINI_SELECTORS.COMPOSER}") : null;
  const sendBtn = isAllowedSurface ? document.querySelector("${GEMINI_SELECTORS.SEND_BUTTON}") : null;
  const stopBtn = isAllowedSurface ? document.querySelector("${GEMINI_SELECTORS.STOP_BUTTON}") : null;

  const isGenerating = Boolean(stopBtn && getComputedStyle(stopBtn).display !== 'none');
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
  const responses = isAllowedSurface ? document.querySelectorAll("${GEMINI_SELECTORS.MODEL_RESPONSE}") : [];
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
    modelDetected,
    responseCount,
    lastResponseText,
    lastResponseCodeBlocks,
    hasCodeBlock
  };
})()
`;
}

export const DOM_INSPECTION_SNIPPET = getDomInspectionSnippet();
