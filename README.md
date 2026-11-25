# InvStock Sync Portal (chuẩn v2.0.0)

React 18 + Vite + supabase-js. Deploy trên Vercel (project `invstocktracker`), dữ liệu ở Supabase project "Stock Analysis", schema `invstock`.

## Trang
- `/` – Thư viện công khai: chỉ hiện bản đã **xuất bản** (`lib_publications`). Khách xem `public`; người đã đăng nhập xem thêm `members`.
- `/research/:ticker?exchange=HOSE`, `/screening/:lineage_key` – chi tiết bản đang công bố.
- `/admin` – Đăng nhập email + mật khẩu (Supabase Auth). Chỉ admin đang hoạt động trong `invstock.research_reviewers` thao tác được.

## Quy trình (file 08 của framework v2)
1. **Preview** – chọn file JSON; gửi nguyên bytes (base64) tới Edge Function `lib-sync`. Máy chủ kiểm tra schema Draft 2020-12 + các kiểm tra ngữ nghĩa như `validate.py`, tính SHA-256 trên bytes gốc, kiểm tra trùng, parent và revision.
2. **Duyệt** – admin gõ lại đúng SHA-256 và ghi chú duyệt.
3. **Sync** – ghi `lib_records` (bất biến) + sự kiện `approved_synced`.
4. **Verify** – đọc lại bytes, so hash; ghi `verified` hoặc `verify_failed`.
5. **Xuất bản** – bước riêng: nút "Xuất bản" gọi `lib-publish` → `invstock.lib_publish` (chỉ bản đã verified). Không có tự xuất bản sau sync.

## Edge Functions
- `lib-sync` (JWT, admin) – preview / sync / verify.
- `lib-publish` (JWT, admin) – list / publish / unpublish.
- `public-research-library` (không bắt JWT) – đọc bản đã xuất bản.

## Môi trường
```env
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```
Chỉ dùng publishable key ở frontend. Không bao giờ đưa service role / secret key vào mã frontend.
