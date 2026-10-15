# Antigravity · Gemini Web Desktop Launcher

Launcher điều khiển runtime cho mục tiêu Gemini Web trong chat native Antigravity IDE. **G4-A desktop/control/UI/fixture VERIFIED**; native inference và chat Google thật chưa được nghiệm thu. [Hướng dẫn tự test](../../docs/G4_USER_TEST_GUIDE.md).

## Chạy desktop

Chạy từ root repository:

~~~powershell
npm install
npm run build
npm run launcher
~~~

`npm run launcher` mở desktop live. `npm run launcher:demo` mở desktop demo có nhãn mô phỏng và dữ liệu tách riêng. Build chỉ tạo artifacts, không mở ứng dụng.

Dependencies pin Electron 44.7.2 và esbuild 0.28.2. Electron cần SDK binary tương ứng trong node_modules; nếu thiếu, quá trình resolve package có thể cần tải binary từ release chính thức. Desktop smoke hiện đã kiểm chứng binary trên máy này. Scripts bỏ ELECTRON_RUN_AS_NODE và NODE_OPTIONS thừa hưởng trước khi spawn Electron.

## Demo browser độc lập

~~~powershell
npm run dev --workspace=@antigravity-gemini-web/launcher
~~~

Mở `http://127.0.0.1:5173/?mode=demo`. Chỉ query `mode=demo` bật mock client. URL mặc định thiếu preload hiện lỗi; không tự chuyển sang demo. Dev browser chưa được smoke trực tiếp trong đợt review này.

## Dữ liệu và ownership

Desktop live mặc định dùng:

- App data: `%USERPROFILE%\.gemini\antigravity-gemini-web-live\app_data`.
- Settings và command receipts: `settings.json`, `operations.json`.
- Recovery journal: `journals\recovery.journal.jsonl`.
- Chrome profile do launcher sở hữu: `browser_profile` bên trong app data; CDP port 9223.
- Electron userData: `%USERPROFILE%\.gemini\antigravity-gemini-web-live\electron`; session/cache trong `electron\session`. Demo shell dùng root `antigravity-gemini-web-demo` riêng.

Đóng instance hiện tại trước khi đổi live/demo. SDK second-instance đã kiểm chứng với hai processes cùng owned temp userData: instance cũ restore/focus, instance mới exit, runtime owner giữ nguyên.

Profile này **khác** profile G2 `%USERPROFILE%\.gemini\gemini_web_probe_profile` dùng port 9222. Không copy cookie hay tự di chuyển đăng nhập. Electron shell/cache được cấu hình trước ready; second process thoát trước khi Chromium mở cache owner. Runtime Demo và smoke dùng temp riêng; Demo shell cache persistent và tách Live. Nếu đang mở bản cũ dùng `%APPDATA%\Antigravity Gemini Web`, đóng bản cũ trước khi chạy bản sửa. [Cache validation](../../docs/evidence/g4-electron-cache-validation.md).

Settings, receipts và export ghi qua file tạm, fsync rồi rename. File hỏng, thay đổi ngoài ứng dụng hoặc recovery không rõ kết quả chặn thao tác; không tự replay mutation. Journal chứa metadata/hash, không raw prompt. Chẩn đoán qua IPC/export được schema-validate và redact theo chính sách; đây không phải cam kết nhận diện mọi chuỗi bí mật tùy ý.

Browser status mặc định không attach vào CDP bên ngoài. Khi mở browser, port đang bận/không xác định bị từ chối. Chỉ browser do runtime sở hữu mới được đóng khi shutdown. Google login do người dùng thực hiện thủ công trên profile launcher nếu muốn kiểm chứng live sau này.

## IPC và vòng đời

Electron main đăng ký sender thật, derive main-frame/origin và validate hai đầu IPC. Preload sandbox CJS chỉ expose 6 methods LauncherClient. Renderer không có Node integration; context isolation, sandbox và web security bật. Production dùng exact origin `app://local`; prefix tương tự, userinfo, port lạ và sender không đăng ký bị chặn.

Reload/destroy gỡ subscriptions của sender; reload không tự dừng runtime. Main giữ một owner và shutdown fence công việc cũ, báo coordinator mất kết nối rồi cleanup browser. Nếu cleanup lỗi, ứng dụng thoát mã khác 0. Không đóng Chrome ngoài ownership.

Activity export dùng Save dialog ở main và ghi đúng file đã chọn. ACK export chỉ reservation; hủy dialog được quan sát ở terminal operation failed/CANCELLED. Các lệnh native install/preview/model/E2E chưa có provider vẫn reject với lỗi capability.

## Kiểm chứng và phần còn lại

~~~powershell
npm test
npm run typecheck
npm run lint
npm run test:desktop
npm run test:desktop-cache
~~~

Sau build, **148/148 TS tests PASS**; launcher 33, runtime 80, browser 22. Desktop acceptance kiểm tra Electron IPC thật, second-instance, pending reload/navigation/close, Save/Cancel dialog Windows và 10 React scenario flows. Owned Chrome crash/reconnect/no replay có runtime fixture riêng. Không account Google. Xem [evidence](../../docs/evidence/g4-acceptance-validation.md), [UI JSON](../../docs/evidence/g4-desktop-smoke/desktop-ui.json), [lifecycle](../../docs/evidence/g4-desktop-smoke/desktop-lifecycle.json), [dialogs](../../docs/evidence/g4-desktop-smoke/desktop-dialog.json).

Early ACK/durable terminal receipts, i18n/errors, dirty draft, CSS contrast và fixture config đã vá. G4-A acceptance trong scope trên đã hoàn tất; Google live/native E2E, full WCAG và Windows foreground cho Chrome chưa proven. Không dùng số unit tests để mở native/live gate.

Prompt tiếp tục: [GEMINI_G4_CONTINUE_PROMPT.md](../../docs/GEMINI_G4_CONTINUE_PROMPT.md). Dừng G4, chưa G5.

