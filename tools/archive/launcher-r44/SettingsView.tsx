import { executeAndWait } from "../client/operations.js";
import React, { useState, useEffect, useRef } from "react";
import type { LauncherClient, RuntimeSnapshot, SettingsPatch } from "@antigravity-gemini-web/contracts";
import { t, errorText } from "../i18n.js";

interface SettingsViewProps {
  client: LauncherClient;
  snapshot: RuntimeSnapshot;
  onRefresh: () => Promise<void>;
  onThemeChange: (theme: "system" | "light" | "dark") => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  client,
  snapshot,
  onRefresh,
}) => {
  const currentSettings = snapshot.settings;
  const lang = currentSettings.language ?? "vi";

  const [theme, setTheme] = useState(currentSettings.theme);
  const [language, setLanguage] = useState(currentSettings.language);
  const [diagnosticLevel, setDiagnosticLevel] = useState(currentSettings.diagnosticLevel);
  const [isSaving, setIsSaving] = useState(false);
  const dirty = useRef(false);
  const baseRevision = useRef(currentSettings.revision);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // A newer snapshot must not silently replace a user's unsaved draft.
  useEffect(() => {
    if (dirty.current || isSaving) return;
    setTheme(currentSettings.theme);
    setLanguage(currentSettings.language);
    setDiagnosticLevel(currentSettings.diagnosticLevel);
    baseRevision.current = currentSettings.revision;
  }, [currentSettings.revision, isSaving]);

  const discardDraft = () => {
    dirty.current = false;
    baseRevision.current = currentSettings.revision;
    setTheme(currentSettings.theme);
    setLanguage(currentSettings.language);
    setDiagnosticLevel(currentSettings.diagnosticLevel);
    setMessage(null);
  };

  const handleSaveSettings = async () => {
    setIsSaving(true);
    setMessage(null);
    try {
      const patch: SettingsPatch = {
        theme,
        language,
        diagnosticLevel,
      };

      const ack = await executeAndWait(client, {
        requestId: crypto.randomUUID(),
        type: "settings.update",
        payload: {
          expectedRevision: baseRevision.current,
          patch,
        },
      });

      if (ack.accepted) {
        dirty.current = false;
        setMessage({ type: "success", text: t(language ?? lang, "saveSuccessMsg") });
        await onRefresh();
      } else {
        setMessage({
          type: "error",
          text: `${t(lang, "saveFailedMsg")}${errorText(lang, ack.error)}`,
        });
      }
    } catch (err: any) {
      // Draft preserves user input on error/conflict
      setMessage({ type: "error", text: errorText(lang, err) });
    } finally {
      setIsSaving(false);
    }
  };

  const isModelSelectAvailable = snapshot.capabilities.modelSelection?.state === "available";

  return (
    <div className="settings-view" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 600 }}>{t(lang, "settingsTitle")}</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          {t(lang, "settingsDesc")}
        </p>
      </div>

      {message && (
        <div
          className={`alert ${message.type}`}
          style={{
            padding: "10px 14px",
            borderRadius: "var(--radius-md)",
            background: message.type === "error" ? "var(--danger-bg)" : "var(--success-bg)",
            color: message.type === "error" ? "var(--danger-fg)" : "var(--success-fg)",
            border: `1px solid ${message.type === "error" ? "var(--danger-border)" : "var(--success-border)"}`,
            fontSize: 13,
          }}
        >
          {message.text}
        </div>
      )}

      {/* Preferences Card */}
      <div className="card">
        <div className="card-title">
          <span>{t(lang, "cardPreferences")}</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Revision: {currentSettings.revision}
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 14, alignItems: "center" }}>
          <label htmlFor="settings-theme" style={{ fontWeight: 500 }}>{t(lang, "labelTheme")}</label>
          <select id="settings-theme" disabled={isSaving} value={theme} onChange={(e) => { dirty.current = true; setTheme(e.target.value as any); }}>
            <option value="system">{t(lang, "themeSystem")}</option>
            <option value="light">{t(lang, "themeLight")}</option>
            <option value="dark">{t(lang, "themeDark")}</option>
          </select>

          <label htmlFor="settings-language" style={{ fontWeight: 500 }}>{t(lang, "labelLanguage")}</label>
          <select id="settings-language" disabled={isSaving} value={language} onChange={(e) => { dirty.current = true; setLanguage(e.target.value as any); }}>
            <option value="vi">{t(lang, "langVi")}</option>
            <option value="en">{t(lang, "langEn")}</option>
          </select>

          <label htmlFor="settings-diagnostics" style={{ fontWeight: 500 }}>{t(lang, "labelDiagLevel")}</label>
          <div>
            <select
              id="settings-diagnostics"
              disabled={isSaving}
              value={diagnosticLevel}
              onChange={(e) => { dirty.current = true; setDiagnosticLevel(e.target.value as any); }}
            >
              <option value="normal">{t(lang, "diagNormal")}</option>
              <option value="verbose_redacted">{t(lang, "diagVerboseRedacted")}</option>
            </select>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
              {t(lang, "diagNotice")}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <button data-action="settings-save" className="primary" onClick={handleSaveSettings} disabled={isSaving}>
            {isSaving ? t(lang, "savingBtn") : t(lang, "saveBtn")}
          </button>
          <button data-action="settings-discard" onClick={discardDraft} disabled={isSaving} style={{ marginLeft: 8 }}>{t(lang, "discardDraftBtn")}</button>
        </div>
      </div>

      {/* Model Selection Card (Capability Gated) */}
      <div className="card">
        <div className="card-title">
          <span>{t(lang, "cardModelSelect")}</span>
          <span className={`badge ${isModelSelectAvailable ? "success" : "warning"}`}>
            {isModelSelectAvailable ? t(lang, "badgeAvailable") : t(lang, "badgeLocked")}
          </span>
        </div>

        <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          {t(lang, "modelSelectDesc")}
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 14, alignItems: "center" }}>
          <label htmlFor="settings-model" style={{ fontWeight: 500 }}>{t(lang, "labelDefaultModel")}</label>
          <select
            id="settings-model"
            disabled={!isModelSelectAvailable}
            value={snapshot.selectedModelId ?? ""}
            onChange={() => {}}
          >
            <option value="">{t(lang, "noModelSelected")}</option>
            {snapshot.availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.availability})
              </option>
            ))}
          </select>
        </div>

        {!isModelSelectAvailable && (
          <div
            style={{
              background: "var(--warning-bg)",
              color: "var(--warning-fg)",
              border: "1px solid var(--warning-border)",
              padding: "8px 12px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12,
            }}
          >
            {t(lang, "modelLockReasonPrefix")}{snapshot.capabilities.modelSelection?.detail ?? t(lang, "defaultModelLockReason")}
          </div>
        )}
      </div>

      {/* About & Metadata Card */}
      <div className="card">
        <div className="card-title">
          <span>{t(lang, "cardAbout")}</span>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          <div><strong>{t(lang, "labelAppName")}</strong> {t(lang, "appNameValue")}</div>
          <div><strong>{t(lang, "labelLauncherVersion")}</strong> {t(lang, "launcherVersionValue")}</div>
          <div><strong>{t(lang, "labelContractVersion")}</strong> {snapshot.schemaVersion}</div>
          <div><strong>{t(lang, "labelRuntimeInstance")}</strong> <code>{snapshot.runtimeInstanceId}</code></div>
          <div><strong>{t(lang, "labelLicense")}</strong> {t(lang, "licenseValue")}</div>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}>
            {t(lang, "disclaimerNotice")}
          </div>
        </div>
      </div>
    </div>
  );
};
