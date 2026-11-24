# InvStock Sync Portal

Portal đồng bộ riêng cho Supabase project `Stock Analysis` theo Option B.

## 1. Kiến trúc đã triển khai trên Supabase

- Project ref: `uupmlkgnyowlertktsbw`
- Auth: Supabase email OTP; không tự tạo tài khoản mới.
- Edge Function `portal-research-sync` — yêu cầu JWT, chỉ tài khoản có `research_reviewers.reviewer_role = admin` và `is_active = true` được gọi.
- Edge Function `portal-screening-sync` — yêu cầu JWT và cùng điều kiện admin.
- Bảng audit `invstock.research_sync_approvals` — RLS bật, không cấp quyền cho `anon`/`authenticated`; chỉ `service_role` truy cập.
- RPC `invstock.commit_portal_research_sync` — chỉ `service_role` được execute; ghi approval receipt + ingest trong cùng transaction. Nếu validation không đạt, transaction rollback.
- Không đưa `service_role` vào mã frontend.

## 2. Cấu hình môi trường

Tạo file `.env` từ `.env.example`:

```env
VITE_SUPABASE_URL=https://uupmlkgnyowlertktsbw.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

Lấy publishable key tại Supabase Dashboard → Project Settings → API Keys → Publishable key (`sb_publishable_...`).

**Chỉ dùng publishable key ở frontend. Tuyệt đối không dùng `service_role` hoặc secret key.**

## 3. Cấu hình Supabase Auth

Trong Supabase Dashboard:

1. Mở Authentication → Providers → Email; bảo đảm Email provider đang bật.
2. Mở Authentication → Email Templates → Magic Link.
3. Nếu muốn nhập mã 6 số trong Portal, sửa nội dung template để có `{{ .Token }}`, ví dụ:

```html
<h2>InvStock Sync Portal - Login code</h2>
<p>Mã đăng nhập một lần của bạn là:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>Không chia sẻ mã này với bất kỳ ai.</p>
```

4. Mở Authentication → URL Configuration:
   - Site URL: URL Portal sau khi deploy.
   - Redirect URLs: thêm URL production chính xác, ví dụ `https://your-portal-domain.vercel.app/**`.
   - Khi phát triển local, thêm `http://localhost:5173/**`.
5. Portal gọi `signInWithOtp` với `shouldCreateUser: false`, vì vậy không tạo user mới.

Tài khoản hiện được audit là `hoanghiep32@gmail.com`, đang có vai trò admin trong `invstock.research_reviewers`. Hãy dùng email này để nhận OTP. Nếu bạn đã đổi email đăng nhập Supabase, cần kiểm tra lại role admin trước khi sử dụng.

## 4. Chạy thử trên máy tính

Cần Node.js 20+.

```bash
npm install
cp .env.example .env
# Sửa VITE_SUPABASE_PUBLISHABLE_KEY trong .env
npm run dev
```

Mở `http://localhost:5173`, đăng nhập bằng OTP và thử với một payload JSON đã được chuẩn bị.

## 5. Deploy lên Vercel

1. Giải nén source code.
2. Tạo một repository GitHub riêng, ví dụ `invstock-sync-portal`, rồi upload toàn bộ source (không upload file `.env`).
3. Vào Vercel → Add New → Project → Import repository vừa tạo.
4. Framework preset: Vite. Build command: `npm run build`. Output directory: `dist`.
5. Trong Project → Settings → Environment Variables, khai báo:
   - `VITE_SUPABASE_URL` = `https://uupmlkgnyowlertktsbw.supabase.co`
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = publishable key lấy từ Supabase.
6. Deploy. Sao chép URL production.
7. Quay lại Supabase → Authentication → URL Configuration, cập nhật Site URL và Redirect URLs theo URL production.
8. Redeploy Vercel nếu bạn thay đổi environment variables.

Có thể dùng Netlify hoặc một static host HTTPS khác; cấu hình build tương tự.

## 6. Cách sử dụng

### Full Research

1. Mở Portal và đăng nhập OTP.
2. Chọn tab **Full Research**.
3. Nạp file `.json` hoặc dán `invstock_research_v1` JSON.
4. Nhấn **Kiểm tra & tạo bản xem trước**.
5. Kiểm tra ticker, toàn bộ payload và SHA-256.
6. Tích xác nhận đồng bộ.
7. Nhấn nút xác nhận. Edge Function sẽ xác thực JWT, kiểm tra vai trò admin, tính lại SHA-256, gọi RPC trong transaction và kiểm tra bản ghi đã tồn tại.
8. Chỉ khi API trả `SYNCED` cùng persistence verification, Portal mới hiển thị thành công.

### Screening Snapshot

1. Chọn tab **Screening**.
2. Nạp Screening Snapshot JSON có mảng `candidates` không rỗng.
3. Kiểm tra danh sách, tạo preview, tích xác nhận và nhấn đồng bộ.
4. Portal gọi `portal-screening-sync`; backend kiểm tra JWT, admin role, hash và số lượng candidate đã ghi.

## 7. Endpoint đã triển khai

- Research: `https://uupmlkgnyowlertktsbw.supabase.co/functions/v1/portal-research-sync`
- Screening: `https://uupmlkgnyowlertktsbw.supabase.co/functions/v1/portal-screening-sync`

Cả hai Function đang bật `verify_jwt = true`.

## 8. Lưu ý bảo mật và giới hạn

- Không bao giờ đưa `service_role` / secret key vào `.env` frontend, GitHub hoặc Vercel.
- Không gửi JWT, OTP hoặc mật khẩu cho người khác.
- Chỉ admin reviewer mới được đồng bộ; việc có tài khoản Supabase thôi là chưa đủ.
- Không có broker connector, tài khoản chứng khoán, API đặt lệnh hay quyền giao dịch.
- Portal không tự publish research; publication vẫn là bước riêng cần chỉ thị riêng.
- `SYNCED` chỉ được hiển thị khi Edge Function xác minh được research version / approval receipt hoặc screening run / candidate count.
- Trạng thái triển khai hiện tại: backend Supabase đã deploy; frontend source đã đóng gói. Cần bạn thực hiện bước deploy frontend lên Vercel/Netlify và cập nhật Auth Redirect URL vì phiên này không có quyền truy cập tài khoản hosting của bạn.
