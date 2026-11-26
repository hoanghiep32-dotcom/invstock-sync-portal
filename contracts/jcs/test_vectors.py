"""Kiểm tra jcs.py theo test_vectors.json: python3 contracts/jcs/test_vectors.py"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from jcs import JcsError, canonicalize, jcs_hash, parse_strict  # noqa: E402

vectors = json.loads((pathlib.Path(__file__).parent / "test_vectors.json").read_text(encoding="utf-8"))["vectors"]
fail = 0
for v in vectors:
    try:
        value = parse_strict(v["input"])
        got, err = canonicalize(value), False
    except JcsError:
        got, err = None, True
    ok = err if v.get("error") else (not err and got == v["canonical"] and jcs_hash(value) == v["sha256"])
    if not ok:
        fail += 1
        print("FAIL", v["name"], repr(got), "expected", repr(v.get("canonical")))
print(f"{len(vectors) - fail}/{len(vectors)} PASS (python)")
sys.exit(1 if fail else 0)
