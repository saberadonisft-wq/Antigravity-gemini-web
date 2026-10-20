import React, { useEffect, useState } from "react";
import type { DesktopClient } from "./desktop-client.js";
import { NativeAccountStore, type NativeAccountViewState } from "./client/native-account-store.js";
import { NativeAccountsView } from "./views/NativeAccountsView.js";
import { SessionsView } from "./views/SessionsView.js";
import { OverviewView } from "./views/OverviewView.js";
import { IconLogo, IconAccounts, IconChats, IconConnections } from "./components/Icons.js";
import "./styles/theme.css";
type View = "accounts" | "chats" | "connections";
export const App: React.FC<{ clientOverride?: DesktopClient }> = ({ clientOverride }) => {
  const [tab, setTab] = useState<View>("accounts");
  const [lang, setLang] = useState<"vi" | "en">(() => { try { return localStorage.getItem("launcher-language") === "en" ? "en" : "vi"; } catch { return "vi"; } });
  const [state, setState] = useState<NativeAccountViewState>({ fresh: false, loading: true });
  const client = clientOverride ?? window.launcherClient;
  const [store,setStore] = useState(() => new NativeAccountStore(client ?? {}));
  useEffect(() => { const active=new NativeAccountStore(client ?? {});setStore(active);const off=active.listen(setState);active.start();return ()=>{off();active.dispose();}; }, [client]);
  useEffect(() => { document.documentElement.dataset.theme = "light"; document.documentElement.lang = lang; try { localStorage.setItem("launcher-language", lang); } catch {} }, [lang]);
  const names = lang === "vi" ? ["Tài khoản", "Đoạn chat", "Kết nối"] : ["Accounts", "Chats", "Connections"];
  return <div className="app-container"><aside className="app-sidebar">
    <div className="sidebar-header"><IconLogo size={28} /><div className="sidebar-brand-text"><span className="sidebar-brand-title">Antigravity · Gemini</span><span className="sidebar-brand-version">Chrome Profile Connector</span></div></div>
    <nav aria-label={lang === "vi" ? "Màn hình" : "Views"}>{(["accounts", "chats", "connections"] as const).map((id,index)=>{const Icon=[IconAccounts,IconChats,IconConnections][index];return <button key={id} data-view={id} data-native-nav={id === "accounts" ? "" : undefined} className={`nav-link ${tab===id?"active":""}`} aria-current={tab===id?"page":undefined} onClick={()=>setTab(id)}><Icon size={18}/>{names[index]}</button>;})}</nav>
    <div className="sidebar-status-card" style={{marginTop:"auto"}}><p>{state.fresh?(lang==="vi"?"Native owner đang chạy":"Native owner online"):(lang==="vi"?"Chưa có trạng thái mới":"No fresh owner status")}</p><label>{lang==="vi"?"Ngôn ngữ":"Language"}<select aria-label="Language" value={lang} onChange={event=>setLang(event.target.value as "vi"|"en")}><option value="vi">Tiếng Việt</option><option value="en">English</option></select></label></div>
  </aside><main className="app-content">
    {!state.fresh&&!state.loading&&<div role="alert" className="alert warning">{lang==="vi"?"Chưa kết nối được runtime. Chọn Tệp → Khởi động kết nối trong bản tải về, rồi thử lại. Nếu chạy mã nguồn, dùng npm run native:launch.":"Runtime unavailable. In the downloaded app, choose File → Start connection, then retry. For source builds, run npm run native:launch."}<button onClick={()=>void store.refresh()}>{lang==="vi"?"Thử lại":"Retry"}</button></div>}
    {tab==="accounts"&&<NativeAccountsView store={store} view={state} lang={lang}/>}
    {tab==="chats"&&<SessionsView store={store} view={state} lang={lang}/>}
    {tab==="connections"&&<OverviewView store={store} view={state} lang={lang} onAccounts={()=>setTab("accounts")}/>}
  </main></div>;
};
