// Kiểm tra bản JS (supabase/functions/_shared/contracts) cho kết quả giống hệt bản Python.
//   node contracts/tests/test_js_parity.mjs <R1.json> <R2.json>   (cần ajv@8 trong NODE_PATH hoặc node_modules)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const here = new URL(".", import.meta.url);
const C = await import(new URL("../../supabase/functions/_shared/contracts/contracts.js", here));
const rd = (p) => readFileSync(new URL(p, here));
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log("FAIL", m); } else console.log("PASS", m); };

for (const f of ["defs.schema.json", "research_note.schema.json", "research_operation.schema.json", "snapshot_manifest.schema.json"]) {
  ok(rd(`../${f}`).equals(rd(`../../supabase/functions/_shared/contracts/${f}`)), `bản sao schema ${f} đồng bộ`);
}
ok(rd("../jcs/jcs.mjs").equals(rd("../../supabase/functions/_shared/contracts/jcs.js")), "bản sao jcs.js đồng bộ");

const PROFILE = "4aaab883-425f-44af-8bf6-7abf0a46918a";
const note = "Backfill từ bytes gốc đã sync; không có operation/reviewer lịch sử nên để trống.";
const [r1, r2] = process.argv.slice(2).map((p) => readFileSync(p));
if (r1 && r2) {
  const opts = { generatedAt: "2026-11-26T00:00:00Z", kind: "LEGACY_BACKFILL", notes: note };
  const m1 = await C.buildManifest(r1, PROFILE, null, opts);
  const m2 = await C.buildManifest(r2, PROFILE, m1, opts);
  ok(Buffer.from(C.manifestBytes(m1)).equals(rd("../examples/FPT_R1.manifest.json")), "manifest R1 JS == Python (từng byte)");
  ok(Buffer.from(C.manifestBytes(m2)).equals(rd("../examples/FPT_R2.manifest.json")), "manifest R2 JS == Python (từng byte)");
}
const require = createRequire(process.cwd() + "/");
const Ajv2020 = require("ajv/dist/2020").default;
const schemas = Object.fromEntries([["defs", "defs"], ["note", "research_note"], ["operation", "research_operation"], ["manifest", "snapshot_manifest"]]
  .map(([k, f]) => [k, JSON.parse(rd(`../${f}.schema.json`))]));
const V = C.makeContractValidators(Ajv2020, schemas);
const n = C.parseContractText(rd("../examples/EXAMPLE_note_ownership.json").toString());
const o = C.parseContractText(rd("../examples/EXAMPLE_operation_deep_dive.json").toString());
ok(V.note(n).length === 0 && C.checkNote(n).length === 0, "note ví dụ PASS (JS)");
ok(V.operation(o).length === 0, "operation ví dụ PASS schema (JS)");
ok(V.manifest(C.parseContractText(rd("../examples/FPT_R2.manifest.json").toString())).length === 0, "manifest R2 PASS schema (JS)");
const bad = structuredClone(n); bad.module_links[1].role = "PRIMARY";
ok(C.checkNote(bad).some(([c]) => c === "PRIMARY_MODULE"), "JS bắt lỗi 2 PRIMARY");
const badOp = structuredClone(o); badOp.write_paths = ["/metadata"];
ok((await C.checkOperation(badOp)).some(([c]) => c === "FORBIDDEN_PATH"), "JS bắt FORBIDDEN_PATH");
if (r2) {
  ok((await C.checkOperation(o, r2)).length === 0, "operation ví dụ PASS với base R2 (JS)");
  ok((await C.checkOperation(o, r1)).some(([c]) => c === "BASE_STALE"), "JS bắt BASE_STALE với base R1");
}
try { C.parseContractText('{"a":1,"a":2}'); ok(false, "khóa trùng"); } catch (e) { ok(e instanceof C.JcsError, "JS từ chối khóa trùng"); }
console.log(fail ? `${fail} FAIL` : "ALL PASS (js parity)");
process.exit(fail ? 1 : 0);
