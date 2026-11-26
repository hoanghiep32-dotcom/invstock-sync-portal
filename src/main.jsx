import React, { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import PublicLibrary from './library.jsx'
import './library.css'
import GlossaryAdminPanel from './glossaryAdmin.jsx'

// InvStock Sync Portal – chuẩn v2.0.0
// Quy trình (file 08): PREVIEW -> duyệt đúng SHA-256 -> SYNC -> VERIFY. Xuất bản là bước riêng của admin.

import { supabase, SUPABASE_URL, SUPABASE_KEY } from './supabaseClient.js'

const FN = name => `${SUPABASE_URL}/functions/v1/${name}`

async function callFn(name, body, session) {
  const res = await fetch(FN(name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body)
  })
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  return { ok: res.ok, status: res.status, data }
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

const fmt = v => v === null || v === undefined ? '—' : typeof v === 'number' ? v.toLocaleString('vi-VN', { maximumFractionDigits: 4 }) : String(v)

function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setError(error.message)
    setBusy(false)
  }
  return <main className="shell">
    <section className="panel auth-panel">
      <div className="eyebrow">INVSTOCK ADMIN</div>
      <h1>Đăng nhập</h1>
      <p className="muted">Chỉ tài khoản admin đang hoạt động mới đồng bộ và xuất bản được.</p>
      <form onSubmit={submit}>
        <label>Email</label>
        <input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
        <label>Mật khẩu</label>
        <input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        <button className="button primary" disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
      </form>
      {error && <div className="error">{error}</div>}
      <div className="hint"><a href={libraryReturn().path}>{libraryReturn().label}</a></div>
    </section>
  </main>
}

function SyncPanel({ session, onSynced }) {
  const [file, setFile] = useState(null)
  const [b64, setB64] = useState('')
  const [preview, setPreview] = useState(null)
  const [hashConfirm, setHashConfirm] = useState('')
  const [approvalText, setApprovalText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  function reset() { setPreview(null); setHashConfirm(''); setApprovalText(''); setResult(null); setError('') }

  async function pick(e) {
    reset()
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setB64(toBase64(await f.arrayBuffer()))
  }

  async function runPreview() {
    setBusy(true); setError(''); setResult(null)
    const r = await callFn('lib-sync', { action: 'preview', payload_base64: b64 }, session)
    if (!r.ok) setError(r.data.error || `Lỗi ${r.status}`)
    else setPreview(r.data)
    setBusy(false)
  }

  async function runSync() {
    setBusy(true); setError('')
    const r = await callFn('lib-sync', { action: 'sync', payload_base64: b64, approved_sha256: hashConfirm.trim().toLowerCase(), approval_text: approvalText }, session)
    setResult(r.data)
    if (!r.ok) setError(r.data.error || r.data.stage || `Lỗi ${r.status}`)
    else onSynced()
    setBusy(false)
  }

  const canSync = preview?.valid && !preview.blockers?.length && hashConfirm.trim().toLowerCase() === preview.sha256 && approvalText.trim().length >= 8

  return <section className="panel">
    <h2>1. Đồng bộ file JSON v2</h2>
    <p className="muted">Chọn đúng file đã chạy validate.py. Hash tính trên chính bytes của file, không định dạng lại.</p>
    <div className="file-row">
      <span className="button secondary file-button">Chọn file JSON<input type="file" accept=".json,application/json" onChange={pick} /></span>
      <span className="muted">{file ? `${file.name} · ${file.size.toLocaleString('vi-VN')} bytes` : 'Chưa chọn file'}</span>
    </div>
    <button className="button primary" disabled={!b64 || busy} onClick={runPreview}>Preview</button>

    {preview && <>
      <div className="summary-grid">
        <div className="summary-cell"><span>Kết quả kiểm tra</span><strong className={preview.valid ? '' : 'danger'}>{preview.valid ? 'Đạt validator v2.0.0' : 'Không đạt'}</strong></div>
        <div className="summary-cell"><span>SHA-256 (máy chủ tính)</span><code>{preview.sha256}</code></div>
        {preview.record && <>
          <div className="summary-cell"><span>Loại / mã</span><strong>{preview.record.record_type} · {preview.record.ticker ? `${preview.record.ticker} (${preview.record.exchange})` : preview.record.universe}</strong></div>
          <div className="summary-cell"><span>record_id · revision</span><strong>{preview.record.record_id} · R{preview.record.revision}</strong></div>
          <div className="summary-cell"><span>parent_id</span><strong>{preview.record.parent_id || '— (bản đầu tiên)'}</strong></div>
          <div className="summary-cell"><span>as_of · cutoff</span><strong>{preview.record.as_of} · {preview.record.cutoff}</strong></div>
          <div className="summary-cell"><span>Quyết định · Risk gate</span><strong>{fmt(preview.record.decision_status)} · {fmt(preview.record.risk_gate)}</strong></div>
          <div className="summary-cell"><span>Thao tác dự kiến</span><strong>{preview.intended}</strong></div>
        </>}
      </div>
      {!!preview.errors?.length && <div className="error"><b>Lỗi kiểm tra:</b><ul>{preview.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
      {!!preview.blockers?.length && <div className="error"><b>Chưa thể sync:</b><ul>{preview.blockers.map(b => <li key={b}>{b}</li>)}</ul></div>}
      {preview.valid && !preview.blockers?.length && <div className="approval">
        <label>Gõ lại đúng SHA-256 ở trên để xác nhận bạn duyệt đúng bản này</label>
        <input value={hashConfirm} onChange={e => setHashConfirm(e.target.value)} placeholder="64 ký tự hex" spellCheck="false" />
        <label>Ghi chú duyệt (tối thiểu 8 ký tự)</label>
        <input value={approvalText} onChange={e => setApprovalText(e.target.value)} placeholder="Ví dụ: Duyệt FPT R2 sau khi đọc lại nguồn" />
        <button className="button danger-button" disabled={!canSync || busy} onClick={runSync}>Sync vào thư viện (chưa xuất bản)</button>
      </div>}
    </>}
    {error && <div className="error">{error}</div>}
    {result?.success && <div className="panel success-panel"><div className="success-title">SYNCED & VERIFIED</div>
      <dl className="result-grid"><dt>record_id</dt><dd>{result.record?.record_id}</dd><dt>SHA-256 đọc lại</dt><dd>{result.read_back_sha256}</dd></dl>
      <p className="muted">Bản ghi đã vào thư viện nhưng chưa công khai. Xuất bản ở mục 2.</p></div>}
  </section>
}

function RecordsPanel({ session, refreshKey }) {
  const [rows, setRows] = useState([])
  const [pubs, setPubs] = useState([])
  const [verified, setVerified] = useState(new Set())
  const [vis, setVis] = useState({})
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const load = useCallback(async () => {
    setError('')
    const r = await callFn('lib-publish', { action: 'list' }, session)
    if (!r.ok) { setError(r.data.error || `Lỗi ${r.status}`); return }
    setRows(r.data.records); setPubs(r.data.publications); setVerified(new Set(r.data.verified))
  }, [session])
  useEffect(() => { load() }, [load, refreshKey])

  async function act(body) {
    setMsg(''); setError('')
    const r = await callFn('lib-publish', body, session)
    if (!r.ok) setError(r.data.error || `Lỗi ${r.status}`)
    else { setMsg(body.action === 'publish' ? `Đã xuất bản (${r.data.result.visibility}).` : 'Đã gỡ xuất bản.'); load() }
  }

  const pubByRecord = Object.fromEntries(pubs.map(p => [p.record_id, p]))
  return <section className="panel">
    <div className="section-head"><h2>2. Thư viện & xuất bản</h2><button className="button subtle" onClick={load}>Tải lại</button></div>
    <p className="muted">Chỉ bản đã VERIFIED mới xuất bản được. Mỗi mã chỉ có một bản đang công bố; xuất bản revision mới sẽ thay bản cũ.</p>
    {error && <div className="error">{error}</div>}
    {msg && <div className="message">{msg}</div>}
    {!rows.length && <p className="muted">Chưa có bản ghi nào.</p>}
    {rows.map(row => {
      const pub = pubByRecord[row.record_id]
      return <div className="summary-cell" key={row.record_id} style={{ margin: '10px 0' }}>
        <strong>{row.ticker ? `${row.ticker} (${row.exchange})` : `Screening · ${row.universe}`} · R{row.revision}</strong>
        <span>as_of {row.as_of} · {fmt(row.decision_status)} · {fmt(row.risk_gate)} · {verified.has(row.record_id) ? 'VERIFIED' : 'chưa verified'}</span>
        <code>{row.sha256}</code>
        <div className="file-row">
          {pub
            ? <><span className="muted">Đang công bố ({pub.visibility}) từ {new Date(pub.published_at).toLocaleString('vi-VN')}</span>
                <button className="button subtle" onClick={() => act({ action: 'unpublish', lineage_key: pub.lineage_key })}>Gỡ xuất bản</button></>
            : <>
                <select value={vis[row.record_id] || 'public'} onChange={e => setVis({ ...vis, [row.record_id]: e.target.value })}>
                  <option value="public">Công khai</option><option value="members">Chỉ người đăng nhập</option>
                </select>
                <button className="button secondary" disabled={!verified.has(row.record_id)} onClick={() => act({ action: 'publish', record_id: row.record_id, visibility: vis[row.record_id] || 'public' })}>Xuất bản</button>
              </>}
        </div>
      </div>
    })}
  </section>
}

// Quay lại đúng trang thư viện đang đọc dở (bài và tab đang mở được lưu trong trình duyệt).
function libraryReturn() {
  try {
    const v = JSON.parse(localStorage.getItem('invstock_tabs_v1') || '{}')
    const path = typeof v.last === 'string' && v.last.startsWith('/') && !v.last.startsWith('/admin') ? v.last : '/'
    const open = Array.isArray(v.tabs) ? v.tabs.length : 0
    return { path, label: open ? `← Thư viện · ${open} bài đang mở` : '← Thư viện' }
  } catch { return { path: '/', label: '← Thư viện' } }
}

function Admin() {
  const [session, setSession] = useState(null)
  const [ready, setReady] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])
  if (!ready) return <main className="shell"><p className="muted">Đang tải…</p></main>
  if (!session) return <SignIn />
  return <main className="shell">
    <header className="topbar">
      <div><div className="eyebrow">INVSTOCK SYNC PORTAL · CHUẨN v2.0.0</div><h1>Đồng bộ & xuất bản</h1></div>
      <div className="admin-navigation">
        <span className="account"><span className="online" />{session.user.email}</span>
        <a className="button secondary" href={libraryReturn().path}>{libraryReturn().label}</a>
        <button className="button subtle" onClick={() => supabase.auth.signOut()}>Đăng xuất</button>
      </div>
    </header>
    <div className="notice">Sync không tự xuất bản. Sau khi sync, bản ghi là bất biến; muốn sửa phải tạo revision mới có parent_id.</div>
    <SyncPanel session={session} onSynced={() => setRefreshKey(k => k + 1)} />
    <RecordsPanel session={session} refreshKey={refreshKey} />
    <GlossaryAdminPanel session={session} callFn={callFn} />
    <footer>InvStock Tracker · Admin</footer>
  </main>
}

function Root() {
  return window.location.pathname.startsWith('/admin') ? <Admin /> : <PublicLibrary />
}

createRoot(document.getElementById('root')).render(<React.StrictMode><Root /></React.StrictMode>)
