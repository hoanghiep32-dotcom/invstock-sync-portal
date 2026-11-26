# InvStock Contracts 0.1.0 — ĐÃ DUYỆT 26/11/2026

Bộ contract máy đọc được cho tài liệu 13 (Modular Research & Block Standard): **Research Note**, **Research Operation**, **Snapshot Manifest**, kèm thư viện hash JCS và validator.

> Đã duyệt ngày 26/11/2026. Mọi thay đổi contract sau này cần tăng contract_version và duyệt lại.

## Nội dung

| File | Vai trò |
|---|---|
| `defs.schema.json` | Định nghĩa dùng chung: uuid, sha256, JSON Pointer, 14 module, 13 component, source (giống schema 02), evidence, gap, impact |
| `research_note.schema.json` | Note chuyên đề / Deep Dive (doc 13 §5) |
| `research_operation.schema.json` | Tác vụ nghiên cứu (doc 13 §4): base, read/write set, changes, impact review |
| `snapshot_manifest.schema.json` | Sidecar kê 27 path của một Full JSON (doc 13 §9) |
| `jcs/` | Canonical JSON theo RFC 8785, bản JS và Python, 13 test vector dùng chung |
| `tools/invstock_contracts.py` | Hash block, dựng manifest, kiểm tra logic (mã lỗi doc 13) |
| `tools/validate_contract.py` | CLI: schema Draft 2020-12 rồi kiểm tra logic |
| `tools/build_fpt_examples.py` | Dựng manifest backfill FPT R1/R2 từ bytes gốc |
| `examples/` | Manifest thật FPT R1/R2 (chỉ chứa hash/path); note và operation **VÍ DỤ** với nội dung giữ chỗ |
| `tests/test_contracts.py` | 26 kiểm thử trên fixture tổng hợp |

## Chạy kiểm thử

```bash
cd contracts/jcs && node test_vectors.mjs && python3 test_vectors.py   # 13/13 mỗi bên
cd .. && python3 tests/test_contracts.py                               # 26 tests OK
python3 tools/validate_contract.py manifest examples/FPT_R2.manifest.json \
  --snapshot <FPT_2026-11-26_LIB_R2.json> --parent examples/FPT_R1.manifest.json
```

Cần Python 3.10+ và `jsonschema` 4.18+. Bytes gốc của FPT không nằm trong repo (repo public).

## Các quyết định cần anh duyệt

1. **profile_id** = `invstock.securities.id` (UUID), không dùng ticker. Ví dụ FPT/HOSE = `4aaab883-…918a`. Đổi mã hoặc đổi sàn sẽ xử lý bằng mapping có duyệt, sau này.
2. **Hash block** (`invstock-block-hash/v1`): `sha256(JCS({path, content, sources}))`. Trong đó `sources` là các source descriptor mà block tham chiếu qua `source_ids`, sắp theo id. Ngày review không nằm trong hash.
3. **normalized_hash**: giống hash block nhưng thay mỗi source_id bằng hash của descriptor (bỏ id). Nếu chỉ `content_hash` đổi còn `normalized_hash` giữ nguyên, block được ghi là `CHANGED / SOURCE_REMAP`, tức thay đổi kỹ thuật chứ không phải nghiên cứu mới (doc 13 §3).
4. **Manifest có đúng 27 entry**: 14 `/modules/<key>` và 13 component top-level. Không cho phép path chồng lấn (ví dụ có cả `/modules` và `/modules/x`).
5. **snapshot_sha256** tính trên bytes gốc, giống `lib_records.sha256`. **manifest hash** tính trên bytes JCS của sidecar và lưu ngoài file.
6. **Disposition và revision của block**: chưa có ở parent thì `INITIAL`, rev 1. Hash giống parent thì `INHERITED`, giữ version_id và rev. Hash khác thì `CHANGED`, version_id mới và rev + 1. Với backfill, version_id là UUIDv5 tái lập được; registry sau này sẽ lưu ID chính thức.
7. **Path cấm ghi qua patch**: `/metadata/record_id`, `/metadata/revision`, `/metadata/parent_id`, `/metadata/scorecard_version`, `/schema_name`, `/schema_version`, cùng mọi path cha của chúng (ví dụ `/metadata`). Builder quản lý các path này theo doc 10.
8. **Array**: v0.1 chỉ cho phép thay nguyên mảng. `null` không phải lệnh xóa; REPLACE hoặc RECALCULATE với giá trị null bị báo lỗi `NULL_NOT_DELETE`.
9. **Action**: APPEND cần `note_ref`; ANNOTATE cần `annotation`; REPLACE cần `candidate_value`; RECALCULATE cần `candidate_value` và `formula_ref`. Operation không phải FULL_RESEARCH thì bắt buộc có base.
10. **Taxonomy note**: `topic` thuộc OWNERSHIP, FORENSICS, RISK, EVENT, INDUSTRY, VALUATION, GOVERNANCE, OTHER. `outcome` thuộc SUPPLEMENT_ONLY, PROPOSE_INTEGRATION, URGENT_REVIEW. Thân bài viết bằng Markdown. Mỗi note có đúng 1 module PRIMARY. `visibility` mặc định là `members`.
11. **Phiên bản note**: `note_id` cố định cho cả chuỗi; mỗi lần sửa tạo `note_version_id` mới và trỏ `parent_note_version_id` về bản trước. Bản đã duyệt không bị sửa.
12. **Approval, integration, publication** không nằm trong file. Chúng là metadata audit ở DB, gắn với snapshot hash, manifest hash và review hash.

## Mã lỗi validator

`BASE_STALE`, `BLOCK_CONFLICT`, `DEPENDENCY_CHANGED`, `MANIFEST_MISMATCH`, `SOURCE_BINDING_CONFLICT` (theo doc 13), cộng thêm `FORBIDDEN_PATH`, `WRITE_SET`, `NULL_NOT_DELETE`, `PRIMARY_MODULE`, `CUTOFF_AFTER_AS_OF`, `NOTE_REF`, `OUTCOME`, `SCHEMA`, `PARSE`. Mã `APPROVAL_HASH_MISMATCH` thuộc bước approval ở DB (GĐ 4–5), chưa có ở đây.

## Kết quả thử với FPT

Manifest R1 có 27 entry đều là `INITIAL`. Manifest R2 (cha là R1) có `schema_name`, `schema_version` và `identity` ở trạng thái `INHERITED`; 24 entry còn lại là `CHANGED / CONTENT`, khớp với việc R2 là bản Update toàn phần. Cả hai đều PASS khi đối chiếu với bytes gốc (sha 798e1b8f…f7ad và 7820631c…cc84). Đưa nhầm snapshot vào thì validator báo `MANIFEST_MISMATCH`.

## Sau khi duyệt (GĐ 3–6, mỗi bước một PR, backup trước, chỉ thêm mới)

- **GĐ 3, Registry**: bảng `lib_blocks`, `lib_block_versions`, `lib_manifests` và `lib_manifest_entries`, RLS chặn mặc định. Backfill manifest FPT R1/R2 từ bytes gốc.
- **GĐ 4, Operation và Note**: bảng `lib_operations` và `lib_notes` (bất biến) cùng bảng liên kết; Edge Function import có validator; giao diện tab "Chuyên đề".
- **GĐ 5, Tích hợp**: operation tạo candidate snapshot, diff theo block, approval gắn hash, publish theo doc 12.
- **GĐ 6, Kiểm thử B01–B22** và đối soát dữ liệu.
