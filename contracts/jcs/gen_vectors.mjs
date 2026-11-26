// Sinh test_vectors.json từ jcs.mjs (bản tham chiếu theo ngữ nghĩa ECMAScript).
// Chạy: node gen_vectors.mjs vector_inputs.json
import { readFileSync, writeFileSync } from "node:fs";
import { parseStrict, canonicalize, sha256Hex, JcsError } from "./jcs.mjs";
const inputs = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = [];
for (const v of inputs) {
  try {
    const c = canonicalize(parseStrict(v.input));
    if (v.error) throw new Error(`${v.name}: expected error, got ${c}`);
    out.push({ name: v.name, input: v.input, canonical: c, sha256: await sha256Hex(c) });
  } catch (e) {
    if (!(e instanceof JcsError) || !v.error) throw e;
    out.push({ name: v.name, input: v.input, error: true });
  }
}
writeFileSync(new URL("./test_vectors.json", import.meta.url), JSON.stringify({ canonicalization_version: "JCS-RFC8785/invstock-1", vectors: out }, null, 2) + "\n");
console.log(out.length, "vectors");
