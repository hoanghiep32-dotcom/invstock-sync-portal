-- InvStock Giai đoạn 1 – migration lib_v2_02_drop_v1_and_publish_step
-- Chạy trên database chính (Supabase "Stock Analysis", schema invstock), trong 1 transaction.
-- GIỮ LẠI: securities, market_data_* , daily/intraday_price_bars, market_corporate_actions,
--          user_watchlists, user_watchlist_items, research_reviewers (danh sách admin, v2 vẫn dùng),
--          lib_records, lib_sync_events, lib_publications, lib_scorecard_criteria.

-- 1) Gỡ cơ chế tự xuất bản sau sync
drop trigger if exists trg_auto_publish_approved_research_after_sync on invstock.sync_queue;
drop function if exists invstock.auto_publish_approved_research_after_sync();

-- 2) Xóa RPC/hàm v1
drop function if exists invstock.calculate_scorecard(jsonb);
drop function if exists invstock.commit_approved_screening_snapshot(uuid, jsonb, text, text);
drop function if exists invstock.commit_portal_research_sync(uuid, jsonb, text, text, text);
drop function if exists invstock.create_research_revision(uuid, text);
drop function if exists invstock.ingest_research_payload_v1(jsonb, text, uuid);
drop function if exists invstock.list_pending_research_reviews();
drop function if exists invstock.normalize_research_version_v1(uuid);
drop function if exists invstock.publish_research_version_as_user(uuid, uuid);
drop function if exists invstock.review_research_submission(uuid, text, text, text);
drop function if exists invstock.review_research_submission_as_user(uuid, text, uuid, text);
drop function if exists invstock.submit_research_for_review(uuid, text);
drop function if exists invstock.submit_research_for_sync_as_user(uuid, uuid);
drop function if exists invstock.validate_research_payload(jsonb);
drop function if exists invstock.validate_research_version(uuid);

-- 3) Xóa 20 bảng v1 (không CASCADE: nếu còn phụ thuộc lạ, migration dừng và rollback)
drop table invstock.research_criterion_scores, invstock.research_scorecards,
           invstock.scorecard_criteria, invstock.scorecard_frameworks,
           invstock.research_json_standards, invstock.research_sync_approvals,
           invstock.research_workflow_events, invstock.research_publications,
           invstock.research_sections, invstock.research_sources,
           invstock.financial_snapshots, invstock.valuation_scenarios,
           invstock.signal_events, invstock.investment_decisions,
           invstock.research_versions, invstock.research_sessions,
           invstock.sync_queue, invstock.audit_log,
           invstock.screening_candidates, invstock.screening_runs;
drop function if exists invstock.guard_research_version_content();
drop function if exists invstock.prevent_workflow_event_mutation();

-- 4) Thu quyền is_active_reviewer: chuyển sang schema riêng không mở ra API
create schema if not exists invstock_private;
revoke all on schema invstock_private from public, anon;
grant usage on schema invstock_private to authenticated, service_role;
create or replace function invstock_private.is_active_reviewer()
returns boolean language sql stable security definer set search_path to ''
as $$ select exists (select 1 from invstock.research_reviewers r
                     where r.user_id = (select auth.uid()) and r.is_active); $$;
revoke all on function invstock_private.is_active_reviewer() from public, anon;
grant execute on function invstock_private.is_active_reviewer() to authenticated, service_role;
alter policy lib_criteria_read    on invstock.lib_scorecard_criteria using ((select invstock_private.is_active_reviewer()));
alter policy lib_records_read     on invstock.lib_records            using ((select invstock_private.is_active_reviewer()));
alter policy lib_events_read      on invstock.lib_sync_events        using ((select invstock_private.is_active_reviewer()));
alter policy lib_publications_read on invstock.lib_publications      using ((select invstock_private.is_active_reviewer()));
drop function invstock.is_active_reviewer();

-- 5) Trường visibility (public / members) cho bản công bố
alter table invstock.lib_publications
  add column visibility text not null default 'public' check (visibility in ('public','members'));

-- 6) Bước xuất bản riêng (chỉ service_role gọi, qua Edge Function lib-publish do admin bấm)
create or replace function invstock.lib_publish(p_record_id uuid, p_actor uuid, p_visibility text default 'public')
returns jsonb language plpgsql set search_path to '' as $$
declare r invstock.lib_records; v_root uuid; v_key text;
begin
  if p_visibility not in ('public','members') then raise exception 'invalid_visibility'; end if;
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
  insert into invstock.lib_publications (lineage_key, record_id, published_by, visibility)
  values (v_key, p_record_id, p_actor, p_visibility)
  on conflict (lineage_key) do update
    set record_id = excluded.record_id, published_at = now(),
        published_by = excluded.published_by, visibility = excluded.visibility;
  insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
  values (p_record_id, r.sha256, 'published', p_actor,
          jsonb_build_object('lineage_key', v_key, 'visibility', p_visibility));
  return jsonb_build_object('lineage_key', v_key, 'record_id', p_record_id,
                            'sha256', r.sha256, 'visibility', p_visibility);
end; $$;

create or replace function invstock.lib_unpublish(p_lineage_key text, p_actor uuid)
returns jsonb language plpgsql set search_path to '' as $$
declare v_record uuid; v_sha text;
begin
  if not exists (select 1 from invstock.research_reviewers x
                 where x.user_id = p_actor and x.is_active and x.reviewer_role = 'admin') then
    raise exception 'actor_not_admin';
  end if;
  delete from invstock.lib_publications where lineage_key = p_lineage_key returning record_id into v_record;
  if v_record is null then raise exception 'publication_not_found'; end if;
  select sha256 into v_sha from invstock.lib_records where record_id = v_record;
  insert into invstock.lib_sync_events (record_id, sha256, event_type, actor, details)
  values (v_record, v_sha, 'unpublished', p_actor, jsonb_build_object('lineage_key', p_lineage_key));
  return jsonb_build_object('lineage_key', p_lineage_key, 'record_id', v_record);
end; $$;

revoke all on function invstock.lib_publish(uuid, uuid, text) from public, anon, authenticated;
revoke all on function invstock.lib_unpublish(text, uuid) from public, anon, authenticated;
grant execute on function invstock.lib_publish(uuid, uuid, text) to service_role;
grant execute on function invstock.lib_unpublish(text, uuid) to service_role;
