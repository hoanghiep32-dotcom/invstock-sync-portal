#!/usr/bin/env python3
"""Dựng manifest backfill ví dụ cho FPT R1/R2 từ bytes gốc (không commit bytes gốc vào repo).

  python3 build_fpt_examples.py R1.json R2.json OUT_DIR
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import invstock_contracts as ic  # noqa: E402

FPT_PROFILE = "4aaab883-425f-44af-8bf6-7abf0a46918a"  # invstock.securities.id của FPT/HOSE

r1, r2, out = Path(sys.argv[1]).read_bytes(), Path(sys.argv[2]).read_bytes(), Path(sys.argv[3])
note = "Backfill từ bytes gốc đã sync; không có operation/reviewer lịch sử nên để trống."
m1 = ic.build_manifest(r1, FPT_PROFILE, None, "2026-11-26T00:00:00Z", notes=note)
m2 = ic.build_manifest(r2, FPT_PROFILE, m1, "2026-11-26T00:00:00Z", notes=note)
out.mkdir(parents=True, exist_ok=True)
for name, m in (("FPT_R1.manifest.json", m1), ("FPT_R2.manifest.json", m2)):
    b = ic.manifest_bytes(m)
    (out / name).write_bytes(b)
    print(name, "manifest_sha256", ic.sha256_bytes(b))
for e in m2["entries"]:
    print(f"  {e['path']:<36} {e['disposition']:<9} {e['change_class']:<12} rev{e['block_revision']}")
