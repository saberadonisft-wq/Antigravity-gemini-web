import { executeAndWait } from "../client/operations.js";
import React, { useState, useEffect, useRef } from "react";
import type {
  LauncherClient,
  ActivityEntry,
  ActivitySeverity,
} from "@antigravity-gemini-web/contracts";
import { t, errorText } from "../i18n.js";

interface ActivityViewProps {
  client: LauncherClient;
  initialSessionFilter?: string;
  lang?: string;
}

export const ActivityView: React.FC<ActivityViewProps> = ({ client, initialSessionFilter, lang = "vi" }) => {
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [severityFilter, setSeverityFilter] = useState<ActivitySeverity | "all">("all");
  const [sessionFilter, setSessionFilter] = useState<string>(initialSessionFilter ?? "");
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const queryEpoch = useRef(0);

  const loadActivities = async (append = false) => {
    const epoch = ++queryEpoch.current;
    setIsLoading(true);
    setLoadError(null);
    try {
      const page = await client.getActivity({
        severity: severityFilter === "all" ? undefined : severityFilter,
        sessionId: sessionFilter.trim() ? sessionFilter.trim() : undefined,
        limit: 50,
        cursor: append ? nextCursor : undefined,
      });
      if (epoch !== queryEpoch.current) return;
      setActivities(previous => append ? [...previous, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } catch (err: any) {
      if (epoch === queryEpoch.current) setLoadError(errorText(lang, err));
    } finally {
      if (epoch === queryEpoch.current) setIsLoading(false);
    }
  };

  useEffect(() => {
    loadActivities();
    return () => { queryEpoch.current++; };
  }, [severityFilter, sessionFilter, client]);

  useEffect(() => { setSessionFilter(initialSessionFilter ?? ""); }, [initialSessionFilter]);

  const handleCopyCorrelationId = (id: string) => {
    navigator.clipboard.writeText(id).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }).catch(() => setExportMessage({ type: "error", text: t(lang, "copyCorrelationFailed") }));
  };

  const handleExport = async () => {
    setIsExporting(true);
    setExportMessage(null);
    try {
      const ack = await executeAndWait(client, {
        requestId: crypto.randomUUID(),
        type: "activity.export",
        payload: { range: "last_24h" },
      });
      if (ack.accepted) {
        setExportMessage({
          type: "success",
          text: t(lang, "exportSuccessMsg"),
        });
      } else {
        setExportMessage({
          type: ack.error.code === "CANCELLED" ? "info" : "error",
          text: errorText(lang, ack.error),
        });
      }
    } catch (err: any) {
      setExportMessage({
        type: "error",
        text: errorText(lang, err),
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="activity-view" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>{t(lang, "activityTitle")}</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            {t(lang, "activityDesc")}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => loadActivities()} disabled={isLoading}>
            {isLoading ? t(lang, "reloadingBtn") : t(lang, "reloadBtn")}
          </button>
          <button className="primary" onClick={handleExport} disabled={isExporting}>
            {isExporting ? t(lang, "exportingBtn") : t(lang, "exportBtn")}
          </button>
        </div>
      </div>

      {loadError && <div role="alert" className="alert danger">{loadError}</div>}

      {exportMessage && (
        <div
          className={`alert ${exportMessage.type}`}
          style={{
            padding: "10px 14px",
            borderRadius: "var(--radius-md)",
            background: exportMessage.type === "error" ? "var(--danger-bg)" : exportMessage.type === "success" ? "var(--success-bg)" : "var(--info-bg)",
            color: exportMessage.type === "error" ? "var(--danger-fg)" : exportMessage.type === "success" ? "var(--success-fg)" : "var(--info-fg)",
            border: `1px solid ${exportMessage.type === "error" ? "var(--danger-border)" : exportMessage.type === "success" ? "var(--success-border)" : "var(--info-border)"}`,
            fontSize: 13,
          }}
        >
          {exportMessage.text}
        </div>
      )}

      {/* Filters */}
      <div className="card" style={{ display: "flex", flexDirection: "row", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label htmlFor="activity-severity" style={{ fontSize: 13, fontWeight: 500 }}>{t(lang, "filterSeverity")}</label>
          <select
            id="activity-severity"
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value as any)}
          >
            <option value="all">{t(lang, "severityAll")}</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label htmlFor="activity-session" style={{ fontSize: 13, fontWeight: 500 }}>{t(lang, "filterSession")}</label>
          <input
            id="activity-session"
            type="text"
            placeholder={t(lang, "sessionFilterPlaceholder")}
            value={sessionFilter}
            onChange={(e) => setSessionFilter(e.target.value)}
            style={{ width: 180 }}
          />
        </div>
      </div>

      {/* Activity Log Table */}
      <div className="card">
        {isLoading && activities.length === 0 ? <div role="status">{t(lang, "loadingActivities")}</div> : !loadError && activities.length === 0 ? (
          <div style={{ textAlign: "center", padding: "30px", color: "var(--text-muted)" }}>
            {t(lang, "noActivitiesEmpty")}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 150 }}>{t(lang, "colTime")}</th>
                <th style={{ width: 90 }}>{t(lang, "colSeverity")}</th>
                <th style={{ width: 120 }}>{t(lang, "colCategory")}</th>
                <th>{t(lang, "colEventContent")}</th>
                <th style={{ width: 150 }}>{t(lang, "colCorrelationId")}</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((act) => (
                <tr key={act.id}>
                  <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {new Date(act.at).toLocaleTimeString()}
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        act.severity === "error"
                          ? "danger"
                          : act.severity === "warning"
                          ? "warning"
                          : "info"
                      }`}
                    >
                      {act.severity}
                    </span>
                  </td>
                  <td><code>{act.category}</code></td>
                  <td>{act.summary}</td>
                  <td>
                    {act.correlationId ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <code style={{ fontSize: 11 }}>{act.correlationId}</code>
                        <button
                          style={{ padding: "2px 6px", fontSize: 10 }}
                          onClick={() => handleCopyCorrelationId(act.correlationId!)}
                          title={t(lang, "copyTitle")}
                        >
                          {copiedId === act.correlationId ? "✓" : t(lang, "copyBtn")}
                        </button>
                      </div>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {nextCursor && <button disabled={isLoading} onClick={() => loadActivities(true)}>{t(lang, "loadMoreBtn")}</button>}
    </div>
  );
};
