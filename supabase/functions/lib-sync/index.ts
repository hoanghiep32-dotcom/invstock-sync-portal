// lib-sync: PREVIEW -> (người dùng duyệt đúng SHA-256) -> SYNC -> VERIFY, theo file 08 của framework v2.0.0.
// POST { action: "preview" | "sync", payload_base64 | payload_text, approved_sha256?, approval_text? }
import Ajv2020 from "npm:ajv@8.17.1/dist/2020.js";
import addFormats from "npm:ajv-formats@3.0.1";
import researchSchema from "../_shared/research_schema.json" with { type: "json" };
import screeningSchema from "../_shared/screening_schema.json" with { type: "json" };
import scorecardFramework from "../_shared/scorecard_framework.json" with { type: "json" };
import { makeValidator } from "../_shared/validator.js";
import { cors, json, serviceClient, requireAdmin, HttpError, sha256Hex, toHex, fromPgBytea } from "../_shared/common.ts";

const validate = makeValidator(Ajv2020, addFormats, { research: researchSchema, screening: screeningSchema }, scorecardFramework);
const MAX_BYTES = 2_000_000;

function columns(d: any) {
  const m = d.metadata;
  const base = {
    record_id: m.record_id, schema_name: d.schema_name, schema_version: d.schema_version,
    scorecard_version: m.scorecard_version, revision: m.revision, parent_id: m.parent_id,
    as_of: m.as_of, cutoff: m.cutoff, reporting_period: m.reporting_period,
  };
  if (d.schema_name === "invstock_research_v2") {
    const v = d.valuation, s = d.scorecard;
    return { ...base, record_type: "research",
      ticker: d.identity.ticker, exchange: d.identity.exchange, company: d.identity.company, sector: d.identity.sector,
      decision_status: d.decision.status, thesis_status: d.decision.thesis_status, risk_gate: d.risk.gate,
      price: v.price, price_date: v.price_date, fair_value: v.fair_value, mos: v.mos, upside: v.upside,
      downside: v.downside, reward_risk: v.reward_risk, required_mos: v.required_mos, max_buy: v.max_buy,
      target_price: v.target_price, score_coverage: s.coverage, normalized_score: s.normalized_score,
      official_total: s.official_total, score_confidence: s.confidence };
  }
  return { ...base, record_type: "screening", universe: d.universe, strategy: d.strategy, candidate_count: d.candidates.length };
}

function readPayload(body: any): { bytes: Uint8Array; text: string } {
  // Ưu tiên payload_base64 (bytes nguyên văn của file); payload_text chỉ dùng khi dán tay.
  if (typeof body.payload_base64 === "string" && body.payload_base64.length) {
    const bin = atob(body.payload_base64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new HttpError(400, "payload_not_utf8"); }
    return { bytes, text };
  }
  if (typeof body.payload_text === "string" && body.payload_text.length)
    return { bytes: new TextEncoder().encode(body.payload_text), text: body.payload_text };
  throw new HttpError(400, "payload_required");
}

async function prepare(db: any, body: any) {
  const { bytes, text: payloadText } = readPayload(body);
  if (bytes.length > MAX_BYTES) throw new HttpError(413, "payload_too_large");
  const sha256 = await sha256Hex(bytes);
  let d: any;
  try { d = JSON.parse(payloadText); } catch { return { sha256, bytes, valid: false, errors: ["invalid_json"] }; }
  const errors = validate(d);
  if (errors.length) return { sha256, bytes, valid: false, errors };
  const cols = columns(d);
  const blockers: string[] = [];
  const { data: dupSha } = await db.from("lib_records").select("record_id").eq("sha256", sha256).maybeSingle();
  if (dupSha) blockers.push("duplicate_sha256");
  const { data: dupId } = await db.from("lib_records").select("record_id").eq("record_id", cols.record_id).maybeSingle();
  if (dupId && !dupSha) blockers.push("record_id_already_used");
  let parent: any = null;
  if (cols.parent_id) {
    const { data: p } = await db.from("lib_records").select("record_id,record_type,ticker,exchange,revision,sha256").eq("record_id", cols.parent_id).maybeSingle();
    parent = p;
    if (!p) blockers.push("parent_not_in_library");
    else {
      if (p.revision !== cols.revision - 1) blockers.push("parent_revision_mismatch");
      if (p.record_type !== cols.record_type || p.ticker !== ((cols as any).ticker ?? null) || p.exchange !== ((cols as any).exchange ?? null)) blockers.push("parent_lineage_mismatch");
      const { data: child } = await db.from("lib_records").select("record_id").eq("parent_id", cols.parent_id).maybeSingle();
      if (child) blockers.push("parent_already_has_child");
    }
  } else if (cols.record_type === "research") {
    const { data: r1 } = await db.from("lib_records").select("record_id").eq("record_type", "research")
      .eq("ticker", (cols as any).ticker).eq("exchange", (cols as any).exchange).eq("revision", 1).maybeSingle();
    if (r1) blockers.push("revision_1_already_exists");
  }
  return { sha256, bytes, valid: true, errors: [], cols, parent, blockers, duplicate: Boolean(dupSha) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const svc = serviceClient();
  const db = svc.schema("invstock");
  let actor: string | null = null;
  try {
    actor = await requireAdmin(req, svc);
    const body = await req.json().catch(() => ({}));
    const p = await prepare(db, body);
    const preview = { sha256: p.sha256, bytes: p.bytes.length, valid: p.valid, errors: p.errors,
      record: p.cols ?? null, parent: p.parent ?? null, blockers: p.blockers ?? [], intended: p.valid ? "INSERT invstock.lib_records" : null };
    if (body.action === "preview") return json({ success: true, stage: "PREVIEW", ...preview });
    if (body.action !== "sync") throw new HttpError(400, "unknown_action");

    // SYNC
    if (!p.valid) {
      await db.from("lib_sync_events").insert({ sha256: p.sha256, event_type: "validation_failed", actor, details: { errors: p.errors.slice(0, 50) } });
      return json({ success: false, stage: "VALIDATE", ...preview }, 422);
    }
    if (p.duplicate) {
      await db.from("lib_sync_events").insert({ sha256: p.sha256, event_type: "duplicate", actor, details: {} });
      return json({ success: false, stage: "SYNC_BLOCKED", ...preview, error: "duplicate_sha256" }, 409);
    }
    if (body.approved_sha256 !== p.sha256) throw new HttpError(409, "approved_hash_mismatch", { expected: p.sha256 });
    const approvalText = String(body.approval_text ?? "").trim();
    if (approvalText.length < 8) throw new HttpError(400, "approval_text_required");
    if (p.blockers!.length) {
      await db.from("lib_sync_events").insert({ sha256: p.sha256, event_type: "sync_blocked", actor, details: { blockers: p.blockers } });
      return json({ success: false, stage: "SYNC_BLOCKED", ...preview }, 409);
    }
    const row = { ...p.cols, payload: JSON.parse(readPayload(body).text), payload_bytes: "\\x" + toHex(p.bytes),
      sha256: p.sha256, approved_by: actor, approval_text: approvalText };
    const { error: ie } = await db.from("lib_records").insert(row);
    if (ie) {
      await db.from("lib_sync_events").insert({ sha256: p.sha256, event_type: "sync_blocked", actor, details: { db_error: ie.message } });
      return json({ success: false, stage: "SYNC_BLOCKED", ...preview, error: ie.message }, 409);
    }
    await db.from("lib_sync_events").insert({ record_id: p.cols!.record_id, sha256: p.sha256, event_type: "approved_synced", actor, details: { approval_text: approvalText } });

    // VERIFY: đọc lại record_id, revision, hash và payload bytes
    const { data: back, error: be } = await db.from("lib_records").select("record_id,revision,sha256,payload_bytes").eq("record_id", p.cols!.record_id).single();
    const backSha = back ? await sha256Hex(fromPgBytea(back.payload_bytes)) : null;
    const ok = !be && back.revision === p.cols!.revision && back.sha256 === p.sha256 && backSha === p.sha256;
    await db.from("lib_sync_events").insert({ record_id: p.cols!.record_id, sha256: p.sha256, event_type: ok ? "verified" : "verify_failed", actor, details: { read_back_sha256: backSha } });
    return json({ success: ok, stage: ok ? "SYNCED_VERIFIED" : "VERIFY_FAILED", ...preview, read_back_sha256: backSha }, ok ? 200 : 500);
  } catch (e) {
    if (e instanceof HttpError) return json({ success: false, error: e.message, details: e.details ?? null }, e.status);
    console.error("lib-sync-error", e);
    return json({ success: false, error: "lib_sync_failed" }, 500);
  }
});
