// lib-publish: bước xuất bản riêng của admin. Không có tự xuất bản sau sync.
// POST { action: "list" } | { action: "publish", record_id, visibility?: "public" | "members" }  |  { action: "unpublish", lineage_key }
import { cors, json, serviceClient, requireAdmin, HttpError } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const svc = serviceClient();
  try {
    const actor = await requireAdmin(req, svc);
    const body = await req.json().catch(() => ({}));
    const db = svc.schema("invstock");
    let res;
    if (body.action === "list") {
      const [r, p, e] = await Promise.all([
        db.from("lib_records").select("record_id,record_type,ticker,exchange,universe,revision,parent_id,as_of,decision_status,risk_gate,sha256,created_at").order("created_at", { ascending: false }).limit(500),
        db.from("lib_publications").select("lineage_key,record_id,published_at,visibility"),
        db.from("lib_sync_events").select("record_id").eq("event_type", "verified"),
      ]);
      const err = r.error || p.error || e.error;
      if (err) throw err;
      return json({ success: true, records: r.data, publications: p.data, verified: [...new Set(e.data.map((x: any) => x.record_id))] });
    }
    if (body.action === "publish") {
      if (!body.record_id) throw new HttpError(400, "record_id_required");
      res = await db.rpc("lib_publish", { p_record_id: body.record_id, p_actor: actor, p_visibility: body.visibility ?? "public" });
    } else if (body.action === "unpublish") {
      if (!body.lineage_key) throw new HttpError(400, "lineage_key_required");
      res = await db.rpc("lib_unpublish", { p_lineage_key: body.lineage_key, p_actor: actor });
    } else throw new HttpError(400, "unknown_action");
    if (res.error) return json({ success: false, error: res.error.message }, 409);
    return json({ success: true, result: res.data });
  } catch (e) {
    if (e instanceof HttpError) return json({ success: false, error: e.message }, e.status);
    console.error("lib-publish-error", e);
    return json({ success: false, error: "lib_publish_failed" }, 500);
  }
});
