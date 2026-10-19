import React, { useState, useEffect, useRef } from "react";
import { LauncherStore } from "./client/launcher-store.js";
import { safeUiError } from "@antigravity-gemini-web/contracts";
import type {
  LauncherClient,
  RuntimeSnapshot,
  RuntimeEvent,
  UiError,
} from "@antigravity-gemini-web/contracts";
import { isPreloadAvailable, getPreloadClient } from "./client/preload-client.js";
import { MockLauncherClient, MOCK_SCENARIOS, getMockScenarioLabel, type MockScenarioId } from "./client/mock-client.js";
import { OverviewView } from "./views/OverviewView.js";
import { OnboardingView } from "./views/OnboardingView.js";
import { SessionsView } from "./views/SessionsView.js";
import { ActivityView } from "./views/ActivityView.js";
import { SettingsView } from "./views/SettingsView.js";
import { NativeAccountsView } from "./views/NativeAccountsView.js";
import { NativeKnowledgeView } from "./views/NativeKnowledgeView.js";
import { NativeChatImportView } from "./views/NativeChatImportView.js";
import { t, errorText } from "./i18n.js";
import "./styles/theme.css";

type ViewId = "overview" | "onboarding" | "sessions" | "activity" | "settings" | "native_accounts" | "native_knowledge" | "native_imports";

export const App: React.FC<{ clientOverride?: LauncherClient }> = ({ clientOverride }) => {
  const [client, setClient] = useState<LauncherClient | null>(null);
  const [mockClient, setMockClient] = useState<MockLauncherClient | null>(null);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [currentView, setCurrentView] = useState<ViewId>("overview");
  const [activitySessionFilter, setActivitySessionFilter] = useState<string | undefined>(undefined);
  const [initError, setInitError] = useState<UiError | null>(null);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [lastDisconnectedAt, setLastDisconnectedAt] = useState<string | null>(null);

  const storeRef = useRef<LauncherStore | null>(null);

  useEffect(() => {
    if (clientOverride) {
      setClient(clientOverride);
      if (clientOverride instanceof MockLauncherClient) setMockClient(clientOverride);
      return;
    }
    // Determine whether to run in Live or Demo mode
    const params = new URLSearchParams(window.location.search);
    const forceDemo = params.get("mode") === "demo";

    if (!forceDemo) {
      try {
        const liveClient = getPreloadClient();
        setClient(liveClient);
      } catch (err: any) {
        setInitError(safeUiError(err));
      }
    } else {
      // In standalone browser or demo query param: use MockLauncherClient
      const mock = new MockLauncherClient("first_run");
      setMockClient(mock);
      setClient(mock);
    }
  }, [clientOverride]);

  const refreshSnapshot = async (_targetClient = client) => { await storeRef.current?.refresh(); };

  useEffect(() => {
    if (!client) return;
    const store = new LauncherStore(client);
    storeRef.current = store;
    const stopListening = store.listen(state => {
      setSnapshot(state.snapshot);
      setIsDisconnected(state.disconnected);
      setLastDisconnectedAt(state.disconnectedAt ? new Date(state.disconnectedAt).toLocaleTimeString() : null);
      setInitError(state.snapshot ? null : state.error);
    });
    store.start().catch(error => setInitError(safeUiError(error)));
    return () => { stopListening(); store.dispose(); if (storeRef.current === store) storeRef.current = null; };
  }, [client]);

  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.settings.theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", snapshot.settings.theme);
    document.documentElement.lang = snapshot.settings.language === "en" ? "en" : "vi";
  }, [snapshot?.settings.theme, snapshot?.settings.language]);

  const handleThemeChange = (_newTheme: "system" | "light" | "dark") => {
    // Authoritative snapshot listener manages theme application
  };

  const handleScenarioChange = (scenarioId: MockScenarioId) => {
    if (mockClient) {
      mockClient.setScenario(scenarioId);
      refreshSnapshot(mockClient);
    }
  };

  const navigateToActivity = (sessionId?: string) => {
    setActivitySessionFilter(sessionId);
    setCurrentView("activity");
  };

  const lang = snapshot?.settings.language ?? "vi";

  if (initError) {
    return (
      <div style={{ padding: 40, maxWidth: 600, margin: "100px auto" }} className="card">
        <h2 style={{ color: "var(--danger-fg)" }}>{t(lang, "startupFailed")}</h2>
        <p style={{ marginTop: 8 }}>{errorText(lang, initError)}</p>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
          {t(lang, "errorCode")} <code>{initError.code}</code>
        </p>
      </div>
    );
  }

  if (!client || !snapshot) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
        <div style={{ color: "var(--text-secondary)", fontSize: 16 }}>{t(lang, "connectingRuntime")}</div>
      </div>
    );
  }

  const isDemo = snapshot.mode === "demo";

  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <aside className="app-sidebar">
        <div>
          <h1 style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em" }}>
            Antigravity · Gemini
          </h1>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
            Desktop Launcher v0.1.0
          </div>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <button
            className={`nav-link ${currentView === "overview" ? "active" : ""}`}
            onClick={() => setCurrentView("overview")}
          >
            {t(lang, "navOverview")}
          </button>
          <button
            className={`nav-link ${currentView === "onboarding" ? "active" : ""}`}
            onClick={() => setCurrentView("onboarding")}
          >
            {t(lang, "navOnboarding")}
          </button>
          <button
            className={`nav-link ${currentView === "sessions" ? "active" : ""}`}
            onClick={() => setCurrentView("sessions")}
          >
            {t(lang, "navSessions")}
          </button>
          <button
            className={`nav-link ${currentView === "activity" ? "active" : ""}`}
            onClick={() => {
              setActivitySessionFilter(undefined);
              setCurrentView("activity");
            }}
          >
            {t(lang, "navActivity")}
          </button>
          <button
            className={`nav-link ${currentView === "settings" ? "active" : ""}`}
            onClick={() => setCurrentView("settings")}
          >
            {t(lang, "navSettings")}
          </button>
          <button className={`nav-link ${currentView==="native_accounts"?"active":""}`} data-native-nav aria-current={currentView==="native_accounts"?"page":undefined} onClick={()=>setCurrentView("native_accounts")}>{lang==="vi"?"Tài khoản Web":"Web accounts"}</button>
          <button className={`nav-link ${currentView==="native_knowledge"?"active":""}`} data-knowledge-nav aria-current={currentView==="native_knowledge"?"page":undefined} onClick={()=>setCurrentView("native_knowledge")}>{lang==="vi"?"Nguồn dự án":"Project references"}</button>
          <button className={`nav-link ${currentView==="native_imports"?"active":""}`} data-imports-nav aria-current={currentView==="native_imports"?"page":undefined} onClick={()=>setCurrentView("native_imports")}>{lang==="vi"?"Nhập lịch sử":"History import"}</button>
        </nav>

        <div style={{ marginTop: "auto", borderTop: "1px solid var(--border-color)", paddingTop: 14 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {t(lang, "runtimeLabel")} <strong>{snapshot.runtime.state}</strong> <br />
            {t(lang, "routeLabel")} <strong>{snapshot.integration.state}</strong>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="app-content">
        {/* Permanent Demo Banner */}
        {isDemo && (
          <div className="demo-banner">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>{t(lang, "demoBannerTitle")}</span>
              <span style={{ fontWeight: 400 }}>{t(lang, "demoBannerSubtitle")}</span>
            </div>
            {mockClient && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <label htmlFor="demo-scenario" style={{ fontSize: 11 }}>{t(lang, "scenarioLabel")}</label>
                <select
                  id="demo-scenario"
                  style={{ fontSize: 12, padding: "2px 6px" }}
                  value={mockClient.currentScenario}
                  onChange={(e) => handleScenarioChange(e.target.value as MockScenarioId)}
                >
                  {MOCK_SCENARIOS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {getMockScenarioLabel(s, lang)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {/* Runtime Disconnected Alert Banner */}
        {isDisconnected && (
          <div className="disconnect-banner">
            <div>
              <strong>{t(lang, "disconnectedTitle")}</strong>
              {lastDisconnectedAt && `${t(lang, "disconnectedLastSeen")}${lastDisconnectedAt}`}
            </div>
            <button onClick={() => refreshSnapshot()}>{t(lang, "reconnectBtn")}</button>
          </div>
        )}

        {/* View Router */}
        <fieldset disabled={isDisconnected&&currentView!=="native_accounts"&&currentView!=="native_knowledge"&&currentView!=="native_imports"} className="view-controls">
        {currentView==="native_imports"&&<NativeChatImportView client={client} lang={lang}/>}
        {currentView==="native_knowledge"&&<NativeKnowledgeView client={client} lang={lang}/>}
        {currentView==="native_accounts"&&<NativeAccountsView client={client} lang={lang}/>}
        {currentView === "overview" && (
          <OverviewView
            client={client}
            snapshot={snapshot}
            onRefresh={() => refreshSnapshot()}
            onNavigate={(view) => setCurrentView(view as ViewId)}
          />
        )}

        {currentView === "onboarding" && (
          <OnboardingView
            client={client}
            snapshot={snapshot}
            onRefresh={() => refreshSnapshot()}
          />
        )}

        {currentView === "sessions" && (
          <SessionsView
            client={client}
            snapshot={snapshot}
            onRefresh={() => refreshSnapshot()}
            onNavigateToActivity={navigateToActivity}
          />
        )}

        {currentView === "activity" && (
          <ActivityView
            client={client}
            initialSessionFilter={activitySessionFilter}
            lang={lang}
          />
        )}

        {currentView === "settings" && (
          <SettingsView
            client={client}
            snapshot={snapshot}
            onRefresh={() => refreshSnapshot()}
            onThemeChange={handleThemeChange}
          />
        )}
        </fieldset>
      </main>
    </div>
  );
};
