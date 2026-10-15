import React, { useState, useEffect } from "react";
import type { LauncherClient, RuntimeSnapshot, TurnState } from "@antigravity-gemini-web/contracts";
import { t, errorText } from "../i18n.js";
import { executeAndWait } from "../client/operations.js";

interface SessionsViewProps {
  client: LauncherClient;
  snapshot: RuntimeSnapshot;
  onRefresh: () => Promise<void>;
  onNavigateToActivity: (sessionId?: string) => void;
}

export const SessionsView: React.FC<SessionsViewProps> = ({
  client,
  snapshot,
  onRefresh,
  onNavigateToActivity,
}) => {
  const [cancelingTurn, setCancelingTurn] = useState<{ sessionId: string; turnId: string } | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const lang = snapshot.settings.language ?? "vi";

  useEffect(() => {
    if (
      cancelingTurn &&
      snapshot.sessions.every(
        session =>
          session.id !== cancelingTurn.sessionId || !session.activeTurn ||
          session.activeTurn.id !== cancelingTurn.turnId ||
          ["completed", "cancelled", "cancel_confirmed", "failed", "interrupted", "outcome_unknown"].includes(session.activeTurn.state)
      )
    ) {
      setCancelingTurn(null);
    }
  }, [snapshot.sessions, cancelingTurn]);

  const handleCancelClick = async (sessionId: string, turnId: string) => {
    setCancelingTurn({ sessionId, turnId });
    setCancelError(null);
    try {
      const ack = await executeAndWait(client, {
        requestId: crypto.randomUUID(),
        type: "turn.cancel",
        payload: { sessionId, turnId },
      });
      if (!ack.accepted) {
        setCancelError(errorText(lang, ack.error));
        setCancelingTurn(null);
      } else {
        // Acknowledged by runtime: wait for terminal event/snapshot update
        await onRefresh();
      }
    } catch (err: any) {
      setCancelError(errorText(lang, err));
      setCancelingTurn(null);
    }
  };

  const getTurnBadgeClass = (state: TurnState) => {
    switch (state) {
      case "completed":
        return "success";
      case "generating":
      case "streaming":
      case "tool_running":
      case "tool_pending":
      case "submitting":
      case "accepted":
        return "info";
      case "cancel_requested":
      case "awaiting_user":
      case "reserved":
      case "preparing":
        return "warning";
      case "cancelled":
      case "cancel_confirmed":
      case "failed":
      case "interrupted":
      case "outcome_unknown":
        return "danger";
      default:
        return "info";
    }
  };

  const sessions = snapshot.sessions;

  return (
    <div className="sessions-view" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 600 }}>{t(lang, "sessionsTitle")}</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          {t(lang, "sessionsDesc")}
        </p>
      </div>

      {cancelError && (
        <div
          className="alert danger"
          style={{
            padding: "10px 14px",
            borderRadius: "var(--radius-md)",
            background: "var(--danger-bg)",
            color: "var(--danger-fg)",
            border: "1px solid var(--danger-border)",
            fontSize: 13,
          }}
        >
          {cancelError}
        </div>
      )}

      {sessions.length === 0 ? (
        <div
          className="card"
          style={{ textAlign: "center", padding: "40px 20px", color: "var(--text-secondary)" }}
        >
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{t(lang, "sessionsEmptyTitle")}</div>
          <p style={{ fontSize: 13 }}>
            {t(lang, "sessionsEmptyDesc")}
          </p>
        </div>
      ) : (
        sessions.map(session => {
          const active = session.activeTurn;
          const isOutcomeUnknown = active?.state === "outcome_unknown" || session.lastOutcome === "outcome_unknown";
          const isCanceling = (cancelingTurn?.sessionId === session.id && cancelingTurn?.turnId === active?.id) || active?.state === "cancel_requested";

          return (
            <div key={session.id} className="card">
              <div className="card-title">
                <span>
                  <strong>{t(lang, "labelWorkspace")}</strong> {session.workspaceLabel}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  ID: {session.id}
                </span>
              </div>

              <div style={{ fontSize: 13, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
                <div><strong>{t(lang, "labelHostTaskId")}</strong> {session.hostTaskId ?? "None"}</div>
                <div><strong>{t(lang, "labelModel")}</strong> {session.modelId ?? t(lang, "unverified")}</div>
                <div><strong>{t(lang, "labelCreated")}</strong> {new Date(session.createdAt).toLocaleTimeString()}</div>
                <div><strong>{t(lang, "labelUpdated")}</strong> {new Date(session.updatedAt).toLocaleTimeString()}</div>
              </div>

              {/* Active Turn Details */}
              {active ? (
                <div
                  style={{
                    background: "var(--bg-tertiary)",
                    borderRadius: "var(--radius-md)",
                    padding: "12px 14px",
                    marginTop: 8,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{t(lang, "labelTurn")}{active.id}</span>
                      <span className={`badge ${getTurnBadgeClass(active.state)}`}>
                        {active.state}
                      </span>
                    </div>

                    {active.canCancel && !isCanceling && (
                      <button
                        className="danger"
                        style={{ fontSize: 12, padding: "4px 8px" }}
                        onClick={() => handleCancelClick(session.id, active.id)}
                      >
                        {t(lang, "cancelTurnBtn")}
                      </button>
                    )}

                    {isCanceling && (
                      <span style={{ fontSize: 12, color: "var(--warning-fg)", fontWeight: 500 }}>
                        {t(lang, "cancelingTurn")}
                      </span>
                    )}
                  </div>

                  {active.phaseLabel && (
                    <div style={{ fontSize: 13, color: "var(--text-primary)" }}>
                      {active.phaseLabel}
                    </div>
                  )}

                  {active.error && (
                    <div style={{ color: "var(--danger-fg)", fontSize: 12, marginTop: 4 }}>
                      <strong>{t(lang, "labelError")}</strong> {errorText(lang, active.error)} ({active.error.code})
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
                  {t(lang, "lastOutcomeLabel")} <strong>{session.lastOutcome ?? "none"}</strong>
                </div>
              )}

              {/* Outcome Unknown Banner */}
              {isOutcomeUnknown && (
                <div
                  style={{
                    background: "var(--danger-bg)",
                    border: "1px solid var(--danger-border)",
                    color: "var(--danger-fg)",
                    padding: "10px 14px",
                    borderRadius: "var(--radius-md)",
                    fontSize: 13,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: 8,
                  }}
                >
                  <div>
                    {t(lang, "outcomeUnknownWarning")}
                  </div>
                  <button
                    onClick={() => onNavigateToActivity(session.id)}
                    style={{ whiteSpace: "nowrap", marginLeft: 12 }}
                  >
                    {t(lang, "viewActivityBtn")}
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
};
