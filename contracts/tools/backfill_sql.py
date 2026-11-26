#!/usr/bin/env python3
"""Sinh SQL backfill manifest từ các file manifest (theo thứ tự revision).

  python3 backfill_sql.py FPT_R1.manifest.json FPT_R2.manifest.json > backfill.sql

Bytes manifest được nhúng base64 để SQL Editor không làm đổi byte nào; RPC tự tính lại sha256
và đối chiếu với lib_records. Mỗi lệnh kiểm tra manifest_sha256 kỳ vọng.
"""
import base64
import hashlib
import sys
from pathlib import Path

print("-- Backfill manifest (doc 13 §15). Chạy sau migration 20261126_lib_blocks_01_notes_registry.sql.")
print("begin;")
for f in sys.argv[1:]:
    b = Path(f).read_bytes()
    sha = hashlib.sha256(b).hexdigest()
    b64 = base64.b64encode(b).decode()
    print(f"-- {Path(f).name}  manifest_sha256={sha}")
    print("do $$ declare r jsonb; begin")
    print(f"  r := invstock.lib_register_manifest(decode('{b64}', 'base64'), null);")
    print(f"  if r->>'manifest_sha256' <> '{sha}' then raise exception 'unexpected manifest sha %', r; end if;")
    print("  raise notice '%', r;")
    print("end $$;")
print("commit;")
