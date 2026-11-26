-- InvStock GĐ 3 + 4 (tài liệu 13 §15): Supplementary Notes, Operations, Block Registry, Snapshot Manifest.
-- Contract: contracts/ 0.1.0 (đã duyệt 2026-11-26).
-- Chỉ THÊM: không sửa lib_records / lib_publications / lib_record_publications, không đổi bytes/hash.
-- Chạy trong 1 transaction. Backup trước: invstock_backup.*_20261126b.
--
-- Nguyên tắc:
--   * Bytes gốc + sha256 lưu bất biến (trigger chặn UPDATE/DELETE); chỉ trạng thái duyệt/xuất bản là thay được.
--   * Quyền mặc định: chặn. Reviewer đang hoạt động được SELECT; mọi ghi đi qua RPC chỉ service_role gọi được.
--   * Validator đầy đủ (JSON Schema + logic) chạy ở Edge Function; RPC kiểm tra lại các ràng buộc then chốt.

-- 0) Hàm chặn sửa/xóa cho bảng bất biến
create function invstock_private.lib_immutable() returns trigger language plpgsql set search_path to '' as $$
begin
  raise exception 'IMMUTABLE: % không cho phép % ', tg_table_name, tg_op using errcode = 'P0001';
end $$;

-- 1) Research Notes (GĐ 3). Mỗi dòng = một phiên bản note.
create table invstock.lib_notes (
  note_version_id        uuid primary key,
  note_id                uuid not null,
  note_version           integer not null check (note_version >= 1),
  parent_note_version_id uuid references invstock.lib_notes(note_version_id),
  profile_id             uuid not null references invstock.securities(id),
  topic                  text not null check (topic in ('OWNERSHIP','FORENSICS','RISK','EVENT','INDUSTRY','VALUATION','GOVERNANCE','OTHER')),
  title                  text not null check (length(btrim(title)) > 0),
  outcome                text not null check (outcome in ('SUPPLEMENT_ONLY','PROPOSE_INTEGRATION','URGENT_REVIEW')),
  requested_visibility   text not null check (requested_visibility in ('members','public')),
  base_record_id         uuid references invstock.lib_records(record_id),
  base_sha256            text check (base_sha256 ~ '^[0-9a-f]{64}$'),
  as_of                  date not null,
  cutoff                 date not null,
  contract_version       text not null,
  payload                jsonb not null,
  payload_bytes          bytea not null,
  sha256                 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status                 text not null default 'draft' check (status in ('draft','approved','rejected')),
  reviewed_by            uuid,
  reviewed_at            timestamptz,
  review_note            text,
  created_by             uuid,
  created_at             timestamptz not null default now(),
  unique (note_id, note_version),
  constraint lib_notes_sha check (sha256 = encode(sha256(payload_bytes), 'hex')),
  constraint lib_notes_cutoff check (cutoff <= as_of),
  constraint lib_notes_parent check ((note_version = 1) = (parent_note_version_id is null)),
  constraint lib_notes_base check ((base_record_id is null) = (base_sha256 is null)),
  constraint lib_notes_reviewed check (status = 'draft' or (reviewed_at is not null))
);
create index lib_notes_profile on invstock.lib_notes (profile_id, created_at);

create table invstock.lib_note_module_links (
  note_version_id uuid not null references invstock.lib_notes(note_version_id),
  module_key      text not null check (module_key in ('executive_summary','company_intelligence','industry_macro',
                    'competitive_advantage','financial_performance','financial_forensics','debt_liquidity',
                    'ownership_governance','assets_projects','growth_forecast','valuation_engine',
                    'catalysts_expectations','scorecard_risk','decision_monitoring')),
  role            text not null check (role in ('PRIMARY','SECONDARY')),
  primary key (note_version_id, module_key)
);
create unique index lib_note_module_links_one_primary on invstock.lib_note_module_links (note_version_id) where role = 'PRIMARY';
create index lib_note_module_links_module on invstock.lib_note_module_links (module_key);

-- Xuất bản note độc lập với con trỏ current của snapshot (doc 13 §5).
create table invstock.lib_note_publications (
  note_version_id   uuid primary key references invstock.lib_notes(note_version_id),
  role              text not null check (role in ('published','withdrawn')),
  visibility        text not null check (visibility in ('members','public')),
  approved_sha256   text not null check (approved_sha256 ~ '^[0-9a-f]{64}$'),
  published_at      timestamptz not null default now(),
  published_by      uuid,
  withdrawn_at      timestamptz,
  withdrawn_by      uuid,
  withdraw_reason   text,
  updated_at        timestamptz not null default now(),
  constraint lib_np_withdrawn_reason check (role <> 'withdrawn' or length(btrim(coalesce(withdraw_reason, ''))) > 0)
);

-- 2) Research Operations
create table invstock.lib_operations (
  operation_id        uuid primary key,
  operation_type      text not null check (operation_type in ('FULL_RESEARCH','UPDATE','PARTIAL_UPDATE','DEEP_DIVE','REVALUATION','RE_SCORE')),
  profile_id          uuid not null references invstock.securities(id),
  base_record_id      uuid references invstock.lib_records(record_id),
  base_sha256         text check (base_sha256 ~ '^[0-9a-f]{64}$'),
  outcome             text not null check (outcome in ('NO_CHANGE','NOTE_ONLY','CANDIDATE_SNAPSHOT')),
  candidate_record_id uuid,
  as_of               date not null,
  cutoff              date not null,
  contract_version    text not null,
  payload             jsonb not null,
  payload_bytes       bytea not null,
  sha256              text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_by          uuid,
  created_at          timestamptz not null default now(),
  constraint lib_operations_sha check (sha256 = encode(sha256(payload_bytes), 'hex')),
  constraint lib_operations_cutoff check (cutoff <= as_of),
  constraint lib_operations_base check ((base_record_id is null) = (base_sha256 is null)),
  constraint lib_operations_base_required check (operation_type = 'FULL_RESEARCH' or base_record_id is not null)
);
create index lib_operations_profile on invstock.lib_operations (profile_id, created_at);

create table invstock.lib_operation_notes (
  operation_id    uuid not null references invstock.lib_operations(operation_id),
  note_version_id uuid not null references invstock.lib_notes(note_version_id),
  primary key (operation_id, note_version_id)
);

-- 3) Block Registry (GĐ 4)
create table invstock.lib_blocks (
  block_id   uuid primary key default gen_random_uuid(),
  profile_id uuid not null references invstock.securities(id),
  block_key  text not null check (block_key in (
    '/modules/executive_summary','/modules/company_intelligence','/modules/industry_macro',
    '/modules/competitive_advantage','/modules/financial_performance','/modules/financial_forensics',
    '/modules/debt_liquidity','/modules/ownership_governance','/modules/assets_projects',
    '/modules/growth_forecast','/modules/valuation_engine','/modules/catalysts_expectations',
    '/modules/scorecard_risk','/modules/decision_monitoring',
    '/schema_name','/schema_version','/metadata','/identity','/sources','/core10','/committee',
    '/scorecard','/valuation','/risk','/decision','/catalysts','/monitoring')),
  kind       text not null check (kind in ('MODULE','COMPONENT')),
  created_at timestamptz not null default now(),
  unique (profile_id, block_key),
  constraint lib_blocks_kind check ((kind = 'MODULE') = (block_key like '/modules/%'))
);

create table invstock.lib_block_versions (
  block_version_id         uuid primary key,
  block_id                 uuid not null references invstock.lib_blocks(block_id),
  block_revision           integer not null check (block_revision >= 1),
  parent_block_version_id  uuid references invstock.lib_block_versions(block_version_id),
  content_hash             text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  normalized_hash          text not null check (normalized_hash ~ '^[0-9a-f]{64}$'),
  change_class             text not null check (change_class in ('NONE','CONTENT','SOURCE_REMAP')),
  origin_record_id         uuid not null references invstock.lib_records(record_id),
  hash_algorithm           text not null check (hash_algorithm = 'sha256'),
  canonicalization_version text not null,
  created_at               timestamptz not null default now(),
  unique (block_id, block_revision),
  constraint lib_bv_parent check ((block_revision = 1) = (parent_block_version_id is null))
);

create table invstock.lib_manifests (
  manifest_id               uuid primary key,
  record_id                 uuid not null unique references invstock.lib_records(record_id),
  profile_id                uuid not null references invstock.securities(id),
  parent_manifest_id        uuid unique references invstock.lib_manifests(manifest_id),
  contract_version          text not null,
  manifest_bytes            bytea not null,
  manifest_sha256           text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_sha256           text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  provenance_kind           text not null check (provenance_kind in ('BUILDER','LEGACY_BACKFILL')),
  legacy_provenance_unknown boolean not null,
  created_by                uuid,
  created_at                timestamptz not null default now(),
  constraint lib_manifests_sha check (manifest_sha256 = encode(sha256(manifest_bytes), 'hex'))
);

create table invstock.lib_manifest_entries (
  manifest_id      uuid not null references invstock.lib_manifests(manifest_id),
  path             text not null,
  block_version_id uuid not null references invstock.lib_block_versions(block_version_id),
  disposition      text not null check (disposition in ('INITIAL','INHERITED','CHANGED')),
  change_class     text not null check (change_class in ('NONE','CONTENT','SOURCE_REMAP')),
  source_ids       text[] not null default '{}',
  operation_ids    uuid[] not null default '{}',
  note_ids         uuid[] not null default '{}',
  primary key (manifest_id, path)
);
create index lib_manifest_entries_version on invstock.lib_manifest_entries (block_version_id);

-- 4) Bất biến
create trigger lib_notes_lock_delete before delete on invstock.lib_notes for each row execute function invstock_private.lib_immutable();
create function invstock_private.lib_notes_guard() returns trigger language plpgsql set search_path to '' as $$
begin
  if (new.note_version_id, new.note_id, new.note_version, new.parent_note_version_id, new.profile_id, new.topic, new.title,
      new.outcome, new.requested_visibility, new.base_record_id, new.base_sha256, new.as_of, new.cutoff,
      new.contract_version, new.payload, new.payload_bytes, new.sha256, new.created_by, new.created_at)
     is distinct from
     (old.note_version_id, old.note_id, old.note_version, old.parent_note_version_id, old.profile_id, old.topic, old.title,
      old.outcome, old.requested_visibility, old.base_record_id, old.base_sha256, old.as_of, old.cutoff,
      old.contract_version, old.payload, old.payload_bytes, old.sha256, old.created_by, old.created_at) then
    raise exception 'IMMUTABLE: nội dung note không sửa được; tạo phiên bản note mới' using errcode = 'P0001';
  end if;
  if old.status <> 'draft' then
    raise exception 'IMMUTABLE: note đã %', old.status using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger lib_notes_guard before update on invstock.lib_notes for each row execute function invstock_private.lib_notes_guard();
create trigger lib_nml_lock before update or delete on invstock.lib_note_module_links for each row execute function invstock_private.lib_immutable();
create trigger lib_operations_lock before update or delete on invstock.lib_operations for each row execute function invstock_private.lib_immutable();
create trigger lib_operation_notes_lock before update or delete on invstock.lib_operation_notes for each row execute function invstock_private.lib_immutable();
create trigger lib_blocks_lock before update or delete on invstock.lib_blocks for each row execute function invstock_private.lib_immutable();
create trigger lib_block_versions_lock before update or delete on invstock.lib_block_versions for each row execute function invstock_private.lib_immutable();
create trigger lib_manifests_lock before update or delete on invstock.lib_manifests for each row execute function invstock_private.lib_immutable();
create trigger lib_manifest_entries_lock before update or delete on invstock.lib_manifest_entries for each row execute function invstock_private.lib_immutable();
create trigger lib_note_publications_lock_delete before delete on invstock.lib_note_publications for each row execute function invstock_private.lib_immutable();

-- 5) Quyền: chặn mặc định, reviewer đọc, service_role ghi qua RPC
do $$
declare t text;
begin
  foreach t in array array['lib_notes','lib_note_module_links','lib_note_publications','lib_operations','lib_operation_notes',
                           'lib_blocks','lib_block_versions','lib_manifests','lib_manifest_entries'] loop
    execute format('alter table invstock.%I enable row level security', t);
    execute format('create policy %I on invstock.%I for select to authenticated using ((select invstock_private.is_active_reviewer()))', t || '_read', t);
    execute format('revoke all on invstock.%I from public, anon, authenticated', t);
    execute format('grant select on invstock.%I to authenticated', t);
    execute format('grant select, insert, update, delete on invstock.%I to service_role', t);
  end loop;
end $$;

-- 6) Loại sự kiện audit mới
alter table invstock.lib_sync_events drop constraint lib_sync_events_event_type_check;
alter table invstock.lib_sync_events add constraint lib_sync_events_event_type_check check (event_type = any (array[
  'approved_synced', 'duplicate', 'validation_failed', 'sync_blocked', 'verified', 'verify_failed',
  'published', 'unpublished', 'superseded', 'withdrawn', 'restored', 'rolled_back',
  'manifest_registered', 'note_imported', 'note_reviewed', 'note_published', 'note_withdrawn', 'operation_imported']));

-- 7) RPC: đăng ký manifest. Bytes manifest do Edge Function (hoặc script backfill) dựng từ payload_bytes của DB.
create function invstock.lib_register_manifest(p_manifest_bytes bytea, p_actor uuid)
returns jsonb language plpgsql set search_path to '' as $$
declare
  m jsonb := convert_from(p_manifest_bytes, 'UTF8')::jsonb;
  rec invstock.lib_records;
  sec invstock.securities;
  parent_m invstock.lib_manifests;
  e jsonb;
  pe invstock.lib_manifest_entries;
  pv invstock.lib_block_versions;
  v_block uuid;
  v_sha text := encode(sha256(p_manifest_bytes), 'hex');
  n int := 0;
begin
  if m->>'contract_name' <> 'invstock.snapshot_manifest' or m->>'contract_version' <> '0.1.0' then
    raise exception 'MANIFEST_MISMATCH: contract không hỗ trợ' using errcode = 'P0001';
  end if;
  if exists (select 1 from invstock.lib_manifests where manifest_id = (m->>'manifest_id')::uuid and manifest_sha256 = v_sha) then
    return jsonb_build_object('status', 'unchanged', 'manifest_id', m->>'manifest_id', 'manifest_sha256', v_sha);
  end if;
  select * into rec from invstock.lib_records where record_id = (m->>'record_id')::uuid;
  if not found then raise exception 'MANIFEST_MISMATCH: record không tồn tại' using errcode = 'P0001'; end if;
  if rec.sha256 <> m->>'snapshot_sha256' or encode(sha256(rec.payload_bytes), 'hex') <> rec.sha256 then
    raise exception 'MANIFEST_MISMATCH: snapshot_sha256 không khớp bytes gốc' using errcode = 'P0001';
  end if;
  if rec.revision <> (m->>'revision')::int or rec.parent_id is distinct from (m->>'parent_record_id')::uuid then
    raise exception 'MANIFEST_MISMATCH: revision/parent không khớp' using errcode = 'P0001';
  end if;
  select * into sec from invstock.securities where id = (m->>'profile_id')::uuid;
  if not found or sec.ticker <> rec.ticker or sec.exchange is distinct from rec.exchange then
    raise exception 'MANIFEST_MISMATCH: profile_id không khớp mã/sàn của record' using errcode = 'P0001';
  end if;
  if rec.parent_id is null then
    if m->>'parent_manifest_id' is not null then raise exception 'MANIFEST_MISMATCH: bản gốc không có parent manifest' using errcode = 'P0001'; end if;
  else
    select * into parent_m from invstock.lib_manifests where record_id = rec.parent_id;
    if not found then raise exception 'MANIFEST_MISMATCH: cần đăng ký manifest của record cha trước' using errcode = 'P0001'; end if;
    if parent_m.manifest_id <> (m->>'parent_manifest_id')::uuid then
      raise exception 'MANIFEST_MISMATCH: parent_manifest_id không khớp' using errcode = 'P0001';
    end if;
  end if;
  if jsonb_array_length(m->'entries') <> 27
     or (select count(distinct x->>'path') from jsonb_array_elements(m->'entries') x) <> 27 then
    raise exception 'MANIFEST_MISMATCH: cần đúng 27 path khác nhau' using errcode = 'P0001';
  end if;

  insert into invstock.lib_manifests (manifest_id, record_id, profile_id, parent_manifest_id, contract_version, manifest_bytes,
    manifest_sha256, snapshot_sha256, provenance_kind, legacy_provenance_unknown, created_by)
  values ((m->>'manifest_id')::uuid, rec.record_id, sec.id, parent_m.manifest_id, m->>'contract_version', p_manifest_bytes,
    v_sha, rec.sha256, m->'provenance'->>'kind', (m->'provenance'->>'legacy_provenance_unknown')::boolean, p_actor);

  for e in select * from jsonb_array_elements(m->'entries') loop
    pe := null; pv := null;
    if parent_m.manifest_id is not null then
      select * into pe from invstock.lib_manifest_entries where manifest_id = parent_m.manifest_id and path = e->>'path';
      if pe.block_version_id is not null then
        select * into pv from invstock.lib_block_versions where block_version_id = pe.block_version_id;
      end if;
    end if;
    if e->>'disposition' = 'INITIAL' then
      if pv.block_version_id is not null then raise exception 'MANIFEST_MISMATCH: % đã có ở parent, không thể INITIAL', e->>'path' using errcode = 'P0001'; end if;
      insert into invstock.lib_blocks (profile_id, block_key, kind) values (sec.id, e->>'path', e->>'kind')
        on conflict (profile_id, block_key) do nothing;
      select block_id into v_block from invstock.lib_blocks where profile_id = sec.id and block_key = e->>'path';
      if (e->>'block_revision')::int <> 1 then raise exception 'MANIFEST_MISMATCH: INITIAL phải rev 1' using errcode = 'P0001'; end if;
      insert into invstock.lib_block_versions (block_version_id, block_id, block_revision, parent_block_version_id, content_hash,
        normalized_hash, change_class, origin_record_id, hash_algorithm, canonicalization_version)
      values ((e->>'version_id')::uuid, v_block, 1, null, e->>'content_hash', e->>'normalized_hash', 'NONE', rec.record_id,
        m->>'hash_algorithm', m->>'canonicalization_version');
    elsif e->>'disposition' = 'INHERITED' then
      if pv.block_version_id is null or pv.block_version_id <> (e->>'version_id')::uuid or pv.content_hash <> e->>'content_hash'
         or pv.block_revision <> (e->>'block_revision')::int then
        raise exception 'MANIFEST_MISMATCH: % INHERITED không khớp parent', e->>'path' using errcode = 'P0001';
      end if;
    elsif e->>'disposition' = 'CHANGED' then
      if pv.block_version_id is null or pv.content_hash = e->>'content_hash' or (e->>'block_revision')::int <> pv.block_revision + 1
         or (e->>'change_class') <> (case when pv.normalized_hash = e->>'normalized_hash' then 'SOURCE_REMAP' else 'CONTENT' end) then
        raise exception 'MANIFEST_MISMATCH: % CHANGED không khớp parent', e->>'path' using errcode = 'P0001';
      end if;
      insert into invstock.lib_block_versions (block_version_id, block_id, block_revision, parent_block_version_id, content_hash,
        normalized_hash, change_class, origin_record_id, hash_algorithm, canonicalization_version)
      values ((e->>'version_id')::uuid, pv.block_id, pv.block_revision + 1, pv.block_version_id, e->>'content_hash',
        e->>'normalized_hash', e->>'change_class', rec.record_id, m->>'hash_algorithm', m->>'canonicalization_version');
    else
      raise exception 'MANIFEST_MISMATCH: disposition sai' using errcode = 'P0001';
    end if;
    insert into invstock.lib_manifest_entries (manifest_id, path, block_version_id, disposition, change_class, source_ids, operation_ids, note_ids)
    values ((m->>'manifest_id')::uuid, e->>'path', (e->>'version_id')::uuid, e->>'disposition', e->>'change_class',
      array(select jsonb_array_elements_text(e->'source_ids')),
      array(select jsonb_array_elements_text(e->'operation_ids'))::uuid[],
      array(select jsonb_array_elements_text(e->'note_ids'))::uuid[]);
    n := n + 1;
  end loop;

  insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
  values (rec.record_id, rec.sha256, 'manifest_registered', p_actor,
    jsonb_build_object('manifest_id', m->>'manifest_id', 'manifest_sha256', v_sha, 'entries', n,
      'changed', (select count(*) from jsonb_array_elements(m->'entries') x where x->>'disposition' = 'CHANGED'),
      'provenance', m->'provenance'->>'kind'));
  return jsonb_build_object('status', 'registered', 'manifest_id', m->>'manifest_id', 'manifest_sha256', v_sha, 'entries', n);
end $$;

-- 8) RPC: nhập note (đã qua validator ở Edge Function)
create function invstock.lib_note_import(p_bytes bytea, p_actor uuid)
returns jsonb language plpgsql set search_path to '' as $$
declare
  n jsonb := convert_from(p_bytes, 'UTF8')::jsonb;
  v_sha text := encode(sha256(p_bytes), 'hex');
  v_id uuid := (n->>'note_version_id')::uuid;
  par invstock.lib_notes;
  sec invstock.securities;
  base_rec invstock.lib_records;
  l jsonb;
begin
  if n->>'contract_name' <> 'invstock.research_note' or n->>'contract_version' <> '0.1.0' then
    raise exception 'SCHEMA: contract không hỗ trợ' using errcode = 'P0001';
  end if;
  if exists (select 1 from invstock.lib_notes where note_version_id = v_id) then
    if (select sha256 from invstock.lib_notes where note_version_id = v_id) = v_sha then
      return jsonb_build_object('status', 'unchanged', 'note_version_id', v_id, 'sha256', v_sha);
    end if;
    raise exception 'IMMUTABLE: note_version_id đã tồn tại với nội dung khác' using errcode = 'P0001';
  end if;
  select * into sec from invstock.securities where id = (n->>'profile_id')::uuid;
  if not found or sec.ticker <> n->'identity'->>'ticker' or sec.exchange is distinct from n->'identity'->>'exchange' then
    raise exception 'SCHEMA: profile_id không khớp identity' using errcode = 'P0001';
  end if;
  if n->'base' is not null and jsonb_typeof(n->'base') = 'object' then
    select * into base_rec from invstock.lib_records where record_id = (n->'base'->>'record_id')::uuid;
    if not found or base_rec.sha256 <> n->'base'->>'sha256' or base_rec.revision <> (n->'base'->>'revision')::int then
      raise exception 'BASE_STALE: base không khớp record/sha trong thư viện' using errcode = 'P0001';
    end if;
    if base_rec.ticker <> sec.ticker or base_rec.exchange is distinct from sec.exchange then
      raise exception 'BASE_STALE: base thuộc mã khác' using errcode = 'P0001';
    end if;
  end if;
  if (n->>'note_version')::int > 1 then
    select * into par from invstock.lib_notes where note_version_id = (n->>'parent_note_version_id')::uuid;
    if not found or par.note_id <> (n->>'note_id')::uuid or par.note_version <> (n->>'note_version')::int - 1
       or par.profile_id <> sec.id then
      raise exception 'SCHEMA: parent_note_version_id không đúng chuỗi note' using errcode = 'P0001';
    end if;
  end if;
  insert into invstock.lib_notes (note_version_id, note_id, note_version, parent_note_version_id, profile_id, topic, title, outcome,
    requested_visibility, base_record_id, base_sha256, as_of, cutoff, contract_version, payload, payload_bytes, sha256, created_by)
  values (v_id, (n->>'note_id')::uuid, (n->>'note_version')::int, (n->>'parent_note_version_id')::uuid, sec.id, n->>'topic',
    n->>'title', n->>'outcome', n->>'visibility', base_rec.record_id, base_rec.sha256, (n->>'as_of')::date, (n->>'cutoff')::date,
    n->>'contract_version', n, p_bytes, v_sha, p_actor);
  for l in select * from jsonb_array_elements(n->'module_links') loop
    insert into invstock.lib_note_module_links values (v_id, l->>'module_key', l->>'role');
  end loop;
  if (select count(*) from invstock.lib_note_module_links where note_version_id = v_id and role = 'PRIMARY') <> 1 then
    raise exception 'PRIMARY_MODULE: cần đúng 1 module PRIMARY' using errcode = 'P0001';
  end if;
  insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
  values (base_rec.record_id, v_sha, 'note_imported', p_actor,
    jsonb_build_object('note_version_id', v_id, 'note_id', n->>'note_id', 'note_version', (n->>'note_version')::int,
      'profile_id', sec.id, 'topic', n->>'topic'));
  return jsonb_build_object('status', 'imported', 'note_version_id', v_id, 'sha256', v_sha);
end $$;

-- 9) RPC: duyệt / từ chối note (ràng buộc đúng sha đã xem)
create function invstock.lib_note_review(p_note_version_id uuid, p_expected_sha256 text, p_decision text, p_actor uuid, p_note text default null)
returns jsonb language plpgsql set search_path to '' as $$
declare r invstock.lib_notes;
begin
  if p_decision not in ('approved', 'rejected') then raise exception 'decision_invalid' using errcode = 'P0001'; end if;
  select * into r from invstock.lib_notes where note_version_id = p_note_version_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if r.sha256 <> p_expected_sha256 then raise exception 'APPROVAL_HASH_MISMATCH' using errcode = 'P0001'; end if;
  if r.status <> 'draft' then raise exception 'already_%', r.status using errcode = 'P0001'; end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_note, ''))) = 0 then raise exception 'reason_required' using errcode = 'P0001'; end if;
  update invstock.lib_notes set status = p_decision, reviewed_by = p_actor, reviewed_at = now(), review_note = p_note
   where note_version_id = p_note_version_id;
  insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
  values (r.base_record_id, r.sha256, 'note_reviewed', p_actor, jsonb_build_object('note_version_id', r.note_version_id, 'decision', p_decision, 'note', p_note));
  return jsonb_build_object('status', p_decision, 'note_version_id', r.note_version_id);
end $$;

-- 10) RPC: xuất bản / thu hồi note. Không đụng con trỏ current của snapshot.
create function invstock.lib_note_publish(p_note_version_id uuid, p_expected_sha256 text, p_visibility text, p_actor uuid)
returns jsonb language plpgsql set search_path to '' as $$
declare r invstock.lib_notes; p invstock.lib_note_publications;
begin
  if p_visibility not in ('members', 'public') then raise exception 'visibility_invalid' using errcode = 'P0001'; end if;
  select * into r from invstock.lib_notes where note_version_id = p_note_version_id for share;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if r.sha256 <> p_expected_sha256 then raise exception 'APPROVAL_HASH_MISMATCH' using errcode = 'P0001'; end if;
  if r.status <> 'approved' then raise exception 'not_approved' using errcode = 'P0001'; end if;
  if p_visibility = 'public' and r.requested_visibility <> 'public' then
    raise exception 'visibility_not_allowed: note chỉ dành cho members' using errcode = 'P0001';
  end if;
  select * into p from invstock.lib_note_publications where note_version_id = p_note_version_id for update;
  if found and p.role = 'published' and p.visibility = p_visibility then
    return jsonb_build_object('status', 'unchanged', 'note_version_id', p_note_version_id);
  end if;
  insert into invstock.lib_note_publications (note_version_id, role, visibility, approved_sha256, published_by)
  values (p_note_version_id, 'published', p_visibility, r.sha256, p_actor)
  on conflict (note_version_id) do update set role = 'published', visibility = excluded.visibility, published_at = now(),
    published_by = excluded.published_by, withdrawn_at = null, withdrawn_by = null, withdraw_reason = null, updated_at = now();
  insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
  values (r.base_record_id, r.sha256, 'note_published', p_actor, jsonb_build_object('note_version_id', r.note_version_id, 'visibility', p_visibility));
  return jsonb_build_object('status', 'published', 'note_version_id', r.note_version_id, 'visibility', p_visibility);
end $$;

create function invstock.lib_note_withdraw(p_note_version_id uuid, p_actor uuid, p_reason text)
returns jsonb language plpgsql set search_path to '' as $$
declare p invstock.lib_note_publications; r invstock.lib_notes;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required' using errcode = 'P0001'; end if;
  select * into p from invstock.lib_note_publications where note_version_id = p_note_version_id for update;
  if not found or p.role <> 'published' then raise exception 'not_published' using errcode = 'P0001'; end if;
  select * into r from invstock.lib_notes where note_version_id = p_note_version_id;
  update invstock.lib_note_publications set role = 'withdrawn', withdrawn_at = now(), withdrawn_by = p_actor,
    withdraw_reason = p_reason, updated_at = now() where note_version_id = p_note_version_id;
  insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
  values (r.base_record_id, r.sha256, 'note_withdrawn', p_actor, jsonb_build_object('note_version_id', p_note_version_id, 'reason', p_reason));
  return jsonb_build_object('status', 'withdrawn', 'note_version_id', p_note_version_id);
end $$;

-- 11) RPC: nhập operation (đã qua validator ở Edge Function)
create function invstock.lib_operation_import(p_bytes bytea, p_actor uuid)
returns jsonb language plpgsql set search_path to '' as $$
declare
  o jsonb := convert_from(p_bytes, 'UTF8')::jsonb;
  v_sha text := encode(sha256(p_bytes), 'hex');
  v_id uuid := (o->>'operation_id')::uuid;
  sec invstock.securities;
  base_rec invstock.lib_records;
  nid text;
begin
  if o->>'contract_name' <> 'invstock.research_operation' or o->>'contract_version' <> '0.1.0' then
    raise exception 'SCHEMA: contract không hỗ trợ' using errcode = 'P0001';
  end if;
  if exists (select 1 from invstock.lib_operations where operation_id = v_id) then
    if (select sha256 from invstock.lib_operations where operation_id = v_id) = v_sha then
      return jsonb_build_object('status', 'unchanged', 'operation_id', v_id, 'sha256', v_sha);
    end if;
    raise exception 'IMMUTABLE: operation_id đã tồn tại với nội dung khác' using errcode = 'P0001';
  end if;
  select * into sec from invstock.securities where id = (o->>'profile_id')::uuid;
  if not found or sec.ticker <> o->'identity'->>'ticker' or sec.exchange is distinct from o->'identity'->>'exchange' then
    raise exception 'SCHEMA: profile_id không khớp identity' using errcode = 'P0001';
  end if;
  if jsonb_typeof(o->'base') = 'object' then
    select * into base_rec from invstock.lib_records where record_id = (o->'base'->>'record_id')::uuid;
    if not found or base_rec.sha256 <> o->'base'->>'sha256' or base_rec.revision <> (o->'base'->>'revision')::int
       or base_rec.ticker <> sec.ticker then
      raise exception 'BASE_STALE: base không khớp record/sha trong thư viện' using errcode = 'P0001';
    end if;
  end if;
  insert into invstock.lib_operations (operation_id, operation_type, profile_id, base_record_id, base_sha256, outcome,
    candidate_record_id, as_of, cutoff, contract_version, payload, payload_bytes, sha256, created_by)
  values (v_id, o->>'operation_type', sec.id, base_rec.record_id, base_rec.sha256, o->>'outcome',
    (o->'output_refs'->>'candidate_record_id')::uuid, (o->>'as_of')::date, (o->>'cutoff')::date, o->>'contract_version',
    o, p_bytes, v_sha, p_actor);
  for nid in select jsonb_array_elements_text(o->'note_ids') loop
    if not exists (select 1 from invstock.lib_notes where note_version_id = nid::uuid and profile_id = sec.id) then
      raise exception 'NOTE_REF: note % chưa được nhập hoặc khác mã', nid using errcode = 'P0001';
    end if;
    insert into invstock.lib_operation_notes values (v_id, nid::uuid);
  end loop;
  insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
  values (base_rec.record_id, v_sha, 'operation_imported', p_actor,
    jsonb_build_object('operation_id', v_id, 'operation_type', o->>'operation_type', 'outcome', o->>'outcome'));
  return jsonb_build_object('status', 'imported', 'operation_id', v_id, 'sha256', v_sha);
end $$;

revoke all on function invstock.lib_register_manifest(bytea, uuid) from public, anon, authenticated;
revoke all on function invstock.lib_note_import(bytea, uuid) from public, anon, authenticated;
revoke all on function invstock.lib_note_review(uuid, text, text, uuid, text) from public, anon, authenticated;
revoke all on function invstock.lib_note_publish(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function invstock.lib_note_withdraw(uuid, uuid, text) from public, anon, authenticated;
revoke all on function invstock.lib_operation_import(bytea, uuid) from public, anon, authenticated;
revoke all on function invstock_private.lib_immutable() from public, anon, authenticated;
revoke all on function invstock_private.lib_notes_guard() from public, anon, authenticated;
grant execute on function invstock.lib_register_manifest(bytea, uuid) to service_role;
grant execute on function invstock.lib_note_import(bytea, uuid) to service_role;
grant execute on function invstock.lib_note_review(uuid, text, text, uuid, text) to service_role;
grant execute on function invstock.lib_note_publish(uuid, text, text, uuid) to service_role;
grant execute on function invstock.lib_note_withdraw(uuid, uuid, text) to service_role;
grant execute on function invstock.lib_operation_import(bytea, uuid) to service_role;
