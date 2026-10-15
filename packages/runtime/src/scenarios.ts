import {
  SCHEMA_VERSION,
  type RuntimeSnapshot,
  type CapabilityMap,
  type SessionSummary,
  type TurnSummary,
} from "@antigravity-gemini-web/contracts";

export type ScenarioName =
  | "first_run"
  | "login_required"
  | "native_unverified"
  | "generating"
  | "tool_running"
  | "cancel_pending"
  | "disconnected"
  | "config_conflict"
  | "outcome_unknown";

const baseCapabilities: CapabilityMap = {
  nativeRoute: {
    state: "unverified",
    reasonCode: "NATIVE_ROUTE_UNVERIFIED",
    detail: "Antigravity IDE native route via agy.exe is unverified (Gate G0 unresolved).",
  },
  modelSelection: {
    state: "unverified",
    reasonCode: "MODEL_CATALOG_CURATED",
    detail: "Model catalog is hardcoded in agy.exe binary; dynamic model registration is unverified.",
  },
  toolExecution: {
    state: "unverified",
    reasonCode: "NATIVE_EXECUTOR_UNCONNECTED",
    detail: "IDE task executor connection to Gemini Web bridge is unverified.",
  },
  customMcp: {
    state: "unavailable",
    reasonCode: "MCP_STATUS_UNVERIFIED",
    detail: "MCP support is documented but requires personal account eligibility and local tunnel.",
  },
  cancelTurn: {
    state: "available",
  },
  imageInput: {
    state: "unavailable",
    reasonCode: "TEXT_ONLY_G1",
  },
  contextCompaction: {
    state: "unavailable",
  },
  usageObservation: {
    state: "available",
    detail: "Diagnostic metrics observation enabled.",
  },
  logExport: {
    state: "available",
  },
};

export function createScenarioSnapshot(
  scenario: ScenarioName,
  runtimeInstanceId: string,
  revision: number,
  lastEventSequence: number
): RuntimeSnapshot {
  const now = new Date().toISOString();

  const demoSession: SessionSummary = {
    id: "sess-demo-1",
    workspaceLabel: "Antigravity-gemini-web (Demo)",
    modelId: "gemini-3.8-flash-high",
    createdAt: now,
    updatedAt: now,
  };

  const snapshot: RuntimeSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    runtimeInstanceId,
    revision,
    lastEventSequence,
    observedAt: now,
    mode: "demo",
    runtime: {
      state: "ready",
      version: "0.1.0-fake",
    },
    browser: {
      state: "ready",
    },
    account: {
      state: "signed_in",
      displayLabel: "Demo User (demo@google.internal)",
      checkedAt: now,
    },
    integration: {
      target: "native_ide",
      state: "unverified",
      hostVersion: "1.7.0 (VS Code)",
      checkedAt: now,
    },
    capabilities: { ...baseCapabilities },
    availableModels: [
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash High (Native Placeholder)", availability: "available" },
      { id: "gemini-web-pro", label: "Gemini Web Pro (Target)", availability: "unverified" },
    ],
    selectedModelId: "gemini-3.8-flash-high",
    sessions: [demoSession],
    settings: {
      theme: "system",
      language: "vi",
      diagnosticLevel: "normal",
      revision: 1,
    },
    lastCheck: {
      operationId: "op-check-init",
      at: now,
      checks: [
        { key: "host", status: "passed", summary: "VS Code with google-antigravity 1.7.0 detected." },
        { key: "route", status: "unsupported", summary: "Inference routing via ConnectRPC is unverified." },
        { key: "browser", status: "passed", summary: "Chrome browser automation is functional." },
        { key: "account", status: "passed", summary: "Demo account profile simulated." },
        { key: "model", status: "unsupported", summary: "Custom model picker registration unsupported." },
        { key: "tools", status: "unsupported", summary: "Native tool executor bridge unverified." },
      ],
    },
  };

  switch (scenario) {
    case "first_run":
      snapshot.browser = { state: "closed" };
      snapshot.account = { state: "unknown" };
      snapshot.integration.state = "not_installed";
      snapshot.sessions = [];
      break;

    case "login_required":
      snapshot.browser = { state: "needs_user_action", actionReason: "Manual login required in browser" };
      snapshot.account = { state: "signed_out" };
      break;

    case "native_unverified":
      snapshot.integration.state = "unverified";
      snapshot.integration.error = {
        code: "NATIVE_ROUTE_UNVERIFIED",
        message: "Gate G0 is unresolved. Native ConnectRPC inference route is unverified.",
        retryable: false,
        suggestedAction: "review_integration",
      };
      break;

    case "generating": {
      const activeTurn: TurnSummary = {
        id: "turn-gen-1",
        sessionId: demoSession.id,
        state: "generating",
        phaseLabel: "Generating response tokens from Gemini Web...",
        startedAt: now,
        updatedAt: now,
        canCancel: true,
      };
      demoSession.activeTurn = activeTurn;
      break;
    }

    case "tool_running": {
      const activeTurn: TurnSummary = {
        id: "turn-tool-1",
        sessionId: demoSession.id,
        state: "tool_running",
        phaseLabel: "Executing IDE tool read_file on fixture...",
        startedAt: now,
        updatedAt: now,
        canCancel: true,
      };
      demoSession.activeTurn = activeTurn;
      break;
    }

    case "cancel_pending": {
      const activeTurn: TurnSummary = {
        id: "turn-cancel-1",
        sessionId: demoSession.id,
        state: "cancel_requested",
        phaseLabel: "Cancellation requested; awaiting terminal acknowledgement...",
        startedAt: now,
        updatedAt: now,
        canCancel: false,
      };
      demoSession.activeTurn = activeTurn;
      break;
    }

    case "disconnected":
      snapshot.runtime = {
        state: "failed",
        error: {
          code: "RUNTIME_DISCONNECTED",
          message: "Control connection lost. Last snapshot observed at " + now,
          retryable: true,
          suggestedAction: "run_check",
        },
      };
      break;

    case "config_conflict":
      snapshot.settings.revision = 99; // Stale revision trigger
      break;

    case "outcome_unknown": {
      const activeTurn: TurnSummary = {
        id: "turn-unknown-1",
        sessionId: demoSession.id,
        state: "outcome_unknown",
        phaseLabel: "Operation interrupted; outcome unknown. Manual verification required.",
        startedAt: now,
        updatedAt: now,
        completedAt: now,
        error: {
          code: "OUTCOME_UNKNOWN",
          message: "Network glitch occurred during turn execution. State cannot be safely determined.",
          retryable: false,
          suggestedAction: "view_activity",
        },
        canCancel: false,
      };
      demoSession.activeTurn = activeTurn;
      demoSession.lastOutcome = "outcome_unknown";
      break;
    }
  }

  return snapshot;
}

