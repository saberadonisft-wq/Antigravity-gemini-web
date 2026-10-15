# G4 contract alignment

Cập nhật 15/10/2026. Public LauncherClient v0.1 giữ 6 methods; shared schemas là nguồn chuẩn.

- Operation ID derive từ requestId; fingerprint full command độc lập để kiểm tra conflict. Một ID giữa receipt/engine/event/lastCheck.
- Browser/check/export/cancel durable queued receipt trước external wait; accepted ACK chỉ reservation, UI quan sát terminal.
- Settings synchronous giữ known rejection. Terminal receipt persistence failure → unknown/block, không success hoặc auto replay. Recovery/shutdown giữ accepted operation identity và terminal unknown.
- Export Cancel dialog → failed operation với CANCELLED; renderer không nhận destination/file path. Save dialog main-owned.
- Cancel binding session/turn/operation; terminal bất biến; renderer deadline hữu hạn. Không success timer.
- Internal transport envelope/unsubscribe/preload-ready không thêm methods public.
- ConfigTransactionService chỉ host fixture, yêu cầu fixtureRoot và explicit restore confirmation; không native install capability.
- Locale/theme authoritative, dirty draft/baseRevision giữ đến discard/success; errors typed/localized. Không tự thêm quota/token/context metrics từ suy đoán.

148 TS tests và desktop acceptance scope được ghi tại [validation](../../../docs/evidence/g4-acceptance-validation.md). Actual second-instance/pending lifecycle và Save/Cancel dùng production IPC/main; isolated UI fixture không expose thêm public API. G4-A launcher/control/fixture VERIFIED nhờ từng flow có proof; native/live chưa PASS. [Tự test](../../../docs/G4_USER_TEST_GUIDE.md); chưa G5.

