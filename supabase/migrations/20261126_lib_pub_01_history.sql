-- InvStock GĐ 1 – Publication History (tài liệu 12, mục 4 và 6.1).
-- Chỉ THÊM: không xóa bản ghi, không sửa bytes/hash. Chạy trong 1 transaction.
-- Backup trước khi chạy: schema invstock_backup.*_20261126.
--
-- Mô hình:
--   lib_publications          = con trỏ CURRENT (mỗi chuỗi tối đa 1 bản, như cũ, API cũ vẫn chạy).
--   lib_record_publications   = vai trò xuất bản của TỪNG bản: current / historical / withdrawn.
--   lib_sync_events           = nhật ký audit (thêm loại superseded / withdrawn / restored / rolled_back).

-- 1) Vai trò xuất bản của từng bản
create table invstock.lib_record_publications (
  record_id          uuid primary key references invstock.lib_records(record_id),
  lineage_key        text not null,
  role               text not null check (role in ('current', 'historical', 'withdrawn')),
  visibility         text not null check (visibility in ('public', 'members')),
  first_published_at timestamptz not null default now(),
  first_published_by uuid,
  became_current_at  timestamptz not null default now(),
  superseded_at      timestamptz,
  superseded_by      uuid references invstock.lib_records(record_id),
  withdrawn_at       timestamptz,
  withdrawn_by       uuid,
  withdraw_reason    text,
  approved_sha256    text not null check (approved_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at         timestamptz not null default now(),
  constraint lib_rp_withdrawn_reason check (role <> 'withdrawn' or length(btrim(coalesce(withdraw_reason, ''))) > 0)
);
create unique index lib_record_publications_one_current on invstock.lib_record_publications (lineage_key) where role = 'current';
create index lib_record_publications_lineage on invstock.lib_record_publications (lineage_key, first_published_at);
alter table invstock.lib_record_publications enable row level security;
create policy lib_record_publications_read on invstock.lib_record_publications
  for select to authenticated using ((select invstock_private.is_active_reviewer()));
revoke all on invstock.lib_record_publications from public, anon, authenticated;
grant select on invstock.lib_record_publications to authenticated;
grant select, insert, update, delete on invstock.lib_record_publications to service_role;

-- 2) Thêm loại sự kiện audit
alter table invstock.lib_sync_events drop constraint lib_sync_events_event_type_check;
alter table invstock.lib_sync_events add constraint lib_sync_events_event_type_check check (event_type = any (array[
  'approved_synced', 'duplicate', 'validation_failed', 'sync_blocked', 'verified', 'verify_failed',
  'published', 'unpublished', 'superseded', 'withdrawn', 'restored', 'rolled_back']));

-- 3) Toàn vẹn lineage ở mức DB (lib-sync đã kiểm tra, nay chặn cả khi hai lần sync chạy song song)
create unique index lib_records_one_child on invstock.lib_records (parent_id) where parent_id is not null;
create unique index lib_records_one_root_research on invstock.lib_records (ticker, exchange) where record_type = 'research' and revision = 1;

-- 4) Dựng lại lịch sử từ nhật ký 'published' hiện có
with pubs as (
  select record_id, details->>'lineage_key' as lk, created_at, actor, details->>'visibility' as vis,
         row_number() over (partition by record_id order by created_at) as rn_first,
         row_number() over (partition by record_id order by created_at desc) as rn_last
  from invstock.lib_sync_events where event_type = 'published' and record_id is not null
), agg as (
  select f.record_id, f.lk, f.created_at as first_at, f.actor as first_by, l.created_at as last_at, coalesce(l.vis, 'public') as vis
  from pubs f join pubs l on l.record_id = f.record_id and l.rn_last = 1
  where f.rn_first = 1
)
insert into invstock.lib_record_publications (record_id, lineage_key, role, visibility, first_published_at, first_published_by,
  became_current_at, superseded_at, superseded_by, withdrawn_at, withdraw_reason, approved_sha256)
select a.record_id, a.lk,
       case when cur.record_id = a.record_id then 'current' when cur.record_id is not null then 'historical' else 'withdrawn' end,
       case when cur.record_id = a.record_id then cur.visibility else a.vis end,
       a.first_at, a.first_by, a.last_at,
       case when cur.record_id is not null and cur.record_id <> a.record_id then cur.published_at end,
       case when cur.record_id is not null and cur.record_id <> a.record_id then cur.record_id end,
       case when cur.record_id is null then coalesce((select max(e.created_at) from invstock.lib_sync_events e
              where e.record_id = a.record_id and e.event_type = 'unpublished'), a.last_at) end,
       case when cur.record_id is null then 'Gỡ xuất bản trước khi có lịch sử xuất bản' end,
       r.sha256
from agg a
join invstock.lib_records r on r.record_id = a.record_id
left join invstock.lib_publications cur on cur.lineage_key = a.lk;

-- 5) Xuất bản: một transaction, khóa theo chuỗi, compare-and-swap con trỏ current
drop function invstock.lib_publish(uuid, uuid, text);
create function invstock.lib_publish(
  p_record_id uuid, p_actor uuid, p_visibility text default 'public',
  p_expected_current uuid default null, p_check_current boolean default false, p_reason text default null)
returns jsonb language plpgsql set search_path to '' as $$
declare
  r invstock.lib_records; v_root uuid; v_key text;
  v_cur invstock.lib_publications; v_cur_rev integer; v_prev_role text; v_action text;
begin
  if p_visibility not in ('public', 'members') then raise exception 'invalid_visibility'; end if;
  if not exists (select 1 from invstock.research_reviewers x
                 where x.user_id = p_actor and x.is_active and x.reviewer_role = 'admin') then
    raise exception 'actor_not_admin';
  end if;
  select * into r from invstock.lib_records where record_id = p_record_id;
  if not found then raise exception 'record_not_found'; end if;
  if not exists (select 1 from invstock.lib_sync_events e
                 where e.record_id = p_record_id and e.event_type = 'verified') then
    raise exception 'record_not_verified';
  end if;
  if r.record_type = 'research' then
    v_key := 'research:' || r.ticker || ':' || r.exchange;
  else
    with recursive up as (
      select record_id, parent_id from invstock.lib_records where record_id = p_record_id
      union all
      select l.record_id, l.parent_id from invstock.lib_records l join up on l.record_id = up.parent_id)
    select record_id into v_root from up where parent_id is null;
    v_key := 'screening:' || v_root::text;
  end if;

  -- Hai admin xuất bản cùng lúc: người sau chờ, rồi thấy current đã đổi.
  perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
  select * into v_cur from invstock.lib_publications where lineage_key = v_key for update;
  if p_check_current and v_cur.record_id is distinct from p_expected_current then
    raise exception 'current_changed' using detail = coalesce(v_cur.record_id::text, 'none');
  end if;

  -- Gửi lại cùng yêu cầu: không tạo sự kiện trùng.
  if v_cur.record_id = p_record_id then
    if v_cur.visibility = p_visibility then
      return jsonb_build_object('lineage_key', v_key, 'record_id', p_record_id, 'sha256', r.sha256,
                                'visibility', p_visibility, 'unchanged', true);
    end if;
    update invstock.lib_publications set visibility = p_visibility where lineage_key = v_key;
    update invstock.lib_record_publications set visibility = p_visibility, updated_at = now() where record_id = p_record_id;
    insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
    values (p_record_id, r.sha256, 'published', p_actor,
            jsonb_build_object('lineage_key', v_key, 'visibility', p_visibility, 'visibility_change', true));
    return jsonb_build_object('lineage_key', v_key, 'record_id', p_record_id, 'sha256', r.sha256, 'visibility', p_visibility);
  end if;

  if v_cur.record_id is not null then
    select revision into v_cur_rev from invstock.lib_records where record_id = v_cur.record_id;
  end if;
  select role into v_prev_role from invstock.lib_record_publications where record_id = p_record_id;
  v_action := case when v_prev_role = 'withdrawn' then 'restored'
                   when v_cur_rev is not null and r.revision < v_cur_rev then 'rolled_back'
                   else 'published' end;
  if v_action <> 'published' and length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'reason_required' using detail = v_action;
  end if;

  if v_cur.record_id is not null then
    update invstock.lib_record_publications
       set role = 'historical', superseded_at = now(), superseded_by = p_record_id, updated_at = now()
     where record_id = v_cur.record_id;
    insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
    select v_cur.record_id, x.sha256, 'superseded', p_actor, jsonb_build_object('lineage_key', v_key, 'superseded_by', p_record_id)
    from invstock.lib_records x where x.record_id = v_cur.record_id;
  end if;

  insert into invstock.lib_record_publications (record_id, lineage_key, role, visibility, first_published_by, approved_sha256)
  values (p_record_id, v_key, 'current', p_visibility, p_actor, r.sha256)
  on conflict (record_id) do update
    set role = 'current', visibility = excluded.visibility, became_current_at = now(),
        superseded_at = null, superseded_by = null, withdrawn_at = null, withdrawn_by = null, withdraw_reason = null,
        updated_at = now();

  insert into invstock.lib_publications (lineage_key, record_id, published_by, visibility)
  values (v_key, p_record_id, p_actor, p_visibility)
  on conflict (lineage_key) do update
    set record_id = excluded.record_id, published_at = now(),
        published_by = excluded.published_by, visibility = excluded.visibility;

  insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
  values (p_record_id, r.sha256, v_action, p_actor,
          jsonb_build_object('lineage_key', v_key, 'visibility', p_visibility, 'replaced', v_cur.record_id, 'reason', p_reason));
  return jsonb_build_object('lineage_key', v_key, 'record_id', p_record_id, 'sha256', r.sha256,
                            'visibility', p_visibility, 'action', v_action, 'replaced', v_cur.record_id);
end; $$;

-- 6) Thu hồi một bản (current hoặc historical). Không tự đưa bản cũ lên current.
create function invstock.lib_withdraw(p_record_id uuid, p_actor uuid, p_reason text)
returns jsonb language plpgsql set search_path to '' as $$
declare rp invstock.lib_record_publications; v_sha text;
begin
  if not exists (select 1 from invstock.research_reviewers x
                 where x.user_id = p_actor and x.is_active and x.reviewer_role = 'admin') then
    raise exception 'actor_not_admin';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
  select * into rp from invstock.lib_record_publications where record_id = p_record_id;
  if not found then raise exception 'publication_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(rp.lineage_key, 0));
  select * into rp from invstock.lib_record_publications where record_id = p_record_id for update;
  if rp.role = 'withdrawn' then
    return jsonb_build_object('record_id', p_record_id, 'role', 'withdrawn', 'unchanged', true);
  end if;
  if rp.role = 'current' then
    delete from invstock.lib_publications where lineage_key = rp.lineage_key and record_id = p_record_id;
  end if;
  update invstock.lib_record_publications
     set role = 'withdrawn', withdrawn_at = now(), withdrawn_by = p_actor, withdraw_reason = btrim(p_reason), updated_at = now()
   where record_id = p_record_id;
  select sha256 into v_sha from invstock.lib_records where record_id = p_record_id;
  insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
  values (p_record_id, v_sha, 'withdrawn', p_actor,
          jsonb_build_object('lineage_key', rp.lineage_key, 'was_role', rp.role, 'reason', btrim(p_reason)));
  return jsonb_build_object('record_id', p_record_id, 'lineage_key', rp.lineage_key, 'was_role', rp.role, 'role', 'withdrawn');
end; $$;

-- 7) lib_unpublish cũ (giao diện admin cũ) = thu hồi bản current, có lý do mặc định.
create or replace function invstock.lib_unpublish(p_lineage_key text, p_actor uuid)
returns jsonb language plpgsql set search_path to '' as $$
declare v_record uuid;
begin
  select record_id into v_record from invstock.lib_publications where lineage_key = p_lineage_key;
  if v_record is null then raise exception 'publication_not_found'; end if;
  return invstock.lib_withdraw(v_record, p_actor, 'Gỡ xuất bản từ trang admin');
end; $$;

revoke all on function invstock.lib_publish(uuid, uuid, text, uuid, boolean, text) from public, anon, authenticated;
revoke all on function invstock.lib_withdraw(uuid, uuid, text) from public, anon, authenticated;
revoke all on function invstock.lib_unpublish(text, uuid) from public, anon, authenticated;
grant execute on function invstock.lib_publish(uuid, uuid, text, uuid, boolean, text) to service_role;
grant execute on function invstock.lib_withdraw(uuid, uuid, text) to service_role;
grant execute on function invstock.lib_unpublish(text, uuid) to service_role;
