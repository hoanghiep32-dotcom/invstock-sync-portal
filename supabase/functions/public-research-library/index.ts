// public-research-library v4: chỉ đọc bản đã xuất bản. Khách xem 'public'; người đã đăng nhập xem thêm 'members'.
// GET ?action=list | ?action=research&ticker=FPT[&exchange=HOSE] | ?action=screening&lineage_key=...
//     ?action=history&ticker=FPT[&exchange=HOSE] | ?action=history&lineage_key=...   (các bản từng xuất bản của chuỗi)
//     ?action=record&id=<record_id>                                                 (đường dẫn cố định một bản)
//     ?action=criteria | ?action=glossary
// Bản đã thu hồi (withdrawn) không bao giờ trả nội dung; chỉ trả ngày thu hồi cho người có quyền xem bản đó.
import { cors, json, serviceClient, callerId } from "../_shared/common.ts";

const SUMMARY = "record_id,record_type,ticker,exchange,company,sector,universe,strategy,revision,as_of,cutoff,reporting_period," +
  "decision_status,thesis_status,risk_gate,price,price_date,fair_value,mos,upside,downside,reward_risk,required_mos,max_buy," +
  "target_price,score_coverage,normalized_score,official_total,score_confidence,candidate_count,sha256,schema_version,scorecard_version";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  try {
    const svc = serviceClient();
    const db = svc.schema("invstock");
    const signedIn = Boolean(await callerId(req, svc));
    const vis = signedIn ? ["public", "members"] : ["public"];
    const cache = signedIn ? { "Cache-Control": "private, no-store" } : { "Cache-Control": "public, max-age=60, s-maxage=60" };
    const q = new URL(req.url).searchParams;
    const action = q.get("action") ?? "list";

    if (action === "criteria") {
      const { data, error } = await db.from("lib_scorecard_criteria").select("criterion_id,name,weight,grp,is_critical,rubric_version").order("criterion_id");
      if (error) throw error;
      return json({ success: true, criteria: data }, 200, cache);
    }
    if (action === "glossary") {
      const { data, error } = await db.from("lib_glossary_terms")
        .select("slug,term,full_name,vi_name,industry,aliases,short_def,body,formula,example,related,auto_link,match_case,updated_at")
        .eq("is_published", true).order("term");
      if (error) throw error;
      return json({ success: true, terms: data }, 200, { "Cache-Control": "public, max-age=300, s-maxage=300" });
    }
    if (action === "list") {
      const { data, error } = await db.from("lib_publications")
        .select(`lineage_key,published_at,visibility,record:lib_records(${SUMMARY})`).in("visibility", vis)
        .order("published_at", { ascending: false }).limit(500);
      if (error) throw error;
      const items = (data ?? []).map((p: any) => ({ lineage_key: p.lineage_key, published_at: p.published_at, visibility: p.visibility, ...p.record }));
      return json({ success: true, research: items.filter((i) => i.record_type === "research"), screenings: items.filter((i) => i.record_type === "screening") }, 200, cache);
    }
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (action === "record") {
      const id = (q.get("id") ?? "").trim().toLowerCase();
      if (!UUID.test(id)) return json({ error: "id_required" }, 400);
      const { data, error } = await db.from("lib_record_publications")
        .select(`lineage_key,role,visibility,first_published_at,became_current_at,superseded_at,superseded_by,withdrawn_at,record:lib_records!lib_record_publications_record_id_fkey(${SUMMARY},payload)`)
        .eq("record_id", id).in("visibility", vis).maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "published_record_not_found" }, 404, cache);
      if (data.role === "withdrawn") return json({ error: "record_withdrawn", withdrawn_at: data.withdrawn_at }, 410, cache);
      const { data: cur } = await db.from("lib_publications").select("record_id,visibility").eq("lineage_key", data.lineage_key).maybeSingle();
      const current_record_id = cur && vis.includes(cur.visibility) ? cur.record_id : null;
      const { record, ...pub } = data as any;
      return json({ success: true, ...pub, published_at: pub.became_current_at, current_record_id, ...record }, 200, cache);
    }
    if (action === "history") {
      let lk = q.get("lineage_key");
      if (!lk) {
        const t = (q.get("ticker") ?? "").trim().toUpperCase();
        if (!/^[A-Z0-9]{2,10}$/.test(t)) return json({ error: "ticker_required" }, 400);
        lk = `research:${t}:${(q.get("exchange") ?? "HOSE").toUpperCase()}`;
      }
      const { data, error } = await db.from("lib_record_publications")
        .select(`record_id,role,visibility,first_published_at,became_current_at,superseded_at,superseded_by,withdrawn_at,` +
          `record:lib_records!lib_record_publications_record_id_fkey(${SUMMARY},change_log:payload->metadata->change_log)`)
        .eq("lineage_key", lk).in("visibility", vis).order("first_published_at", { ascending: true });
      if (error) throw error;
      // Bản đã thu hồi: chỉ giữ revision và các mốc thời gian, không trả số liệu.
      const items = (data ?? []).map((p: any) => p.role === "withdrawn"
        ? { record_id: p.record_id, role: p.role, revision: p.record?.revision, first_published_at: p.first_published_at, withdrawn_at: p.withdrawn_at }
        : { ...p.record, record_id: p.record_id, role: p.role, visibility: p.visibility, first_published_at: p.first_published_at,
            became_current_at: p.became_current_at, superseded_at: p.superseded_at, superseded_by: p.superseded_by });
      items.sort((a: any, b: any) => (a.revision ?? 0) - (b.revision ?? 0));
      return json({ success: true, lineage_key: lk, items }, 200, cache);
    }
    let key: string | null = null;
    if (action === "research") {
      const t = (q.get("ticker") ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9]{2,10}$/.test(t)) return json({ error: "ticker_required" }, 400);
      key = `research:${t}:${(q.get("exchange") ?? "HOSE").toUpperCase()}`;
    } else if (action === "screening") key = q.get("lineage_key");
    else return json({ error: "unknown_action" }, 400);
    if (!key) return json({ error: "lineage_key_required" }, 400);
    const { data, error } = await db.from("lib_publications")
      .select(`lineage_key,published_at,visibility,record:lib_records(${SUMMARY},payload)`).eq("lineage_key", key).in("visibility", vis).maybeSingle();
    if (error) throw error;
    if (!data) return json({ error: "published_record_not_found" }, 404, cache);
    return json({ success: true, lineage_key: data.lineage_key, published_at: data.published_at, visibility: data.visibility, role: "current", ...(data as any).record }, 200, cache);
  } catch (e) {
    console.error("public-library-read-error", e);
    return json({ error: "public_library_read_failed" }, 500);
  }
});
