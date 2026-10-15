import type { IntegrationState, CapabilityValue, UiError } from "@antigravity-gemini-web/contracts";

export interface NativeAntigravityStatus {
  target: "native_ide";
  state: IntegrationState;
  hostVersion?: string;
  hostDetected?: boolean;
  checkedAt: string;
  capability: CapabilityValue;
  error?: UiError;
}

export interface BridgePreviewResult {
  previewId: string;
  action: "install" | "disconnect" | "restore";
  summary: string;
  requiresConfirmation: boolean;
  canApply: boolean;
  unverifiedReason?: string;
}

export interface NativeAntigravityAdapter {
  checkStatus(): Promise<NativeAntigravityStatus>;
  previewBridge(action: "install" | "disconnect" | "restore"): Promise<BridgePreviewResult>;
  applyBridge(previewId: string): Promise<never>;
}

export class LiveNativeAntigravityAdapter implements NativeAntigravityAdapter {
  async checkStatus(): Promise<NativeAntigravityStatus> {
    return {
      target: "native_ide",
      state: "unverified",
      checkedAt: new Date().toISOString(),
      capability: {
        state: "unverified",
        reasonCode: "NATIVE_ROUTE_UNVERIFIED",
        detail: "Host detection is not configured; native inference route remains unverified.",
      },
    };
  }

  async previewBridge(action: "install" | "disconnect" | "restore"): Promise<BridgePreviewResult> {
    return {
      previewId: `prev-${Date.now()}`,
      action,
      summary: `Action '${action}' planned. Gate G0 is unresolved; native route cannot be verified.`,
      requiresConfirmation: true,
      canApply: false,
      unverifiedReason: "NATIVE_ROUTE_UNVERIFIED: Inference route must be proven before applying changes.",
    };
  }

  async applyBridge(previewId: string): Promise<never> {
    const error: UiError = {
      code: "NATIVE_ROUTE_UNVERIFIED",
      message: `Cannot apply bridge preview '${previewId}': Native integration route is unverified and G0 native gate is unresolved.`,
      retryable: false,
      suggestedAction: "review_integration",
      correlationId: `err-apply-${Date.now()}`,
    };
    throw error;
  }
}

