# G4 — trạng thái kiểm chứng hiện tại

Cập nhật 15/10/2026. Báo cáo 133 tests đã được review lại; findings, patches và checks mới nằm ở [G4_CONTINUE_CODE_REVIEW.md](G4_CONTINUE_CODE_REVIEW.md) và [g4-codex-followup-validation.md](g4-codex-followup-validation.md).

**146/146 TS tests PASS**, root build/typecheck/lint và Electron smoke PASS. Desktop control verified trong các flow đã đo; **G4-A acceptance đầy đủ PARTIAL**, **G4-B BLOCKED/NOT_TESTED**. Không chứng nhận WCAG toàn ứng dụng, zero flaky, native inference hoặc Google login.

Lịch sử: 119 tests sau bản vá đầu G4, 133 trước review continuation, 146 sau 13 regressions mới. Python không rerun trong đợt này.

[Prompt tiếp tục G4](../archive/prompts/GEMINI_G4_CONTINUE_PROMPT.md). Dừng G4, chưa G5.

