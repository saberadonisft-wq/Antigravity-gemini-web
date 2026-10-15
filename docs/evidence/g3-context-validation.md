# G3 — Kiểm chứng ngữ cảnh sau review

Ngày: 14/10/2026. Chi tiết test run: [g3-codex-remediation-validation.md](g3-codex-remediation-validation.md).

## Identity và toàn vẹn

Context được kiểm tra bằng StructuredContextSchema. Opaque workspace IDs và POSIX paths phân biệt hoa thường; chỉ absolute Windows paths có path normalization/case folding. Session cũng phải khớp. Đây không phải realpath/symlink authorization cho IDE executor.

Fingerprint SHA-256 bao gồm tất cả instructions/history/tool output/metadata. Object key order không đổi hash; array order và từng giá trị có ý nghĩa. Đã test đổi message giữa, phần nội dung sau ký tự 50, tool output và model metadata.

ContextManager bảo toàn dữ liệu có cấu trúc; chưa có serializer native đã kiểm chứng. Việc file/web/model content không được nâng thành host instruction là ràng buộc adapter và host, chưa thể được chứng nhận bằng việc có schema.

## Budget

- Đo toàn bộ JSON envelope: characterCount, UTF-8 byteCount.
- Estimated tokens: `ceil(max(characterCount, byteCount) / 4)`; luôn `isEstimate: true`.
- Local safety cap mặc định: 32.000 estimated tokens và 1.000.000 bytes.
- knownContextLimit chỉ dùng nếu host cung cấp; không suy đoán quota/model window Google.
- Limits phải là positive finite integers. Vượt cap hoặc giới hạn khai báo trả CONTEXT_TOO_LARGE, không cắt ngầm.
- compact() trả UNSUPPORTED_OPERATION khi host compaction chưa proven.
- Requested model khác hoặc active model unknown trả REBIND_REQUIRED.

Coordinator enqueue gọi preflight cho context cùng prompt, trước journal/dispatch. Test xác nhận foreign session và oversized prompt không tạo queue/executor work. Các tests này không phải bằng chứng preflight trên native chat thật.

## Những phần chưa kiểm chứng live

Host instruction provenance, native context assembly/serialization, attachments, account/model/target/conversation change và reconnect xuyên IDE vẫn cần native adapter/binding thật. Không tự điền model hay số token usage chính thức để làm UI ready.

