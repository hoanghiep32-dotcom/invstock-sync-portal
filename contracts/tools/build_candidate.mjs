// Dựng bản Full JSON ứng viên từ head + operation nháp, rồi điền output_refs vào operation (GĐ 5).
//   node contracts/tools/build_candidate.mjs <operation_draft.json> <head_snapshot.json> <thư_mục_ra>
// Ghi ra <thư_mục_ra>/operation.json và <thư_mục_ra>/<TICKER>_R<n>_candidate.json.
// Dựng ứng viên KHÔNG thay việc nghiên cứu: các giá trị liên đới (EPS, FV, MOS, điểm…) phải nằm sẵn trong changes.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const here = new URL(".", import.meta.url);
const I = await import(new URL("../../supabase/functions/_shared/contracts/integration.js", here));
const C = await import(new URL("../../supabase/functions/_shared/contracts/contracts.js", here));

const [opPath, headPath, outDir] = process.argv.slice(2);
if (!outDir) { console.error("cách dùng: build_candidate.mjs <operation_draft.json> <head.json> <out_dir>"); process.exit(2); }
const op = C.parseContractText(readFileSync(opPath, "utf8"));
const headBytes = readFileSync(headPath);
const head = JSON.parse(headBytes.toString("utf8"));
const headSha = await C.sha256Bytes(headBytes);
if (op.base?.record_id !== head.metadata.record_id || op.base?.sha256 !== headSha)
  console.warn(`CẢNH BÁO: base của operation (${op.base?.record_id}) khác head đưa vào – engine sẽ kiểm tra rebase ba chiều.`);
const cand = await I.buildCandidate(headBytes, op);
op.outcome = "CANDIDATE_SNAPSHOT";
op.output_refs = { ...op.output_refs, candidate_record_id: cand.record_id, candidate_sha256: cand.sha256 };
mkdirSync(outDir, { recursive: true });
const candFile = join(outDir, `${head.identity.ticker}_R${head.metadata.revision + 1}_candidate.json`);
writeFileSync(candFile, cand.text);
writeFileSync(join(outDir, "operation.json"), JSON.stringify(op, null, 2) + "\n");
console.log(JSON.stringify({ candidate: candFile, record_id: cand.record_id, sha256: cand.sha256 }, null, 2));
