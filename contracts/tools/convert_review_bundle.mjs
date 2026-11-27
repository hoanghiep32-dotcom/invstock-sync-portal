// Chuyển "gói review hợp nhất" (logical review bundle: operation + notes + quality review gộp một file,
// không có contract_name) thành 1..n Research Note + 1 Research Operation đúng contract 0.1.0 để nhập ở
// mục 3 trang quản trị. Gói loại này KHÔNG phải Full JSON nên ô "Đồng bộ Full JSON" báo "Unknown schema".
//
//   node contracts/tools/convert_review_bundle.mjs <bundle.json> <base_snapshot.json> <out_dir> \
//        --profile-id <securities.id> --manifest-id <uuid> --manifest-sha256 <hex> [--created-at <ISO>]
//
// profile_id / manifest lấy từ trang quản trị (mục 3, danh sách manifest) hoặc DB. Tool kiểm tra:
//   - sha256(bytes base) = base_sha256 của gói; record_id/revision khớp;
//   - mọi change là APPEND (gói nhiều REPLACE phải đi đường build_candidate.mjs, không tự chuyển);
//   - tính expected_input_hashes / expected_old_hash từ bytes base (block hash v1), rồi chạy schema + checkNote/checkOperation.
// Nội dung không có chỗ trong contract (original_research, quality_review, dedup, validation_ref…) được giữ nguyên văn
// trong body Markdown của note, không bị bỏ.
// Cần ajv@8 + ajv-formats trong NODE_PATH hoặc node_modules.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const here = new URL(".", import.meta.url);
const C = await import(new URL("../../supabase/functions/_shared/contracts/contracts.js", here));
const require = createRequire(process.cwd() + "/");
const Ajv2020 = require("ajv/dist/2020").default;
const rd = (p) => JSON.parse(readFileSync(new URL(p, here), "utf8"));
const V = C.makeContractValidators(Ajv2020, { defs: rd("../defs.schema.json"), note: rd("../research_note.schema.json"),
  operation: rd("../research_operation.schema.json"), manifest: rd("../snapshot_manifest.schema.json") });

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const profileId = opt("--profile-id"), manifestId = opt("--manifest-id"), manifestSha = opt("--manifest-sha256");
const createdAtArg = opt("--created-at");
const [bundlePath, basePath, outDir] = args;
if (!outDir || !profileId) {
  console.error("cách dùng: convert_review_bundle.mjs <bundle.json> <base.json> <out_dir> --profile-id <uuid> [--manifest-id <uuid> --manifest-sha256 <hex>]");
  process.exit(2);
}
const die = (m) => { console.error("LỖI: " + m); process.exit(1); };

const b = C.parseContractText(readFileSync(bundlePath, "utf8"));
if (b.contract_name) die(`file đã có contract_name=${b.contract_name}; nhập trực tiếp ở mục 3, không cần chuyển.`);
if (!b.operation_type || !Array.isArray(b.changes) || !Array.isArray(b.notes)) die("không nhận ra gói review (thiếu operation_type/changes/notes).");
const baseBytes = readFileSync(basePath);
const baseSha = await C.sha256Bytes(baseBytes);
const snap = JSON.parse(baseBytes.toString("utf8"));
if (baseSha !== b.base_sha256) die(`sha256 base ${baseSha} ≠ base_sha256 trong gói ${b.base_sha256}`);
if (snap.metadata.record_id !== b.base_record_id || snap.metadata.revision !== b.base_revision) die("record_id/revision base không khớp gói");
const nonAppend = b.changes.filter((c) => c.action !== "APPEND");
if (nonAppend.length) die(`gói có ${nonAppend.length} change không phải APPEND; dùng build_candidate.mjs cho đường tích hợp.`);

const identity = { ticker: b.identity.ticker, exchange: b.identity.exchange };
const base = { record_id: b.base_record_id, revision: b.base_revision, sha256: baseSha,
  manifest_id: manifestId ?? null, manifest_sha256: manifestSha ?? null };
const createdAt = createdAtArg ?? `${b.as_of}T00:00:00Z`;
const textOr = (v, d) => (typeof v === "string" && v.trim() ? v : Array.isArray(v) && v.length ? v.join(", ") : d);
const hashAt = async (p) => (await C.blockHashes(snap, p)).contentHash;

// evidence của gói = danh mục file nguồn → sources (cùng shape source schema 02)
const sources = (b.evidence ?? []).map((e) => ({
  id: e.id,
  title: [e.filename, e.scope, e.period].filter(Boolean).join(" · "),
  locator: e.url || `file:${e.filename}${e.sha256 ? ` sha256:${e.sha256}` : ""}${e.pages ? ` (${e.pages})` : ""}`,
  published_on: e.published_on ?? null,
  accessed_on: e.accessed_on ?? b.as_of,
  tier: e.tier ?? 3,
}));
const gaps = (list) => (list ?? []).map((g) => typeof g === "string"
  ? { description: g, materiality: "MATERIAL", impact: "Gói gốc không ghi mức trọng yếu; tạm coi MATERIAL cho tới khi người duyệt đánh giá." }
  : g);
const impact = (ir) => Array.isArray(ir) ? ir : Object.entries(ir ?? {}).map(([path, v]) => ({
  path, result: v.result, reason: v.reason, reviewer: v.reviewer ?? null }));
const TOPIC = { forensics: "FORENSICS", ownership: "OWNERSHIP", governance: "GOVERNANCE", risk: "RISK", event: "EVENT",
  industry: "INDUSTRY", valuation: "VALUATION" };
const topicOf = (t) => { const k = String(t ?? "").toLowerCase().split(/[^a-z]+/).find((x) => TOPIC[x]); return k ? TOPIC[k] : "OTHER"; };
const fence = (o) => "```json\n" + JSON.stringify(o, null, 2) + "\n```";

const notes = [];
for (const n of b.notes) {
  const primary = n.primary_modules?.[0] ?? b.changes.find((c) => c.note_ref === n.note_id)?.path.split("/").pop();
  const links = [...new Set([primary, ...(n.module_links ?? [])])].filter((k) => C.MODULE_KEYS.includes(k))
    .map((k) => ({ module_key: k, role: k === primary ? "PRIMARY" : "SECONDARY" }));
  const parts = [n.content_markdown.trim()];
  if (n.counterevidence?.length) parts.push("## Bằng chứng ngược\n" + n.counterevidence.map((x) => "- " + x).join("\n"));
  if (n.assumptions?.length || b.assumptions?.length) parts.push("## Giả định\n" + (n.assumptions ?? b.assumptions).map((x) => "- " + x).join("\n"));
  for (const o of n.original_research ?? [])
    parts.push(`## Phụ lục – nghiên cứu gốc ${o.filename ?? ""}\n_note gốc ${o.original_note_id ?? "?"} · sha256 ${o.sha256 ?? "?"}_\n\n` + o.content_markdown.trim().replace(/^# /gm, "### "));
  if (b.quality_review?.content_markdown)
    parts.push("## Phụ lục – quality & impact review\n\n" + b.quality_review.content_markdown.trim().replace(/^# /gm, "### ").replace(/^## /gm, "### "));
  const meta = { operation_id_goc: b.operation_id, framework_version: b.framework_version, contract_status_goc: b.contract_status,
    base_publication: b.base_publication, validation_ref: b.validation_ref, deduplication: b.deduplication,
    official_snapshot_values: b.official_snapshot_values, quality_review_status: b.quality_review?.status,
    quality_review_provenance: b.quality_review?.provenance, import_blocker_goc: b.quality_review?.import_blocker };
  parts.push("## Phụ lục – thông tin đóng gói gốc\n\n" + fence(meta));
  const needsReview = impact(b.impact_review).some((i) => i.result === "NEEDS_REVIEW");
  const note = {
    contract_name: "invstock.research_note", contract_version: C.CONTRACT_VERSION,
    note_id: n.note_id, note_version_id: await C.uuid5(n.note_id, "note_version:1"), note_version: 1, parent_note_version_id: null,
    profile_id: profileId, identity, topic: topicOf(n.topic), title: n.title, base, base_absent_reason: null,
    module_links: links, scope: textOr(n.scope, textOr(b.scope, "Deep Dive")),
    research_question: textOr(n.research_question, textOr(b.research_question, n.title)),
    as_of: n.as_of ?? b.as_of, cutoff: n.cutoff ?? b.cutoff,
    body: { format: "markdown", text: parts.join("\n\n") + "\n" },
    sources: sources.filter((s) => !n.source_ids || n.source_ids.includes(s.id)),
    evidence: [], gaps: gaps(n.gaps ?? b.gaps), risks: n.risks ?? [], impact_review: impact(b.impact_review),
    outcome: "SUPPLEMENT_ONLY",
    quality: { scope_level: "SCOPED_PARTIAL",
      notes: `Chuyển từ gói review hợp nhất (không có contract). Tự review bởi trợ lý, chưa duyệt.${needsReview ? " Còn mục NEEDS_REVIEW, không đủ điều kiện tích hợp." : ""}` },
    visibility: "members", created_at: createdAt,
  };
  notes.push(note);
}
const vid = Object.fromEntries(notes.map((n) => [n.note_id, n.note_version_id]));

const changes = [];
for (const c of b.changes) {
  if (!vid[c.note_ref]) die(`change ${c.path} trỏ note_ref ${c.note_ref} không có trong notes`);
  changes.push({ path: c.path, action: "APPEND", expected_old_hash: await hashAt(c.path), note_ref: vid[c.note_ref],
    reason: c.reason, source_refs: c.source_refs ?? [] });
}
const op = {
  contract_name: "invstock.research_operation", contract_version: C.CONTRACT_VERSION,
  operation_id: b.operation_id, operation_type: b.operation_type, profile_id: profileId, identity, base,
  as_of: b.as_of, cutoff: b.cutoff, scope: textOr(b.scope, "Deep Dive"), research_question: textOr(b.research_question, "Deep Dive"),
  read_paths: b.read_paths, write_paths: b.write_paths ?? [],
  expected_input_hashes: await Promise.all(b.read_paths.map(async (p) => ({ path: p, content_hash: await hashAt(p) }))),
  changes, sources, note_ids: notes.map((n) => n.note_version_id), evidence: [], gaps: gaps(b.gaps),
  impact_review: impact(b.impact_review), outcome: "NOTE_ONLY",
  output_refs: { candidate_record_id: null, candidate_sha256: null, note_version_ids: notes.map((n) => n.note_version_id), diff_ref: null },
  created_at: createdAt,
};

const report = { notes: [], operation: null };
mkdirSync(outDir, { recursive: true });
const tk = identity.ticker, R = `R${b.base_revision}`;
for (const [i, n] of notes.entries()) {
  const errs = [...V.note(n), ...(V.note(n).length ? [] : C.checkNote(n))];
  const file = join(outDir, `${tk}_${R}_note${notes.length > 1 ? i + 1 : ""}_${n.topic}.json`);
  const text = JSON.stringify(n, null, 2) + "\n";
  writeFileSync(file, text);
  report.notes.push({ file, note_version_id: n.note_version_id, sha256: await C.sha256Bytes(new TextEncoder().encode(text)), errors: errs });
}
const se = V.operation(op);
const oerrs = se.length ? se : await C.checkOperation(op, baseBytes);
const ofile = join(outDir, `${tk}_${R}_operation_${b.operation_type}.json`);
const otext = JSON.stringify(op, null, 2) + "\n";
writeFileSync(ofile, otext);
report.operation = { file: ofile, operation_id: op.operation_id, sha256: await C.sha256Bytes(new TextEncoder().encode(otext)), errors: oerrs };
console.log(JSON.stringify(report, null, 2));
process.exit(report.notes.some((n) => n.errors.length) || oerrs.length ? 1 : 0);
