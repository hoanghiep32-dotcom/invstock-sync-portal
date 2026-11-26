import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { INDUSTRIES, industryLabel, fold } from './glossary.jsx'

// Admin: nhập thuật ngữ đơn giản, không theo chuẩn JSON research.
// Nhập nhanh nhiều dòng: "Thuật ngữ | Định nghĩa ngắn | Nhóm ngành | Tên đầy đủ | Tên tiếng Việt", hoặc dán mảng JSON.

const EMPTY = { term: '', full_name: '', vi_name: '', industry: 'general', aliases: '', short_def: '', body: '', formula: '', example: '', related: '', auto_link: true, match_case: true, is_published: true }

const industryByText = s => {
  const v = fold(s).trim()
  if (!v) return 'general'
  if (INDUSTRIES[v]) return v
  const hit = Object.entries(INDUSTRIES).find(([, x]) => fold(x.vi) === v || fold(x.vi).startsWith(v))
  return hit ? hit[0] : v.replace(/[^a-z_]+/g, '_').replace(/^_+|_+$/g, '') || 'other'
}

export function parseBulk(text) {
  const s = text.trim()
  if (!s) return []
  if (s.startsWith('[') || s.startsWith('{')) {
    const data = JSON.parse(s)
    return (Array.isArray(data) ? data : [data]).map(t => ({ ...t, industry: industryByText(t.industry || '') }))
  }
  return s.split(/\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(line => {
    const [term, short_def, industry, full_name, vi_name] = line.split(/\s*[|\t]\s*/)
    return { term, short_def, industry: industryByText(industry || ''), full_name, vi_name }
  })
}

const toForm = t => ({ ...EMPTY, ...t, aliases: (t.aliases || []).join(', '), related: (t.related || []).join(', ') })

function TermForm({ initial, busy, onSave, onCancel, onDelete }) {
  const [v, setV] = useState(() => toForm(initial || {}))
  const set = patch => setV(prev => ({ ...prev, ...patch }))
  const ok = v.term.trim() && v.short_def.trim()
  return <form className="gla-form" onSubmit={e => { e.preventDefault(); if (ok) onSave(v) }}>
    <div className="gla-grid">
      <div><label>Thuật ngữ / viết tắt *</label><input value={v.term} onChange={e => set({ term: e.target.value })} placeholder="Ví dụ: CASA" required /></div>
      <div><label>Nhóm ngành</label>
        <select value={INDUSTRIES[v.industry] ? v.industry : '__custom'} onChange={e => set({ industry: e.target.value === '__custom' ? '' : e.target.value })}>
          {Object.entries(INDUSTRIES).map(([k, x]) => <option key={k} value={k}>{x.vi}</option>)}
          <option value="__custom">Nhóm khác (tự đặt mã)…</option>
        </select>
        {!INDUSTRIES[v.industry] && <input value={v.industry} onChange={e => set({ industry: e.target.value.toLowerCase().replace(/[^a-z_]/g, '') })} placeholder="mã nhóm, ví dụ: aviation" />}
      </div>
      <div><label>Tên đầy đủ</label><input value={v.full_name || ''} onChange={e => set({ full_name: e.target.value })} placeholder="Current Account Savings Account" /></div>
      <div><label>Tên tiếng Việt</label><input value={v.vi_name || ''} onChange={e => set({ vi_name: e.target.value })} placeholder="Tiền gửi không kỳ hạn" /></div>
    </div>
    <label>Định nghĩa ngắn * <small>hiện trong tooltip, nên dưới 250 ký tự ({v.short_def.length})</small></label>
    <textarea className="gla-short" value={v.short_def} onChange={e => set({ short_def: e.target.value })} maxLength={500} required />
    <label>Giải thích đầy đủ <small>tự do, xuống dòng để tách đoạn</small></label>
    <textarea className="gla-long" value={v.body || ''} onChange={e => set({ body: e.target.value })} />
    <div className="gla-grid">
      <div><label>Công thức</label><input value={v.formula || ''} onChange={e => set({ formula: e.target.value })} /></div>
      <div><label>Ví dụ</label><input value={v.example || ''} onChange={e => set({ example: e.target.value })} /></div>
      <div><label>Cách viết khác <small>cách nhau bằng dấu phẩy</small></label><input value={v.aliases} onChange={e => set({ aliases: e.target.value })} placeholder="tỷ lệ CASA" /></div>
      <div><label>Thuật ngữ liên quan <small>dấu phẩy</small></label><input value={v.related} onChange={e => set({ related: e.target.value })} placeholder="NIM, CoF" /></div>
    </div>
    <div className="gla-checks">
      <label className="check"><input type="checkbox" checked={v.auto_link} onChange={e => set({ auto_link: e.target.checked })} />Tự liên kết trong bài</label>
      <label className="check"><input type="checkbox" checked={v.match_case} onChange={e => set({ match_case: e.target.checked })} />Phân biệt hoa thường<small>nên bật cho từ viết tắt (CAR ≠ car)</small></label>
      <label className="check"><input type="checkbox" checked={v.is_published} onChange={e => set({ is_published: e.target.checked })} />Hiển thị công khai</label>
    </div>
    <div className="file-row">
      <button className="button primary gla-save" disabled={!ok || busy}>{busy ? 'Đang lưu…' : initial?.term_id ? 'Lưu thay đổi' : 'Thêm thuật ngữ'}</button>
      <button type="button" className="button subtle" onClick={onCancel}>Hủy</button>
      {onDelete && <button type="button" className="button subtle gla-delete" onClick={onDelete} disabled={busy}>Xóa thuật ngữ</button>}
    </div>
  </form>
}

export default function GlossaryAdminPanel({ session, callFn }) {
  const [terms, setTerms] = useState([])
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [ind, setInd] = useState('')
  const [editing, setEditing] = useState(null) // 'new' | term_id
  const [confirmDel, setConfirmDel] = useState(null)
  const [bulk, setBulk] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)

  const load = useCallback(async () => {
    setError('')
    const r = await callFn('lib-glossary', { action: 'list' }, session)
    if (!r.ok) { setError(r.data.error || `Lỗi ${r.status}`); return }
    setTerms(r.data.terms || [])
  }, [session, callFn])
  useEffect(() => { load() }, [load])

  async function save(v) {
    setBusy(true); setError(''); setMsg('')
    const term = { ...v, term_id: editing === 'new' ? undefined : editing }
    const r = await callFn('lib-glossary', { action: 'save', term }, session)
    setBusy(false)
    if (!r.ok) { setError(r.data.error || `Lỗi ${r.status}`); return }
    setMsg(r.data.action === 'created' ? `Đã thêm ${r.data.term.term}.` : `Đã cập nhật ${r.data.term.term}.`)
    setEditing(null); load()
  }
  async function remove(t) {
    setBusy(true); setError(''); setMsg('')
    const r = await callFn('lib-glossary', { action: 'delete', term_id: t.term_id }, session)
    setBusy(false); setConfirmDel(null)
    if (!r.ok) { setError(r.data.error || `Lỗi ${r.status}`); return }
    setMsg(`Đã xóa ${t.term}.`); setEditing(null); load()
  }
  let parsed = [], parseError = ''
  try { parsed = parseBulk(bulk) } catch (e) { parseError = `JSON không hợp lệ: ${e.message}` }
  async function runImport() {
    setBusy(true); setError(''); setMsg('')
    const r = await callFn('lib-glossary', { action: 'import', terms: parsed }, session)
    setBusy(false)
    if (!r.ok) { setError(r.data.error || `Lỗi ${r.status}`); return }
    const res = r.data.results || []
    const bad = res.filter(x => x.error)
    const created = res.filter(x => x.action === 'created').length
    const updated = res.filter(x => x.action === 'updated').length
    setMsg(`Nhập xong: thêm ${created}, cập nhật ${updated}${bad.length ? `, lỗi ${bad.length}` : ''}.`)
    if (bad.length) setError(bad.map(x => `Dòng ${x.i + 1} (${x.term || '?'}): ${x.error}`).join('\n'))
    else setBulk('')
    load()
  }

  const needle = fold(q.trim())
  const list = useMemo(() => terms
    .filter(t => !ind || t.industry === ind)
    .filter(t => !needle || fold(`${t.term} ${t.full_name || ''} ${t.vi_name || ''} ${(t.aliases || []).join(' ')}`).includes(needle))
    .sort((a, b) => fold(a.term).localeCompare(fold(b.term))), [terms, needle, ind])
  const industries = useMemo(() => [...new Set(terms.map(t => t.industry))].sort((a, b) => (INDUSTRIES[a]?.order ?? 50) - (INDUSTRIES[b]?.order ?? 50)), [terms])

  return <section className="panel gla">
    <div className="section-head"><h2>3. Thư viện thuật ngữ</h2>
      <div className="file-row" style={{ margin: 0 }}>
        <a className="button subtle" href="/thuat-ngu" target="_blank" rel="noreferrer">Xem trang công khai ↗</a>
        <button className="button subtle" onClick={() => setBulkOpen(!bulkOpen)}>{bulkOpen ? 'Đóng nhập nhanh' : 'Nhập nhanh nhiều thuật ngữ'}</button>
        <button className="button secondary" onClick={() => { setEditing('new'); setMsg('') }}>+ Thêm thuật ngữ</button>
      </div>
    </div>
    <p className="muted">Không cần theo chuẩn JSON research. Thuật ngữ bật "Tự liên kết" sẽ được tự nhận diện trong mọi bài đã xuất bản và hiện giải thích khi người đọc rê chuột vào.</p>
    {error && <div className="error" style={{ whiteSpace: 'pre-line' }}>{error}</div>}
    {msg && <div className="message">{msg}</div>}

    {bulkOpen && <div className="gla-bulk">
      <label>Dán danh sách, mỗi dòng một thuật ngữ: <code>Thuật ngữ | Định nghĩa ngắn | Nhóm ngành | Tên đầy đủ | Tên tiếng Việt</code>. Có thể dán mảng JSON. Thuật ngữ đã có (cùng tên, cùng nhóm ngành) sẽ được cập nhật.</label>
      <textarea value={bulk} onChange={e => setBulk(e.target.value)} placeholder={'NIM | Thu nhập lãi thuần chia cho tài sản sinh lãi bình quân | Ngân hàng | Net Interest Margin | Biên lãi ròng\nBacklog | Giá trị hợp đồng đã ký chưa thực hiện | Xây dựng'} />
      {parseError ? <div className="error">{parseError}</div>
        : parsed.length > 0 && <p className="muted">Đọc được {parsed.length} thuật ngữ: {parsed.slice(0, 8).map(t => `${t.term} (${industryLabel(t.industry)})`).join(', ')}{parsed.length > 8 ? '…' : ''}</p>}
      <button className="button primary" disabled={!parsed.length || !!parseError || busy} onClick={runImport}>Nhập {parsed.length || ''} thuật ngữ</button>
    </div>}

    {editing === 'new' && <div className="gla-editor"><h3>Thuật ngữ mới</h3><TermForm busy={busy} onSave={save} onCancel={() => setEditing(null)} /></div>}

    <div className="file-row">
      <input className="gla-search" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Tìm thuật ngữ…" />
      <select value={ind} onChange={e => setInd(e.target.value)}>
        <option value="">Mọi nhóm ngành ({terms.length})</option>
        {industries.map(i => <option key={i} value={i}>{industryLabel(i)} ({terms.filter(t => t.industry === i).length})</option>)}
      </select>
    </div>
    <div className="gla-list">
      {list.map(t => <div key={t.term_id} className={`gla-row ${editing === t.term_id ? 'editing' : ''}`}>
        {editing === t.term_id
          ? <TermForm initial={t} busy={busy} onSave={save} onCancel={() => setEditing(null)} onDelete={() => setConfirmDel(t)} />
          : <button type="button" className="gla-row-btn" onClick={() => { setEditing(t.term_id); setMsg('') }}>
            <b>{t.term}</b>
            <span className="gla-row-def">{t.short_def}</span>
            <span className="gla-tags">
              <span>{industryLabel(t.industry)}</span>
              {!t.auto_link && <span className="off">không tự liên kết</span>}
              {!t.is_published && <span className="off">ẩn</span>}
            </span>
          </button>}
        {confirmDel?.term_id === t.term_id && <div className="approval">
          Xóa vĩnh viễn thuật ngữ <b>{t.term}</b>? Bài viết sẽ không còn tự liên kết từ này.
          <div className="file-row">
            <button className="button danger-button" style={{ width: 'auto', marginTop: 0 }} disabled={busy} onClick={() => remove(t)}>Xóa</button>
            <button className="button subtle" onClick={() => setConfirmDel(null)}>Giữ lại</button>
          </div>
        </div>}
      </div>)}
      {!list.length && <p className="muted">{terms.length ? 'Không có thuật ngữ nào khớp.' : 'Chưa có thuật ngữ nào.'}</p>}
    </div>
  </section>
}
