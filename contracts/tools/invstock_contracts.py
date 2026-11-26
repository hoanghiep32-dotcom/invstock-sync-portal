"""InvStock contracts 0.1.0 (DRAFT) - block hashing, manifest builder and semantic validator.

Dùng chung thư viện JCS ở ../jcs/jcs.py. Không đọc/ghi DB; chỉ làm việc trên bytes file.
"""
import hashlib
import json
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "jcs"))
from jcs import canonicalize, parse_strict, JcsError  # noqa: E402

CONTRACT_VERSION = "0.1.0"
CANON = "JCS-RFC8785/invstock-1"
BLOCK_HASH_INPUT = "invstock-block-hash/v1"
MODULE_KEYS = ["executive_summary", "company_intelligence", "industry_macro", "competitive_advantage",
               "financial_performance", "financial_forensics", "debt_liquidity", "ownership_governance",
               "assets_projects", "growth_forecast", "valuation_engine", "catalysts_expectations",
               "scorecard_risk", "decision_monitoring"]
COMPONENT_KEYS = ["schema_name", "schema_version", "metadata", "identity", "sources", "core10", "committee",
                  "scorecard", "valuation", "risk", "decision", "catalysts", "monitoring"]
REQUIRED_PATHS = ["/modules/" + k for k in MODULE_KEYS] + ["/" + k for k in COMPONENT_KEYS]
# Builder quản lý các path này (doc 10/13): patch không được ghi.
FORBIDDEN_WRITE = ["/metadata/record_id", "/metadata/revision", "/metadata/parent_id",
                   "/metadata/scorecard_version", "/schema_name", "/schema_version"]
# Namespace UUIDv5 cố định để version_id của manifest backfill tái lập được.
NS_BLOCK = uuid.UUID("6b1f3c1e-6a0e-5c8e-9d1a-1e0c0a5b2f10")
NS_MANIFEST = uuid.UUID("0d7a2c55-3e4b-5f61-8a9c-2b4d6e8f0a13")


class ContractError(Exception):
    def __init__(self, code, msg):
        super().__init__(f"{code}: {msg}")
        self.code = code


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def jcs_sha(value):
    return sha256_bytes(canonicalize(value).encode("utf-8"))


# ---------- JSON Pointer (RFC 6901) ----------
def ptr_tokens(p):
    if p == "" or not p.startswith("/"):
        raise ContractError("BAD_POINTER", p)
    return [t.replace("~1", "/").replace("~0", "~") for t in p[1:].split("/")]


def ptr_get(doc, p):
    cur = doc
    for t in ptr_tokens(p):
        if isinstance(cur, dict) and t in cur:
            cur = cur[t]
        elif isinstance(cur, list) and t.isdigit() and int(t) < len(cur) and (t == "0" or not t.startswith("0")):
            cur = cur[int(t)]
        else:
            raise KeyError(p)
    return cur


def ptr_covers(a, b):
    """True nếu path a bằng hoặc là cha của b."""
    return a == b or b.startswith(a + "/")


# ---------- block hash ----------
def collect_source_ids(value, out=None):
    out = set() if out is None else out
    if isinstance(value, dict):
        for k, v in value.items():
            if k in ("source_ids", "source_refs") and isinstance(v, list):
                out.update(x for x in v if isinstance(x, str))
            else:
                collect_source_ids(v, out)
    elif isinstance(value, list):
        for v in value:
            collect_source_ids(v, out)
    return out


def _descriptor_hash(src):
    return jcs_sha({k: v for k, v in src.items() if k != "id"})


def _normalize(value, desc):
    if isinstance(value, dict):
        return {k: (sorted(desc.get(x, "missing:" + x) for x in v)
                    if k in ("source_ids", "source_refs") and isinstance(v, list) else _normalize(v, desc))
                for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize(v, desc) for v in value]
    return value


def block_hashes(snapshot, path):
    """Trả về (content_hash, normalized_hash, source_ids) cho path trong snapshot."""
    content = ptr_get(snapshot, path)
    by_id = {s["id"]: s for s in snapshot.get("sources", [])}
    if path == "/sources":
        ids = []
        bound = []
    else:
        ids = sorted(collect_source_ids(content))
        missing = [i for i in ids if i not in by_id]
        if missing:
            raise ContractError("SOURCE_BINDING_CONFLICT", f"{path} tham chiếu source không tồn tại: {missing}")
        bound = [by_id[i] for i in ids]
    content_hash = jcs_sha({"path": path, "content": content, "sources": bound})
    desc = {i: _descriptor_hash(s) for i, s in by_id.items()}
    norm_content = _normalize(content, desc) if path != "/sources" else sorted(_descriptor_hash(s) for s in content)
    normalized_hash = jcs_sha({"path": path, "content": norm_content,
                               "sources": sorted(desc[i] for i in ids)})
    return content_hash, normalized_hash, ids


# ---------- manifest ----------
def build_manifest(snapshot_bytes, profile_id, parent_manifest=None, generated_at=None,
                   kind="LEGACY_BACKFILL", notes=""):
    snap = parse_strict(snapshot_bytes.decode("utf-8"))
    md = snap["metadata"]
    parent_entries = {e["path"]: e for e in (parent_manifest or {}).get("entries", [])}
    if parent_manifest and parent_manifest["record_id"] != md["parent_id"]:
        raise ContractError("MANIFEST_MISMATCH", "parent manifest không thuộc record cha của snapshot")
    entries = []
    for path in REQUIRED_PATHS:
        ch, nh, ids = block_hashes(snap, path)
        kind_ = "MODULE" if path.startswith("/modules/") else "COMPONENT"
        key = path.rsplit("/", 1)[1]
        pe = parent_entries.get(path)
        if pe is None:
            disp, cls, rev = "INITIAL", "NONE", 1
            vid = str(uuid.uuid5(NS_BLOCK, f"{profile_id}|{path}|{ch}"))
        elif pe["content_hash"] == ch:
            disp, cls, rev, vid = "INHERITED", "NONE", pe["block_revision"], pe["version_id"]
        else:
            disp, rev = "CHANGED", pe["block_revision"] + 1
            cls = "SOURCE_REMAP" if pe["normalized_hash"] == nh else "CONTENT"
            vid = str(uuid.uuid5(NS_BLOCK, f"{profile_id}|{path}|{ch}"))
        entries.append({"path": path, "kind": kind_, "key": key, "version_id": vid, "block_revision": rev,
                        "content_hash": ch, "normalized_hash": nh, "disposition": disp, "change_class": cls,
                        "source_ids": ids, "operation_ids": [], "note_ids": []})
    snap_sha = sha256_bytes(snapshot_bytes)
    return {
        "contract_name": "invstock.snapshot_manifest",
        "contract_version": CONTRACT_VERSION,
        "manifest_id": str(uuid.uuid5(NS_MANIFEST, f"{md['record_id']}|{snap_sha}")),
        "profile_id": profile_id,
        "identity": {"ticker": snap["identity"]["ticker"], "exchange": snap["identity"]["exchange"]},
        "record_id": md["record_id"],
        "revision": md["revision"],
        "snapshot_sha256": snap_sha,
        "parent_record_id": md["parent_id"],
        "parent_manifest_id": parent_manifest["manifest_id"] if parent_manifest else None,
        "hash_algorithm": "sha256",
        "canonicalization_version": CANON,
        "block_hash_input": BLOCK_HASH_INPUT,
        "entries": entries,
        "provenance": {"kind": kind, "legacy_provenance_unknown": kind == "LEGACY_BACKFILL",
                       "generated_at": generated_at or "1970-01-01T00:00:00Z",
                       "generator": "contracts/tools/invstock_contracts.py@0.1.0", "notes": notes},
    }


def manifest_bytes(m):
    """Bytes chuẩn của sidecar = JCS; manifest hash = sha256 của các bytes này (lưu ngoài file)."""
    return canonicalize(m).encode("utf-8")


# ---------- semantic checks ----------
def check_manifest(m, snapshot_bytes=None, parent=None):
    errs = []
    paths = [e["path"] for e in m["entries"]]
    if len(set(paths)) != len(paths):
        errs.append(("MANIFEST_MISMATCH", "path trùng"))
    for a in paths:
        for b in paths:
            if a != b and ptr_covers(a, b):
                errs.append(("MANIFEST_MISMATCH", f"path chồng lấn {a} ⊃ {b}"))
    if sorted(paths) != sorted(REQUIRED_PATHS):
        errs.append(("MANIFEST_MISMATCH", f"thiếu/thừa: {sorted(set(REQUIRED_PATHS) ^ set(paths))}"))
    for e in m["entries"]:
        if e["path"] != ("/modules/" if e["kind"] == "MODULE" else "/") + e["key"]:
            errs.append(("MANIFEST_MISMATCH", f"key không khớp path {e['path']}"))
    if snapshot_bytes is not None:
        if sha256_bytes(snapshot_bytes) != m["snapshot_sha256"]:
            errs.append(("MANIFEST_MISMATCH", "snapshot_sha256 không khớp bytes"))
        else:
            snap = parse_strict(snapshot_bytes.decode("utf-8"))
            md = snap["metadata"]
            if (md["record_id"], md["revision"], md["parent_id"]) != (m["record_id"], m["revision"], m["parent_record_id"]):
                errs.append(("MANIFEST_MISMATCH", "record_id/revision/parent không khớp metadata"))
            for e in m["entries"]:
                try:
                    ch, nh, ids = block_hashes(snap, e["path"])
                except KeyError:
                    errs.append(("MANIFEST_MISMATCH", f"path không có trong snapshot {e['path']}"))
                    continue
                except ContractError as ce:
                    errs.append((ce.code, str(ce)))
                    continue
                if (ch, nh, ids) != (e["content_hash"], e["normalized_hash"], e["source_ids"]):
                    errs.append(("MANIFEST_MISMATCH", f"hash/source_ids sai tại {e['path']}"))
    pe = {e["path"]: e for e in (parent or {}).get("entries", [])}
    if parent is not None:
        if parent["record_id"] != m["parent_record_id"] or parent["manifest_id"] != m["parent_manifest_id"]:
            errs.append(("MANIFEST_MISMATCH", "parent manifest không khớp"))
        if parent["profile_id"] != m["profile_id"]:
            errs.append(("MANIFEST_MISMATCH", "khác profile"))
    for e in m["entries"]:
        p = pe.get(e["path"])
        if p is None:
            ok = e["disposition"] == "INITIAL" and e["block_revision"] == 1
        elif p["content_hash"] == e["content_hash"]:
            ok = (e["disposition"] == "INHERITED" and e["version_id"] == p["version_id"]
                  and e["block_revision"] == p["block_revision"])
        else:
            ok = (e["disposition"] == "CHANGED" and e["version_id"] != p["version_id"]
                  and e["block_revision"] == p["block_revision"] + 1
                  and e["change_class"] == ("SOURCE_REMAP" if p["normalized_hash"] == e["normalized_hash"] else "CONTENT"))
        if not ok:
            errs.append(("MANIFEST_MISMATCH", f"disposition/version/revision sai tại {e['path']}"))
    return errs


def _cutoff(doc, errs):
    if doc["cutoff"] > doc["as_of"]:
        errs.append(("CUTOFF_AFTER_AS_OF", f"cutoff {doc['cutoff']} > as_of {doc['as_of']}"))


def _source_refs(ids_lists, sources, errs, where):
    known = {s["id"] for s in sources}
    if len(known) != len(sources):
        errs.append(("SOURCE_BINDING_CONFLICT", f"{where}: source id trùng"))
    for ids in ids_lists:
        for i in ids:
            if i not in known:
                errs.append(("SOURCE_BINDING_CONFLICT", f"{where}: source_id '{i}' không có trong sources"))


def check_note(n):
    errs = []
    _cutoff(n, errs)
    prim = [l for l in n["module_links"] if l["role"] == "PRIMARY"]
    if len(prim) != 1:
        errs.append(("PRIMARY_MODULE", f"cần đúng 1 module PRIMARY, có {len(prim)}"))
    keys = [l["module_key"] for l in n["module_links"]]
    if len(set(keys)) != len(keys):
        errs.append(("PRIMARY_MODULE", "module_links trùng module"))
    _source_refs([e["source_ids"] for e in n["evidence"]], n["sources"], errs, "note")
    return errs


def check_operation(op, base_bytes=None):
    errs = []
    _cutoff(op, errs)
    for p in op["write_paths"] + [c["path"] for c in op["changes"]]:
        if any(ptr_covers(f, p) or ptr_covers(p, f) for f in FORBIDDEN_WRITE):
            errs.append(("FORBIDDEN_PATH", f"không được ghi {p} qua patch"))
    for c in op["changes"]:
        if c["action"] in ("REPLACE", "RECALCULATE") and not any(ptr_covers(w, c["path"]) for w in op["write_paths"]):
            errs.append(("WRITE_SET", f"{c['path']} nằm ngoài write_paths"))
        if c["action"] in ("REPLACE", "RECALCULATE") and c.get("candidate_value") is None:
            errs.append(("NULL_NOT_DELETE", f"{c['path']}: null không phải lệnh xoá"))
        if c["action"] == "APPEND" and c.get("note_ref") not in op["output_refs"]["note_version_ids"] + op["note_ids"]:
            errs.append(("NOTE_REF", f"{c['path']}: note_ref không có trong note_ids/output_refs"))
    _source_refs([c["source_refs"] for c in op["changes"]] + [e["source_ids"] for e in op["evidence"]],
                 op["sources"], errs, "operation")
    if op["outcome"] == "NO_CHANGE" and any(c["action"] in ("REPLACE", "RECALCULATE") for c in op["changes"]):
        errs.append(("OUTCOME", "NO_CHANGE nhưng có REPLACE/RECALCULATE"))
    if base_bytes is not None and op["base"] is not None:
        if sha256_bytes(base_bytes) != op["base"]["sha256"]:
            errs.append(("BASE_STALE", "base.sha256 không khớp bytes bản cơ sở"))
        else:
            snap = parse_strict(base_bytes.decode("utf-8"))
            md = snap["metadata"]
            if (md["record_id"], md["revision"]) != (op["base"]["record_id"], op["base"]["revision"]):
                errs.append(("BASE_STALE", "record_id/revision của base không khớp"))
            for h in op["expected_input_hashes"]:
                try:
                    if block_hashes(snap, h["path"])[0] != h["content_hash"]:
                        errs.append(("DEPENDENCY_CHANGED", f"đầu vào {h['path']} đã đổi so với khi lập operation"))
                except KeyError:
                    errs.append(("DEPENDENCY_CHANGED", f"đầu vào {h['path']} không còn tồn tại"))
            for c in op["changes"]:
                try:
                    cur = block_hashes(snap, c["path"])[0]
                except KeyError:
                    cur = None
                if cur != c["expected_old_hash"]:
                    errs.append(("BLOCK_CONFLICT", f"{c['path']}: expected_old_hash khác bản cơ sở"))
    return errs
