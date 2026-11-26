#!/usr/bin/env python3
"""Kiểm thử contract DRAFT 0.1.0 trên fixture tổng hợp (không dùng nội dung báo cáo thật).

  python3 contracts/tests/test_contracts.py
"""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "tools"))
import invstock_contracts as ic  # noqa: E402
import validate_contract as vc  # noqa: E402

PROFILE = "4aaab883-425f-44af-8bf6-7abf0a46918a"
EX = HERE.parent / "examples"


def snapshot(rev=1, parent=None, rid="aaaaaaaa-0000-4000-8000-000000000001", src_prefix="S", tweak=None):
    srcs = [{"id": f"{src_prefix}{i}", "title": f"Nguồn tổng hợp {i}", "locator": f"https://example.invalid/{i}",
             "published_on": None, "accessed_on": "2026-11-25", "tier": 2} for i in (1, 2)]
    mods = {k: {"analysis": f"Nội dung tổng hợp {k}", "metrics": [], "source_ids": [f"{src_prefix}1"], "gaps": []}
            for k in ic.MODULE_KEYS}
    d = {"schema_name": "invstock_full_research", "schema_version": "2.0.0",
         "metadata": {"record_id": rid, "revision": rev, "parent_id": parent, "as_of": "2026-11-25",
                      "cutoff": "2026-11-25", "reporting_period": "Q3/2026", "scorecard_version": "2.0.0",
                      "change_log": [f"r{rev}"]},
         "identity": {"ticker": "TST", "exchange": "HOSE", "company": "Công ty Test", "sector": "Test"},
         "sources": srcs, "modules": mods,
         **{k: {"value": k, "source_ids": [f"{src_prefix}2"]} for k in
            ["core10", "committee", "scorecard", "valuation", "risk", "decision", "catalysts", "monitoring"]}}
    if tweak:
        tweak(d)
    return json.dumps(d, ensure_ascii=False, indent=1).encode("utf-8")


def write(tmp, name, obj):
    p = Path(tmp) / name
    p.write_bytes(obj if isinstance(obj, bytes) else json.dumps(obj, ensure_ascii=False).encode("utf-8"))
    return str(p)


def codes(errs):
    return {c for c, _ in errs}


class Manifest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.r1 = snapshot()
        self.m1 = ic.build_manifest(self.r1, PROFILE)

    def check(self, m, snap, parent=None):
        p = write(self.tmp, "m.json", m)
        return vc.validate("manifest", p, snapshot=write(self.tmp, "s.json", snap),
                           parent=write(self.tmp, "p.json", parent) if parent else None)

    def test_initial_manifest_pass_and_covers_27(self):
        self.assertEqual(self.check(self.m1, self.r1), [])
        self.assertEqual(len(self.m1["entries"]), 27)
        self.assertTrue(all(e["disposition"] == "INITIAL" for e in self.m1["entries"]))

    def test_partial_update_inherits_unchanged_blocks(self):
        def t(d):
            d["modules"]["valuation_engine"]["analysis"] = "Định giá mới"
        r2 = snapshot(2, self.m1["record_id"], "aaaaaaaa-0000-4000-8000-000000000002", tweak=t)
        m2 = ic.build_manifest(r2, PROFILE, self.m1)
        self.assertEqual(self.check(m2, r2, self.m1), [])
        changed = {e["path"] for e in m2["entries"] if e["disposition"] == "CHANGED"}
        self.assertEqual(changed, {"/modules/valuation_engine", "/metadata"})
        ve = next(e for e in m2["entries"] if e["path"] == "/modules/valuation_engine")
        self.assertEqual((ve["block_revision"], ve["change_class"]), (2, "CONTENT"))

    def test_source_remap_detected(self):
        r2 = snapshot(2, self.m1["record_id"], "aaaaaaaa-0000-4000-8000-000000000002", src_prefix="Z")
        m2 = ic.build_manifest(r2, PROFILE, self.m1)
        classes = {e["change_class"] for e in m2["entries"] if e["path"].startswith("/modules/")}
        self.assertEqual(classes, {"SOURCE_REMAP"})

    def test_source_descriptor_change_changes_hash(self):
        def t(d):
            d["sources"][0]["locator"] = "https://example.invalid/other"
        r2 = snapshot(2, self.m1["record_id"], "aaaaaaaa-0000-4000-8000-000000000002", tweak=t)
        m2 = ic.build_manifest(r2, PROFILE, self.m1)
        es = next(e for e in m2["entries"] if e["path"] == "/modules/executive_summary")
        self.assertEqual(es["disposition"], "CHANGED")

    def test_snapshot_bytes_mismatch(self):
        other = snapshot(tweak=lambda d: d["identity"].update(sector="Khác"))
        self.assertIn("MANIFEST_MISMATCH", codes(self.check(self.m1, other)))

    def test_whitespace_only_bytes_change_breaks_snapshot_sha_but_not_blocks(self):
        reformatted = json.dumps(json.loads(self.r1), ensure_ascii=False).encode("utf-8")
        m = ic.build_manifest(reformatted, PROFILE)
        self.assertNotEqual(m["snapshot_sha256"], self.m1["snapshot_sha256"])
        self.assertEqual([e["content_hash"] for e in m["entries"]], [e["content_hash"] for e in self.m1["entries"]])

    def test_overlap_and_missing_paths(self):
        m = copy.deepcopy(self.m1)
        e = copy.deepcopy(m["entries"][0])
        e.update(path="/modules", key="executive_summary")
        m["entries"][0] = e
        errs = ic.check_manifest(m)
        self.assertIn("MANIFEST_MISMATCH", codes(errs))
        self.assertTrue(any("chồng lấn" in msg for _, msg in errs))

    def test_tampered_entry_hash(self):
        m = copy.deepcopy(self.m1)
        m["entries"][3]["content_hash"] = "0" * 64
        self.assertIn("MANIFEST_MISMATCH", codes(self.check(m, self.r1)))

    def test_wrong_disposition_vs_parent(self):
        r2 = snapshot(2, self.m1["record_id"], "aaaaaaaa-0000-4000-8000-000000000002")
        m2 = ic.build_manifest(r2, PROFILE, self.m1)
        m2["entries"][0]["disposition"] = "CHANGED"
        m2["entries"][0]["change_class"] = "CONTENT"
        self.assertIn("MANIFEST_MISMATCH", codes(self.check(m2, r2, self.m1)))

    def test_dangling_source_id(self):
        bad = snapshot(tweak=lambda d: d["modules"]["debt_liquidity"].update(source_ids=["NOPE"]))
        with self.assertRaises(ic.ContractError) as cm:
            ic.build_manifest(bad, PROFILE)
        self.assertEqual(cm.exception.code, "SOURCE_BINDING_CONFLICT")

    def test_duplicate_key_rejected(self):
        p = write(self.tmp, "dup.json", b'{"contract_name":"a","contract_name":"b"}')
        self.assertEqual(codes(vc.validate("manifest", p)), {"PARSE"})


class NoteAndOperation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.note = json.loads((EX / "EXAMPLE_note_ownership.json").read_text("utf-8"))
        self.op = json.loads((EX / "EXAMPLE_operation_deep_dive.json").read_text("utf-8"))

    def v(self, kind, doc, base=None):
        return vc.validate(kind, write(self.tmp, "d.json", doc), base=write(self.tmp, "b.json", base) if base else None)

    def test_examples_pass_schema_and_semantics(self):
        self.assertEqual(self.v("note", self.note), [])
        self.assertEqual(self.v("operation", self.op), [])

    def test_note_two_primary(self):
        n = copy.deepcopy(self.note)
        n["module_links"][1]["role"] = "PRIMARY"
        self.assertIn("PRIMARY_MODULE", codes(self.v("note", n)))

    def test_note_cutoff_after_as_of(self):
        n = copy.deepcopy(self.note)
        n["cutoff"] = "2026-12-01"
        self.assertIn("CUTOFF_AFTER_AS_OF", codes(self.v("note", n)))

    def test_note_unknown_source(self):
        n = copy.deepcopy(self.note)
        n["evidence"][0]["source_ids"] = ["NOPE"]
        self.assertIn("SOURCE_BINDING_CONFLICT", codes(self.v("note", n)))

    def test_note_without_base_needs_reason(self):
        n = copy.deepcopy(self.note)
        n["base"] = None
        self.assertIn("SCHEMA", codes(self.v("note", n)))
        n["base_absent_reason"] = "Chưa có Full Research"
        self.assertEqual(self.v("note", n), [])

    def test_note_extra_field_rejected(self):
        n = copy.deepcopy(self.note)
        n["record_id"] = "x"
        self.assertIn("SCHEMA", codes(self.v("note", n)))

    def _replace_op(self, base_bytes, path="/modules/valuation_engine"):
        snap = json.loads(base_bytes)
        o = copy.deepcopy(self.op)
        o["operation_type"] = "REVALUATION"
        o["base"].update(record_id=snap["metadata"]["record_id"], revision=snap["metadata"]["revision"],
                         sha256=ic.sha256_bytes(base_bytes))
        o["read_paths"], o["write_paths"] = [path], [path]
        o["expected_input_hashes"] = [{"path": path, "content_hash": ic.block_hashes(snap, path)[0]}]
        o["changes"] = [{"path": path, "action": "REPLACE", "expected_old_hash": ic.block_hashes(snap, path)[0],
                         "candidate_value": {"analysis": "mới", "metrics": [], "source_ids": ["X1"], "gaps": []},
                         "reason": "test", "source_refs": ["X1"]}]
        o["outcome"] = "CANDIDATE_SNAPSHOT"
        o["output_refs"].update(candidate_record_id="aaaaaaaa-0000-4000-8000-000000000009", candidate_sha256="1" * 64)
        return o

    def test_replace_against_fresh_base_passes(self):
        base = snapshot()
        self.assertEqual(self.v("operation", self._replace_op(base), base), [])

    def test_base_stale(self):
        base = snapshot()
        o = self._replace_op(base)
        self.assertIn("BASE_STALE", codes(self.v("operation", o, snapshot(tweak=lambda d: d["identity"].update(sector="X")))))

    def test_block_conflict_and_dependency_changed(self):
        base = snapshot()
        o = self._replace_op(base)
        o["changes"][0]["expected_old_hash"] = "2" * 64
        o["expected_input_hashes"][0]["content_hash"] = "3" * 64
        self.assertTrue({"BLOCK_CONFLICT", "DEPENDENCY_CHANGED"} <= codes(self.v("operation", o, base)))

    def test_forbidden_paths(self):
        for p in ["/metadata/revision", "/metadata/record_id", "/metadata/parent_id", "/schema_version", "/metadata"]:
            o = self._replace_op(snapshot())
            o["write_paths"] = [p]
            o["changes"][0]["path"] = p
            self.assertIn("FORBIDDEN_PATH", codes(self.v("operation", o)), p)

    def test_write_outside_write_set(self):
        o = self._replace_op(snapshot())
        o["write_paths"] = ["/modules/risk_x"]
        self.assertIn("WRITE_SET", codes(self.v("operation", o)))

    def test_null_is_not_delete(self):
        o = self._replace_op(snapshot())
        o["changes"][0]["candidate_value"] = None
        self.assertIn("NULL_NOT_DELETE", codes(self.v("operation", o)))

    def test_non_full_operation_requires_base(self):
        o = copy.deepcopy(self.op)
        o["base"] = None
        self.assertIn("SCHEMA", codes(self.v("operation", o)))

    def test_append_requires_note_ref(self):
        o = copy.deepcopy(self.op)
        del o["changes"][0]["note_ref"]
        self.assertIn("SCHEMA", codes(self.v("operation", o)))

    def test_candidate_snapshot_requires_refs(self):
        o = copy.deepcopy(self.op)
        o["outcome"] = "CANDIDATE_SNAPSHOT"
        self.assertIn("SCHEMA", codes(self.v("operation", o)))


if __name__ == "__main__":
    unittest.main(verbosity=1)
