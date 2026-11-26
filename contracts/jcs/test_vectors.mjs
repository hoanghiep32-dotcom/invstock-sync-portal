// Kiểm tra jcs.mjs theo test_vectors.json: node contracts/jcs/test_vectors.mjs
import { readFileSync } from "node:fs";
import { parseStrict, canonicalize, sha256Hex } from "./jcs.mjs";
const { vectors } = JSON.parse(readFileSync(new URL("./test_vectors.json", import.meta.url), "utf8"));
let fail = 0;
for (const v of vectors) {
  let got, err = false;
  try { got = canonicalize(parseStrict(v.input)); } catch { err = true; }
  const ok = v.error ? err : !err && got === v.canonical && (await sha256Hex(got)) === v.sha256;
  if (!ok) { fail++; console.log("FAIL", v.name, got); }
}
console.log(`${vectors.length - fail}/${vectors.length} PASS (js)`);
process.exit(fail ? 1 : 0);
