// Port of InvStock_Operating_Framework_v2/validate.py (v2.0.0). Keep semantics in sync with the Python file.

// Ô này chỉ nhận Full JSON schema 02 (schema_name). Nói rõ file thực ra là gì để người dùng đưa đúng chỗ.
export function unknownSchemaMessage(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return "Unknown schema: file không phải object JSON";
  const where = "Không phải Full JSON (schema 02). Nhập ở mục 3 'Khối, chuyên đề & tác vụ' của trang quản trị";
  if (d.contract_name === "invstock.research_note") return `Unknown schema: đây là Research Note. ${where} (ô Chuyên đề).`;
  if (d.contract_name === "invstock.research_operation") return `Unknown schema: đây là Research Operation. ${where} (ô Tác vụ nghiên cứu, sau khi đã nhập chuyên đề).`;
  if (d.contract_name === "invstock.snapshot_manifest") return "Unknown schema: đây là Snapshot Manifest; manifest do máy chủ tự dựng, không cần tải lên.";
  if (d.operation_type && Array.isArray(d.notes) && Array.isArray(d.changes))
    return "Unknown schema: đây là gói review hợp nhất (operation + notes, không có contract_name). " +
      "Chạy contracts/tools/convert_review_bundle.mjs để tách thành note + operation contract 0.1.0, rồi nhập ở mục 3.";
  if (d.schema_name) return `Unknown schema: schema_name '${d.schema_name}' không được hỗ trợ (chỉ invstock_research_v2, invstock_screening_v2).`;
  return "Unknown schema: thiếu schema_name (invstock_research_v2 hoặc invstock_screening_v2).";
}
export function makeValidator(Ajv2020, addFormats, schemas, scorecardFramework) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const compiled = {
    invstock_research_v2: ajv.compile(schemas.research),
    invstock_screening_v2: ajv.compile(schemas.screening),
  };
  const weights = Object.fromEntries(scorecardFramework.criteria.map((c) => [c.id, c.weight]));
  const isclose = (a, b) => Math.abs(a - b) <= Math.max(1e-6 * Math.max(Math.abs(a), Math.abs(b)), 1e-6);
  const eq = (a, b) => (a == null && b == null) || (a != null && b != null && isclose(a, b));

  return function validate(d) {
    const v = d && compiled[d.schema_name];
    if (!v) return [unknownSchemaMessage(d)];
    if (!v(d)) return v.errors.map((e) => `${e.instancePath || "/"}: ${e.message}`);
    const errors = [];
    const check = (ok, msg) => { if (!ok) errors.push(msg); };
    const m = d.metadata;
    check(m.cutoff <= m.as_of, "cutoff after as_of");
    check((m.revision === 1) === (m.parent_id === null), "parent/revision mismatch");
    check(m.parent_id !== m.record_id, "self parent");
    check(m.revision === 1 || m.change_log.length > 0, "missing change log");
    const ids = d.sources.map((s) => s.id);
    check(ids.length === new Set(ids).size, "duplicate source IDs");
    for (const s of d.sources) check(s.published_on === null || s.published_on <= m.cutoff, "source after cutoff");
    const idset = new Set(ids);
    const walk = (x) => {
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (x && typeof x === "object") {
        if ("source_ids" in x) check(x.source_ids.every((i) => idset.has(i)), "unknown source reference");
        if ("classification" in x) {
          check((x.value === null) === (x.classification === "UNAVAILABLE"), "metric classification mismatch");
          check(x.value !== null || Boolean(x.missing_reason), "missing reason");
        }
        Object.values(x).forEach(walk);
      }
    };
    walk(d);
    const sc = (s) => {
      const c = Object.entries(s.criteria);
      const scored = c.filter(([, v]) => v.score !== null);
      const cov = scored.reduce((a, [k]) => a + weights[k], 0);
      const pts = scored.reduce((a, [k, v]) => a + (weights[k] * v.score) / 10, 0);
      const norm = cov ? (100 * pts) / cov : null;
      for (const [k, val] of [["coverage", cov], ["observed_points", pts], ["normalized_score", norm], ["official_total", cov === 100 ? norm : null]])
        check(eq(s[k], val), "scorecard " + k);
      for (const [k, v] of c) check(v.score === null || v.source_ids.length > 0, "scored without source " + k);
    };
    if (d.schema_name === "invstock_research_v2") {
      sc(d.scorecard);
      const v = d.valuation, p = v.price, fv = v.fair_value;
      const [b, a, u] = ["bear", "base", "bull"].map((k) => v[k].value);
      const probs = ["bear", "base", "bull"].map((k) => v[k].probability);
      check(p === null || p > 0, "nonpositive price");
      check(fv === null || fv > 0, "nonpositive FV");
      check(v.price_date === null || v.price_date <= m.cutoff, "price after cutoff");
      check(p === null || v.price_date !== null, "price date missing");
      check(probs.every((x) => x === null) || (probs.every((x) => x !== null) && eq(probs.reduce((s, x) => s + x, 0), 1)), "scenario probabilities");
      if ([b, a, u].every((x) => x !== null)) {
        check(0 <= b && b <= a && a <= u, "scenario order");
        const expected = probs.every((y) => y !== null) ? b * probs[0] + a * probs[1] + u * probs[2] : a;
        check(eq(fv, expected), "fair value");
      }
      if (p && p > 0 && fv && fv > 0) { check(eq(v.mos, 1 - p / fv), "MOS"); check(eq(v.upside, fv / p - 1), "upside"); }
      if (p && p > 0 && b !== null) {
        const down = Math.max(0, 1 - b / p);
        check(eq(v.downside, down), "downside");
        check(eq(v.reward_risk, down > 0 && a !== null && a > p ? (a / p - 1) / down : null), "reward/risk");
      }
      if (fv !== null && v.required_mos !== null) check(eq(v.max_buy, fv * (1 - v.required_mos)), "max buy");
      if (d.decision.status === "ACCUMULATE")
        check(["PASS", "CAUTION"].includes(d.risk.gate) && d.risk.critical_gaps.length === 0 && d.decision.thesis_status !== "INVALIDATED" &&
          ["C06", "C07", "C08", "C10", "C11", "C12", "C13"].every((k) => d.scorecard.criteria[k].score !== null) &&
          v.mos !== null && v.required_mos !== null && v.mos >= v.required_mos, "ACCUMULATE gate");
    } else {
      const cs = d.candidates;
      check(cs.length === d.universe_count, "universe count");
      check(new Set(cs.map((c) => c.exchange + "|" + c.ticker)).size === cs.length, "duplicate ticker");
      const ranked = [];
      for (const c of cs) {
        if (c.scorecard) sc(c.scorecard);
        if (c.disposition === "RANKED") {
          check(c.scorecard && c.scorecard.official_total !== null && ["PASS", "CAUTION"].includes(c.risk_gate) && c.rank !== null, "rank eligibility");
          ranked.push(c);
        } else check(c.rank === null, "non-ranked rank");
      }
      if (ranked.every((c) => c.scorecard && c.scorecard.official_total !== null)) {
        ranked.sort((x, y) => (y.scorecard.official_total - x.scorecard.official_total) ||
          ((y.mos ?? -Infinity) - (x.mos ?? -Infinity)) || (x.ticker < y.ticker ? -1 : x.ticker > y.ticker ? 1 : 0));
        check(ranked.every((c, i) => c.rank === i + 1), "rank order");
      }
    }
    return errors;
  };
}
