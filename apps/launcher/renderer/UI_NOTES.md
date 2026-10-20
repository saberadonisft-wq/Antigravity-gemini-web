# UI Notes — G4

Cập nhật 15/10/2026. [Review trước](../../../docs/evidence/G4_CONTINUE_CODE_REVIEW.md), [validation hiện tại](../../../docs/evidence/g4-acceptance-validation.md). G4-A launcher/control/UI/fixture VERIFIED.

5 views hiện có: Overview, Onboarding, Sessions, Activity, Settings. Copy layer vi/en và localized typed errors; technical identifiers và diagnostic/provider strings giữ dữ liệu nguồn. Demo explicit có banner, live thiếu preload fail closed.

Settings dirty draft giữ base revision; external update không reset draft. Save conflict giữ input, “Dùng cài đặt đã lưu / Use Saved Settings” là explicit reconcile. Native E2E disabled; Sessions pending theo session/turn và đợi operation terminal, timeout không biến thành success.

Electron smoke đã kiểm chứng save/reload/theme/English, conflict trên React form, 5 English headings, 5 views × 3 logical viewports và Tab focus. [English/light image](../../../docs/evidence/g4-desktop-smoke/launcher-english-light.png), [JSON](../../../docs/evidence/g4-desktop-smoke/desktop-smoke.json). Ảnh chỉ Overview; không ảnh mọi flow.

18 computed CSS text/background pairs ≥4.5:1: primary/primary light 15.80:1, dark 16.02:1; secondary/tertiary light 4.92:1, dark 4.95:1. Không chứng nhận full WCAG. Không dùng copied literal colors làm chứng cứ CSS.

Acceptance đã bổ sung actual second-instance/pending lifecycle, owned Chrome page activation/crash/reconnect fixture, native Windows Save/Cancel, đủ 10 rendered UI scenarios, Activity race/pagination/failure, cancel confirmed/failed và Settings write failure. Picker có đủ nhãn VI/EN. Contrast scan 576 measurements trên 32 combinations minimum 4.5166:1; Demo subtitle bỏ opacity, danger dark hover dùng #b62324 và text/background đổi cùng lúc. System dark/reduced-motion computed CSS, Tab/Enter/focus-visible, form labels và long workspace tại actual 1280/1024/800 widths đã đo. Không chứng nhận full WCAG/screen reader/Windows foreground cho Chrome; native/Google live NOT_TESTED. [Tự test](../../../docs/archive/guides/G4_USER_TEST_GUIDE.md), không G5.

React ^18.3.1, Vite 6.4.4 resolved, Electron 44.7.2, esbuild 0.28.2. Repo tham khảo miuuyy/codex-chatgpt-web snapshot 889f291d06339400a8b9c2941473f65cd47d4830; chưa license/attribution audit cho release.
