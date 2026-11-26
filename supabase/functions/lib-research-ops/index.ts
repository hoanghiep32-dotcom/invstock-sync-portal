// lib-research-ops: GĐ 3–4 (tài liệu 13). Chỉ admin. Không bao giờ publish snapshot, không sửa lib_records.
// POST { action: "list", ticker? }                                    notes + operations + manifests của mã
//    | { action: "build_manifest", record_id }                        dựng manifest từ bytes gốc trên DB rồi đăng ký (idempotent)
//    | { action: "verify_manifest", record_id }                       dựng lại và so bytes với manifest đã lưu
//    | { action: "validate_note", text } | { action: "import_note", text }
//    | { action: "review_note", note_version_id, expected_sha256, decision: "approved"|"rejected", note? }
//    | { action: "publish_note", note_version_id, expected_sha256, visibility }
//    | { action: "withdraw_note", note_version_id, reason }
//    | { action: "validate_operation", text } | { action: "import_operation", text }
// `text` là nguyên văn file JSON; bytes lưu đúng như gửi lên (UTF-8), sha256 tính trên bytes đó.
import Ajv2020 from "npm:ajv@8.17.1/dist/2020.js";
import defs from "../_shared/contracts/defs.schema.json" with { type: "json" };
import noteSchema from "../_shared/contracts/research_note.schema.json" with { type: "json" };
import opSchema from "../_shared/contracts/research_operation.schema.json" with { type: "json" };
import manifestSchema from "../_shared/contracts/snapshot_manifest.schema.json" with { type: "json" };
import * as C from "../_shared/contracts/contracts.js";
import { cors, json, serviceClient, requireAdmin, HttpError, fromPgBytea, toHex } from "../_shared/common.ts";

const V = C.makeContractValidators(Ajv2020, { defs, note: noteSchema, operation: opSchema, manifest: manifestSchema });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const enc = new TextEncoder();
const asBytea = (b: Uint8Array) => "\\x" + toHex(b);
const uuidArg = (v: unknown, name: string) => {
  if (typeof v !== "string" || !UUID.test(v)) throw new HttpError(400, `${name}_required`);
  return v;
};

async function loadRecord(db: any, id: string) {
  const { data, error } = await db.from("lib_records").select("record_id,ticker,exchange,revision,parent_id,sha256,payload_bytes")
    .eq("record_id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "record_not_found");
  const bytes = fromPgBytea(data.payload_bytes);
  if ((await C.sha256Bytes(bytes)) !== data.sha256) throw new HttpError(409, "MANIFEST_MISMATCH: bytes gốc không khớp sha256");
  return { ...data, bytes };
}
async function loadManifest(db: any, recordId: string) {
  const { data, error } = await db.from("lib_manifests").select("manifest_id,manifest_bytes,manifest_sha256").eq("record_id", recordId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const bytes = fromPgBytea(data.manifest_bytes);
  return { ...data, bytes, json: JSON.parse(new TextDecoder().decode(bytes)) };
}
async function profileFor(db: any, ticker: string, exchange: string | null) {
  const { data, error } = await db.from("securities").select("id,ticker,exchange").eq("ticker", ticker).maybeSingle();
  if (error) throw error;
  if (!data || data.exchange !== exchange) throw new HttpError(409, "profile_not_found");
  return data.id as string;
}
async function expectedManifest(db: any, recordId: string) {
  const rec = await loadRecord(db, recordId);
  const parent = rec.parent_id ? await loadManifest(db, rec.parent_id) : null;
  if (rec.parent_id && !parent) throw new HttpError(409, "MANIFEST_MISMATCH: cần đăng ký manifest của record cha trước");
  const existing = await loadManifest(db, recordId);
  const prov = existing?.json?.provenance;
  const m = await C.buildManifest(rec.bytes, await profileFor(db, rec.ticker, rec.exchange), parent?.json ?? null,
    prov ? { generatedAt: prov.generated_at, kind: prov.kind, notes: prov.notes }
         : { generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), kind: "BUILDER", notes: "Dựng bởi lib-research-ops từ bytes gốc." });
  return { rec, existing, manifest: m, bytes: C.manifestBytes(m) };
}

function parseText(text: unknown) {
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "text_required");
  if (enc.encode(text).length > 2_000_000) throw new HttpError(413, "too_large");
  try { return C.parseContractText(text); } catch (e) { throw new HttpError(422, "PARSE", [["PARSE", (e as Error).message]]); }
}
async function validateNote(text: unknown) {
  const doc = parseText(text);
  const errs = V.note(doc);
  return { doc, errors: errs.length ? errs : C.checkNote(doc) };
}
async function validateOperation(db: any, text: unknown) {
  const doc = parseText(text);
  let errs = V.operation(doc);
  if (!errs.length) {
    let base: Uint8Array | null = null;
    if (doc.base) {
      try { base = (await loadRecord(db, doc.base.record_id)).bytes; }
      catch (e) { if (e instanceof HttpError && e.status === 404) errs = [["BASE_STALE", "base record không có trong thư viện"]]; else throw e; }
    }
    if (!errs.length) errs = await C.checkOperation(doc, base as any);
  }
  return { doc, errors: errs };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const svc = serviceClient();
  try {
    const actor = await requireAdmin(req, svc);
    const body = await req.json().catch(() => ({}));
    const db = svc.schema("invstock");
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      const r = await db.rpc(fn, args);
      if (r.error) return json({ success: false, error: r.error.message }, 409);
      return json({ success: true, result: r.data });
    };
    switch (body.action) {
      case "list": {
        const t = typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : null;
        let profile: string | null = null;
        if (t) {
          const { data } = await db.from("securities").select("id").eq("ticker", t).maybeSingle();
          profile = data?.id ?? "00000000-0000-0000-0000-000000000000";
        }
        const f = (q: any) => (profile ? q.eq("profile_id", profile) : q);
        const [n, p, o, m] = await Promise.all([
          f(db.from("lib_notes").select("note_version_id,note_id,note_version,profile_id,topic,title,outcome,requested_visibility,base_record_id,as_of,cutoff,sha256,status,reviewed_at,review_note,created_at,links:lib_note_module_links(module_key,role)")).order("created_at", { ascending: false }).limit(200),
          db.from("lib_note_publications").select("note_version_id,role,visibility,published_at,withdrawn_at,withdraw_reason"),
          f(db.from("lib_operations").select("operation_id,operation_type,profile_id,base_record_id,outcome,as_of,cutoff,sha256,created_at")).order("created_at", { ascending: false }).limit(200),
          f(db.from("lib_manifests").select("manifest_id,record_id,profile_id,parent_manifest_id,manifest_sha256,snapshot_sha256,provenance_kind,created_at")).order("created_at"),
        ]);
        const err = n.error || p.error || o.error || m.error;
        if (err) throw err;
        return json({ success: true, notes: n.data, note_publications: p.data, operations: o.data, manifests: m.data });
      }
      case "build_manifest": {
        const { existing, bytes } = await expectedManifest(db, uuidArg(body.record_id, "record_id"));
        if (existing) {
          const same = toHex(existing.bytes) === toHex(bytes);
          return json({ success: same, result: { status: same ? "unchanged" : "mismatch", manifest_id: existing.manifest_id } }, same ? 200 : 409);
        }
        return rpc("lib_register_manifest", { p_manifest_bytes: asBytea(bytes), p_actor: actor });
      }
      case "verify_manifest": {
        const { existing, bytes, manifest } = await expectedManifest(db, uuidArg(body.record_id, "record_id"));
        if (!existing) return json({ success: false, error: "manifest_not_registered" }, 404);
        const schemaErrors = V.manifest(existing.json);
        const match = toHex(existing.bytes) === toHex(bytes);
        const { count } = await db.from("lib_manifest_entries").select("path", { count: "exact", head: true }).eq("manifest_id", existing.manifest_id);
        const sha = await C.sha256Bytes(existing.bytes);
        return json({ success: match && !schemaErrors.length && count === 27 && sha === existing.manifest_sha256,
          result: { manifest_id: existing.manifest_id, bytes_match: match, schema_errors: schemaErrors, entries: count,
            manifest_sha256_ok: sha === existing.manifest_sha256,
            changed: manifest.entries.filter((e: any) => e.disposition === "CHANGED").length } });
      }
      case "validate_note": {
        const { errors } = await validateNote(body.text);
        return json({ success: !errors.length, errors, sha256: await C.sha256Bytes(enc.encode(body.text)) });
      }
      case "import_note": {
        const { errors } = await validateNote(body.text);
        if (errors.length) return json({ success: false, error: "validation_failed", errors }, 422);
        return rpc("lib_note_import", { p_bytes: asBytea(enc.encode(body.text)), p_actor: actor });
      }
      case "review_note":
        return rpc("lib_note_review", { p_note_version_id: uuidArg(body.note_version_id, "note_version_id"),
          p_expected_sha256: String(body.expected_sha256 ?? ""), p_decision: String(body.decision ?? ""), p_actor: actor,
          p_note: typeof body.note === "string" ? body.note : null });
      case "publish_note":
        return rpc("lib_note_publish", { p_note_version_id: uuidArg(body.note_version_id, "note_version_id"),
          p_expected_sha256: String(body.expected_sha256 ?? ""), p_visibility: String(body.visibility ?? "members"), p_actor: actor });
      case "withdraw_note":
        return rpc("lib_note_withdraw", { p_note_version_id: uuidArg(body.note_version_id, "note_version_id"), p_actor: actor,
          p_reason: typeof body.reason === "string" ? body.reason : "" });
      case "validate_operation": {
        const { errors } = await validateOperation(db, body.text);
        return json({ success: !errors.length, errors, sha256: await C.sha256Bytes(enc.encode(body.text)) });
      }
      case "import_operation": {
        const { errors } = await validateOperation(db, body.text);
        if (errors.length) return json({ success: false, error: "validation_failed", errors }, 422);
        return rpc("lib_operation_import", { p_bytes: asBytea(enc.encode(body.text)), p_actor: actor });
      }
      default:
        throw new HttpError(400, "unknown_action");
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ success: false, error: e.message, errors: e.details }, e.status);
    if (e instanceof C.ContractError) return json({ success: false, error: e.message, errors: [[e.code, e.message]] }, 422);
    console.error("lib-research-ops-error", e);
    return json({ success: false, error: "lib_research_ops_failed" }, 500);
  }
});
