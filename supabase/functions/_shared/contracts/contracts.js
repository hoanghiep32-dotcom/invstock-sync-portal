// InvStock contracts 0.1.0 – bản JS của contracts/tools/invstock_contracts.py (giữ ngữ nghĩa đồng bộ; test parity ở
// contracts/tests/test_js_parity.mjs). Dùng trong Edge Function (Deno) và Node.
import { canonicalize, parseStrict, JcsError, CANONICALIZATION_VERSION } from "./jcs.js";

export { parseStrict, JcsError, CANONICALIZATION_VERSION };
export const CONTRACT_VERSION = "0.1.0";
export const BLOCK_HASH_INPUT = "invstock-block-hash/v1";
export const MODULE_KEYS = ["executive_summary", "company_intelligence", "industry_macro", "competitive_advantage",
  "financial_performance", "financial_forensics", "debt_liquidity", "ownership_governance", "assets_projects",
  "growth_forecast", "valuation_engine", "catalysts_expectations", "scorecard_risk", "decision_monitoring"];
export const COMPONENT_KEYS = ["schema_name", "schema_version", "metadata", "identity", "sources", "core10", "committee",
  "scorecard", "valuation", "risk", "decision", "catalysts", "monitoring"];
export const REQUIRED_PATHS = [...MODULE_KEYS.map((k) => "/modules/" + k), ...COMPONENT_KEYS.map((k) => "/" + k)];
export const FORBIDDEN_WRITE = ["/metadata/record_id", "/metadata/revision", "/metadata/parent_id",
  "/metadata/scorecard_version", "/schema_name", "/schema_version"];
const NS_BLOCK = "6b1f3c1e-6a0e-5c8e-9d1a-1e0c0a5b2f10";
const NS_MANIFEST = "0d7a2c55-3e4b-5f61-8a9c-2b4d6e8f0a13";

export class ContractError extends Error {
  constructor(code, msg) { super(`${code}: ${msg}`); this.code = code; }
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256Bytes(bytes) { return hex(await crypto.subtle.digest("SHA-256", bytes)); }
export const jcsSha = (v) => sha256Bytes(enc.encode(canonicalize(v)));

// UUIDv5 (RFC 4122) – để version_id/manifest_id tái lập được giống bản Python.
export async function uuid5(ns, name) {
  const nsb = Uint8Array.from(ns.replace(/-/g, "").match(/../g).map((h) => parseInt(h, 16)));
  const nb = enc.encode(name);
  const buf = new Uint8Array(nsb.length + nb.length); buf.set(nsb); buf.set(nb, nsb.length);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", buf)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const s = hex(h);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// ---------- JSON Pointer ----------
export function ptrTokens(p) {
  if (p === "" || !p.startsWith("/")) throw new ContractError("BAD_POINTER", p);
  return p.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export function ptrGet(doc, p) {
  let cur = doc;
  for (const t of ptrTokens(p)) {
    if (cur && typeof cur === "object" && !Array.isArray(cur) && own(cur, t)) cur = cur[t];
    else if (Array.isArray(cur) && /^(0|[1-9]\d*)$/.test(t) && Number(t) < cur.length) cur = cur[Number(t)];
    else { const e = new Error(p); e.missing = true; throw e; }
  }
  return cur;
}
export const ptrCovers = (a, b) => a === b || b.startsWith(a + "/");

// ---------- block hash ----------
const REF_KEYS = new Set(["source_ids", "source_refs"]);
function collectSourceIds(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => collectSourceIds(x, out));
  else if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      if (REF_KEYS.has(k) && Array.isArray(v[k])) v[k].forEach((x) => typeof x === "string" && out.add(x));
      else collectSourceIds(v[k], out);
    }
  }
  return out;
}
const descriptorHash = (s) => { const { id: _id, ...rest } = s; return jcsSha(rest); };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function normalize(v, desc) {
  if (Array.isArray(v)) return v.map((x) => normalize(x, desc));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) {
      o[k] = REF_KEYS.has(k) && Array.isArray(v[k]) ? v[k].map((x) => desc[x] ?? "missing:" + x).sort(cmp) : normalize(v[k], desc);
    }
    return o;
  }
  return v;
}

export async function blockHashes(snapshot, path) {
  const content = ptrGet(snapshot, path);
  const byId = Object.fromEntries((snapshot.sources ?? []).map((s) => [s.id, s]));
  let ids = [], bound = [];
  if (path !== "/sources") {
    ids = [...collectSourceIds(content)].sort(cmp);
    const missing = ids.filter((i) => !own(byId, i));
    if (missing.length) throw new ContractError("SOURCE_BINDING_CONFLICT", `${path} tham chiếu source không tồn tại: ${missing}`);
    bound = ids.map((i) => byId[i]);
  }
  const contentHash = await jcsSha({ path, content, sources: bound });
  const desc = {};
  for (const [i, s] of Object.entries(byId)) desc[i] = await descriptorHash(s);
  const normContent = path !== "/sources" ? normalize(content, desc)
    : (await Promise.all(content.map(descriptorHash))).sort(cmp);
  const normalizedHash = await jcsSha({ path, content: normContent, sources: ids.map((i) => desc[i]).sort(cmp) });
  return { contentHash, normalizedHash, ids };
}

// ---------- manifest ----------
export async function buildManifest(snapshotBytes, profileId, parentManifest = null,
  { generatedAt = "1970-01-01T00:00:00Z", kind = "BUILDER", notes = "" } = {}) {
  const snap = parseStrict(new TextDecoder("utf-8", { fatal: true }).decode(snapshotBytes));
  const md = snap.metadata;
  if (parentManifest && parentManifest.record_id !== md.parent_id) throw new ContractError("MANIFEST_MISMATCH", "parent manifest không thuộc record cha");
  const pe = Object.fromEntries((parentManifest?.entries ?? []).map((e) => [e.path, e]));
  const entries = [];
  for (const path of REQUIRED_PATHS) {
    const { contentHash: ch, normalizedHash: nh, ids } = await blockHashes(snap, path);
    const p = pe[path];
    let disp, cls, rev, vid;
    if (!p) { disp = "INITIAL"; cls = "NONE"; rev = 1; vid = await uuid5(NS_BLOCK, `${profileId}|${path}|${ch}`); }
    else if (p.content_hash === ch) { disp = "INHERITED"; cls = "NONE"; rev = p.block_revision; vid = p.version_id; }
    else { disp = "CHANGED"; rev = p.block_revision + 1; cls = p.normalized_hash === nh ? "SOURCE_REMAP" : "CONTENT"; vid = await uuid5(NS_BLOCK, `${profileId}|${path}|${ch}`); }
    entries.push({ path, kind: path.startsWith("/modules/") ? "MODULE" : "COMPONENT", key: path.slice(path.lastIndexOf("/") + 1),
      version_id: vid, block_revision: rev, content_hash: ch, normalized_hash: nh, disposition: disp, change_class: cls,
      source_ids: ids, operation_ids: [], note_ids: [] });
  }
  const snapSha = await sha256Bytes(snapshotBytes);
  return {
    contract_name: "invstock.snapshot_manifest", contract_version: CONTRACT_VERSION,
    manifest_id: await uuid5(NS_MANIFEST, `${md.record_id}|${snapSha}`), profile_id: profileId,
    identity: { ticker: snap.identity.ticker, exchange: snap.identity.exchange },
    record_id: md.record_id, revision: md.revision, snapshot_sha256: snapSha, parent_record_id: md.parent_id,
    parent_manifest_id: parentManifest ? parentManifest.manifest_id : null, hash_algorithm: "sha256",
    canonicalization_version: CANONICALIZATION_VERSION, block_hash_input: BLOCK_HASH_INPUT, entries,
    provenance: { kind, legacy_provenance_unknown: kind === "LEGACY_BACKFILL", generated_at: generatedAt,
      generator: "contracts/tools/invstock_contracts.py@0.1.0", notes },
  };
}
export const manifestBytes = (m) => enc.encode(canonicalize(m));

// ---------- semantic checks (giống Python) ----------
function cutoff(doc, errs) { if (doc.cutoff > doc.as_of) errs.push(["CUTOFF_AFTER_AS_OF", `cutoff ${doc.cutoff} > as_of ${doc.as_of}`]); }
function sourceRefs(lists, sources, errs, where) {
  const known = new Set(sources.map((s) => s.id));
  if (known.size !== sources.length) errs.push(["SOURCE_BINDING_CONFLICT", `${where}: source id trùng`]);
  for (const ids of lists) for (const i of ids) if (!known.has(i)) errs.push(["SOURCE_BINDING_CONFLICT", `${where}: source_id '${i}' không có trong sources`]);
}
export function checkNote(n) {
  const errs = [];
  cutoff(n, errs);
  const prim = n.module_links.filter((l) => l.role === "PRIMARY");
  if (prim.length !== 1) errs.push(["PRIMARY_MODULE", `cần đúng 1 module PRIMARY, có ${prim.length}`]);
  const keys = n.module_links.map((l) => l.module_key);
  if (new Set(keys).size !== keys.length) errs.push(["PRIMARY_MODULE", "module_links trùng module"]);
  sourceRefs(n.evidence.map((e) => e.source_ids), n.sources, errs, "note");
  return errs;
}
export async function checkOperation(op, baseBytes = null) {
  const errs = [];
  cutoff(op, errs);
  for (const p of [...op.write_paths, ...op.changes.map((c) => c.path)]) {
    if (FORBIDDEN_WRITE.some((f) => ptrCovers(f, p) || ptrCovers(p, f))) errs.push(["FORBIDDEN_PATH", `không được ghi ${p} qua patch`]);
  }
  for (const c of op.changes) {
    const w = c.action === "REPLACE" || c.action === "RECALCULATE";
    if (w && !op.write_paths.some((x) => ptrCovers(x, c.path))) errs.push(["WRITE_SET", `${c.path} nằm ngoài write_paths`]);
    if (w && (c.candidate_value === null || c.candidate_value === undefined)) errs.push(["NULL_NOT_DELETE", `${c.path}: null không phải lệnh xoá`]);
    if (c.action === "APPEND" && ![...op.output_refs.note_version_ids, ...op.note_ids].includes(c.note_ref)) errs.push(["NOTE_REF", `${c.path}: note_ref không có trong note_ids/output_refs`]);
  }
  sourceRefs([...op.changes.map((c) => c.source_refs), ...op.evidence.map((e) => e.source_ids)], op.sources, errs, "operation");
  if (op.outcome === "NO_CHANGE" && op.changes.some((c) => c.action === "REPLACE" || c.action === "RECALCULATE")) errs.push(["OUTCOME", "NO_CHANGE nhưng có REPLACE/RECALCULATE"]);
  if (baseBytes && op.base) {
    if ((await sha256Bytes(baseBytes)) !== op.base.sha256) errs.push(["BASE_STALE", "base.sha256 không khớp bytes bản cơ sở"]);
    else {
      const snap = parseStrict(new TextDecoder().decode(baseBytes));
      if (snap.metadata.record_id !== op.base.record_id || snap.metadata.revision !== op.base.revision) errs.push(["BASE_STALE", "record_id/revision của base không khớp"]);
      const hashAt = async (p) => { try { return (await blockHashes(snap, p)).contentHash; } catch (e) { if (e.missing) return null; throw e; } };
      for (const h of op.expected_input_hashes) {
        const cur = await hashAt(h.path);
        if (cur === null) errs.push(["DEPENDENCY_CHANGED", `đầu vào ${h.path} không còn tồn tại`]);
        else if (cur !== h.content_hash) errs.push(["DEPENDENCY_CHANGED", `đầu vào ${h.path} đã đổi so với khi lập operation`]);
      }
      for (const c of op.changes) if ((await hashAt(c.path)) !== c.expected_old_hash) errs.push(["BLOCK_CONFLICT", `${c.path}: expected_old_hash khác bản cơ sở`]);
    }
  }
  return errs;
}

// ---------- JSON Schema ----------
export function makeContractValidators(Ajv2020, schemas) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(schemas.defs);
  const mk = (s) => { const v = ajv.compile(s); return (d) => (v(d) ? [] : v.errors.map((e) => ["SCHEMA", `${e.instancePath || "/"}: ${e.message}`])); };
  return { note: mk(schemas.note), operation: mk(schemas.operation), manifest: mk(schemas.manifest) };
}

/** Đọc văn bản JSON: parse strict (chặn khóa trùng…), trả về object thường cho Ajv. */
export function parseContractText(text) {
  parseStrict(text);
  return JSON.parse(text);
}
