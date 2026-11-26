// InvStock JCS (RFC 8785) – canonical JSON cho hash khối/thành phần (tài liệu 13, mục 3).
// Chạy được trên Node, Deno và trình duyệt. Không phụ thuộc thư viện ngoài.
// - parseStrict: đọc JSON văn bản, TỪ CHỐI khóa trùng, NaN/Infinity, số vượt phạm vi double.
// - canonicalize: chuỗi JCS (khóa sắp theo UTF-16 code unit, số theo ECMAScript Number#toString).
// - sha256Hex: SHA-256 trên bytes UTF-8 của chuỗi JCS.
export const CANONICALIZATION_VERSION = "JCS-RFC8785/invstock-1";

export class JcsError extends Error {}

export function parseStrict(text) {
  let i = 0;
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
  const fail = (m) => { throw new JcsError(`${m} at ${i}`); };
  function value() {
    ws();
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    if (c === "t" && text.startsWith("true", i)) { i += 4; return true; }
    if (c === "f" && text.startsWith("false", i)) { i += 5; return false; }
    if (c === "n" && text.startsWith("null", i)) { i += 4; return null; }
    return number();
  }
  function object() {
    i++; const out = Object.create(null); const seen = new Set(); ws();
    if (text[i] === "}") { i++; return out; }
    for (;;) {
      ws(); if (text[i] !== '"') fail("expected key");
      const k = string();
      if (seen.has(k)) fail(`duplicate key ${JSON.stringify(k)}`);
      seen.add(k); ws();
      if (text[i] !== ":") fail("expected ':'"); i++;
      out[k] = value(); ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return out; }
      fail("expected ',' or '}'");
    }
  }
  function array() {
    i++; const out = []; ws();
    if (text[i] === "]") { i++; return out; }
    for (;;) {
      out.push(value()); ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return out; }
      fail("expected ',' or ']'");
    }
  }
  function string() {
    const m = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(text.slice(i));
    if (!m) fail("invalid string");
    i += m[0].length;
    return JSON.parse(m[0]);
  }
  function number() {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail("invalid value");
    i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail("number out of range");
    return n;
  }
  const v = value(); ws();
  if (i !== text.length) fail("trailing data");
  return v;
}

const cmpUtf16 = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // JS so sánh chuỗi theo UTF-16 code unit

export function canonicalize(v) {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new JcsError("NaN/Infinity not allowed");
    return JSON.stringify(v); // -0 → "0"; ES Number#toString
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v).sort(cmpUtf16);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
  }
  throw new JcsError(`unsupported type ${typeof v}`);
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function jcsHash(value) {
  return sha256Hex(canonicalize(value));
}
