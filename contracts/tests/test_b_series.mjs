// GĐ 6 – Kiểm thử B01–B22 (tài liệu 13 §16) ở tầng engine + validator, trên bytes gốc FPT R1/R2 (không có trong repo).
//   node contracts/tests/test_b_series.mjs <R1.json> <R2.json> [--json out.json]
// Các tình huống cần DB (B03, B11, B13, B16–B20, B22) chạy bằng SQL: contracts/tools/gen_gd6_sql.mjs.
// Mọi operation ở đây là TỔNG HỢP để kiểm tra luật, không phải nghiên cứu thật.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const here = new URL(".", import.meta.url);
const C = await import(new URL("../../supabase/functions/_shared/contracts/contracts.js", here));
const I = await import(new URL("../../supabase/functions/_shared/contracts/integration.js", here));
const { canonicalize, parseStrict, sha256Hex } = await import(new URL("../../supabase/functions/_shared/contracts/jcs.js", here));
const { makeValidator } = await import(new URL("../../supabase/functions/_shared/validator.js", here));
const require = createRequire(process.cwd() + "/");
const Ajv2020 = require("ajv/dist/2020").default, addFormats = require("ajv-formats").default;
const rdj = (p) => JSON.parse(readFileSync(new URL(p, here)));
const scorecard = rdj("../../supabase/functions/_shared/scorecard_framework.json");
const validate = makeValidator(Ajv2020, addFormats, { research: rdj("../../supabase/functions/_shared/research_schema.json"),
  screening: rdj("../../supabase/functions/_shared/screening_schema.json") }, scorecard);
const V = C.makeContractValidators(Ajv2020, Object.fromEntries([["defs", "defs"], ["note", "research_note"], ["operation", "research_operation"],
  ["manifest", "snapshot_manifest"]].map(([k, f]) => [k, rdj(`../${f}.schema.json`)])));

const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const [r1b, r2b] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--json").map((p) => readFileSync(p));
const PROFILE = "4aaab883-425f-44af-8bf6-7abf0a46918a";
const enc = new TextEncoder();
const results = [];
let current = null;
function scenario(id, title, fn) { current = { id, title, checks: [], status: "ĐẠT", note: "" }; results.push(current); return fn(); }
const ok = (c, m) => { current.checks.push([!!c, m]); if (!c) { current.status = "LỖI"; console.log(`FAIL ${current.id} ${m}`); } else console.log(`PASS ${current.id} ${m}`); };
const mark = (status, note) => { if (current.status !== "LỖI") current.status = status; current.note = note; };

const rec = async (b) => { const j = JSON.parse(b.toString("utf8")); return { record_id: j.metadata.record_id, revision: j.metadata.revision, sha256: await C.sha256Bytes(b), bytes: b, json: j }; };
const R1 = await rec(r1b), R2 = await rec(r2b);
const M1 = rdj("../examples/FPT_R1.manifest.json"), M2 = rdj("../examples/FPT_R2.manifest.json");
const H = async (snap, p) => (await C.blockHashes(snap, p)).contentHash;
const codes = (p) => p.blockers.map(([c]) => c);
const opBytes = (op) => enc.encode(JSON.stringify(op, null, 2) + "\n");
let seq = 0x100;

/** Operation tổng hợp: changes = [{path, value, action?, formula?}], đọc/ghi theo tham số; hash lấy từ base. */
async function mkOp(base, { type = "PARTIAL_UPDATE", read = [], write, changes, impact, extra = {} }) {
  const s = base.json;
  const id = `${(seq++).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const src = structuredClone(s.sources[0]);
  const ch = [];
  for (const c of changes) {
    const action = c.action ?? "REPLACE";
    let old = null; try { old = await H(s, c.path); } catch { old = null; }
    const o = { path: c.path, action, expected_old_hash: old, reason: c.reason ?? "Kiểm thử GĐ 6", source_refs: [src.id] };
    if (action === "REPLACE" || action === "RECALCULATE") o.candidate_value = c.value;
    if (action === "RECALCULATE") o.formula_ref = c.formula ?? "test-formula@1";
    if (action === "ANNOTATE") o.annotation = c.annotation;
    if (action === "APPEND") o.note_ref = c.note_ref;
    ch.push(o);
  }
  const exp = [];
  for (const p of read) exp.push({ path: p, content_hash: await H(s, p) });
  return {
    contract_name: "invstock.research_operation", contract_version: "0.1.0", operation_id: id, operation_type: type,
    profile_id: PROFILE, identity: { ticker: "FPT", exchange: "HOSE" },
    base: { record_id: base.record_id, revision: base.revision, sha256: base.sha256, manifest_id: null, manifest_sha256: null },
    as_of: "2026-11-26", cutoff: "2026-11-25", scope: "THỬ NGHIỆM GĐ 6", research_question: "Kiểm tra luật tích hợp.",
    read_paths: read, write_paths: write ?? changes.filter((c) => !c.action || ["REPLACE", "RECALCULATE"].includes(c.action)).map((c) => c.path),
    expected_input_hashes: exp, changes: ch, sources: [src], note_ids: [], evidence: [], gaps: [],
    impact_review: impact ?? [{ path: read[0] ?? changes[0].path, result: "NO_CHANGE", reason: "Tổng hợp", reviewer: null }],
    outcome: "CANDIDATE_SNAPSHOT", output_refs: { candidate_record_id: null, candidate_sha256: null, note_version_ids: [], diff_ref: null },
    created_at: "2026-11-26T00:00:00Z", ...extra,
  };
}
async function finalize(op, headBytes) {
  const c = await I.buildCandidate(headBytes, op);
  op.output_refs = { ...op.output_refs, candidate_record_id: c.record_id, candidate_sha256: c.sha256 };
  return c;
}
const preview = async (op, text, { base = R2, head = R2, headManifest = M2 } = {}) =>
  I.previewIntegration({ op, opSha: await C.sha256Bytes(opBytes(op)), base, head, headManifest,
    candidateBytes: enc.encode(text), profileId: PROFILE, validateSnapshot: validate });
/** Sửa tay bản ứng viên (giả lập người lập file sai) rồi khai báo lại hash. */
async function tamper(op, text, f) {
  const j = JSON.parse(text); f(j); const t = JSON.stringify(j, null, 2) + "\n";
  const o = structuredClone(op); o.output_refs.candidate_sha256 = await C.sha256Bytes(enc.encode(t));
  return { o, t };
}
/** Tích hợp giả lập (không DB): trả về head mới R3 + manifest của nó, để kiểm các tình huống head đã đổi. */
async function integrateLocally(op, text) {
  const p = await preview(op, text);
  if (p.blockers.length) throw new Error("integrate failed " + JSON.stringify(p.blockers));
  const r3 = await rec(Buffer.from(text));
  return { R3: r3, M3: p.manifest };
}

// ---------------- B01 ----------------
await scenario("B01", "Full Research legacy không manifest", async () => {
  const before = await C.sha256Bytes(R1.bytes);
  const all = [];
  for (const p of C.REQUIRED_PATHS) all.push(await H(R1.json, p));
  ok(all.length === 27 && C.MODULE_KEYS.every((k) => R1.json.modules[k]), "đọc đủ 14 module + 13 thành phần mà không cần manifest");
  ok((await C.sha256Bytes(R1.bytes)) === before && before === R1.sha256, "bytes/hash không đổi sau khi đọc");
  mark("ĐẠT", "VIX R1 trên DB thật chưa có manifest: xem đối soát.");
});

// ---------------- B02 ----------------
await scenario("B02", "Backfill R1/R2", async () => {
  const opts = { generatedAt: "2026-11-26T00:00:00Z", kind: "LEGACY_BACKFILL", notes: M1.provenance.notes };
  const m1 = await C.buildManifest(R1.bytes, PROFILE, null, opts), m2 = await C.buildManifest(R2.bytes, PROFILE, m1, opts);
  ok(canonicalize(m1) === canonicalize(M1) && canonicalize(m2) === canonicalize(M2), "dựng lại manifest khớp bản đã đăng ký");
  ok([...m1.entries, ...m2.entries].every((e) => !e.operation_ids.length && !e.note_ids.length), "không bịa operation/note cho dữ liệu lịch sử");
  ok(m2.entries.filter((e) => e.disposition === "INHERITED").length === 3 && m2.snapshot_sha256 === R2.sha256, "lineage: R2 kế thừa 3 khối, hash gốc giữ nguyên");
});

// ---------------- B03 (phần engine) ----------------
await scenario("B03", "Note Ownership APPEND", async () => {
  const op = rdj("../examples/EXAMPLE_operation_deep_dive.json");
  const p = await preview(op, R2.bytes.toString("utf8"));
  ok(codes(p).includes("OUTCOME"), "operation chỉ APPEND (NOTE_ONLY) không thể tích hợp thành bản mới");
  mark("ĐẠT", "Phần DB (xuất bản chuyên đề không đổi current/FV/điểm) chạy trong SQL GĐ 6.");
});

// ---------------- B04 ----------------
await scenario("B04", "ANNOTATE rủi ro chưa xác minh", async () => {
  const op = await mkOp(R2, { read: ["/risk"], write: ["/modules/valuation_engine/analysis"], changes: [
    { path: "/modules/valuation_engine/analysis", value: "[GĐ6] văn bản tổng hợp" },
    { path: "/risk", action: "ANNOTATE", annotation: "Cảnh báo tổng hợp chưa xác minh" }] });
  const c = await finalize(op, R2.bytes);
  const p = await preview(op, c.text);
  ok(p.warnings.some((w) => w.includes("ANNOTATE")), "ANNOTATE được ghi nhận nhưng không tự áp vào bản");
  ok(p.entries.find((e) => e.path === "/risk").disposition === "INHERITED", "khối /risk và điểm không bị tự đổi");
  const { o, t } = await tamper(op, c.text, (j) => { j.risk.critical_gaps = [...j.risk.critical_gaps, "Cảnh báo tổng hợp chưa xác minh"]; });
  ok(codes(await preview(o, t)).includes("WRITE_SET"), "tự chèn cảnh báo vào /risk ngoài write_paths bị chặn");
  mark("CHẶN ĐÚNG", "Chưa hỗ trợ áp ANNOTATE vào payload (v0.1). Muốn đưa cảnh báo vào bản thì dùng REPLACE có write_paths.");
});

// ---------------- B05 ----------------
let R3 = null, M3 = null, opB05 = null;
await scenario("B05", "REPLACE một block", async () => {
  opB05 = await mkOp(R2, { type: "DEEP_DIVE", read: [], write: ["/modules/ownership_governance/analysis"],
    changes: [{ path: "/modules/ownership_governance/analysis", value: "[GĐ6] Phân tích sở hữu tổng hợp." }] });
  const c = await finalize(opB05, R2.bytes);
  const p = await preview(opB05, c.text);
  ok(!p.blockers.length, "không có blocker");
  ok(!validate(JSON.parse(c.text)).length, "bản ứng viên đạt schema 02 + rubric");
  const ch = p.entries.filter((e) => e.disposition === "CHANGED").map((e) => e.path).sort();
  ok(JSON.stringify(ch) === JSON.stringify(["/metadata", "/modules/ownership_governance"]), "chỉ đổi khối được ghi + metadata");
  ok(p.manifest.entries.filter((e) => e.disposition === "INHERITED").every((e) => M2.entries.find((x) => x.path === e.path).version_id === e.version_id), "khối không đổi giữ nguyên version_id cũ");
  ({ R3, M3 } = await integrateLocally(opB05, c.text));
});

// ---------------- B06 ----------------
const WEIGHTS = Object.fromEntries(scorecard.criteria.map((c) => [c.id, c.weight]));
function revalue(v, price) {
  const fv = v.fair_value, bear = v.bear.value, base = v.base.value;
  const down = Math.max(0, 1 - bear / price);
  return { ...v, price, mos: 1 - price / fv, upside: fv / price - 1, downside: down,
    reward_risk: down > 0 && base > price ? (base / price - 1) / down : null };
}
await scenario("B06", "Revaluation đổi giá", async () => {
  const bad = await mkOp(R2, { type: "REVALUATION", write: ["/valuation/price"], changes: [{ path: "/valuation/price", value: 44000 }] });
  const cb = await finalize(bad, R2.bytes);
  const pb = await preview(bad, cb.text);
  ok(pb.blockers.some(([c, m]) => c === "SCHEMA" && /MOS|upside|downside|reward/.test(m)), "chỉ đổi giá mà không tính lại MOS/upside/reward-risk → chặn");
  const good = await mkOp(R2, { type: "REVALUATION", read: ["/valuation"], write: ["/valuation"],
    changes: [{ path: "/valuation", value: revalue(R2.json.valuation, 44000), action: "RECALCULATE", formula: "invstock-valuation@2.0.0" }],
    impact: [{ path: "/decision", result: "NO_CHANGE", reason: "MOS 14,3% < required 35%, vẫn WATCH", reviewer: "test" }] });
  const cg = await finalize(good, R2.bytes);
  const pg = await preview(good, cg.text);
  ok(!pg.blockers.length, "tính lại đầy đủ → không blocker: " + JSON.stringify(pg.blockers.slice(0, 3)));
  ok(pg.entries.filter((e) => e.disposition === "CHANGED").map((e) => e.path).sort().join() === "/metadata,/valuation", "phân rã tác động: chỉ /valuation đổi");
  mark("ĐẠT", "Hệ thống không tự tính lại; nó chặn khi các số liên đới không nhất quán.");
});

// ---------------- B07 ----------------
function rescore(sc, crit, score) {
  const criteria = structuredClone(sc.criteria); criteria[crit].score = score;
  const scored = Object.entries(criteria).filter(([, v]) => v.score !== null);
  const cov = scored.reduce((a, [k]) => a + WEIGHTS[k], 0), pts = scored.reduce((a, [k, v]) => a + WEIGHTS[k] * v.score / 10, 0);
  return { ...sc, criteria, coverage: cov, observed_points: pts, normalized_score: cov ? 100 * pts / cov : null, official_total: cov === 100 ? 100 * pts / cov : null };
}
await scenario("B07", "Re-score có null", async () => {
  const sc = R2.json.scorecard;
  const bad = await mkOp(R2, { type: "RE_SCORE", write: ["/scorecard/criteria"], changes: [{ path: "/scorecard/criteria",
    value: { ...structuredClone(sc.criteria), C01: { ...sc.criteria.C01, score: null } } }] });
  const cb = await finalize(bad, R2.bytes);
  ok((await preview(bad, cb.text)).blockers.some(([c, m]) => c === "SCHEMA" && m.includes("scorecard")), "đặt null mà không tính lại coverage → chặn");
  const nsc = rescore(sc, "C01", null);
  const good = await mkOp(R2, { type: "RE_SCORE", write: ["/scorecard"], changes: [{ path: "/scorecard", value: nsc, action: "RECALCULATE", formula: "rubric-03@2.0.0" }] });
  const cg = await finalize(good, R2.bytes);
  const pg = await preview(good, cg.text);
  ok(!pg.blockers.length, "coverage 51, official_total null đúng rubric → không blocker");
  ok(nsc.coverage === 51 && nsc.official_total === null, "coverage = 57 − 6 = 51; official_total = null vì coverage < 100");
});

// ---------------- B08 ----------------
await scenario("B08", "ESOP đổi số cổ phần", async () => {
  const mk = (res) => mkOp(R2, { type: "DEEP_DIVE", read: ["/valuation"], write: ["/modules/ownership_governance/analysis"],
    changes: [{ path: "/modules/ownership_governance/analysis", value: "[GĐ6] ESOP làm tăng số cổ phần (tổng hợp)." }],
    impact: [{ path: "/valuation", result: res, reason: "EPS/FV phụ thuộc số cổ phần", reviewer: res === "NEEDS_REVIEW" ? null : "test" },
             { path: "/scorecard", result: res, reason: "Tiêu chí liên đới", reviewer: res === "NEEDS_REVIEW" ? null : "test" }] });
  const a = await mk("NEEDS_REVIEW"); const ca = await finalize(a, R2.bytes);
  ok(codes(await preview(a, ca.text)).includes("IMPACT_REVIEW"), "EPS/FV/tiêu chí còn NEEDS_REVIEW → chặn tích hợp");
  const b = await mk("NO_CHANGE"); const cb = await finalize(b, R2.bytes);
  ok(!(await preview(b, cb.text)).blockers.length, "đã review (NO_CHANGE có lý do, reviewer) → cho tích hợp");
  mark("ĐẠT", "Tính lại EPS/FV thực tế là việc của người nghiên cứu; hệ thống buộc phải có review.");
});

// ---------------- B09 ----------------
await scenario("B09", "Hai operation sửa cùng path", async () => {
  const op2 = await mkOp(R2, { type: "DEEP_DIVE", write: ["/modules/ownership_governance/analysis"],
    changes: [{ path: "/modules/ownership_governance/analysis", value: "[GĐ6] Phiên bản khác." }] });
  const c2 = await finalize(op2, R3.bytes); // người lập dựng lại trên head mới
  const p = await preview(op2, c2.text, { base: R2, head: R3, headManifest: M3 });
  ok(codes(p).includes("BLOCK_CONFLICT"), "operation thứ hai (base R2) bị BLOCK_CONFLICT sau khi R3 đã sửa cùng path");
  ok(!p.bundleSha || p.blockers.length > 0, "không last-write-wins");
});

// ---------------- B10 ----------------
await scenario("B10", "Hai path khác nhưng đầu vào đổi", async () => {
  const op = await mkOp(R2, { type: "REVALUATION", read: ["/modules/ownership_governance"], write: ["/modules/valuation_engine/analysis"],
    changes: [{ path: "/modules/valuation_engine/analysis", value: "[GĐ6] Định giá dựa trên số cổ phần cũ." }] });
  const c = await finalize(op, R3.bytes);
  const p = await preview(op, c.text, { base: R2, head: R3, headManifest: M3 });
  ok(codes(p).includes("DEPENDENCY_CHANGED") && !codes(p).includes("BLOCK_CONFLICT"), "write path khác nhưng đầu vào đã đọc bị đổi → DEPENDENCY_CHANGED");
});

// ---------------- B11 (phần engine) ----------------
await scenario("B11", "Base head đổi sau approval", async () => {
  const op = await mkOp(R2, { write: ["/modules/catalysts_expectations/analysis"],
    changes: [{ path: "/modules/catalysts_expectations/analysis", value: "[GĐ6] Chất xúc tác tổng hợp." }] });
  const c = await finalize(op, R2.bytes);
  const approved = (await preview(op, c.text)).bundleSha;
  const after = await preview(op, c.text, { base: R2, head: R3, headManifest: M3 });
  ok(codes(after).includes("BASE_STALE"), "head đổi sang R3 → bản ứng viên (cha R2) bị BASE_STALE");
  ok(after.bundleSha !== approved, "bundle đã duyệt không còn dùng được, phải xem trước và duyệt lại");
  mark("ĐẠT", "RPC lib_integrate cũng từ chối head cũ (SQL GĐ 6 và dry run D3).");
});

// ---------------- B12 ----------------
await scenario("B12", "Source ID trùng hoặc nguồn sau cutoff", async () => {
  const dupSrc = { ...structuredClone(R2.json.sources[0]), title: "Nguồn khác nhưng trùng id" };
  const op = await mkOp(R2, { write: ["/modules/catalysts_expectations/analysis"],
    changes: [{ path: "/modules/catalysts_expectations/analysis", value: "[GĐ6] dùng nguồn trùng id" }] });
  op.sources = [dupSrc];
  const c = await finalize(op, R2.bytes);
  const { o, t } = await tamper(op, c.text, (j) => { j.sources[0] = dupSrc; });
  ok(codes(await preview(o, t)).includes("SOURCE_BINDING_CONFLICT"), "ghi đè nguồn cũ cùng id → SOURCE_BINDING_CONFLICT");
  const late = { id: "Z9", title: "Nguồn công bố sau cutoff", locator: "https://example.invalid/late", published_on: "2026-11-30", accessed_on: "2026-11-26", tier: 3 };
  const op2 = await mkOp(R2, { write: ["/modules/catalysts_expectations/source_ids"],
    changes: [{ path: "/modules/catalysts_expectations/source_ids", value: [...R2.json.modules.catalysts_expectations.source_ids, "Z9"] }] });
  op2.sources = [late]; op2.changes[0].source_refs = ["Z9"];
  const c2 = await finalize(op2, R2.bytes);
  ok((await preview(op2, c2.text)).blockers.some(([cd, m]) => cd === "SCHEMA" && m.includes("source after cutoff")), "nguồn công bố sau cutoff → chặn");
  const { o: o3, t: t3 } = await tamper(op2, c2.text, (j) => { j.modules.catalysts_expectations.source_ids.push("ZZ"); });
  ok((await preview(o3, t3)).blockers.some(([cd]) => cd === "SCHEMA" || cd === "SOURCE_BINDING_CONFLICT"), "tham chiếu nguồn mồ côi → chặn");
  mark("CHẶN ĐÚNG", "Remap source ID có kiểm soát chưa hỗ trợ (v0.1): trùng id thì phải đặt id mới.");
});

// ---------------- B13 (phần engine) ----------------
await scenario("B13", "Manifest thiếu path hoặc hash sai", async () => {
  const bad = structuredClone(M2); bad.entries.pop();
  ok(V.manifest(bad).length > 0, "manifest 26 entry bị schema chặn");
  const wrong = structuredClone(M2); wrong.entries[0].content_hash = "0".repeat(64);
  const rebuilt = await C.buildManifest(R2.bytes, PROFILE, M1, { generatedAt: M2.provenance.generated_at, kind: "LEGACY_BACKFILL", notes: M2.provenance.notes });
  ok(canonicalize(rebuilt) !== canonicalize(wrong), "dựng lại từ bytes gốc phát hiện hash sai (verify_manifest)");
  const op = await mkOp(R2, { write: ["/modules/catalysts_expectations/analysis"], changes: [{ path: "/modules/catalysts_expectations/analysis", value: "[GĐ6] x" }] });
  const c = await finalize(op, R2.bytes);
  ok(codes(await preview(op, c.text, { headManifest: null })).includes("MANIFEST_MISMATCH"), "head thiếu manifest → chặn tích hợp");
  mark("ĐẠT", "RPC lib_register_manifest cũng chặn (SQL GĐ 6).");
});

// ---------------- B14 ----------------
await scenario("B14", "Canonical hash đa runtime, Unicode, số, thứ tự key", async () => {
  const vec = rdj("../jcs/test_vectors.json");
  const list = Array.isArray(vec) ? vec : vec.vectors;
  let n = 0;
  for (const v of list) {
    if (v.error) { let threw = false; try { canonicalize(parseStrict(v.input)); } catch { threw = true; } ok(threw, `vector ${v.name} bị từ chối`); }
    else { const got = canonicalize(parseStrict(v.input)); ok(got === v.canonical && (await sha256Hex(got)) === v.sha256, `vector ${v.name}`); }
    n++;
  }
  let dup = false; try { parseStrict('{"a":1,"a":2}'); } catch { dup = true; }
  ok(dup, "khóa trùng bị từ chối");
  ok(canonicalize({ b: 1, a: "Việt Nam", "€": 1e21, "é": -0 }) === '{"a":"Việt Nam","b":1,"é":0,"€":1e+21}', "Unicode, số, thứ tự key");
  mark("ĐẠT", "Bản Python chạy cùng vector: contracts/jcs/test_vectors.py.");
});

// ---------------- B15 ----------------
await scenario("B15", "No-op operation", async () => {
  const cur = R2.json.modules.valuation_engine.analysis;
  const op = await mkOp(R2, { write: ["/modules/valuation_engine/analysis"], changes: [{ path: "/modules/valuation_engine/analysis", value: cur }] });
  const c = await finalize(op, R2.bytes);
  const p = await preview(op, c.text);
  ok(codes(p).includes("NO_CHANGE"), "chỉ metadata đổi → chặn, không tạo bản/khối trùng thực chất");
  ok(p.warnings.some((w) => w.includes("không có tác dụng")), "báo rõ candidate_value giống head");
});

// ---------------- B16 (phần engine) ----------------
await scenario("B16", "Retry cùng ID/hash; cùng ID khác hash", async () => {
  const c1 = await I.buildCandidate(R2.bytes, opB05), c2 = await I.buildCandidate(R2.bytes, opB05);
  ok(c1.sha256 === c2.sha256 && c1.record_id === c2.record_id, "dựng lại cùng operation + head → cùng bytes, cùng record_id");
  mark("ĐẠT", "Phần DB (idempotent / IMMUTABLE) chạy trong SQL GĐ 6.");
});

// ---------------- B21 ----------------
await scenario("B21", "NOT READY, RESTRICTED", async () => {
  const op = await mkOp(R2, { write: ["/decision/status"], changes: [{ path: "/decision/status", value: "ACCUMULATE" }] });
  const c = await finalize(op, R2.bytes);
  ok((await preview(op, c.text)).blockers.some(([cd, m]) => cd === "SCHEMA" && m.includes("ACCUMULATE gate")), "risk gate RESTRICTED + MOS < required → không thể nâng lên ACCUMULATE");
  mark("ĐẠT", "Tích hợp không tự xuất bản (published=false); xuất bản theo chính sách 12 ở bước riêng.");
});

// ---------------- B22 (phần engine) ----------------
await scenario("B22", "Compare/Screening", async () => {
  const op = rdj("../examples/EXAMPLE_operation_deep_dive.json");
  ok(!V.operation({ ...op, identity: { ticker: "FPT", exchange: "HOSE" } }).length, "operation luôn gắn một mã (identity)");
  let threw = false; try { await C.buildManifest(enc.encode('{"schema_name":"invstock_screening_v2","metadata":{}}'), PROFILE); } catch { threw = true; }
  ok(threw, "không dựng được manifest block từ bản screening → không sinh block version");
  mark("ĐẠT", "Phần DB (nạp screening không đổi head/publication/manifest của FPT) chạy trong SQL GĐ 6.");
});

// ---------------- Gộp nhiều operation ----------------
await scenario("MULTI", "Gộp nhiều operation vào một bản (doc 13 §11)", async () => {
  const a = await mkOp(R2, { write: ["/modules/catalysts_expectations/analysis"], changes: [{ path: "/modules/catalysts_expectations/analysis", value: "[GĐ6] A" }] });
  const b = await mkOp(R2, { write: ["/modules/growth_forecast/analysis"], changes: [{ path: "/modules/growth_forecast/analysis", value: "[GĐ6] B" }] });
  const ca = await finalize(a, R2.bytes);
  const merged = await I.buildCandidate(Buffer.from(ca.text), b); // ghép B lên bản ứng viên của A
  const j = JSON.parse(merged.text); j.metadata = JSON.parse(ca.text).metadata;
  const t = JSON.stringify(j, null, 2) + "\n";
  const o = structuredClone(a); o.output_refs.candidate_sha256 = await C.sha256Bytes(enc.encode(t));
  ok(codes(await preview(o, t)).includes("WRITE_SET"), "một bản chứa thay đổi của hai operation bị chặn (khối của B ngoài phạm vi A)");
  mark("CHƯA HỖ TRỢ", "v0.1 tích hợp tuần tự từng operation (R3 rồi R4). Gộp nhiều operation cần mở rộng contract.");
});

const summary = results.map((r) => ({ id: r.id, title: r.title, status: r.status, checks: r.checks.length, failed: r.checks.filter(([c]) => !c).length, note: r.note }));
console.table(summary.map(({ id, status, checks, failed }) => ({ id, status, checks, failed })));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
const fail = summary.reduce((a, s) => a + s.failed, 0);
console.log(fail ? `${fail} FAIL` : "ALL PASS");
process.exit(fail ? 1 : 0);
