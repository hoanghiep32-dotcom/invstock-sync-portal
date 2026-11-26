-- InvStock GĐ 5 (tài liệu 13 §11, §13): Integration Engine.
-- Chỉ THÊM: 1 bảng (lib_integrations), 1 RPC (lib_integrate), 1 loại sự kiện audit ('integrated').
-- Không sửa lib_records cũ, không đụng lib_publications: tích hợp tạo bản mới nhưng KHÔNG xuất bản.
-- Chạy trong 1 transaction. Backup trước: invstock_backup.*_20261127.
--
-- Luồng: Edge Function xem trước (engine JS kiểm tra bản ứng viên, dựng manifest, tính bundle hash)
--   → admin duyệt đúng bundle hash → RPC này kiểm tra lại các ràng buộc then chốt rồi ghi trong MỘT transaction:
--   lib_records (bản mới) + manifest + block versions + lib_integrations + audit. Lỗi ở bất kỳ bước nào thì không ghi gì.

-- 1) Hồ sơ tích hợp (bất biến). Mỗi operation tích hợp tối đa 1 lần; mỗi record sinh từ tối đa 1 tích hợp.
create table invstock.lib_integrations (
  operation_id      uuid primary key references invstock.lib_operations(operation_id),
  profile_id        uuid not null references invstock.securities(id),
  base_record_id    uuid not null references invstock.lib_records(record_id),
  head_record_id    uuid not null references invstock.lib_records(record_id),
  record_id         uuid not null unique references invstock.lib_records(record_id),
  candidate_sha256  text not null check (candidate_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_id       uuid not null unique references invstock.lib_manifests(manifest_id),
  manifest_sha256   text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  operation_sha256  text not null check (operation_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_version    text not null,
  bundle_sha256     text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  approved_by       uuid not null,
  approval_text     text not null check (length(btrim(approval_text)) >= 8),
  created_at        timestamptz not null default now(),
  constraint lib_integrations_head_not_self check (head_record_id <> record_id)
);
create trigger lib_integrations_lock before update or delete on invstock.lib_integrations
  for each row execute function invstock_private.lib_immutable();

alter table invstock.lib_integrations enable row level security;
create policy lib_integrations_read on invstock.lib_integrations for select to authenticated
  using ((select invstock_private.is_active_reviewer()));
revoke all on invstock.lib_integrations from public, anon, authenticated;
grant select on invstock.lib_integrations to authenticated;
grant select, insert, update, delete on invstock.lib_integrations to service_role;

-- 2) Loại sự kiện audit mới
alter table invstock.lib_sync_events drop constraint lib_sync_events_event_type_check;
alter table invstock.lib_sync_events add constraint lib_sync_events_event_type_check check (event_type = any (array[
  'approved_synced', 'duplicate', 'validation_failed', 'sync_blocked', 'verified', 'verify_failed',
  'published', 'unpublished', 'superseded', 'withdrawn', 'restored', 'rolled_back',
  'manifest_registered', 'note_imported', 'note_reviewed', 'note_published', 'note_withdrawn', 'operation_imported',
  'integrated']));

-- 3) RPC tích hợp. Chỉ service_role gọi được (Edge Function lib-research-ops, sau requireAdmin).
create function invstock.lib_integrate(
  p_operation_id uuid, p_candidate_bytes bytea, p_manifest_bytes bytea, p_expected_head uuid,
  p_bundle_sha256 text, p_approval_text text, p_actor uuid)
returns jsonb language plpgsql set search_path to '' as $$
declare
  op       invstock.lib_operations;
  prev     invstock.lib_integrations;
  sec      invstock.securities;
  head     invstock.lib_records;
  base_rec invstock.lib_records;
  head_m   invstock.lib_manifests;
  d        jsonb;
  m        jsonb;
  v_cand_sha text := encode(sha256(p_candidate_bytes), 'hex');
  v_man_sha  text := encode(sha256(p_manifest_bytes), 'hex');
  v_bundle   text;
  v_reg      jsonb;
begin
  if p_approval_text is null or length(btrim(p_approval_text)) < 8 then
    raise exception 'approval_text_required' using errcode = 'P0001';
  end if;
  select * into op from invstock.lib_operations where operation_id = p_operation_id;
  if not found then raise exception 'operation_not_found' using errcode = 'P0001'; end if;
  if op.outcome <> 'CANDIDATE_SNAPSHOT' then raise exception 'OUTCOME: operation không phải CANDIDATE_SNAPSHOT' using errcode = 'P0001'; end if;
  select * into sec from invstock.securities where id = op.profile_id;

  -- Khóa theo mã: hai tích hợp cùng mã không chạy song song (compare-and-swap theo head).
  perform pg_advisory_xact_lock(hashtextextended('invstock.lib_integrate:' || op.profile_id::text, 0));

  -- Idempotent: cùng operation + cùng bundle thì trả kết quả cũ; khác bundle thì từ chối.
  select * into prev from invstock.lib_integrations where operation_id = p_operation_id;
  if found then
    if prev.bundle_sha256 = p_bundle_sha256 then
      return jsonb_build_object('status', 'unchanged', 'record_id', prev.record_id, 'bundle_sha256', prev.bundle_sha256);
    end if;
    raise exception 'IMMUTABLE: operation đã được tích hợp với bundle khác' using errcode = 'P0001';
  end if;

  -- Head thực tế của chuỗi (chuỗi tuyến tính nhờ lib_records_one_child) phải đúng head mà admin đã xem.
  select * into head from invstock.lib_records
   where record_type = 'research' and ticker = sec.ticker and exchange is not distinct from sec.exchange
   order by revision desc limit 1;
  if not found or head.record_id <> p_expected_head then
    raise exception 'BASE_STALE: head đã đổi sau khi xem trước, cần xem trước và duyệt lại' using errcode = 'P0001';
  end if;
  select * into base_rec from invstock.lib_records where record_id = op.base_record_id;
  if not found or base_rec.ticker <> head.ticker or base_rec.revision > head.revision then
    raise exception 'BASE_STALE: base không thuộc chuỗi của head' using errcode = 'P0001';
  end if;
  select * into head_m from invstock.lib_manifests where record_id = head.record_id;
  if not found then raise exception 'MANIFEST_MISMATCH: head chưa có manifest' using errcode = 'P0001'; end if;

  -- Bản ứng viên: đúng hash khai báo trong operation, đúng lineage
  if v_cand_sha <> op.payload->'output_refs'->>'candidate_sha256' then
    raise exception 'CANDIDATE_HASH_MISMATCH: bytes ứng viên khác output_refs.candidate_sha256' using errcode = 'P0001';
  end if;
  d := convert_from(p_candidate_bytes, 'UTF8')::jsonb;
  if d->>'schema_name' <> 'invstock_research_v2'
     or (d->'metadata'->>'record_id')::uuid is distinct from (op.payload->'output_refs'->>'candidate_record_id')::uuid
     or (d->'metadata'->>'parent_id')::uuid is distinct from head.record_id
     or (d->'metadata'->>'revision')::int <> head.revision + 1
     or d->'identity'->>'ticker' <> sec.ticker or d->'identity'->>'exchange' is distinct from sec.exchange then
    raise exception 'BASE_STALE: lineage của bản ứng viên không khớp head' using errcode = 'P0001';
  end if;

  -- Manifest: thuộc bản ứng viên và nối tiếp manifest của head (lib_register_manifest kiểm tra từng entry)
  m := convert_from(p_manifest_bytes, 'UTF8')::jsonb;
  if (m->>'record_id')::uuid <> (d->'metadata'->>'record_id')::uuid or m->>'snapshot_sha256' <> v_cand_sha
     or (m->>'parent_manifest_id')::uuid is distinct from head_m.manifest_id then
    raise exception 'MANIFEST_MISMATCH: manifest không thuộc bản ứng viên/head' using errcode = 'P0001';
  end if;

  -- Bundle hash: sha256(JCS{bundle, candidate_sha256, head_record_id, head_sha256, manifest_sha256, operation_sha256})
  v_bundle := encode(sha256(convert_to(
    '{"bundle":"invstock-integration-bundle/v1","candidate_sha256":"' || v_cand_sha ||
    '","head_record_id":"' || head.record_id::text || '","head_sha256":"' || head.sha256 ||
    '","manifest_sha256":"' || v_man_sha || '","operation_sha256":"' || op.sha256 || '"}', 'UTF8')), 'hex');
  if v_bundle <> p_bundle_sha256 then
    raise exception 'APPROVAL_HASH_MISMATCH: bundle khác bản anh/chị đã xem' using errcode = 'P0001';
  end if;

  -- Ghi bản mới. Cột suy ra từ payload giống lib-sync (columns()).
  insert into invstock.lib_records (record_id, record_type, schema_name, schema_version, scorecard_version, ticker, exchange,
    company, sector, revision, parent_id, as_of, cutoff, reporting_period, decision_status, thesis_status, risk_gate,
    price, price_date, fair_value, mos, upside, downside, reward_risk, required_mos, max_buy, target_price,
    score_coverage, normalized_score, official_total, score_confidence, payload, payload_bytes, sha256, approved_by, approval_text)
  values ((d->'metadata'->>'record_id')::uuid, 'research', d->>'schema_name', d->>'schema_version', d->'metadata'->>'scorecard_version',
    d->'identity'->>'ticker', d->'identity'->>'exchange', d->'identity'->>'company', d->'identity'->>'sector',
    (d->'metadata'->>'revision')::int, (d->'metadata'->>'parent_id')::uuid, (d->'metadata'->>'as_of')::date,
    (d->'metadata'->>'cutoff')::date, d->'metadata'->>'reporting_period', d->'decision'->>'status', d->'decision'->>'thesis_status',
    d->'risk'->>'gate', (d->'valuation'->>'price')::numeric, (d->'valuation'->>'price_date')::date,
    (d->'valuation'->>'fair_value')::numeric, (d->'valuation'->>'mos')::numeric, (d->'valuation'->>'upside')::numeric,
    (d->'valuation'->>'downside')::numeric, (d->'valuation'->>'reward_risk')::numeric, (d->'valuation'->>'required_mos')::numeric,
    (d->'valuation'->>'max_buy')::numeric, (d->'valuation'->>'target_price')::numeric, (d->'scorecard'->>'coverage')::numeric,
    (d->'scorecard'->>'normalized_score')::numeric, (d->'scorecard'->>'official_total')::numeric, d->'scorecard'->>'confidence',
    d, p_candidate_bytes, v_cand_sha, p_actor, btrim(p_approval_text));
  insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
  values ((d->'metadata'->>'record_id')::uuid, v_cand_sha, 'approved_synced', p_actor,
    jsonb_build_object('approval_text', btrim(p_approval_text), 'via', 'lib_integrate', 'operation_id', p_operation_id));

  v_reg := invstock.lib_register_manifest(p_manifest_bytes, p_actor);
  if v_reg->>'status' <> 'registered' then
    raise exception 'MANIFEST_MISMATCH: manifest không đăng ký được (%)', v_reg->>'status' using errcode = 'P0001';
  end if;

  insert into invstock.lib_integrations (operation_id, profile_id, base_record_id, head_record_id, record_id, candidate_sha256,
    manifest_id, manifest_sha256, operation_sha256, bundle_version, bundle_sha256, approved_by, approval_text)
  values (p_operation_id, op.profile_id, op.base_record_id, head.record_id, (d->'metadata'->>'record_id')::uuid, v_cand_sha,
    (m->>'manifest_id')::uuid, v_man_sha, op.sha256, 'invstock-integration-bundle/v1', v_bundle, p_actor, btrim(p_approval_text));
  insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
  values ((d->'metadata'->>'record_id')::uuid, v_cand_sha, 'integrated', p_actor,
    jsonb_build_object('operation_id', p_operation_id, 'head_record_id', head.record_id, 'base_record_id', op.base_record_id,
      'manifest_id', m->>'manifest_id', 'bundle_sha256', v_bundle));

  return jsonb_build_object('status', 'integrated', 'record_id', d->'metadata'->>'record_id', 'revision', head.revision + 1,
    'sha256', v_cand_sha, 'manifest_id', m->>'manifest_id', 'bundle_sha256', v_bundle, 'published', false);
end $$;

revoke all on function invstock.lib_integrate(uuid, bytea, bytea, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function invstock.lib_integrate(uuid, bytea, bytea, uuid, text, text, uuid) to service_role;
