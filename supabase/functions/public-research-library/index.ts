// public-research-library v2: chỉ đọc bản đã xuất bản (lib_publications). Khách xem 'public';
// người đã đăng nhập xem thêm 'members'.
// GET ?action=list | ?action=research&ticker=FPT[&exchange=HOSE] | ?action=screening&lineage_key=... | ?action=criteria
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
    if (action === "list") {
      const { data, error } = await db.from("lib_publications")
        .select(`lineage_key,published_at,visibility,record:lib_records(${SUMMARY})`).in("visibility", vis)
        .order("published_at", { ascending: false }).limit(500);
      if (error) throw error;
      const items = (data ?? []).map((p: any) => ({ lineage_key: p.lineage_key, published_at: p.published_at, visibility: p.visibility, ...p.record }));
      return json({ success: true, research: items.filter((i) => i.record_type === "research"), screenings: items.filter((i) => i.record_type === "screening") }, 200, cache);
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
    return json({ success: true, lineage_key: data.lineage_key, published_at: data.published_at, visibility: data.visibility, ...(data as any).record }, 200, cache);
  } catch (e) {
    console.error("public-library-read-error", e);
    return json({ error: "public_library_read_failed" }, 500);
  }
});
