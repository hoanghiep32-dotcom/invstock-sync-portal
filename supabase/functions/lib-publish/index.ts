// lib-publish: bước xuất bản riêng của admin. Không có tự xuất bản sau sync.
// POST { action: "list" }
//    | { action: "publish", record_id, visibility?: "public" | "members", expected_current_record_id?: uuid | null, reason?: string }
//    | { action: "withdraw", record_id, reason }          (thu hồi; không tự đưa bản cũ lên current)
//    | { action: "unpublish", lineage_key }               (giữ cho giao diện cũ = thu hồi bản current)
// Có khóa expected_current_record_id (kể cả null) thì DB từ chối khi current đã bị người khác đổi (current_changed).
// Đưa bản cũ trở lại (rolled_back) hoặc khôi phục bản đã thu hồi (restored) bắt buộc có reason.
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
      const [r, p, e, h] = await Promise.all([
        db.from("lib_records").select("record_id,record_type,ticker,exchange,universe,revision,parent_id,as_of,decision_status,risk_gate,sha256,created_at").order("created_at", { ascending: false }).limit(500),
        db.from("lib_publications").select("lineage_key,record_id,published_at,visibility"),
        db.from("lib_sync_events").select("record_id").eq("event_type", "verified"),
        db.from("lib_record_publications").select("record_id,lineage_key,role,visibility,first_published_at,became_current_at,superseded_at,withdrawn_at,withdraw_reason"),
      ]);
      const err = r.error || p.error || e.error || h.error;
      if (err) throw err;
      return json({ success: true, records: r.data, publications: p.data, record_publications: h.data, verified: [...new Set(e.data.map((x: any) => x.record_id))] });
    }
    if (body.action === "publish") {
      if (!body.record_id) throw new HttpError(400, "record_id_required");
      const check = Object.prototype.hasOwnProperty.call(body, "expected_current_record_id");
      res = await db.rpc("lib_publish", {
        p_record_id: body.record_id, p_actor: actor, p_visibility: body.visibility ?? "public",
        p_expected_current: check ? body.expected_current_record_id ?? null : null, p_check_current: check,
        p_reason: typeof body.reason === "string" ? body.reason : null,
      });
    } else if (body.action === "withdraw") {
      if (!body.record_id) throw new HttpError(400, "record_id_required");
      res = await db.rpc("lib_withdraw", { p_record_id: body.record_id, p_actor: actor, p_reason: typeof body.reason === "string" ? body.reason : "" });
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
