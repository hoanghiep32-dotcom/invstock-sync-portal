// Kiểm thử Integration Engine (GĐ 5) trên bytes gốc FPT R1/R2 với operation TỔNG HỢP (không phải nghiên cứu thật).
//   node contracts/tests/test_integration.mjs <R1.json> <R2.json>    (cần ajv@8 + ajv-formats trong node_modules)
// In thêm --emit <dir> để ghi operation/candidate/manifest dùng cho dry run SQL.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const here = new URL(".", import.meta.url);
const C = await import(new URL("../../supabase/functions/_shared/contracts/contracts.js", here));
const I = await import(new URL("../../supabase/functions/_shared/contracts/integration.js", here));
const { makeValidator } = await import(new URL("../../supabase/functions/_shared/validator.js", here));
const require = createRequire(process.cwd() + "/");
const Ajv2020 = require("ajv/dist/2020").default, addFormats = require("ajv-formats").default;
const rdj = (p) => JSON.parse(readFileSync(new URL(p, here)));
const validate = makeValidator(Ajv2020, addFormats, { research: rdj("../../supabase/functions/_shared/research_schema.json"),
  screening: rdj("../../supabase/functions/_shared/screening_schema.json") }, rdj("../../supabase/functions/_shared/scorecard_framework.json"));
const V = C.makeContractValidators(Ajv2020, Object.fromEntries([["defs", "defs"], ["note", "research_note"], ["operation", "research_operation"],
  ["manifest", "snapshot_manifest"]].map(([k, f]) => [k, rdj(`../${f}.schema.json`)])));

const args = process.argv.slice(2);
const emit = args.includes("--emit") ? args[args.indexOf("--emit") + 1] : null;
const [r1b, r2b] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--emit").map((p) => readFileSync(p));
const PROFILE = "4aaab883-425f-44af-8bf6-7abf0a46918a";
const enc = new TextEncoder();
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log("FAIL", m); } else console.log("PASS", m); };
const rec = async (b) => { const j = JSON.parse(b.toString("utf8")); return { record_id: j.metadata.record_id, revision: j.metadata.revision, sha256: await C.sha256Bytes(b), bytes: b, json: j }; };
const R1 = await rec(r1b), R2 = await rec(r2b);
const M2 = rdj("../examples/FPT_R2.manifest.json");
const M2sha = await C.sha256Bytes(readFileSync(new URL("../examples/FPT_R2.manifest.json", here)));
const H = async (snap, p) => (await C.blockHashes(snap, p)).contentHash;

const PATH = "/modules/valuation_engine/analysis";
async function makeOp(base, over = {}) {
  const s = base.json;
  const src = structuredClone(s.sources.find((x) => x.id === "I") ?? s.sources[0]);
  return {
    contract_name: "invstock.research_operation", contract_version: "0.1.0",
    operation_id: over.operation_id ?? "44444444-4444-4444-8444-444444444444", operation_type: "REVALUATION",
    profile_id: PROFILE, identity: { ticker: "FPT", exchange: "HOSE" },
    base: { record_id: base.record_id, revision: base.revision, sha256: base.sha256,
      manifest_id: base.revision === 2 ? M2.manifest_id : null, manifest_sha256: base.revision === 2 ? M2sha : null },
    as_of: "2026-11-26", cutoff: "2026-11-25", scope: "THỬ NGHIỆM GĐ 5 – không phải nghiên cứu thật",
    research_question: "Kiểm tra engine tích hợp với một REPLACE tổng hợp.",
    read_paths: ["/valuation"], write_paths: [PATH],
    expected_input_hashes: [{ path: "/valuation", content_hash: await H(s, "/valuation") }],
    changes: [{ path: PATH, action: "REPLACE", expected_old_hash: await H(s, PATH),
      candidate_value: "[THỬ NGHIỆM GĐ 5] Nội dung tổng hợp để kiểm tra engine, không phải phân tích thật.",
      reason: "Kiểm thử engine tích hợp", source_refs: [src.id] }],
    sources: [src], note_ids: [], evidence: [], gaps: [],
    impact_review: [{ path: "/valuation", result: "NO_CHANGE", reason: "Chỉ đổi văn bản phân tích (tổng hợp)", reviewer: null }],
    outcome: "CANDIDATE_SNAPSHOT",
    output_refs: { candidate_record_id: null, candidate_sha256: null, note_version_ids: [], diff_ref: null },
    created_at: "2026-11-26T00:00:00Z", ...over,
  };
}
async function finalize(op, headBytes) {
  const c = await I.buildCandidate(headBytes, op);
  op.output_refs = { ...op.output_refs, candidate_record_id: c.record_id, candidate_sha256: c.sha256 };
  return { op, cand: c };
}
const opBytes = (op) => enc.encode(JSON.stringify(op, null, 2) + "\n");
const preview = async (op, candText, { base = R2, head = R2, headManifest = M2 } = {}) =>
  I.previewIntegration({ op, opSha: await C.sha256Bytes(opBytes(op)), base, head, headManifest,
    candidateBytes: typeof candText === "string" ? enc.encode(candText) : candText, profileId: PROFILE, validateSnapshot: validate });
const codes = (p) => p.blockers.map(([c]) => c);

// T1: đường đi chuẩn
const { op, cand } = await finalize(await makeOp(R2), R2.bytes);
ok(!V.operation(op).length, "operation tổng hợp đạt schema contract");
const p = await preview(op, cand.text);
ok(!p.blockers.length, "T1 không có blocker: " + JSON.stringify(p.blockers));
ok(!V.manifest(p.manifest).length, "T1 manifest đạt schema");
const ch = p.entries.filter((e) => e.disposition === "CHANGED").map((e) => e.path).sort();
ok(JSON.stringify(ch) === JSON.stringify(["/metadata", "/modules/valuation_engine"]), "T1 chỉ đổi /metadata và valuation_engine: " + ch);
ok(p.entries.filter((e) => e.disposition === "INHERITED").length === 25, "T1 kế thừa 25 block");
const ve = p.manifest.entries.find((e) => e.path === "/modules/valuation_engine");
ok(ve.block_revision === 3 && ve.operation_ids[0] === op.operation_id, "T1 valuation_engine lên rev 3, gắn operation_id");
ok(p.manifest.parent_manifest_id === M2.manifest_id && p.manifest.revision === 3, "T1 manifest trỏ về manifest R2, revision 3");
const again = await preview(op, cand.text);
ok(again.bundleSha === p.bundleSha && again.manifestSha === p.manifestSha, "T1 bundle hash tất định");
ok(cand.record_id === await I.candidateRecordId(op.operation_id, R2.sha256), "T1 record_id tái lập được");

// T2: sửa giá trị sau khi khai báo → hash khác + giá trị khác
const t2 = cand.text.replace("[THỬ NGHIỆM GĐ 5]", "[SỬA LÉN]");
ok(codes(await preview(op, t2)).includes("CANDIDATE_HASH_MISMATCH"), "T2 sửa file → CANDIDATE_HASH_MISMATCH");
ok(codes(await preview(op, t2)).includes("WRITE_SET"), "T2 giá trị khác candidate_value → WRITE_SET");

// T3: đổi lén một block ngoài phạm vi
{ const j = JSON.parse(cand.text); j.modules.ownership_governance.analysis += " (lén)"; const t = JSON.stringify(j, null, 2) + "\n";
  const o = structuredClone(op); o.output_refs.candidate_sha256 = await C.sha256Bytes(enc.encode(t));
  const r = await preview(o, t);
  ok(r.blockers.some(([c, m]) => c === "WRITE_SET" && m.includes("ownership_governance")), "T3 block ngoài write_paths → WRITE_SET"); }

// T4: sửa mô tả nguồn của head
{ const j = JSON.parse(cand.text); j.sources[0].title += " (sửa)"; const t = JSON.stringify(j, null, 2) + "\n";
  const o = structuredClone(op); o.output_refs.candidate_sha256 = await C.sha256Bytes(enc.encode(t));
  ok(codes(await preview(o, t)).includes("SOURCE_BINDING_CONFLICT"), "T4 sửa nguồn cũ → SOURCE_BINDING_CONFLICT"); }

// T5: head đã đổi (giả lập: ứng viên dựng trên R1 nhưng head là R2) → parent sai
{ const { op: o, cand: c } = await finalize(await makeOp(R1, { operation_id: "55555555-5555-4555-8555-555555555555" }), R1.bytes);
  const r = await preview(o, c.text, { base: R1, head: R2 });
  ok(codes(r).includes("BASE_STALE"), "T5 ứng viên không trỏ về head → BASE_STALE");
  ok(codes(r).includes("BLOCK_CONFLICT") && codes(r).includes("DEPENDENCY_CHANGED"), "T5 R1→R2 đổi cả path ghi lẫn path đọc → BLOCK_CONFLICT + DEPENDENCY_CHANGED"); }

// T6: NEEDS_REVIEW chặn
{ const o = structuredClone(op); o.impact_review[0].result = "NEEDS_REVIEW";
  ok(codes(await preview(o, cand.text)).includes("IMPACT_REVIEW"), "T6 NEEDS_REVIEW → chặn"); }

// T7: operation chỉ NOTE_ONLY → không tích hợp
{ const o = structuredClone(op); o.outcome = "NOTE_ONLY";
  ok(codes(await preview(o, cand.text)).includes("OUTCOME"), "T7 NOTE_ONLY → OUTCOME"); }

// T8: đổi scorecard_version / schema → bị chặn bởi schema hoặc FORBIDDEN_PATH
{ const j = JSON.parse(cand.text); j.metadata.reporting_period = "khác"; j.metadata.extra = 1; const t = JSON.stringify(j, null, 2) + "\n";
  const o = structuredClone(op); o.output_refs.candidate_sha256 = await C.sha256Bytes(enc.encode(t));
  ok(codes(await preview(o, t)).includes("SCHEMA"), "T8 thêm trường lạ vào metadata → SCHEMA"); }

// T9: head chưa có manifest
ok(codes(await preview(op, cand.text, { headManifest: null })).includes("MANIFEST_MISMATCH"), "T9 head thiếu manifest → MANIFEST_MISMATCH");

// T10: expected_old_hash sai so với base
{ const o = structuredClone(op); o.changes[0].expected_old_hash = "0".repeat(64);
  ok(codes(await preview(o, cand.text)).includes("BLOCK_CONFLICT"), "T10 expected_old_hash sai → BLOCK_CONFLICT"); }

// T11: bundle JCS khớp chuỗi SQL dựng tay
{ const s = `{"bundle":"${I.BUNDLE_VERSION}","candidate_sha256":"${p.candidateSha}","head_record_id":"${R2.record_id}","head_sha256":"${R2.sha256}","manifest_sha256":"${p.manifestSha}","operation_sha256":"${await C.sha256Bytes(opBytes(op))}"}`;
  ok(await C.sha256Bytes(enc.encode(s)) === p.bundleSha, "T11 bundle hash = sha256 chuỗi mà SQL dựng"); }

// T12: base R1, head R2, nhưng path đọc/ghi (/identity) không đổi giữa R1 và R2 → rebase được
{ const o = await makeOp(R1, { operation_id: "66666666-6666-4666-8666-666666666666", read_paths: ["/identity"], write_paths: ["/identity/sector"],
    expected_input_hashes: [{ path: "/identity", content_hash: await H(R1.json, "/identity") }],
    impact_review: [{ path: "/identity", result: "NO_CHANGE", reason: "Tổng hợp", reviewer: null }] });
  o.changes = [{ path: "/identity/sector", action: "REPLACE", expected_old_hash: await H(R1.json, "/identity/sector"),
    candidate_value: "[THỬ NGHIỆM] ngành", reason: "Kiểm thử rebase", source_refs: [o.sources[0].id] }];
  const { cand: c } = await finalize(o, R2.bytes);
  const r = await preview(o, c.text, { base: R1, head: R2 });
  ok(!r.blockers.length && r.warnings.some((w) => w.includes("rebase")), "T12 rebase ba chiều hợp lệ: " + JSON.stringify(r.blockers)); }

if (emit) {
  mkdirSync(emit, { recursive: true });
  writeFileSync(`${emit}/operation.json`, opBytes(op));
  writeFileSync(`${emit}/candidate.json`, cand.text);
  writeFileSync(`${emit}/manifest.json`, p.manifestBytes);
  writeFileSync(`${emit}/summary.json`, JSON.stringify({ bundle: p.bundleSha, manifest_sha256: p.manifestSha, candidate_sha256: p.candidateSha,
    record_id: cand.record_id, manifest_id: p.manifest.manifest_id }, null, 2));
}
console.log(fail ? `${fail} FAIL` : "ALL PASS");
process.exit(fail ? 1 : 0);
