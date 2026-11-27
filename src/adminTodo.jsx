import React, { useCallback, useEffect, useState } from 'react'

// Hộp "Việc cần làm" của admin: gom các việc đang chờ từ hai danh sách lib-publish và lib-research-ops,
// để không phải cuộn cả trang mới biết còn gì chưa xong. Bấm một mã để lọc toàn trang theo mã đó.

const DAY = 86400000
const STALE_DAYS = 190

const label = r => r ? (r.ticker ? `${r.ticker} R${r.revision}` : `Screening ${r.universe || ''} R${r.revision}`) : '—'

export function useAdminLists(session, callFn, refreshKey) {
  const [state, setState] = useState({ loading: true, error: '', pub: null, ops: null })
  const load = useCallback(async () => {
    const [a, b] = await Promise.all([callFn('lib-publish', { action: 'list' }, session), callFn('lib-research-ops', { action: 'list' }, session)])
    setState({ loading: false, error: !a.ok ? (a.data.error || `Lỗi ${a.status}`) : !b.ok ? (b.data.error || `Lỗi ${b.status}`) : '',
      pub: a.ok ? a.data : null, ops: b.ok ? b.data : null })
  }, [session, callFn])
  useEffect(() => { load() }, [load, refreshKey])
  return state
}

function buildTodo(pub, ops) {
  if (!pub) return []
  const records = pub.records || []
  const byId = Object.fromEntries(records.map(r => [r.record_id, r]))
  const verified = new Set(pub.verified || [])
  const roles = new Map((pub.record_publications || []).map(x => [x.record_id, x]))
  const current = new Set((pub.publications || []).map(p => p.record_id))
  const groups = []

  const unpublished = records.filter(r => verified.has(r.record_id) && !roles.has(r.record_id) && !current.has(r.record_id))
  groups.push({ key: 'publish', title: 'Bản VERIFIED chưa xuất bản', where: '#xuat-ban', items: unpublished.map(r => ({ id: r.record_id, text: label(r), ticker: r.ticker })) })

  const unverified = records.filter(r => !verified.has(r.record_id))
  groups.push({ key: 'verify', title: 'Bản chưa VERIFIED', where: '#xuat-ban', items: unverified.map(r => ({ id: r.record_id, text: label(r), ticker: r.ticker })) })

  const stale = records.filter(r => current.has(r.record_id) && r.as_of && (Date.now() - new Date(r.as_of).getTime()) / DAY > STALE_DAYS)
  groups.push({ key: 'stale', title: `Bản hiện hành đánh giá quá ${STALE_DAYS} ngày`, where: '#xuat-ban', items: stale.map(r => ({ id: r.record_id, text: `${label(r)} · ${new Date(r.as_of).toLocaleDateString('vi-VN')}`, ticker: r.ticker })) })

  if (ops) {
    const manifests = new Set((ops.manifests || []).map(m => m.record_id))
    const noManifest = records.filter(r => r.record_type === 'research' && !manifests.has(r.record_id))
    groups.push({ key: 'manifest', title: 'Bản research chưa có manifest', where: '#khoi-chuyen-de', items: noManifest.map(r => ({ id: r.record_id, text: label(r), ticker: r.ticker })) })

    const notePub = new Map((ops.note_publications || []).map(p => [p.note_version_id, p]))
    const noteTicker = n => byId[n.base_record_id]?.ticker
    const drafts = (ops.notes || []).filter(n => n.status === 'draft')
    groups.push({ key: 'note-review', title: 'Chuyên đề chờ duyệt', where: '#khoi-chuyen-de', items: drafts.map(n => ({ id: n.note_version_id, text: `${noteTicker(n) || ''} ${n.title}`.trim(), ticker: noteTicker(n) })) })
    const approved = (ops.notes || []).filter(n => n.status === 'approved' && !notePub.has(n.note_version_id))
    groups.push({ key: 'note-publish', title: 'Chuyên đề đã duyệt, chưa xuất bản', where: '#khoi-chuyen-de', items: approved.map(n => ({ id: n.note_version_id, text: `${noteTicker(n) || ''} ${n.title}`.trim(), ticker: noteTicker(n) })) })

    const integrated = new Set((ops.integrations || []).map(g => g.operation_id))
    const pending = (ops.operations || []).filter(o => o.outcome === 'CANDIDATE_SNAPSHOT' && !integrated.has(o.operation_id))
    groups.push({ key: 'integrate', title: 'Tác vụ có bản ứng viên chờ tích hợp', where: '#khoi-chuyen-de', items: pending.map(o => ({ id: o.operation_id, text: `${byId[o.base_record_id]?.ticker || ''} ${o.operation_type}`.trim(), ticker: byId[o.base_record_id]?.ticker })) })
  }
  return groups
}

export function TodoPanel({ lists, onFilter }) {
  const groups = buildTodo(lists.pub, lists.ops)
  const open = groups.filter(g => g.items.length)
  const total = open.reduce((n, g) => n + g.items.length, 0)
  return <section className="panel todo-panel">
    <div className="section-head"><h2>Việc cần làm</h2>{!lists.loading && <span className="muted">{total ? `${total} việc đang chờ` : 'Không có việc nào đang chờ'}</span>}</div>
    {lists.loading && <p className="muted">Đang tải…</p>}
    {lists.error && <div className="error">{lists.error}</div>}
    {open.length > 0 && <div className="todo-grid">
      {open.map(g => <div className="todo-group" key={g.key}>
        <a href={g.where} className="todo-title"><b>{g.items.length}</b> {g.title}</a>
        <div className="todo-items">
          {g.items.slice(0, 6).map(i => i.ticker
            ? <button type="button" key={i.id} className="todo-chip" title={`Lọc trang theo ${i.ticker}`} onClick={() => onFilter(i.ticker)}>{i.text}</button>
            : <span key={i.id} className="todo-chip static">{i.text}</span>)}
          {g.items.length > 6 && <span className="muted">+{g.items.length - 6}</span>}
        </div>
      </div>)}
    </div>}
  </section>
}

// Lọc theo mã: so khớp không dấu, không phân biệt hoa thường.
export const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()
export const matches = (filter, ...fields) => !filter.trim() || fields.some(f => fold(f).includes(fold(filter.trim())))
