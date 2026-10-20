import React,{useState} from "react";
import { NativeAccountStore,type NativeAccountViewState,type NativeAccountIntent } from "../client/native-account-store.js";
import { IconRefresh, IconAlertTriangle, IconCheck } from "../components/Icons.js";

const copies={
    vi: { title: "Tài khoản Gemini Web", description: "Quản lý các hồ sơ Gemini Web như các account connection riêng.", refresh: "Kiểm tra trạng thái", loading: "Đang đọc trạng thái proxy…", offline: "Chưa có trạng thái mới từ proxy. Các thao tác tài khoản đang khóa.", unsupported: "Quản lý tài khoản cần launcher chạy ở chế độ thật và proxy Native mới.", update: "Proxy đang chạy chưa hỗ trợ quản lý tài khoản. Cập nhật khi lượt hiện tại đã dừng.", conflict: "Cấu hình hoặc phiên proxy đã đổi. Kiểm tra trạng thái rồi thao tác lại.", login: "Mở profile, đăng nhập đúng tài khoản rồi kiểm tra danh tính.", identityUnverified: "Connector đã nối tab, nhưng Gemini chưa cung cấp được email duy nhất từ các dấu hiệu tài khoản đang hiển thị. Kiểm tra tài khoản Google đang hoạt động trong profile này rồi kiểm tra lại.", challenge: "Hoàn thành xác minh Google trong profile đang mở, rồi kiểm tra lại.", identity: "Profile đang đăng nhập tài khoản khác. Đăng nhập lại đúng tài khoản đã đăng ký.", modelUnavailable: "Model đang cấu hình chưa dùng được trên account này. Kiểm tra lựa chọn Web hoặc model policy.", modelMismatch: "IDE gửi sai model selector cho bridge. Chọn lại Gemini Web (Local); nếu đã chọn, mở chat mới hoặc khởi động lại IDE để tải lại danh mục model. Lượt này bị chặn trước khi gửi tới Gemini Web.", latestIssue: "Lỗi bridge gần nhất:", restoreModel: "Mở profile để khôi phục model chính rồi kiểm tra lại.", cancelled: "Lượt đã được yêu cầu hủy; không tự gửi lại.", generic: "Chưa thực hiện được thao tác. Kiểm tra trạng thái trước khi thử lại.", selected: "Đang chọn", select: "Chọn cho lượt sau", selectDefault: "Đặt mặc định cho chat mới", open: "Mở profile", verify: "Kiểm tra danh tính", enable: "Bật tài khoản", disable: "Tạm ngưng", add: "Thêm tài khoản", name: "Tên tài khoản mới", nameHint: "Ví dụ: Tài khoản phụ", working: "Đang thực hiện…", noAccounts: "Chưa có tài khoản. Thêm một profile rồi đăng nhập.", checkedAt: "Đọc trạng thái lúc", busy: "Có thao tác đang chạy. Chờ kết thúc để đổi cấu hình.", policy: "Định tuyến account", manual: "Thủ công", sticky: "Ghim theo chat", advancedPolicy: "Policy nâng cao đang được cấu hình ngoài giao diện này.", manualHelp: "Mỗi lượt mới dùng account đang chọn.", stickyHelp: "Chat IDE mới ghim vào account đầu tiên phục vụ nó. Chat đã ghim tiếp tục dùng account cũ; đổi mặc định chỉ tác động chat mới.", automatic: "Policy tự chọn account; account mặc định chỉ áp dụng cho chat mới.", webModel: "Theo model đang chọn trên Web", capabilityUnknown: "Khả năng model chưa được xác minh.", capabilities: "Khả năng đã ghi nhận", identityNote: "Kiểm tra danh tính chỉ xác nhận phiên tại thời điểm kiểm tra; không chứng minh model hoặc suy luận IDE sẵn sàng.", cancelNote: "Đã yêu cầu dừng. Chờ xác nhận; lượt cũ không tự gửi lại.", done: "Thao tác đã hoàn tất.", verifyDone: "Đã kiểm tra danh tính, không gửi prompt.", useDone: "Đã cập nhật lựa chọn. Chat tiếp theo sẽ đồng bộ context theo tài khoản phục vụ.", resumeDone: "Đã đánh dấu nối hội thoại cho request IDE mới kế tiếp; chưa gửi prompt.", stopConfirmed: "Browser đã xác nhận dừng.", stopUnknown: "Browser chưa xác nhận dừng.", stale: "Dữ liệu cũ", noReplay: "Kết quả chưa rõ; kiểm tra lịch sử Web trước khi tạo lượt mới.",
        pair: "Sao chép mã ghép nối", pairHelp: "Khởi động connector, sao chép mã ghép nối rồi dán vào popup extension trong đúng hồ sơ Chrome. Sau khi kết nối, kiểm tra danh tính.", pairDone: "Đã sao chép mã ghép nối. Dán mã vào popup extension trong đúng hồ sơ Chrome.", remove: "Xóa tài khoản", removeTitle: "Xóa tài khoản vĩnh viễn?", removeHelp: "Tài khoản sẽ bị xóa khỏi bridge cùng dữ liệu profile, phiên và mã ghép nối do bridge quản lý. Tài khoản Google, lịch sử Gemini trên Google và hồ sơ Chrome cá nhân không bị xóa.", retireChats: "Xóa trạng thái tiếp tục của các chat IDE gắn với tài khoản này. Lượt chưa rõ kết quả vẫn giữ dấu chặn nội bộ để tránh gửi trùng.", retainedChatsError: "Tài khoản còn chat IDE được giữ. Chọn ô bên dưới nếu muốn xóa trạng thái tiếp tục rồi xóa tài khoản.", cleanupFailed: "Tài khoản đã bị xóa, nhưng Windows chưa xóa hết thư mục bridge. Đóng cửa sổ Chrome do bridge mở rồi kiểm tra lại.", confirmRemove: "Xóa vĩnh viễn", cancelRemove: "Hủy", removeDone: "Đã xóa tài khoản và dữ liệu bridge quản lý.", selectedRemove: "Hãy chọn tài khoản khác trước khi xóa tài khoản đang chọn.",
        states: { disabled: "Đã tạm ngưng", unverified: "Chưa kiểm tra phiên", checked: "Danh tính vừa được kiểm tra", busy: "Đang phục vụ lượt chat", login_required: "Cần đăng nhập", identity_mismatch: "Sai tài khoản trong profile", verification_required: "Google yêu cầu xác minh", unavailable: "Lần kiểm tra gần nhất có lỗi", cooldown: "Tạm chờ sau lỗi đã quan sát" } },
    en: { title: "Gemini Web accounts", description: "Manage Gemini Web profiles as separate account connections.", refresh: "Check status", loading: "Reading proxy status…", offline: "No fresh proxy status. Account actions are locked.", unsupported: "Account management requires live desktop mode and an updated native proxy.", update: "The running proxy does not support account management. Update after the current turn has stopped.", conflict: "The configuration or proxy instance changed. Refresh before acting again.", login: "Open the profile, sign into its registered account, then verify identity.", identityUnverified: "The connector is attached, but Gemini did not expose one unique email in its visible account indicators. Check the active Google account in this profile, then verify again.", challenge: "Complete Google verification in the open profile, then check again.", identity: "This profile is signed into another account. Sign into its registered account.", modelUnavailable: "The configured model is unavailable on this account. Check the Web selection or model policy.", modelMismatch: "The IDE sent a model selector the bridge does not accept. Select Gemini Web (Local) again; if it is already selected, open a new chat or restart the IDE to reload the model catalog. This turn was blocked before sending to Gemini Web.", latestIssue: "Latest bridge issue:", restoreModel: "Open the profile to restore the processing model, then check again.", cancelled: "Cancellation was requested; the turn will not be resent.", generic: "The action could not finish. Refresh before trying again.", selected: "Selected", select: "Select for next turn", selectDefault: "Set default for new chats", open: "Open profile", verify: "Verify identity", enable: "Enable account", disable: "Disable", add: "Add account", name: "New account name", nameHint: "For example: Secondary account", working: "Working…", noAccounts: "No accounts yet. Add a profile, then sign in.", checkedAt: "Status read at", busy: "An operation is running. Wait for it to finish before changing settings.", policy: "Account routing", manual: "Manual", sticky: "Sticky per chat", advancedPolicy: "An advanced policy is configured outside this view.", manualHelp: "Each new IDE turn uses the currently selected account.", stickyHelp: "A new IDE chat binds to the first account that serves it. Existing chats stay on their bound account; changing the default affects new chats only.", automatic: "The policy selects the account; the default applies only to new chats.", webModel: "Use the model selected on the Web", capabilityUnknown: "Model availability has not been verified.", capabilities: "Recorded capabilities", identityNote: "Identity verification is a point-in-time check; it does not prove model availability or native IDE inference.", cancelNote: "Cancellation requested. Wait for confirmation; the old turn will not be resent.", done: "Action completed.", verifyDone: "Identity checked without sending a prompt.", useDone: "Selection updated. The next chat turn will sync context for its serving account.", resumeDone: "The next new IDE request is armed to continue this conversation. No prompt was sent.", stopConfirmed: "Browser confirmed cancellation.", stopUnknown: "Browser has not confirmed cancellation.", stale: "Stale data", noReplay: "The outcome is uncertain. Inspect Web history before creating a new turn.",
        pair: "Copy pairing code", pairHelp: "Start the connector, copy the pairing code, then paste it into the extension popup in the matching Chrome profile. Verify identity after it connects.", pairDone: "Pairing code copied. Paste it into the extension popup in the matching Chrome profile.", remove: "Delete account", removeTitle: "Permanently delete this account?", removeHelp: "The bridge account and its bridge-managed profile, session, and pairing data will be deleted. Your Google account, Gemini history stored by Google, and personal Chrome profile will remain.", retireChats: "Delete the IDE continuation state linked to this account. A small internal fence remains for turns with uncertain outcomes to prevent duplicate sends.", retainedChatsError: "This account still owns retained IDE chat state. Check the option below to delete its continuation state and account.", cleanupFailed: "The account was deleted, but Windows could not remove all bridge folders. Close Chrome windows opened by the bridge, then check again.", confirmRemove: "Delete permanently", cancelRemove: "Cancel", removeDone: "Account and bridge-managed data deleted.", selectedRemove: "Select another account before deleting the currently selected one.",
        states: { disabled: "Disabled", unverified: "Session not checked", checked: "Identity checked recently", busy: "Serving a chat turn", login_required: "Sign-in required", identity_mismatch: "Wrong account in profile", verification_required: "Google verification required", unavailable: "Latest check failed", cooldown: "Waiting after an observed failure" } }
};
export const NativeAccountsView:React.FC<{store:NativeAccountStore;view:NativeAccountViewState;lang:"vi"|"en"}>=({store,view,lang})=>{
  const storeRef={current:store};
  const [name,setName]=useState("");
  const [removeConfirmId,setRemoveConfirmId]=useState<string>();
  const [retireNativeConversations,setRetireNativeConversations]=useState(false);
  const [removeErrorCode,setRemoveErrorCode]=useState<string>();
  const copy=copies[lang],snapshot=view.snapshot,locked=!view.fresh||!!view.pendingAction||!snapshot?.canMutate;
  const action=(intent:NativeAccountIntent)=>{void storeRef.current?.execute(intent);};
  const accountName=(id:string)=>snapshot?.accounts.find(row=>row.accountId===id)?.displayName??id;
  const errorCopy=(code:string)=>code==="ACCOUNT_IN_USE"?copy.retainedChatsError:code==="ACCOUNT_CLEANUP_FAILED"?copy.cleanupFailed:code==="RESOURCE_LIMIT"?(lang==="vi"?"Worker hoặc metadata hội thoại đã đạt giới hạn. Kiểm tra cleanup trước khi bắt đầu lượt mới.":"Worker or conversation metadata capacity reached. Check cleanup before starting a new turn."):["UNSUPPORTED_OPERATION","PRELOAD_UNAVAILABLE"].includes(code)?copy.unsupported:["NATIVE_RUNTIME_UPDATE_REQUIRED","ACCOUNT_RUNTIME_STALE"].includes(code)?copy.update:["CONFIG_CONFLICT","STALE_AUTHORITY","OWNER_MISMATCH"].includes(code)?copy.conflict:["LOGIN_REQUIRED","BROWSER_LOGIN_REQUIRED"].includes(code)?copy.login:code==="ACCOUNT_IDENTITY_UNVERIFIED"?copy.identityUnverified:code==="MODEL_UNAVAILABLE"?copy.modelUnavailable:code==="MODEL_RESTORE_PENDING"?copy.restoreModel:code==="BUSY"?copy.busy:code==="BROWSER_USER_ACTION_REQUIRED"?copy.challenge:code==="ACCOUNT_IDENTITY_CHANGED"?copy.identity:code==="OUTCOME_UNKNOWN"?copy.noReplay:code==="CANCELLED"?copy.cancelled:copy.generic;
  const setRoutingMode=(mode:"manual"|"sticky")=>action({action:"configure_routing",settings:{mode,priority:[],roundRobinOptIn:false}});
  const latestIssue=snapshot?.latestIssue;
  const latestIssueText=latestIssue?(latestIssue.code==="NATIVE_MODEL_NOT_SELECTED"
    ?`${copy.modelMismatch}${latestIssue.receivedModelSelectors?` ${Object.entries(latestIssue.receivedModelSelectors).map(([key,value])=>`${key}=${value}`).join(", ")}.`:""}${latestIssue.expectedModel?` ${lang==="vi"?"Bridge chờ":"Bridge expected"}: ${latestIssue.expectedModel}.`:""}`
    :`${copy.latestIssue} ${latestIssue.code}${latestIssue.phase?` · ${latestIssue.phase}`:""}`):undefined;
  const notice=view.notice==="cancel"?(snapshot?.activeTurns.length?copy.cancelNote:snapshot?.lastOutcome?.browserStopConfirmed?copy.stopConfirmed:copy.stopUnknown):view.notice==="verify"?copy.verifyDone:view.notice==="use"?copy.useDone:view.notice==="open"?(lang==="vi"?"Đã yêu cầu mở profile hoặc khởi động connector. Kiểm tra kết nối rồi kiểm tra danh tính.":"Requested profile opening or connector startup. Check the connection and verify identity."):view.notice==="resume"?copy.resumeDone:view.notice==="pair"?copy.pairDone:view.notice==="remove"?copy.removeDone:copy.done;

  return (
    <section className="native-accounts" aria-labelledby="native-accounts-title" data-native-accounts>
      <header className="page-header">
        <div>
          <h2 id="native-accounts-title" className="page-title">{copy.title}</h2>
          <p className="page-desc">{copy.description}</p>
        </div>
        <button data-native-action="refresh" disabled={!!view.pendingAction} onClick={() => void storeRef.current?.refresh()}>
          <IconRefresh size={14} spinning={!!view.pendingAction} />
          <span>{copy.refresh}</span>
        </button>
      </header>

      <div aria-live="polite" className="native-account-feedback">
        {view.loading && <p>{copy.loading}</p>}
        {view.error && (
          <p role="alert" className="native-account-error">
            {view.error.code === "ACCOUNT_SELECTED"
              ? copy.selectedRemove
              : view.error.code === "ACCOUNT_BOUND"
              ? (lang === "vi" ? "Bỏ ghim ở màn hình Đoạn chat và gỡ khỏi thứ tự ưu tiên định tuyến trước." : "Remove chat pins in Chats and its routing priority first.")
              : view.error.code === "ACCOUNT_IN_USE"
              ? copy.retainedChatsError
              : view.error.code === "LAST_ACCOUNT"
              ? (lang === "vi" ? "Không thể xóa tài khoản cuối cùng của bridge." : "The bridge must keep at least one account.")
              : errorCopy(view.error.code)} <code>{view.error.code}</code>
          </p>
        )}
        {!view.fresh && !view.loading && <p>{copy.offline}</p>}
        {view.pendingAction && <p role="status">{copy.working}</p>}
        {view.notice && !view.pendingAction && <p role="status">{notice}</p>}
      </div>

      {snapshot && (
        <>
          <div className="card native-account-summary">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <div className="native-account-route-control">
                <label htmlFor="native-account-routing" style={{ fontWeight: 600 }}>{copy.policy}</label>
                <select
                  id="native-account-routing"
                  data-native-action="routing"
                  value={snapshot.routing.mode}
                  disabled={locked}
                  onChange={event => {
                    if (event.target.value === "manual" || event.target.value === "sticky") setRoutingMode(event.target.value);
                  }}
                >
                  <option value="manual">{copy.manual}</option>
                  <option value="sticky">{copy.sticky}</option>
                  {(snapshot.routing.mode === "priority" || snapshot.routing.mode === "round_robin") && (
                    <option value={snapshot.routing.mode} disabled>{copy.advancedPolicy}</option>
                  )}
                </select>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                <span>{copy.checkedAt} {new Date(snapshot.observedAt).toLocaleTimeString(lang === "vi" ? "vi-VN" : "en-US")}{!view.fresh ? ` · ${copy.stale}` : ""}</span>
              </div>
            </div>

            <p style={{ color: "var(--text-secondary)", fontSize: 12.5, margin: 0 }}>
              {snapshot.routing.mode === "sticky" ? copy.stickyHelp : snapshot.routing.mode === "manual" ? copy.manualHelp : copy.advancedPolicy}
              {" · "}
              <strong>{snapshot.routing.modelSelection?.model ?? copy.webModel}{snapshot.routing.modelSelection?.effort ? ` / ${snapshot.routing.modelSelection.effort}` : ""}</strong>
            </p>

            {latestIssueText && (
              <div role="alert" className="error-callout-card" style={{ padding: "8px 12px", marginTop: 4 }}>
                <IconAlertTriangle size={15} />
                <div style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                  <p role="alert" className="native-account-error" data-native-latest-issue style={{ margin: 0 }}>
                    {latestIssueText} <code>{latestIssue?.code}</code>
                  </p>
                </div>
              </div>
            )}

            {snapshot.routing.automaticEnabled && <p style={{ margin: 0, fontSize: 12 }}>{copy.automatic}</p>}
            {!snapshot.canMutate && <p style={{ margin: 0, fontSize: 12 }}>{copy.busy}</p>}
            <p style={{ color: "var(--text-muted)", fontSize: 11.5, margin: 0 }}>{copy.identityNote}</p>
          </div>

          <form
            className="card native-account-add"
            onSubmit={event => {
              event.preventDefault();
              if (locked || snapshot.runtimeRevision < 41 || !name.trim()) return;
              void storeRef.current?.execute({
                action: "add",
                displayName: name.trim(),
                browserTransport: "extension",
              }).then(ok => {
                if (ok) setName("");
              });
            }}
          >
            <label htmlFor="native-account-name">{copy.name}</label>
            <div className="native-account-actions">
              <input
                id="native-account-name"
                value={name}
                maxLength={128}
                placeholder={copy.nameHint}
                disabled={locked}
                onChange={event => setName(event.target.value)}
              />
              <button type="submit" className="primary" data-native-action="add" disabled={locked || snapshot.runtimeRevision < 41 || !name.trim()}>
                {copy.add}
              </button>
            </div>
            <p>{snapshot.runtimeRevision < 41 ? copy.update : lang === "vi" ? "Dùng hồ sơ Chrome có sẵn đã cài Gemini Profile Connector." : "Use an existing Chrome profile with Gemini Profile Connector installed."}</p>
          </form>

          {!snapshot.accounts.length && <p>{copy.noAccounts}</p>}

          <div className="native-account-list">
            {snapshot.accounts.map(account => (
              <article
                className={`card native-account ${account.selected ? "is-selected" : ""}`}
                key={account.accountId}
                data-native-account={account.accountId}
              >
                <div className="native-account-header">
                  <div className="native-account-title-wrap">
                    <span className="native-account-avatar">
                      {account.displayName.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <h3>{account.displayName}</h3>
                      <span className="native-account-transport-chip">
                        {account.browserTransport === "extension"
                          ? (lang === "vi" ? "Chrome profile" : "Chrome profile")
                          : (lang === "vi" ? "Bridge Chrome" : "Bridge Chrome")}
                      </span>
                    </div>
                  </div>
                  <div className="native-account-badges">
                    {account.selected && (
                      <span className="badge success" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <IconCheck size={12} />
                        <span>{copy.selected}</span>
                      </span>
                    )}
                  </div>
                </div>

                <div className="native-account-body">
                  <p data-native-account-state style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      className={`status-dot ${
                        account.state === "checked"
                          ? "ready"
                          : account.state === "disabled"
                          ? "neutral"
                          : account.state === "busy"
                          ? "running"
                          : "unverified"
                      }`}
                    />
                    <span>{view.fresh ? copy.states[account.state] : copy.stale}</span>
                  </p>

                  {account.browserTransport === "extension" && (
                    <p style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{copy.pairHelp}</p>
                  )}

                  {account.reasonCode && (
                    <div role="alert" className="error-callout-card" style={{ padding: "6px 10px", marginTop: 4 }}>
                      <p className="native-account-error" style={{ margin: 0, fontSize: 12 }}>
                        {errorCopy(account.reasonCode)} <code className="error-chip">{account.reasonCode}</code>
                      </p>
                    </div>
                  )}

                  <p style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                    {!account.capabilities.length
                      ? copy.capabilityUnknown
                      : copy.capabilities + ": " + account.capabilities.map(capability => `${capability.name} (${capability.status})`).join(", ")}
                  </p>
                </div>

                <div className="native-account-actions">
                  <button
                    data-native-action="use"
                    disabled={locked || !account.enabled || account.selected}
                    onClick={() => action({ action: "use", accountId: account.accountId })}
                  >
                    {snapshot.routing.automaticEnabled ? copy.selectDefault : copy.select}
                  </button>
                  <button
                    data-native-action="open"
                    disabled={locked || !account.enabled}
                    onClick={() => action({ action: "open", accountId: account.accountId })}
                  >
                    {account.browserTransport === "extension" ? (lang === "vi" ? "Khởi động connector" : "Start connector") : copy.open}
                  </button>
                  <button
                    data-native-action="verify"
                    disabled={locked || !account.enabled}
                    onClick={() => action({ action: "verify", accountId: account.accountId })}
                  >
                    {copy.verify}
                  </button>
                  {account.browserTransport === "extension" && (
                    <button
                      data-native-action="pair"
                      disabled={locked || !account.enabled || snapshot.runtimeRevision < 41}
                      onClick={() => void storeRef.current?.copyPairingCode(account.accountId)}
                    >
                      {copy.pair}
                    </button>
                  )}
                  <button
                    data-native-action={account.enabled ? "disable" : "enable"}
                    disabled={locked}
                    onClick={() => action({ action: account.enabled ? "disable" : "enable", accountId: account.accountId })}
                  >
                    {account.enabled ? copy.disable : copy.enable}
                  </button>
                  <button
                    data-native-action="remove"
                    disabled={locked}

                    onClick={() => {setRemoveConfirmId(account.accountId);setRemoveErrorCode(undefined);setRetireNativeConversations(false);}}
                  >
                    {copy.remove}
                  </button>
                </div>

                {removeConfirmId === account.accountId && (
                  <div
                    className="native-account-remove-confirm"
                    role="alertdialog"
                    aria-labelledby={`remove-title-${account.accountId}`}
                    aria-describedby={`remove-help-${account.accountId}`}
                  >
                    <h4 id={`remove-title-${account.accountId}`}>{copy.removeTitle}</h4>
                    <p id={`remove-help-${account.accountId}`}>{copy.removeHelp}</p>
                    <label className="native-account-remove-choice">
                      <input type="checkbox" checked={retireNativeConversations} disabled={!!view.pendingAction} onChange={event=>{setRetireNativeConversations(event.target.checked);setRemoveErrorCode(undefined);}} />
                      <span>{copy.retireChats}</span>
                    </label>
                    {removeErrorCode && <p role="alert" className="native-account-error"><span>{errorCopy(removeErrorCode)}</span> <code>{removeErrorCode}</code></p>}
                    <div className="native-account-actions">
                      <button data-native-action="cancel-remove" onClick={() => {setRemoveConfirmId(undefined);setRemoveErrorCode(undefined);setRetireNativeConversations(false);}}>
                        {copy.cancelRemove}
                      </button>
                      <button
                        className="danger"
                        data-native-action="confirm-remove"
                        disabled={locked}
                        onClick={() => void (async()=>{const ok=await storeRef.current?.execute({action:"remove",accountId:account.accountId,...(retireNativeConversations?{retireNativeConversations:true}:{})});if(ok){setRemoveConfirmId(undefined);setRemoveErrorCode(undefined);setRetireNativeConversations(false);}else setRemoveErrorCode(storeRef.current?.current.error?.code??"UNKNOWN");})()}
                      >
                        {copy.confirmRemove}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>

        </>
      )}
    </section>
  );
};
