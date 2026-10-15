import React, { useState } from "react";
import type { LauncherClient, RuntimeSnapshot } from "@antigravity-gemini-web/contracts";
import { t } from "../i18n.js";

interface OverviewViewProps {
  client: LauncherClient;
  snapshot: RuntimeSnapshot;
  onRefresh: () => Promise<void>;
  onNavigate: (view: string) => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({ snapshot, onRefresh, onNavigate }) => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const lang = snapshot.settings.language ?? "vi";

  const handleRefreshClick = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case "ready":
      case "signed_in":
      case "passed":
      case "available":
      case "connected":
        return "success";
      case "needs_user_action":
      case "warning":
      case "installing":
      case "running":
        return "warning";
      case "failed":
      case "closed":
      case "stopped":
      case "conflict":
      case "unsupported":
        return "danger";
      default:
        return "info";
    }
  };

  return (
    <div className="overview-view" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>{t(lang, "overviewTitle")}</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            {t(lang, "overviewDesc")}
          </p>
        </div>
        <button onClick={handleRefreshClick} disabled={isRefreshing}>
          {isRefreshing ? t(lang, "refreshingBtn") : t(lang, "refreshBtn")}
        </button>
      </div>

      {/* 4 Status Cards */}
      <div className="grid-cards">
        {/* Card 1: Runtime */}
        <div className="card">
          <div className="card-title">
            <span>{t(lang, "cardRuntime")}</span>
            <span className={`badge ${getStatusBadgeClass(snapshot.runtime.state)}`}>
              {snapshot.runtime.state}
            </span>
          </div>
          <div style={{ fontSize: 13 }}>
            <div><strong>{t(lang, "labelVersion")}</strong> {snapshot.runtime.version ?? "0.1.0"}</div>
            <div><strong>{t(lang, "labelInstanceId")}</strong> {snapshot.runtimeInstanceId}</div>
            <div><strong>{t(lang, "labelMode")}</strong> {snapshot.mode === "demo" ? t(lang, "modeDemo") : t(lang, "modeLive")}</div>
          </div>
        </div>

        {/* Card 2: Native Route */}
        <div className="card">
          <div className="card-title">
            <span>{t(lang, "cardNativeRoute")}</span>
            <span className={`badge ${getStatusBadgeClass(snapshot.integration.state)}`}>
              {snapshot.integration.state}
            </span>
          </div>
          <div style={{ fontSize: 13 }}>
            <div><strong>{t(lang, "labelHostTarget")}</strong> {snapshot.integration.target}</div>
            <div><strong>{t(lang, "labelHostVersion")}</strong> {snapshot.integration.hostVersion ?? t(lang, "unverified")}</div>
            <div><strong>{t(lang, "labelState")}</strong> {snapshot.capabilities.nativeRoute?.state ?? "unverified"}</div>
          </div>
        </div>

        {/* Card 3: Browser & Account */}
        <div className="card">
          <div className="card-title">
            <span>{t(lang, "cardBrowserAccount")}</span>
            <span className={`badge ${getStatusBadgeClass(snapshot.account.state)}`}>
              {snapshot.account.state}
            </span>
          </div>
          <div style={{ fontSize: 13 }}>
            <div><strong>{t(lang, "labelBrowser")}</strong> {snapshot.browser.state}</div>
            <div><strong>{t(lang, "labelAccount")}</strong> {snapshot.account.displayLabel ?? t(lang, "noIdentity")}</div>
            {snapshot.account.state !== "signed_in" && (
              <button
                style={{ marginTop: 8 }}
                onClick={() => onNavigate("onboarding")}
              >
                {t(lang, "openLoginBtn")}
              </button>
            )}
          </div>
        </div>

        {/* Card 4: Model */}
        <div className="card">
          <div className="card-title">
            <span>{t(lang, "cardModel")}</span>
            <span className={`badge ${getStatusBadgeClass(snapshot.capabilities.modelSelection?.state ?? "unverified")}`}>
              {snapshot.capabilities.modelSelection?.state ?? "unverified"}
            </span>
          </div>
          <div style={{ fontSize: 13 }}>
            <div><strong>{t(lang, "labelCurrentModel")}</strong> {snapshot.selectedModelId ?? t(lang, "modelLocked")}</div>
            <div><strong>{t(lang, "labelAvailableModels")}</strong> {snapshot.capabilities.modelSelection?.state === "available" ? `${snapshot.availableModels.length} models` : t(lang, "modelListUnverified")}</div>
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
              {t(lang, "modelLockedNote")}
            </div>
          </div>
        </div>
      </div>

      {/* Capabilities Overview Table */}
      <div className="card">
        <div className="card-title">
          <span>{t(lang, "capabilitiesTitle")}</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {t(lang, "observedAt")} {new Date(snapshot.observedAt).toLocaleTimeString()}
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>{t(lang, "colFeature")}</th>
              <th>{t(lang, "colStatus")}</th>
              <th>{t(lang, "colDetail")}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(snapshot.capabilities).map(([key, cap]) => (
              <tr key={key}>
                <td><code>{key}</code></td>
                <td>
                  <span className={`badge ${getStatusBadgeClass(cap.state)}`}>
                    {cap.state}
                  </span>
                </td>
                <td style={{ color: "var(--text-secondary)" }}>
                  {cap.detail || (cap.state === "available" ? t(lang, "capAvailable") : t(lang, "capUnavailable"))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Diagnostic Checks Breakdown */}
      {snapshot.lastCheck && (
        <div className="card">
          <div className="card-title">
            <span>{t(lang, "lastCheckTitle")}</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {new Date(snapshot.lastCheck.at).toLocaleString()}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>{t(lang, "colItem")}</th>
                <th>{t(lang, "colResult")}</th>
                <th>{t(lang, "colSummaryHeader")}</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.lastCheck.checks.map(check => (
                <tr key={check.key}>
                  <td><strong>{check.key.toUpperCase()}</strong></td>
                  <td>
                    <span className={`badge ${getStatusBadgeClass(check.status)}`}>
                      {check.status}
                    </span>
                  </td>
                  <td>{check.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
