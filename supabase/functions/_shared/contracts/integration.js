// InvStock GĐ 5 – Integration Engine (tài liệu 13 §11, §13). Dùng chung cho Edge Function (Deno) và Node (CLI, test).
// Một tích hợp = một operation CANDIDATE_SNAPSHOT + bản Full JSON ứng viên (bytes gốc của người lập).
// Engine KHÔNG tự sửa nội dung: nó dựng lại kỳ vọng từ head + changes và chặn mọi khác biệt ngoài phạm vi.
import { canonicalize, parseStrict } from "./jcs.js";
import * as C from "./contracts.js";

export const BUNDLE_VERSION = "invstock-integration-bundle/v1";
const NS_CANDIDATE = "a3c9e5f1-2b4d-5e6f-8a1b-3c5d7e9f1a2b";
const dec = (b) => new TextDecoder("utf-8", { fatal: true }).decode(b);
const enc = new TextEncoder();
const same = (a, b) => canonicalize(a) === canonicalize(b);
const WRITES = new Set(["REPLACE", "RECALCULATE"]);
const LINEAGE_FIELDS = ["record_id", "revision", "parent_id", "scorecard_version"];

/** record_id tái lập được cho bản ứng viên: cùng operation + cùng head thì cùng id. */
export const candidateRecordId = (operationId, headSha) => C.uuid5(NS_CANDIDATE, `${operationId}|${headSha}`);

/** sha256(JCS{bundle, candidate_sha256, head_record_id, head_sha256, manifest_sha256, operation_sha256}).
 *  RPC lib_integrate dựng lại đúng chuỗi này trong SQL (khóa ASCII đã theo thứ tự JCS). */
export async function bundleSha(p) {
  const s = canonicalize({ bundle: BUNDLE_VERSION, candidate_sha256: p.candidate_sha256, head_record_id: p.head_record_id,
    head_sha256: p.head_sha256, manifest_sha256: p.manifest_sha256, operation_sha256: p.operation_sha256 });
  return C.sha256Bytes(enc.encode(s));
}

async function hashAt(snap, p) {
  try { return (await C.blockHashes(snap, p)).contentHash; } catch (e) { if (e.missing) return null; throw e; }
}
const touches = (paths, p) => paths.some((w) => C.ptrCovers(w, p) || C.ptrCovers(p, w));

/** Gắn operation_ids / note_ids vào manifest tích hợp (giữ nguyên thứ tự entry, chỉ đổi 2 mảng). */
export function annotateManifest(m, op) {
  for (const e of m.entries) {
    if (e.disposition === "CHANGED") e.operation_ids = [op.operation_id];
    const notes = op.changes.filter((c) => c.action === "APPEND" && C.ptrCovers(e.path, c.path) && c.note_ref).map((c) => c.note_ref);
    e.note_ids = [...new Set(notes)].sort();
  }
  return m;
}

/** Manifest của bản tích hợp, tất định theo (bytes ứng viên, head manifest, operation). */
export async function integrationManifest(candidateBytes, profileId, headManifest, op) {
  const m = await C.buildManifest(candidateBytes, profileId, headManifest,
    { generatedAt: op.created_at, kind: "BUILDER", notes: `Tích hợp operation ${op.operation_id} (${op.operation_type}).` });
  return annotateManifest(m, op);
}

/** Dựng bản ứng viên từ head + changes (công cụ cho người lập; engine vẫn kiểm tra lại độc lập).
 *  Trả về { text, sha256, record_id } – text là JSON 2 dấu cách + "\n". */
export async function buildCandidate(headBytes, op) {
  const headSha = await C.sha256Bytes(headBytes);
  parseStrict(dec(headBytes));
  const snap = JSON.parse(dec(headBytes));
  for (const c of op.changes) {
    if (!WRITES.has(c.action)) continue;
    const toks = C.ptrTokens(c.path);
    let cur = snap;
    for (const t of toks.slice(0, -1)) {
      if (!cur || typeof cur !== "object" || !(t in cur)) throw new C.ContractError("WRITE_SET", `${c.path}: path cha không tồn tại ở head`);
      cur = cur[t];
    }
    const last = toks[toks.length - 1];
    if (Array.isArray(cur)) throw new C.ContractError("WRITE_SET", `${c.path}: v0.1 chỉ thay nguyên mảng, không ghi vào phần tử`);
    cur[last] = structuredClone(c.candidate_value);
  }
  const md = snap.metadata;
  const recordId = await candidateRecordId(op.operation_id, headSha);
  const head = JSON.parse(dec(headBytes)).metadata;
  snap.metadata = { ...md, record_id: recordId, revision: head.revision + 1, parent_id: head.record_id,
    as_of: op.as_of, cutoff: op.cutoff,
    change_log: [`Tích hợp operation ${op.operation_id} (${op.operation_type}) trên R${head.revision} SHA256 ${headSha}.`,
      ...op.changes.filter((c) => WRITES.has(c.action)).map((c) => `${c.path}: ${c.reason}`)] };
  for (const s of op.sources) if (!snap.sources.some((x) => x.id === s.id)) snap.sources.push(structuredClone(s));
  const text = JSON.stringify(snap, null, 2) + "\n";
  return { text, sha256: await C.sha256Bytes(enc.encode(text)), record_id: recordId };
}

/**
 * Xem trước tích hợp. Không ghi gì. Trả về blockers (chặn), warnings (hiển thị), diff theo block, manifest và bundle hash.
 * args: { op, opSha, base:{record_id,revision,sha256,bytes}, head:{...}, headManifest, candidateBytes, profileId, validateSnapshot }
 * validateSnapshot(doc) -> [{path,message}] hoặc mảng chuỗi: validator schema 02 + rubric (validator.js).
 */
export async function previewIntegration(a) {
  const { op, head, base } = a;
  const blockers = [], warnings = [];
  const B = (code, msg) => blockers.push([code, msg]);
  const W = (msg) => warnings.push(msg);
  const out = { blockers, warnings, entries: [], manifest: null, manifestBytes: null, manifestSha: null, bundleSha: null,
    candidateSha: await C.sha256Bytes(a.candidateBytes), candidate: null };

  // 1) Operation
  if (op.outcome !== "CANDIDATE_SNAPSHOT") B("OUTCOME", `operation có outcome ${op.outcome}, không phải CANDIDATE_SNAPSHOT`);
  const writes = op.changes.filter((c) => WRITES.has(c.action));
  if (!writes.length) B("OUTCOME", "operation không có REPLACE/RECALCULATE nào để tích hợp");
  for (const c of op.changes) if (c.action === "ANNOTATE") W(`${c.path}: ANNOTATE chưa được áp vào snapshot ở v0.1, chỉ lưu trong hồ sơ operation.`);
  for (const r of op.impact_review) if (r.result === "NEEDS_REVIEW") B("IMPACT_REVIEW", `${r.path} còn NEEDS_REVIEW: ${r.reason}`);
  for (const g of op.gaps) if (g.materiality === "MATERIAL") W(`Khoảng trống trọng yếu: ${g.description}`);
  for (const [code, msg] of await C.checkOperation(op, base.bytes)) B(code, msg);
  if (!a.headManifest) B("MANIFEST_MISMATCH", `head R${head.revision} chưa có manifest`);

  // 2) Bản ứng viên: hash khai báo, parse, schema 02
  if (out.candidateSha !== op.output_refs.candidate_sha256) B("CANDIDATE_HASH_MISMATCH", `SHA-256 file (${out.candidateSha.slice(0, 12)}…) khác output_refs.candidate_sha256 của operation`);
  let cand;
  try { cand = parseStrict(dec(a.candidateBytes)); cand = JSON.parse(dec(a.candidateBytes)); }
  catch (e) { B("PARSE", e.message); return out; }
  out.candidate = cand;
  const vErr = a.validateSnapshot ? a.validateSnapshot(cand) : [];
  for (const e of vErr.slice(0, 50)) B("SCHEMA", typeof e === "string" ? e : `${e.path ?? e.instancePath ?? "/"}: ${e.message}`);
  if (vErr.length) return out;

  // 3) Lineage: chỉ builder được đặt các trường này
  const hs = JSON.parse(dec(head.bytes)), bs = JSON.parse(dec(base.bytes));
  const md = cand.metadata;
  if (md.parent_id !== head.record_id) B("BASE_STALE", `parent_id của bản ứng viên phải là head hiện tại R${head.revision} (${head.record_id})`);
  if (md.revision !== head.revision + 1) B("BASE_STALE", `revision phải là ${head.revision + 1}`);
  if (md.record_id !== op.output_refs.candidate_record_id) B("FORBIDDEN_PATH", "metadata.record_id khác output_refs.candidate_record_id");
  if (md.scorecard_version !== hs.metadata.scorecard_version) B("FORBIDDEN_PATH", "không được đổi scorecard_version");
  if (cand.identity.ticker !== op.identity.ticker || cand.identity.exchange !== op.identity.exchange) B("BASE_STALE", "identity khác operation");
  if (md.as_of !== op.as_of || md.cutoff !== op.cutoff) W(`as_of/cutoff của bản ứng viên (${md.as_of}/${md.cutoff}) khác operation (${op.as_of}/${op.cutoff}).`);
  if (same(md.change_log, hs.metadata.change_log)) W("change_log giống hệt head; nên ghi thay đổi của bản này.");

  // 4) Base cũ hơn head: so ba chiều base / head trên mọi path đọc và ghi
  if (base.record_id !== head.record_id) {
    W(`Operation lập trên R${base.revision}, head hiện là R${head.revision}: kiểm tra rebase ba chiều.`);
    const wp = [...new Set([...op.write_paths, ...op.changes.map((c) => c.path)])];
    const rp = [...new Set([...op.read_paths, ...op.expected_input_hashes.map((h) => h.path)])].filter((p) => !wp.includes(p));
    for (const p of wp) if ((await hashAt(bs, p)) !== (await hashAt(hs, p))) B("BLOCK_CONFLICT", `${p} đã đổi giữa R${base.revision} và R${head.revision}`);
    for (const p of rp) if ((await hashAt(bs, p)) !== (await hashAt(hs, p))) B("DEPENDENCY_CHANGED", `đầu vào ${p} đã đổi giữa R${base.revision} và R${head.revision}`);
  }

  // 5) Giá trị tại path ghi phải đúng candidate_value
  for (const c of writes) {
    let v; try { v = C.ptrGet(cand, c.path); } catch { B("WRITE_SET", `${c.path} không có trong bản ứng viên`); continue; }
    if (!same(v, c.candidate_value)) B("WRITE_SET", `${c.path}: giá trị trong bản ứng viên khác candidate_value`);
    let hv; try { hv = C.ptrGet(hs, c.path); } catch { hv = undefined; }
    if (hv !== undefined && same(hv, c.candidate_value)) W(`${c.path}: candidate_value giống head, thay đổi này không có tác dụng.`);
  }

  // 6) Sources: giữ nguyên nguồn cũ, chỉ thêm nguồn khai báo trong operation
  const hsrc = Object.fromEntries(hs.sources.map((s) => [s.id, s]));
  const osrc = Object.fromEntries(op.sources.map((s) => [s.id, s]));
  const csrc = Object.fromEntries(cand.sources.map((s) => [s.id, s]));
  for (const [id, s] of Object.entries(hsrc)) {
    if (!csrc[id]) B("SOURCE_BINDING_CONFLICT", `nguồn ${id} của head bị xóa`);
    else if (!same(csrc[id], s)) B("SOURCE_BINDING_CONFLICT", `nguồn ${id} của head bị sửa (không ghi đè nguồn của bản khác)`);
  }
  for (const [id, s] of Object.entries(csrc)) {
    if (hsrc[id]) continue;
    if (!osrc[id]) B("SOURCE_BINDING_CONFLICT", `nguồn mới ${id} không có trong operation.sources`);
    else if (!same(osrc[id], s)) B("SOURCE_BINDING_CONFLICT", `nguồn mới ${id} khác mô tả trong operation`);
  }

  // 7) Metadata: chỉ as_of, cutoff, reporting_period, change_log và các trường lineage được đổi
  for (const k of Object.keys({ ...md, ...hs.metadata })) {
    if (LINEAGE_FIELDS.includes(k) || ["as_of", "cutoff", "reporting_period", "change_log"].includes(k)) continue;
    if (!same(md[k], hs.metadata[k])) B("FORBIDDEN_PATH", `metadata.${k} không được đổi khi tích hợp`);
  }

  // 8) Manifest so với head manifest: mọi block đổi phải nằm trong phạm vi ghi
  if (!a.headManifest || blockers.some(([c]) => c === "PARSE")) return out;
  let m;
  try { m = await integrationManifest(a.candidateBytes, a.profileId, a.headManifest, op); }
  catch (e) { B(e.code ?? "MANIFEST_MISMATCH", e.message); return out; }
  const scope = [...op.write_paths, ...writes.map((c) => c.path)];
  for (const e of m.entries) {
    out.entries.push({ path: e.path, disposition: e.disposition, change_class: e.change_class, block_revision: e.block_revision });
    if (e.disposition !== "CHANGED") continue;
    if (e.path === "/metadata" || e.path === "/sources") continue; // đã kiểm ở bước 6–7
    if (!touches(scope, e.path)) B("WRITE_SET", `${e.path} đổi nhưng không nằm trong write_paths của operation`);
  }
  for (const c of writes) {
    const blk = m.entries.find((e) => C.ptrCovers(e.path, c.path) || C.ptrCovers(c.path, e.path));
    if (blk && blk.disposition !== "CHANGED") W(`${c.path}: block ${blk.path} không đổi so với head.`);
  }
  out.manifest = m;
  out.manifestBytes = C.manifestBytes(m);
  out.manifestSha = await C.sha256Bytes(out.manifestBytes);
  out.bundleSha = await bundleSha({ candidate_sha256: out.candidateSha, head_record_id: head.record_id, head_sha256: head.sha256,
    manifest_sha256: out.manifestSha, operation_sha256: a.opSha });
  return out;
}
