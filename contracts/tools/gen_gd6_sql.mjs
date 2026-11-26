// GĐ 6 – sinh bộ kiểm thử tầng DB (một khối DO, tự ROLLBACK) cho B03, B11, B13, B16, B18, B19, B20 và các chốt chặn xuất bản.
//   node contracts/tools/gen_gd6_sql.mjs <dir có operation.json, candidate.json, manifest.json> <out.sql>
// operation/candidate/manifest là bản R3 TỔNG HỢP do test_integration.mjs --emit ghi ra (không phải nghiên cứu thật).
// File SQL sinh ra chứa bytes bản ứng viên dựng từ báo cáo FPT, nên KHÔNG commit vào repo: chỉ để trong thư mục dự án.
// Kết quả hiện dưới dạng lỗi 'GD6_RESULT ...' (chủ ý, để mọi thay đổi bị huỷ). Mỗi mục là TÊN=PASS hoặc TÊN=FAIL(giá trị thật).
import { readFileSync, writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url);
const C = await import(new URL("../../supabase/functions/_shared/contracts/contracts.js", here));
const I = await import(new URL("../../supabase/functions/_shared/contracts/integration.js", here));
const { canonicalize } = await import(new URL("../../supabase/functions/_shared/contracts/jcs.js", here));
const [dir, out] = process.argv.slice(2);
const enc = new TextEncoder();
const op = readFileSync(`${dir}/operation.json`), cand = readFileSync(`${dir}/candidate.json`), man = readFileSync(`${dir}/manifest.json`);
const opj = JSON.parse(op), mj = JSON.parse(man);
const R1 = "0a052079-2141-494d-a116-2a390b94733b", R2 = "330d2606-645a-4cac-8065-617b21746617";
const R2SHA = "7820631c30d26c28271aa8a3a7878624afcd328845ec6d080ab1d4aaa8bdcc84";
const sha = (b) => C.sha256Bytes(b);
const bundleFor = async (c, m) => I.bundleSha({ candidate_sha256: await sha(c), head_record_id: R2, head_sha256: R2SHA,
  manifest_sha256: await sha(m), operation_sha256: await sha(op) });
const good = await bundleFor(cand, man);
const b64 = (b) => Buffer.from(b).toString("base64");
const bytes = (o) => enc.encode(canonicalize(o));

// B16: cùng operation_id, khác nội dung
const op2 = structuredClone(opj); op2.scope = op2.scope + " (sửa)";
// B16: cùng operation, bytes ứng viên khác (thêm khoảng trắng cuối → khác hash)
const cand2 = Buffer.concat([cand, Buffer.from(" ")]);
// B13: manifest thiếu một entry / sai content_hash (cùng manifest_id, đưa qua lib_integrate)
const m26 = structuredClone(mj); m26.entries.pop();
const mBad = structuredClone(mj); 
mBad.entries.find((e) => e.path === "/identity").content_hash = "0".repeat(64);
// B03: note mẫu (placeholder, gắn base R2)
const note = JSON.parse(readFileSync(new URL("../examples/EXAMPLE_note_ownership.json", here)));
const noteB = bytes(note), noteSha = await sha(noteB);

// Ghi một kiểm tra: expr là biểu thức SQL trả text; lỗi được ghi thành ERR:<mã>.
let n = 0;
const T = (name, expr, expected) => `  begin v := (${expr})::text; exception when others then v := 'ERR:' || split_part(sqlerrm, ':', 1); end;
  res := res || ' ${name}=' || case when v is not distinct from ${lit(expected)} then 'PASS' else 'FAIL(' || coalesce(v, 'null') || ')' end;`;
// Câu lệnh phải lỗi với mã (phần trước dấu ':') bắt đầu bằng expected.
// Sau câu lệnh luôn raise, nên ngay cả khi câu lệnh chạy được thì thay đổi của nó cũng bị huỷ.
const E = (name, stmt, expected) => `  begin ${stmt}; raise exception 'NO_ERROR'; exception when others then v := split_part(sqlerrm, ':', 1); end;
  res := res || ' ${name}=' || case when v ilike ${lit(expected + "%")} then 'PASS' else 'FAIL(' || v || ')' end;`;
function lit(s) { return s === null ? "null" : `'${String(s).replace(/'/g, "''")}'`; }
const asUser = (uid) => `perform set_config('role', 'authenticated', true); perform set_config('test.uid', ${uid}::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', ${uid}, 'role', 'authenticated')::text, true)`;
const reset = `perform set_config('role', 'none', true)`;

const sql = `-- GĐ 6: kiểm thử tầng DB trên dữ liệu thật, KHÔNG để lại thay đổi (khối DO kết thúc bằng raise → rollback toàn bộ).
-- Kết quả: thông báo lỗi 'GD6_RESULT ...' (đó là chủ ý). Mỗi mục TÊN=PASS hoặc TÊN=FAIL(giá trị thật).
-- Operation, bản R3 và note ở đây là TỔNG HỢP để kiểm tra luật, không phải nghiên cứu thật.
do $$
declare
  res text := ''; v text; r jsonb;
  admin_id uuid := (select user_id from invstock.research_reviewers where is_active and reviewer_role = 'admin' order by user_id limit 1);
  outsider uuid := gen_random_uuid();
  rec0 bigint; pub0 text; rpub0 text; man0 bigint;
  op_b bytea := decode('${b64(op)}', 'base64');
  op2_b bytea := decode('${b64(bytes(op2))}', 'base64');
  cand_b bytea := decode('${b64(cand)}', 'base64');
  cand2_b bytea := decode('${b64(cand2)}', 'base64');
  man_b bytea := decode('${b64(man)}', 'base64');
  m26_b bytea := decode('${b64(bytes(m26))}', 'base64');
  mbad_b bytea := decode('${b64(bytes(mBad))}', 'base64');
  note_b bytea := decode('${b64(noteB)}', 'base64');
  op_id uuid := '${opj.operation_id}';
  r3 uuid := '${opj.output_refs.candidate_record_id}';
  note_v uuid := '${note.note_version_id}';
begin
  if admin_id is null then raise exception 'GD6_SETUP: không có admin đang hoạt động'; end if;
  select count(*) into rec0 from invstock.lib_records;
  select count(*) into man0 from invstock.lib_manifests;
  select string_agg(lineage_key || '>' || record_id || '/' || visibility, ',' order by lineage_key) into pub0 from invstock.lib_publications;
  select string_agg(record_id || ':' || role || '/' || visibility, ',' order by record_id) into rpub0 from invstock.lib_record_publications;

  -- B18 quyền đọc/ghi (RLS + GRANT). Chạy dưới vai authenticated/anon trong transaction này.
  begin ${asUser("admin_id")}; select count(*)::text into v from invstock.lib_records; ${reset};
  exception when others then v := 'ERR:' || sqlerrm; end;
  res := res || ' B18_reviewer_reads=' || case when v = rec0::text then 'PASS' else 'FAIL(' || v || ')' end;
  begin ${asUser("outsider")}; select (select count(*) from invstock.lib_records) + (select count(*) from invstock.lib_operations)
    + (select count(*) from invstock.lib_notes) + (select count(*) from invstock.lib_integrations) into v; ${reset};
  exception when others then v := 'ERR:' || sqlerrm; end;
  res := res || ' B18_outsider_sees=' || case when v = '0' then 'PASS' else 'FAIL(' || v || ')' end;
${E("B18_anon_select", `perform set_config('role', 'anon', true); perform count(*) from invstock.lib_records`, "permission denied")}
${E("B18_auth_insert", `${asUser("admin_id")}; insert into invstock.lib_sync_events (record_id, sha256, event_type, actor) values ('${R2}', '${R2SHA}', 'verified', admin_id)`, "permission denied")}
${E("B18_auth_rpc", `${asUser("admin_id")}; perform invstock.lib_publish('${R2}', admin_id)`, "permission denied")}
  perform set_config('role', 'none', true);

  -- B19 lịch sử bất biến
${E("B19_update_record", `update invstock.lib_records set revision = revision where record_id = '${R2}'`, "immutable_library_table")}
${E("B19_delete_record", `delete from invstock.lib_records where record_id = '${R1}'`, "immutable_library_table")}
${E("B19_update_entry", `update invstock.lib_manifest_entries set block_version_id = block_version_id where manifest_id = (select manifest_id from invstock.lib_manifests where record_id = '${R2}')`, "immutable")}
${E("B19_delete_event", `delete from invstock.lib_sync_events where record_id = '${R2}'`, "immutable_library_table")}

  -- B03 note: nhập, duyệt, xuất bản note không đổi snapshot hay bản đang xuất bản
${T("B03_import", `invstock.lib_note_import(note_b, admin_id)->>'status'`, "imported")}
${E("B03_review_wrong_hash", `perform invstock.lib_note_review(note_v, repeat('0', 64), 'approved', admin_id, null)`, "APPROVAL_HASH_MISMATCH")}
${T("B03_review", `invstock.lib_note_review(note_v, '${noteSha}', 'approved', admin_id, null) is not null`, "true")}
${E("B03_public_denied", `perform invstock.lib_note_publish(note_v, '${noteSha}', 'public', admin_id)`, "visibility_not_allowed")}
${T("B03_publish_members", `invstock.lib_note_publish(note_v, '${noteSha}', 'members', admin_id) is not null`, "true")}
${T("B03_records_same", `(select count(*) from invstock.lib_records) = rec0`, "true")}
${T("B03_pubs_same", `(select string_agg(lineage_key || '>' || record_id || '/' || visibility, ',' order by lineage_key) from invstock.lib_publications) = pub0`, "true")}

  -- B20 rollback xuất bản: cần lý do, không xoá/sửa bản mới hơn
${E("B20_not_admin", `perform invstock.lib_publish('${R1}', outsider, 'public', '${R2}', true, 'thử')`, "actor_not_admin")}
${E("B20_stale_expected", `perform invstock.lib_publish('${R1}', admin_id, 'public', '${R1}', true, 'thử')`, "current_changed")}
${E("B20_no_reason", `perform invstock.lib_publish('${R1}', admin_id, 'public', '${R2}', true, null)`, "reason_required")}
${T("B20_rollback", `invstock.lib_publish('${R1}', admin_id, 'public', '${R2}', true, 'Kiểm thử GĐ 6: rollback')->>'action'`, "rolled_back")}
${T("B20_current_is_R1", `(select record_id from invstock.lib_publications where lineage_key = 'research:FPT:HOSE')`, R1)}
${T("B20_R2_kept", `(select count(*) from invstock.lib_records where record_id = '${R2}' and sha256 = '${R2SHA}')`, "1")}
${T("B20_republish_R2", `invstock.lib_publish('${R2}', admin_id, 'public', '${R1}', true, 'Kiểm thử GĐ 6: trả lại')->>'action'`, "published")}
${T("B20_pubs_restored", `(select string_agg(lineage_key || '>' || record_id || '/' || visibility, ',' order by lineage_key) from invstock.lib_publications) = pub0`, "true")}
${E("B20_withdraw_no_reason", `perform invstock.lib_withdraw('${R2}', admin_id, '')`, "reason_required")}

  -- B16 operation: cùng ID cùng bytes → unchanged; cùng ID khác bytes → IMMUTABLE
${T("B16_op_import", `invstock.lib_operation_import(op_b, admin_id)->>'status'`, "imported")}
${T("B16_op_same", `invstock.lib_operation_import(op_b, admin_id)->>'status'`, "unchanged")}
${E("B16_op_changed", `perform invstock.lib_operation_import(op2_b, admin_id)`, "IMMUTABLE")}

  -- B11 head cũ → BASE_STALE, không ghi gì
${E("B11_stale_head", `perform invstock.lib_integrate(op_id, cand_b, man_b, '${R1}', '${good}', 'Kiểm thử GĐ 6 tích hợp', admin_id)`, "BASE_STALE")}
${T("B11_no_write", `(select count(*) from invstock.lib_records) = rec0`, "true")}

  -- B13 manifest thiếu entry / sai content_hash: lib_integrate hỏng giữa chừng (sau khi ghi record) và không để lại gì
${E("B13_26_entries", `perform invstock.lib_integrate(op_id, cand_b, m26_b, '${R2}', '${await bundleFor(cand, bytes(m26))}', 'Kiểm thử GĐ 6 tích hợp', admin_id)`, "MANIFEST_MISMATCH")}
${E("B13_bad_hash", `perform invstock.lib_integrate(op_id, cand_b, mbad_b, '${R2}', '${await bundleFor(cand, bytes(mBad))}', 'Kiểm thử GĐ 6 tích hợp', admin_id)`, "MANIFEST_MISMATCH")}
${T("B13_no_leftover", `(select count(*) from invstock.lib_records) = rec0 and (select count(*) from invstock.lib_manifests) = man0 and not exists (select 1 from invstock.lib_integrations where operation_id = op_id)`, "true")}

  -- B16 tích hợp: lần đầu → integrated, gọi lại → unchanged, khác bytes → IMMUTABLE
${T("B16_integrate", `invstock.lib_integrate(op_id, cand_b, man_b, '${R2}', '${good}', 'Kiểm thử GĐ 6 tích hợp', admin_id)->>'status'`, "integrated")}
${T("B16_retry", `invstock.lib_integrate(op_id, cand_b, man_b, '${R2}', '${good}', 'Kiểm thử GĐ 6 tích hợp', admin_id)->>'status'`, "unchanged")}
${E("B16_other_bytes", `perform invstock.lib_integrate(op_id, cand2_b, man_b, '${R2}', '${await bundleFor(cand2, man)}', 'Kiểm thử GĐ 6 tích hợp', admin_id)`, "IMMUTABLE")}
${T("B16_one_record", `(select count(*) from invstock.lib_records) - rec0`, "1")}
${T("B16_one_manifest", `(select count(*) from invstock.lib_manifests) - man0`, "1")}

  -- Tích hợp không tự xuất bản; bản mới chưa 'verified' thì không xuất bản được
${T("PUB_not_auto", `(select string_agg(lineage_key || '>' || record_id || '/' || visibility, ',' order by lineage_key) from invstock.lib_publications) = pub0`, "true")}
${E("PUB_needs_verified", `perform invstock.lib_publish(r3, admin_id, 'public', '${R2}', true, null)`, "record_not_verified")}

  raise exception 'GD6_RESULT%', res;
end $$;
`;
writeFileSync(out, sql);
console.log(out, sql.length, "bundle", good);
