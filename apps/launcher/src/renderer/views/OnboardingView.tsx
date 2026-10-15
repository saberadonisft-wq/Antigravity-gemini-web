import { executeAndWait } from "../client/operations.js";
import React, { useState } from "react";
import type { LauncherClient, RuntimeSnapshot } from "@antigravity-gemini-web/contracts";
import { t, errorText } from "../i18n.js";

interface OnboardingViewProps {
  client: LauncherClient;
  snapshot: RuntimeSnapshot;
  onRefresh: () => Promise<void>;
}

export const OnboardingView: React.FC<OnboardingViewProps> = ({ client, snapshot, onRefresh }) => {
  const [isOpeningBrowser, setIsOpeningBrowser] = useState(false);
  const [isRunningCheck, setIsRunningCheck] = useState(false);
  const [isRunningE2E, setIsRunningE2E] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: "info" | "error" | "success"; text: string } | null>(null);

  const lang = snapshot.settings.language ?? "vi";

  const handleOpenBrowser = async () => {
    setIsOpeningBrowser(true);
    setActionMessage(null);
    try {
      const ack = await executeAndWait(client, {
        requestId: crypto.randomUUID(),
        type: "browser.open",
        payload: {},
      });
      if (ack.accepted) {
        setActionMessage({
          type: "info",
          text: t(lang, "browserOpenedMsg"),
        });
      } else {
        setActionMessage({
          type: "error",
          text: `${t(lang, "browserOpenFailedMsg")}${errorText(lang, ack.error)}`,
        });
      }
      await onRefresh();
    } catch (err: any) {
      setActionMessage({ type: "error", text: errorText(lang, err) });
    } finally {
      setIsOpeningBrowser(false);
    }
  };

  const handleRunConnectionCheck = async () => {
    setIsRunningCheck(true);
    setActionMessage(null);
    try {
      const ack = await executeAndWait(client, {
        requestId: crypto.randomUUID(),
        type: "runtime.check",
        payload: { scope: "connection" },
      });
      if (ack.accepted) {
        setActionMessage({
          type: "success",
          text: t(lang, "checkConnSuccessMsg"),
        });
      } else {
        setActionMessage({
          type: "error",
          text: `${t(lang, "checkConnFailedMsg")}${errorText(lang, ack.error)}`,
        });
      }
      await onRefresh();
    } catch (err: any) {
      setActionMessage({ type: "error", text: errorText(lang, err) });
    } finally {
      setIsRunningCheck(false);
    }
  };

  const handleRunE2ECheck = async () => {
    setIsRunningE2E(true);
    setActionMessage(null);
    try {
      const ack = await executeAndWait(client, {
        requestId: crypto.randomUUID(),
        type: "runtime.check",
        payload: { scope: "end_to_end" },
      });
      if (ack.accepted) {
        setActionMessage({ type: "success", text: t(lang, "e2eSuccessMsg") });
      } else {
        setActionMessage({
          type: "error",
          text: `${t(lang, "e2eFailedMsg")}${errorText(lang, ack.error)}`,
        });
      }
      await onRefresh();
    } catch (err: any) {
      setActionMessage({
        type: "error",
        text: err.message || t(lang, "e2eRejectedMsg"),
      });
    } finally {
      setIsRunningE2E(false);
    }
  };

  const hostStatus = snapshot.lastCheck?.checks.find(c => c.key === "host");
  const isRouteVerified = snapshot.capabilities.nativeRoute?.state === "available";

  return (
    <div className="onboarding-view" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>{t(lang, "onboardingTitle")}</h2>
        <p style={{ color: "var(--text-secondary)" }}>
          {t(lang, "onboardingDesc")}
        </p>
      </div>

      {actionMessage && (
        <div
          className={`alert ${actionMessage.type}`}
          style={{
            padding: "10px 14px",
            borderRadius: "var(--radius-md)",
            background: actionMessage.type === "error" ? "var(--danger-bg)" : actionMessage.type === "success" ? "var(--success-bg)" : "var(--info-bg)",
            color: actionMessage.type === "error" ? "var(--danger-fg)" : actionMessage.type === "success" ? "var(--success-fg)" : "var(--info-fg)",
            border: `1px solid ${actionMessage.type === "error" ? "var(--danger-border)" : actionMessage.type === "success" ? "var(--success-border)" : "var(--info-border)"}`,
            fontSize: 13,
          }}
        >
          {actionMessage.text}
        </div>
      )}

      {/* Step 1 */}
      <div className="card">
        <div className="card-title">
          <span>{t(lang, "step1Title")}</span>
          <span className={`badge ${hostStatus?.status === "passed" ? "success" : "warning"}`}>
            {hostStatus?.status === "passed" ? t(lang, "step1Passed") : t(lang, "unverified")}
          </span>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          {t(lang, "step1Desc")}
        </p>
        <div style={{ background: "var(--bg-tertiary)", padding: "10px 12px", borderRadius: "var(--radius-sm)", fontSize: 13 }}>
          <strong>{t(lang, "labelHostVersion")}</strong> {snapshot.integration.hostVersion ?? t(lang, "step1Unmeasured")} <br />
          <strong>{t(lang, "step1Target")}</strong> {snapshot.integration.target} ({snapshot.integration.state})
        </div>
      </div>

      {/* Step 2 */}
      <div className="card">
        <div className="card-title">
          <span>{t(lang, "step2Title")}</span>
          <span className={`badge ${snapshot.account.state === "signed_in" ? "success" : snapshot.account.state === "needs_user_action" ? "warning" : "info"}`}>
            {snapshot.account.state === "signed_in" ? t(lang, "step2SignedIn") : snapshot.account.state === "needs_user_action" ? t(lang, "step2ActionRequired") : t(lang, "step2NotSignedIn")}
          </span>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          {t(lang, "step2Desc")}
        </p>
        {snapshot.browser.actionReason && (
          <div style={{ background: "var(--warning-bg)", color: "var(--warning-fg)", padding: "8px 12px", borderRadius: "var(--radius-sm)", fontSize: 12 }}>
            {snapshot.browser.actionReason}
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <button className="primary" onClick={handleOpenBrowser} disabled={isOpeningBrowser}>
            {isOpeningBrowser ? t(lang, "step2OpeningBtn") : t(lang, "step2OpenBtn")}
          </button>
        </div>
      </div>

      {/* Step 3 */}
      <div className="card">
        <div className="card-title">
          <span>{t(lang, "step3Title")}</span>
          <span className={`badge ${isRouteVerified ? "success" : "warning"}`}>
            {isRouteVerified ? t(lang, "step3Passed") : t(lang, "unverified")}
          </span>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          {t(lang, "step3Desc")}
        </p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 4 }}>
          <button onClick={handleRunConnectionCheck} disabled={isRunningCheck}>
            {isRunningCheck ? t(lang, "step3CheckingQuick") : t(lang, "step3QuickBtn")}
          </button>
          <button data-action="native-e2e" onClick={handleRunE2ECheck} disabled={isRunningE2E || !isRouteVerified}>
            {isRunningE2E ? t(lang, "step3CheckingE2E") : t(lang, "step3E2EBtn")}
          </button>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t(lang, "step3LockedNote")}
        </div>
      </div>
    </div>
  );
};
