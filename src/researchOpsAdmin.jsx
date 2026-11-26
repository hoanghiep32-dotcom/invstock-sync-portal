import React, { useCallback, useEffect, useState } from 'react'

// GĐ 3–4 (tài liệu 13): manifest khối, chuyên đề (Research Note) và tác vụ (Research Operation).
// Mọi bước đều qua Edge Function lib-research-ops (chỉ admin). Không bước nào đổi bản hiện hành của snapshot.

const ERR_VI = {
  APPROVAL_HASH_MISMATCH: 'Nội dung đã khác bản anh/chị vừa xem (sai SHA-256). Tải lại rồi duyệt lại.',
  not_approved: 'Chuyên đề chưa được duyệt.',
  reason_required: 'Cần nhập lý do.',
  manifest_not_registered: 'Bản này chưa có manifest.',
  validation_failed: 'File chưa đạt contract, xem danh sách lỗi.'
}
const STATUS_VI = { draft: 'Chờ duyệt', approved: 'Đã duyệt', rejected: 'Từ chối' }
const TOPIC_VI = { OWNERSHIP: 'Sở hữu', FORENSICS: 'Chất lượng lợi nhuận', RISK: 'Rủi ro', EVENT: 'Sự kiện', INDUSTRY: 'Ngành',
  VALUATION: 'Định giá', GOVERNANCE: 'Quản trị', OTHER: 'Khác' }
const errText = d => {
  const e = d?.error || ''
  const key = Object.keys(ERR_VI).find(k => e.startsWith(k))
  return key ? ERR_VI[key] : e || 'Lỗi không xác định'
}

function Errors({ list }) {
  if (!list?.length) return null
  return <ul className="error" style={{ margin: '8px 0', paddingLeft: 20 }}>
    {list.slice(0, 30).map(([code, msg], i) => <li key={i}><b>{code}</b> {msg}</li>)}
    {list.length > 30 && <li>… và {list.length - 30} lỗi khác</li>}
  </ul>
}

// Ô nhập file JSON: chọn file hoặc dán văn bản. Giữ nguyên văn để SHA-256 đúng bytes gốc.
function JsonInput({ value, onChange, placeholder }) {
  return <>
    <div className="file-row">
      <input type="file" accept=".json,application/json" onChange={async e => { const f = e.target.files?.[0]; if (f) onChange(await f.text()) }} />
      {value && <button className="button subtle" onClick={() => onChange('')}>Xóa</button>}
    </div>
    <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={5}
      style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
  </>
}

function ImportBox({ kind, session, callFn, onDone }) {
  const [text, setText] = useState('')
  const [check, setCheck] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const label = kind === 'note' ? 'chuyên đề' : 'tác vụ'
  async function run(action) {
    setBusy(true); setMsg('')
    const r = await callFn('lib-research-ops', { action: `${action}_${kind === 'note' ? 'note' : 'operation'}`, text }, session)
    setBusy(false)
    if (action === 'validate') { setCheck(r.data); return }
    if (!r.ok) { setCheck(r.data); setMsg(errText(r.data)); return }
    setMsg(r.data.result.status === 'unchanged' ? `File này đã được nhập trước đó.` : `Đã nhập ${label} (SHA-256 ${r.data.result.sha256.slice(0, 12)}…).`)
    setText(''); setCheck(null); onDone()
  }
  return <div className="summary-cell" style={{ margin: '10px 0' }}>
    <strong>Nhập {label} (JSON theo contract 0.1.0)</strong>
    <JsonInput value={text} onChange={v => { setText(v); setCheck(null) }} placeholder={`Dán JSON ${label} ở đây hoặc chọn file`} />
    <div className="file-row">
      <button className="button secondary" disabled={!text.trim() || busy} onClick={() => run('validate')}>Kiểm tra</button>
      <button className="button primary" disabled={!check?.success || busy} onClick={() => run('import')}>Nhập vào thư viện</button>
    </div>
    {check && check.success && <div className="message">Đạt contract. SHA-256 <code>{check.sha256}</code></div>}
    {check && !check.success && <Errors list={check.errors || [[check.error, '']]} />}
    {msg && <div className="message">{msg}</div>}
  </div>
}

export default function ResearchOpsPanel({ session, callFn, refreshKey }) {
  const [state, setState] = useState(null)
  const [records, setRecords] = useState([])
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [inputs, setInputs] = useState({})
  const [verify, setVerify] = useState({})
  const load = useCallback(async () => {
    setError('')
    const [a, b] = await Promise.all([callFn('lib-research-ops', { action: 'list' }, session), callFn('lib-publish', { action: 'list' }, session)])
    if (!a.ok) { setError(errText(a.data)); return }
    setState(a.data)
    if (b.ok) setRecords(b.data.records.filter(r => r.record_type === 'research').sort((x, y) => (x.ticker || '').localeCompare(y.ticker || '') || x.revision - y.revision))
  }, [session, callFn])
  useEffect(() => { load() }, [load, refreshKey])

  async function act(body, done) {
    setMsg(''); setError('')
    const r = await callFn('lib-research-ops', body, session)
    if (!r.ok || r.data.success === false) { setError(errText(r.data)); return r.data }
    setMsg(done(r.data.result)); load(); return r.data
  }
  const input = (id, k) => inputs[id]?.[k] ?? ''
  const setInput = (id, k, v) => setInputs({ ...inputs, [id]: { ...inputs[id], [k]: v } })
  const manifestOf = id => state?.manifests?.find(m => m.record_id === id)
  const pubOf = id => state?.note_publications?.find(p => p.note_version_id === id)

  return <section className="panel">
    <div className="section-head"><h2>3. Khối, chuyên đề & tác vụ</h2><button className="button subtle" onClick={load}>Tải lại</button></div>
    <p className="muted">Manifest kê 27 khối của mỗi bản, dựng từ bytes gốc. Chuyên đề được duyệt đúng SHA-256 rồi xuất bản riêng; không làm đổi bản hiện hành, điểm hay quyết định. Tác vụ chỉ được lưu làm hồ sơ; tích hợp thành bản mới là bước sau.</p>
    {error && <div className="error">{error}</div>}
    {msg && <div className="message">{msg}</div>}

    <h3>Manifest theo bản</h3>
    {records.map(r => {
      const m = manifestOf(r.record_id)
      const v = verify[r.record_id]
      return <div className="summary-cell" key={r.record_id} style={{ margin: '8px 0' }}>
        <strong>{r.ticker} · R{r.revision} · {m ? `có manifest (${m.provenance_kind === 'LEGACY_BACKFILL' ? 'backfill' : 'builder'})` : 'chưa có manifest'}</strong>
        {m && <span>manifest <code>{m.manifest_sha256.slice(0, 16)}…</code></span>}
        <div className="file-row">
          {!m && <button className="button secondary" onClick={() => act({ action: 'build_manifest', record_id: r.record_id }, res => `Đã đăng ký manifest R${r.revision} (${res.entries || 27} khối).`)}>Dựng manifest</button>}
          {m && <button className="button subtle" onClick={async () => {
            const res = await callFn('lib-research-ops', { action: 'verify_manifest', record_id: r.record_id }, session)
            setVerify({ ...verify, [r.record_id]: res.data })
          }}>Kiểm tra lại từ bytes gốc</button>}
          {v && <span className={v.success ? 'muted' : 'error'}>{v.success ? `Khớp: ${v.result.entries} khối, ${v.result.changed} khối đổi so với bản cha.` : `Không khớp: ${errText(v)}${v.result ? ` (bytes ${v.result.bytes_match ? 'khớp' : 'lệch'})` : ''}`}</span>}
        </div>
      </div>
    })}

    <h3>Chuyên đề</h3>
    <ImportBox kind="note" session={session} callFn={callFn} onDone={load} />
    {(state?.notes || []).map(n => {
      const pub = pubOf(n.note_version_id)
      const primary = (n.links || []).find(l => l.role === 'PRIMARY')?.module_key
      return <div className="summary-cell" key={n.note_version_id} style={{ margin: '8px 0' }}>
        <strong>{n.title}</strong>
        <span>{TOPIC_VI[n.topic] || n.topic} · v{n.note_version} · mục chính {primary} · dữ liệu đến {n.cutoff} · {STATUS_VI[n.status]}
          {pub ? ` · ${pub.role === 'published' ? `đã xuất bản (${pub.visibility})` : `đã thu hồi: ${pub.withdraw_reason}`}` : ''}
          {n.review_note ? ` · ghi chú duyệt: ${n.review_note}` : ''}</span>
        <code>{n.sha256}</code>
        <div className="file-row">
          {n.status === 'draft' && <>
            <button className="button secondary" onClick={() => act({ action: 'review_note', note_version_id: n.note_version_id, expected_sha256: n.sha256, decision: 'approved', note: input(n.note_version_id, 'why') || undefined }, () => 'Đã duyệt chuyên đề.')}>Duyệt đúng SHA-256 này</button>
            <button className="button subtle" disabled={!input(n.note_version_id, 'why').trim()} onClick={() => act({ action: 'review_note', note_version_id: n.note_version_id, expected_sha256: n.sha256, decision: 'rejected', note: input(n.note_version_id, 'why') }, () => 'Đã từ chối.')}>Từ chối</button>
          </>}
          {n.status === 'approved' && pub?.role !== 'published' && <>
            <select value={input(n.note_version_id, 'vis') || 'members'} onChange={e => setInput(n.note_version_id, 'vis', e.target.value)}>
              <option value="members">Chỉ người đăng nhập</option>
              {n.requested_visibility === 'public' && <option value="public">Công khai</option>}
            </select>
            <button className="button secondary" onClick={() => act({ action: 'publish_note', note_version_id: n.note_version_id, expected_sha256: n.sha256, visibility: input(n.note_version_id, 'vis') || 'members' }, res => `Đã xuất bản (${res.visibility}).`)}>Xuất bản chuyên đề</button>
          </>}
          {pub?.role === 'published' && <button className="button subtle" disabled={!input(n.note_version_id, 'why').trim()} onClick={() => act({ action: 'withdraw_note', note_version_id: n.note_version_id, reason: input(n.note_version_id, 'why') }, () => 'Đã thu hồi chuyên đề.')}>Thu hồi</button>}
          {(n.status === 'draft' || pub?.role === 'published') && <input type="text" placeholder="Lý do / ghi chú (bắt buộc khi từ chối hoặc thu hồi)" value={input(n.note_version_id, 'why')} onChange={e => setInput(n.note_version_id, 'why', e.target.value)} style={{ minWidth: 260 }} />}
        </div>
      </div>
    })}
    {state && !state.notes?.length && <p className="muted">Chưa có chuyên đề nào.</p>}

    <h3>Tác vụ nghiên cứu</h3>
    <ImportBox kind="operation" session={session} callFn={callFn} onDone={load} />
    {(state?.operations || []).map(o => <div className="summary-cell" key={o.operation_id} style={{ margin: '8px 0' }}>
      <strong>{o.operation_type} · {o.outcome}</strong>
      <span>dữ liệu đến {o.cutoff} · nhập {new Date(o.created_at).toLocaleString('vi-VN')}</span>
      <code>{o.sha256}</code>
    </div>)}
  </section>
}
