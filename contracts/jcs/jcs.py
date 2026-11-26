"""InvStock JCS (RFC 8785) – bản Python, phải cho kết quả giống hệt jcs.mjs (tài liệu 13, mục 3, B14).

parse_strict(text)  -> giá trị Python; từ chối khóa trùng, NaN/Infinity, số nguyên vượt 2^53.
canonicalize(value) -> chuỗi JCS.
jcs_hash(value)     -> SHA-256 hex trên bytes UTF-8 của chuỗi JCS.
"""
import hashlib
import json
import math
from decimal import Decimal

CANONICALIZATION_VERSION = "JCS-RFC8785/invstock-1"


class JcsError(ValueError):
    pass


def _no_dupes(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise JcsError(f"duplicate key {k!r}")
        out[k] = v
    return out


def _bad_constant(name):
    raise JcsError(f"{name} not allowed")


def parse_strict(text):
    try:
        return json.loads(text, object_pairs_hook=_no_dupes, parse_constant=_bad_constant,
                          parse_int=lambda s: _as_double(float(s)), parse_float=lambda s: _as_double(float(s)))
    except json.JSONDecodeError as e:
        raise JcsError(f"invalid JSON: {e}") from None


def _as_double(n):
    if isinstance(n, int):
        if abs(n) > 2 ** 53:
            raise JcsError("integer outside IEEE-754 double safe range")
        return float(n)
    if not math.isfinite(n):
        raise JcsError("number out of range")
    return n


def _number(x):
    """ECMAScript Number.prototype.toString cho số hữu hạn (RFC 8785 mục 3.2.2.3)."""
    if isinstance(x, bool):
        raise JcsError("bool is not a number")
    x = float(x)
    if not math.isfinite(x):
        raise JcsError("NaN/Infinity not allowed")
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    t = Decimal(repr(abs(x))).normalize().as_tuple()  # repr = chữ số ngắn nhất round-trip
    digits = "".join(map(str, t.digits))
    k = len(digits)
    n = t.exponent + k  # vị trí dấu thập phân
    if k <= n <= 21:
        s = digits + "0" * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        mant = digits[0] + ("." + digits[1:] if k > 1 else "")
        s = f"{mant}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + s


_ESC = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _string(s):
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch in _ESC:
            out.append(_ESC[ch])
        elif o < 0x20 or 0xD800 <= o <= 0xDFFF:  # điều khiển và surrogate lẻ (giống JSON.stringify ES2019)
            out.append(f"\\u{o:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(s):
    return s.encode("utf-16-be", "surrogatepass")


def canonicalize(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return _number(v)
    if isinstance(v, str):
        return _string(v)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonicalize(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=_utf16_key)
        return "{" + ",".join(_string(k) + ":" + canonicalize(v[k]) for k in keys) + "}"
    raise JcsError(f"unsupported type {type(v).__name__}")


def jcs_hash(v):
    return hashlib.sha256(canonicalize(v).encode("utf-8", "surrogatepass")).hexdigest()
