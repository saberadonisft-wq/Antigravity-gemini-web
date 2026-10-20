import React, { useEffect, useRef, useState } from "react";
import type { LauncherClient, ChatImportProvider, ChatImportJob } from "@antigravity-gemini-web/contracts";
import { NativeChatImportStore, type NativeChatImportViewState } from "../client/native-chat-import-store.js";

const text = {
  vi: { title: "Chuẩn bị nhập lịch sử", intro: "Chọn tài khoản đích và kiểm tra ZIP xuất từ ChatGPT hoặc Claude. Bước này chưa tải dữ liệu lên Gemini.", refresh: "Đọc trạng thái", account: "Tài khoản đích", provider: "Nền tảng xuất dữ liệu", select: "Chọn ZIP và kiểm tra", picking: "Đang chọn tệp…", local: "Chưa gửi lên Google", loading: "Đang đọc trạng thái Native…", unavailable: "Cần launcher thật và Native phiên bản mới để kiểm tra tệp.", offline: "Chưa có trạng thái mới. Đọc lại trước khi thao tác.", disabled: "Kiểm tra lịch sử chưa được bật trong proxy hiện tại.", busy: "Đợi lượt Native hoặc kiểm tra tệp hiện tại kết thúc.", identity: "Chọn tài khoản đã đăng ký danh tính trong Tài khoản Web.", cancelled: "Đã hủy chọn tệp; không bắt đầu kiểm tra.", error: "Chưa hoàn tất thao tác. Đọc lại trạng thái trước khi thử lại.", cancel: "Hủy kiểm tra", clear: "Bỏ bản kiểm tra cục bộ", empty: "Chưa có archive được kiểm tra cho tài khoản và nền tảng này.", files: "File", folders: "Thư mục", bytes: "Kích thước ZIP", expanded: "Bytes theo danh mục", encrypted: "File mã hóa", changed: "Tệp đã thay đổi hoặc không đọc được. Chọn lại ZIP xuất gốc.", future: "Upload, xác nhận kết quả trên Gemini và nhập memory vẫn cần bước riêng. Kết quả dưới đây chỉ là kiểm tra cục bộ.", states: { checking: "Đang kiểm tra…", cancelling: "Đang hủy…", ready: "Đã kiểm tra cục bộ", cancelled: "Đã hủy kiểm tra", failed: "Không kiểm tra được", stale: "Tài khoản hoặc cấu hình đã đổi; chọn lại tệp", expired: "Bản kiểm tra đã hết hạn; chọn lại tệp" } },
  en: { title: "Prepare chat history import", intro: "Select a destination account and inspect a ChatGPT or Claude export ZIP. This step does not upload data to Gemini.", refresh: "Refresh status", account: "Destination account", provider: "Export provider", select: "Select ZIP and inspect", picking: "Selecting a file…", local: "Not sent to Google", loading: "Reading Native status…", unavailable: "Archive inspection requires the desktop launcher and an updated Native proxy.", offline: "Current status is unavailable. Refresh before making changes.", disabled: "History inspection is not enabled in this proxy.", busy: "Wait for the current Native turn or archive inspection to finish.", identity: "Select an account with a registered identity in Web accounts.", cancelled: "File selection cancelled; no inspection started.", error: "The operation did not complete. Refresh status before trying again.", cancel: "Cancel inspection", clear: "Remove local preview", empty: "No inspected archives for this account and provider.", files: "Files", folders: "Folders", bytes: "ZIP size", expanded: "Directory data bytes", encrypted: "Encrypted files", changed: "The file changed or could not be read. Select the original export ZIP again.", future: "Upload, confirmation in Gemini and memory import need separate steps. Results below are local inspection only.", states: { checking: "Inspecting…", cancelling: "Cancelling…", ready: "Locally inspected", cancelled: "Inspection cancelled", failed: "Inspection failed", stale: "Account or configuration changed; select the file again", expired: "Preview expired; select the file again" } },
};
export function NativeChatImportView({ client, lang }: { client: LauncherClient; lang: "vi" | "en" }) {
  const copy = text[lang], store = useRef<NativeChatImportStore>();
  const [view, setView] = useState<NativeChatImportViewState>({ fresh: false, loading: true });
  const [accountId, setAccountId] = useState(""), [provider, setProvider] = useState<ChatImportProvider>("chatgpt");
  useEffect(() => { const value = new NativeChatImportStore(client); store.current = value; const unsubscribe = value.listen(setView); value.start(); return () => { unsubscribe(); value.dispose(); }; }, [client]);
  useEffect(() => { if (view.accounts && !view.accounts.accounts.some(account => account.accountId === accountId)) setAccountId(view.accounts.selectedAccountId ?? view.accounts.accounts[0]?.accountId ?? ""); }, [view.accounts, accountId]);
  const snapshot = view.snapshot, account = view.accounts?.accounts.find(value => value.accountId === accountId);
  const jobs = snapshot?.jobs.filter(job => job.accountId === accountId && job.declaredProvider === provider).slice().reverse() ?? [];
  const current = view.fresh && !!snapshot && !!view.accounts, pending = !!view.pending;
  const eligible = !!account?.enabled && account.identityRegistered;
  const canInspect = current && !pending && !!snapshot?.canInspect && !!view.accounts?.canMutate && eligible;
  const stateLabel = (job: ChatImportJob) => copy.states[job.state];
  const bytes = (value: number) => new Intl.NumberFormat(lang === "vi" ? "vi-VN" : "en-US").format(value);
  const error = view.error?.code === "NATIVE_RUNTIME_UPDATE_REQUIRED" || view.error?.code === "UNSUPPORTED_OPERATION" ? copy.unavailable : view.error?.code === "BUSY" ? copy.busy : copy.error;
  return <section className="native-imports" aria-labelledby="chat-import-title">
    <header className="page-header"><div><h1 id="chat-import-title">{copy.title}</h1><p>{copy.intro}</p></div><button onClick={() => void store.current?.refresh()} disabled={pending}>{copy.refresh}</button></header>
    <p className="import-local-status" role="status">{copy.local}</p>
    {view.loading && <p role="status">{copy.loading}</p>}
    {view.error && <p className="error-message" role="alert">{error}</p>}
    {!view.fresh && !view.loading && <p>{copy.offline}</p>}
    {snapshot && !snapshot.experimentalEnabled && <p>{copy.disabled}</p>}
    {view.notice === "selection_cancelled" && <p role="status">{copy.cancelled}</p>}
    <div className="panel import-target-controls">
      <label htmlFor="chat-import-account">{copy.account}<select id="chat-import-account" value={accountId} disabled={!current || pending} onChange={event => setAccountId(event.target.value)}>{view.accounts?.accounts.map(value => <option key={value.accountId} value={value.accountId} disabled={!value.enabled}>{value.displayName}</option>)}</select></label>
      <label htmlFor="chat-import-provider">{copy.provider}<select id="chat-import-provider" value={provider} disabled={!current || pending} onChange={event => setProvider(event.target.value as ChatImportProvider)}><option value="chatgpt">ChatGPT</option><option value="claude">Claude</option></select></label>
      <button data-import-select disabled={!canInspect} onClick={() => account && void store.current?.inspect(account.accountId, account.identityEpoch, provider)}>{view.pending === "select" ? copy.picking : copy.select}</button>
      {current && !eligible && <p>{copy.identity}</p>}
      {current && snapshot?.experimentalEnabled && !snapshot.canInspect && <p>{copy.busy}</p>}
    </div>
    <p>{copy.future}</p>
    {!jobs.length && <p>{copy.empty}</p>}
    <div className="import-job-list" aria-live="polite">{jobs.map(job => <article className="panel import-job" key={job.jobId} data-import-job={job.jobId} data-import-state={job.state}>
      <h2>{job.inspection?.fileName ?? `${job.declaredProvider === "chatgpt" ? "ChatGPT" : "Claude"} ZIP`}</h2><p role="status">{stateLabel(job)}</p>
      {["checking", "cancelling"].includes(job.state) && <><progress aria-label={stateLabel(job)} max={job.totalBytes || 1} value={job.totalBytes ? job.bytesRead : undefined}/><p>{bytes(job.bytesRead)} / {bytes(job.totalBytes)} bytes</p></>}
      {job.state === "failed" && <p>{copy.changed}</p>}
      {job.inspection && <dl className="import-metadata"><dt>{copy.bytes}</dt><dd>{bytes(job.inspection.bytes)} bytes</dd><dt>{copy.files}</dt><dd>{job.inspection.directory.files}</dd><dt>{copy.folders}</dt><dd>{job.inspection.directory.folders}</dd><dt>{copy.encrypted}</dt><dd>{job.inspection.directory.encryptedFiles}</dd><dt>{copy.expanded}</dt><dd>{job.inspection.directory.uncompressedBytes}</dd><dt>SHA-256</dt><dd className="import-digest">{job.inspection.sha256}</dd></dl>}
      <div className="import-job-actions">{["checking", "cancelling"].includes(job.state) ? <button data-import-cancel disabled={!current || pending || job.state === "cancelling"} onClick={() => void store.current?.execute("cancel", job.jobId)}>{copy.cancel}</button> : <button data-import-clear disabled={!current || pending || !!snapshot?.inspectionActive} onClick={() => void store.current?.execute("clear", job.jobId)}>{copy.clear}</button>}</div>
    </article>)}</div>
  </section>;
}
