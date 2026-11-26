#!/usr/bin/env python3
"""Validator DRAFT 0.1.0 cho Research Note / Research Operation / Snapshot Manifest.

  python3 validate_contract.py note FILE
  python3 validate_contract.py operation FILE [--base SNAPSHOT.json]
  python3 validate_contract.py manifest FILE [--snapshot SNAPSHOT.json] [--parent PARENT_MANIFEST.json]

Thoát 0 = PASS, 1 = FAIL. Chỉ kiểm tra cấu trúc + logic nội bộ, không xác minh sự thật, nguồn, DB hay quyền.
"""
import argparse
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

sys.path.insert(0, str(Path(__file__).resolve().parent))
import invstock_contracts as ic  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SCHEMAS = {"note": "research_note.schema.json", "operation": "research_operation.schema.json",
           "manifest": "snapshot_manifest.schema.json"}


def registry():
    reg = Registry()
    for f in ["defs.schema.json", *SCHEMAS.values()]:
        s = json.loads((ROOT / f).read_text("utf-8"))
        reg = reg.with_resource(s["$id"], Resource.from_contents(s))
    return reg


def schema_errors(kind, doc):
    s = json.loads((ROOT / SCHEMAS[kind]).read_text("utf-8"))
    v = Draft202012Validator(s, registry=registry())
    return [("SCHEMA", f"{'/' + '/'.join(map(str, e.absolute_path))}: {e.message[:200]}")
            for e in sorted(v.iter_errors(doc), key=lambda e: list(map(str, e.absolute_path)))]


def validate(kind, path, base=None, snapshot=None, parent=None):
    try:
        doc = ic.parse_strict(Path(path).read_text("utf-8"))
    except ic.JcsError as e:
        return [("PARSE", str(e))]
    errs = schema_errors(kind, doc)
    if errs:
        return errs
    if kind == "note":
        return ic.check_note(doc)
    if kind == "operation":
        return ic.check_operation(doc, Path(base).read_bytes() if base else None)
    par = json.loads(Path(parent).read_text("utf-8")) if parent else None
    return ic.check_manifest(doc, Path(snapshot).read_bytes() if snapshot else None, par)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=SCHEMAS)
    ap.add_argument("file")
    ap.add_argument("--base")
    ap.add_argument("--snapshot")
    ap.add_argument("--parent")
    a = ap.parse_args()
    errs = validate(a.kind, a.file, a.base, a.snapshot, a.parent)
    for code, msg in errs:
        print(f"FAIL [{code}] {msg}")
    print("PASS" if not errs else f"{len(errs)} lỗi")
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
