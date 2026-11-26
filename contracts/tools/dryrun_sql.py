#!/usr/bin/env python3
"""Sinh dryrun.sql cho migration GĐ 3–4: chạy toàn bộ trong 1 transaction rồi tự ROLLBACK bằng exception
DRYRUN_RESULT (không để lại dữ liệu). Dùng trong SQL Editor sau khi đã chạy migration.

  python3 dryrun_sql.py EXAMPLES_DIR > dryrun.sql
"""
import base64
import json
import sys
from pathlib import Path

ex = Path(sys.argv[1])
b64 = lambda p: base64.b64encode((ex / p).read_bytes()).decode()
m1, m2 = b64("FPT_R1.manifest.json"), b64("FPT_R2.manifest.json")
note = (ex / "EXAMPLE_note_ownership.json").read_bytes()
op = (ex / "EXAMPLE_operation_deep_dive.json").read_bytes()
m2j = json.loads((ex / "FPT_R2.manifest.json").read_bytes())
bad_sha = dict(m2j, snapshot_sha256="0" * 64)
bad_inh = json.loads(json.dumps(m2j))
next(e for e in bad_inh["entries"] if e["disposition"] == "INHERITED")["version_id"] = "00000000-0000-4000-8000-000000000000"
op_stale = json.loads(op)
op_stale["operation_id"] = "44444444-4444-4444-8444-444444444444"
op_stale["base"]["sha256"] = "f" * 64
enc = lambda o: base64.b64encode(json.dumps(o, ensure_ascii=False, separators=(",", ":")).encode()).decode()

print(f"""-- DRY RUN GĐ 3–4. Kết quả trả về dưới dạng lỗi 'DRYRUN_RESULT ...' => mọi thay đổi đã ROLLBACK.
do $$
declare
  res text := '';
  r jsonb;
  c int;
  nv uuid := '22222222-2222-4222-8222-222222222222';
  nsha text := encode(sha256(decode('{base64.b64encode(note).decode()}', 'base64')), 'hex');
begin
  -- T1 R2 trước R1 phải bị từ chối
  begin perform invstock.lib_register_manifest(decode('{m2}', 'base64'), null); res := res || ' T1 FAIL';
  exception when others then res := res || ' T1 ' || split_part(sqlerrm, ':', 1); end;
  -- T2 R1 đăng ký, chạy lại idempotent
  r := invstock.lib_register_manifest(decode('{m1}', 'base64'), null); res := res || ' T2 ' || (r->>'status');
  r := invstock.lib_register_manifest(decode('{m1}', 'base64'), null); res := res || '/' || (r->>'status');
  -- T3 snapshot_sha256 sai, INHERITED sai version_id
  begin perform invstock.lib_register_manifest(decode('{enc(bad_sha)}', 'base64'), null); res := res || ' T3 FAIL';
  exception when others then res := res || ' T3 ' || split_part(sqlerrm, ':', 1); end;
  begin perform invstock.lib_register_manifest(decode('{enc(bad_inh)}', 'base64'), null); res := res || '/FAIL';
  exception when others then res := res || '/' || split_part(sqlerrm, ':', 1); end;
  -- T4 R2 đăng ký: 24 CHANGED + 3 INHERITED, 51 block version
  r := invstock.lib_register_manifest(decode('{m2}', 'base64'), null);
  select count(*) into c from invstock.lib_manifest_entries e join invstock.lib_manifests m using (manifest_id)
   where m.record_id = '330d2606-645a-4cac-8065-617b21746617' and e.disposition = 'CHANGED';
  res := res || ' T4 ' || (r->>'status') || ' changed=' || c || ' versions=' || (select count(*) from invstock.lib_block_versions
    where origin_record_id in ('0a052079-2141-494d-a116-2a390b94733b', '330d2606-645a-4cac-8065-617b21746617'));
  -- T5 bất biến
  begin update invstock.lib_block_versions set change_class = 'NONE' where true; res := res || ' T5 FAIL';
  exception when others then res := res || ' T5 ' || split_part(sqlerrm, ':', 1); end;
  begin delete from invstock.lib_manifests where true; res := res || '/FAIL';
  exception when others then res := res || '/' || split_part(sqlerrm, ':', 1); end;
  -- T6 note: nhập, duyệt sai hash, duyệt, public bị chặn, members ok, thu hồi
  r := invstock.lib_note_import(decode('{base64.b64encode(note).decode()}', 'base64'), null); res := res || ' T6 ' || (r->>'status');
  begin perform invstock.lib_note_publish(nv, nsha, 'members', null); res := res || '/FAIL';
  exception when others then res := res || '/' || sqlerrm; end;
  begin perform invstock.lib_note_review(nv, repeat('0', 64), 'approved', null); res := res || '/FAIL';
  exception when others then res := res || '/' || sqlerrm; end;
  r := invstock.lib_note_review(nv, nsha, 'approved', null); res := res || '/' || (r->>'status');
  begin perform invstock.lib_note_publish(nv, nsha, 'public', null); res := res || '/FAIL';
  exception when others then res := res || '/' || split_part(sqlerrm, ':', 1); end;
  r := invstock.lib_note_publish(nv, nsha, 'members', null); res := res || '/' || (r->>'status');
  begin perform invstock.lib_note_withdraw(nv, null, ' '); res := res || '/FAIL';
  exception when others then res := res || '/' || sqlerrm; end;
  r := invstock.lib_note_withdraw(nv, null, 'dry run'); res := res || '/' || (r->>'status');
  begin update invstock.lib_notes set title = 'x' where note_version_id = nv; res := res || '/FAIL';
  exception when others then res := res || '/' || split_part(sqlerrm, ':', 1); end;
  -- T7 operation: nhập, base sai
  r := invstock.lib_operation_import(decode('{base64.b64encode(op).decode()}', 'base64'), null); res := res || ' T7 ' || (r->>'status');
  begin perform invstock.lib_operation_import(decode('{enc(op_stale)}', 'base64'), null); res := res || '/FAIL';
  exception when others then res := res || '/' || split_part(sqlerrm, ':', 1); end;
  -- T8 quyền: anon bị chặn, authenticated không phải reviewer thấy 0 dòng
  begin set local role anon; perform 1 from invstock.lib_notes; reset role; res := res || ' T8 FAIL';
  exception when others then reset role; res := res || ' T8 ' || sqlstate; end;
  perform set_config('request.jwt.claims', '{{"sub":"00000000-0000-4000-8000-000000000000","role":"authenticated"}}', true);
  perform set_config('test.uid', '00000000-0000-4000-8000-000000000000', true);
  set local role authenticated;
  select count(*) into c from invstock.lib_manifest_entries;
  reset role;
  res := res || '/nonreviewer_rows=' || c;
  raise exception 'DRYRUN_RESULT%', res;
end $$;
""")
