-- InvStock – migration lib_glossary_01_table
-- Thư viện thuật ngữ: từ viết tắt / thuật ngữ chuyên ngành, dùng để tra cứu và tự liên kết trong bài research.
-- Không ràng buộc theo chuẩn JSON research: chỉ cần thuật ngữ + định nghĩa ngắn.
-- Ghi chỉ qua Edge Function lib-glossary (service_role, admin). Đọc công khai qua public-research-library?action=glossary.

create table invstock.lib_glossary_terms (
  term_id      uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  term         text not null check (length(btrim(term)) between 1 and 80),   -- ví dụ: CASA
  full_name    text check (length(full_name) <= 200),                          -- Current Account Savings Account
  vi_name      text check (length(vi_name) <= 200),                            -- Tỷ lệ tiền gửi không kỳ hạn
  industry     text not null default 'general' check (industry ~ '^[a-z_]{2,30}$'),
  aliases      text[] not null default '{}',   -- cách viết khác cũng được tự liên kết (ví dụ: "tỷ lệ CASA")
  short_def    text not null check (length(btrim(short_def)) between 1 and 500),  -- hiện trong tooltip
  body         text,                           -- giải thích đầy đủ (đoạn văn tự do)
  formula      text,
  example      text,
  related      text[] not null default '{}',   -- thuật ngữ liên quan (ghi theo term)
  auto_link    boolean not null default true,  -- có tự nhận diện trong bài không
  match_case   boolean not null default true,  -- true: phân biệt hoa thường (an toàn cho từ viết tắt)
  is_published boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null
);
create unique index lib_glossary_terms_term_industry_key on invstock.lib_glossary_terms (lower(term), industry);
create index lib_glossary_terms_industry_idx on invstock.lib_glossary_terms (industry);

alter table invstock.lib_glossary_terms enable row level security;
create policy lib_glossary_read on invstock.lib_glossary_terms
  for select to authenticated using ((select invstock_private.is_active_reviewer()));

revoke all on invstock.lib_glossary_terms from public, anon, authenticated;
grant select on invstock.lib_glossary_terms to authenticated;
grant select, insert, update, delete on invstock.lib_glossary_terms to service_role;
