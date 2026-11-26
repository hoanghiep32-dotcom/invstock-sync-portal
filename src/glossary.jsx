import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, SUPABASE_URL, SUPABASE_KEY } from './supabaseClient.js'
import './glossary.css'

// Thư viện thuật ngữ: tra cứu + tự liên kết thuật ngữ trong bài research (tooltip khi rê chuột, khung giải thích đầy đủ).
// Dữ liệu đọc qua public-research-library?action=glossary (chỉ thuật ngữ đã bật hiển thị).

const API = `${SUPABASE_URL}/functions/v1/public-research-library`

export const INDUSTRIES = {
  general: { vi: 'Phân tích tài chính', order: 1 },
  valuation: { vi: 'Định giá', order: 2 },
  banking: { vi: 'Ngân hàng', order: 3, hint: /ngân hàng|bank/i },
  securities: { vi: 'Chứng khoán', order: 4, hint: /chứng khoán|securit|môi giới/i },
  insurance: { vi: 'Bảo hiểm', order: 5, hint: /bảo hiểm|insur/i },
  real_estate: { vi: 'Bất động sản', order: 6, hint: /bất động sản|real estate|khu công nghiệp|địa ốc/i },
  construction: { vi: 'Xây dựng và vật liệu', order: 7, hint: /xây dựng|vật liệu|xi măng|thép|hạ tầng|construct/i },
  manufacturing: { vi: 'Sản xuất và công nghiệp', order: 8, hint: /sản xuất|công nghiệp|thép|nhựa|hóa chất|dệt|phân bón|manufact|industr/i },
  energy: { vi: 'Năng lượng và tiện ích', order: 9, hint: /điện|năng lượng|dầu|khí|nước|energy|power|utilit|oil|gas/i },
  consumer: { vi: 'Bán lẻ và tiêu dùng', order: 10, hint: /bán lẻ|tiêu dùng|thực phẩm|đồ uống|retail|consumer/i },
  technology: { vi: 'Công nghệ và viễn thông', order: 11, hint: /công nghệ|phần mềm|viễn thông|tech|software|telecom/i },
  market: { vi: 'Thị trường và giao dịch', order: 12 },
  other: { vi: 'Khác', order: 99 }
}
export const industryLabel = code => INDUSTRIES[code]?.vi || code
const industryOrder = code => INDUSTRIES[code]?.order ?? 50

export const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/* ---------- Tải dữ liệu (một lần cho cả trang) ---------- */

let glossaryPromise = null
export function loadGlossary() {
  if (!glossaryPromise) {
    glossaryPromise = (async () => {
      const url = new URL(API)
      url.searchParams.set('action', 'glossary')
      const { data: { session } } = await supabase.auth.getSession()
      const headers = { apikey: SUPABASE_KEY }
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
      const res = await fetch(url, { headers })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`)
      return data.terms || []
    })().catch(err => { glossaryPromise = null; throw err })
  }
  return glossaryPromise
}

export function useGlossaryTerms() {
  const [state, setState] = useState({ terms: [], loading: true, error: '' })
  useEffect(() => {
    let on = true
    loadGlossary().then(terms => on && setState({ terms, loading: false, error: '' }))
      .catch(e => on && setState({ terms: [], loading: false, error: e.message }))
    return () => { on = false }
  }, [])
  return state
}

/* ---------- Bộ nhận diện thuật ngữ ---------- */

// Một regex gộp mọi thuật ngữ và cách viết khác; ưu tiên cụm dài trước. Ranh giới từ hỗ trợ tiếng Việt (Unicode).
export function buildMatcher(terms) {
  const byVariant = new Map()
  for (const t of terms) {
    if (t.auto_link === false) continue
    for (const v of [t.term, ...(t.aliases || [])]) {
      const variant = String(v || '').trim()
      if (variant.length < 2) continue
      const key = variant.toLowerCase()
      if (!byVariant.has(key)) byVariant.set(key, [])
      byVariant.get(key).push({ variant, term: t })
    }
  }
  if (!byVariant.size) return null
  const keys = [...byVariant.keys()].sort((a, b) => b.length - a.length)
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${keys.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
  return { re, byVariant }
}

function pickTerm(candidates, found, industry) {
  const ok = candidates.filter(c => c.term.match_case === false || c.variant === found)
  if (!ok.length) return null
  if (ok.length === 1) return ok[0].term
  return (industry && ok.find(c => c.term.industry === industry)?.term)
    || ok.find(c => c.term.industry === 'general' || c.term.industry === 'valuation')?.term
    || ok[0].term
}

// Tách chuỗi thành các đoạn chữ thường và đoạn thuật ngữ. Mỗi thuật ngữ chỉ được đánh dấu lần đầu trong khối.
export function tokenize(text, matcher, industry, seen = new Set()) {
  if (!matcher || !text) return [text]
  const out = []
  const re = new RegExp(matcher.re.source, matcher.re.flags)
  let last = 0
  let m
  while ((m = re.exec(text))) {
    const term = pickTerm(matcher.byVariant.get(m[0].toLowerCase()) || [], m[0], industry)
    if (!term) { re.lastIndex = m.index + 1; continue }
    if (seen.has(term.slug)) continue
    seen.add(term.slug)
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push({ text: m[0], term })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function industryForSector(sector) {
  if (!sector) return null
  for (const [code, x] of Object.entries(INDUSTRIES)) if (x.hint?.test(sector)) return code
  return null
}

/* ---------- Ngữ cảnh ---------- */

const GlossaryContext = createContext(null)
const ScopeContext = createContext(null)

// Bọc khu vực đọc của một bài: thuật ngữ trùng tên ở nhiều ngành sẽ ưu tiên ngành của bài.
export function GlossaryScope({ sector, children }) {
  const industry = useMemo(() => industryForSector(sector), [sector])
  return <ScopeContext.Provider value={industry}>{children}</ScopeContext.Provider>
}

export function Term({ children }) {
  const g = useContext(GlossaryContext)
  const industry = useContext(ScopeContext)
  const parts = useMemo(() => (typeof children === 'string' && g?.matcher ? tokenize(children, g.matcher, industry) : null), [children, g?.matcher, industry])
  if (!parts) return children ?? null
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0]
  return parts.map((p, i) => typeof p === 'string' ? p
    : <span key={i} className="gl-term" data-gl={p.term.slug} tabIndex={0} role="button" aria-label={`${p.text}: xem giải thích`}>{p.text}</span>)
}

export function useGlossary() { return useContext(GlossaryContext) }

/* ---------- Provider: tooltip + khung giải thích ---------- */

export function GlossaryProvider({ children }) {
  const { terms } = useGlossaryTerms()
  const matcher = useMemo(() => buildMatcher(terms), [terms])
  const bySlug = useMemo(() => new Map(terms.map(t => [t.slug, t])), [terms])
  const byName = useMemo(() => {
    const m = new Map()
    terms.forEach(t => [t.term, ...(t.aliases || [])].forEach(v => { const k = String(v).toLowerCase(); if (!m.has(k)) m.set(k, t) }))
    return m
  }, [terms])
  const [tip, setTip] = useState(null) // { term, rect, pinned }
  const [drawer, setDrawer] = useState(null) // term
  const timers = useRef({})

  const clear = k => { clearTimeout(timers.current[k]); timers.current[k] = null }
  const show = useCallback((el, pinned = false) => {
    const term = bySlug.get(el.dataset.gl)
    if (!term) return
    clear('hide')
    setTip({ term, rect: el.getBoundingClientRect(), pinned, el })
  }, [bySlug])
  const hideSoon = useCallback(() => {
    clear('hide')
    timers.current.hide = setTimeout(() => setTip(t => (t?.pinned ? t : null)), 160)
  }, [])

  useEffect(() => {
    const target = e => e.target instanceof Element ? e.target.closest('[data-gl]') : null
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)')
    const over = e => {
      if (!fine.matches) return
      const el = target(e)
      if (el) { clear('show'); timers.current.show = setTimeout(() => show(el), 120) }
      else if (e.target instanceof Element && e.target.closest('.gl-tip')) clear('hide')
    }
    const out = e => {
      const el = target(e)
      if (el) { clear('show'); if (!e.relatedTarget?.closest?.('.gl-tip')) hideSoon() }
      else if (e.target instanceof Element && e.target.closest('.gl-tip') && !e.relatedTarget?.closest?.('.gl-tip, [data-gl]')) hideSoon()
    }
    const click = e => {
      const el = target(e)
      if (el) { e.preventDefault(); show(el, true); return }
      if (!(e.target instanceof Element && e.target.closest('.gl-tip'))) setTip(null)
    }
    const key = e => {
      if (e.key === 'Escape') { setTip(null); return }
      const el = target(e)
      if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); show(el, true) }
    }
    const focus = e => { const el = target(e); if (el) show(el) }
    const scroll = () => setTip(t => (t ? null : t))
    document.addEventListener('mouseover', over)
    document.addEventListener('mouseout', out)
    document.addEventListener('click', click)
    document.addEventListener('keydown', key)
    document.addEventListener('focusin', focus)
    window.addEventListener('scroll', scroll, { capture: true, passive: true })
    window.addEventListener('resize', scroll)
    return () => {
      document.removeEventListener('mouseover', over)
      document.removeEventListener('mouseout', out)
      document.removeEventListener('click', click)
      document.removeEventListener('keydown', key)
      document.removeEventListener('focusin', focus)
      window.removeEventListener('scroll', scroll, { capture: true })
      window.removeEventListener('resize', scroll)
      clear('show'); clear('hide')
    }
  }, [show, hideSoon])

  const value = useMemo(() => ({ terms, matcher, bySlug, byName, openDrawer: setDrawer }), [terms, matcher, bySlug, byName])
  return <GlossaryContext.Provider value={value}>
    {children}
    {tip && createPortal(<Tooltip tip={tip} onMore={() => { setDrawer(tip.term); setTip(null) }} />, document.body)}
    {drawer && createPortal(<Drawer term={drawer} onClose={() => setDrawer(null)} onOpen={setDrawer} byName={byName} />, document.body)}
  </GlossaryContext.Provider>
}

function Tooltip({ tip, onMore }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: -9999, top: -9999, below: true })
  useEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const r = tip.rect
    const vw = window.innerWidth
    const below = r.bottom + box.height + 12 < window.innerHeight || r.top < box.height + 12
    const left = Math.max(12, Math.min(vw - box.width - 12, r.left + r.width / 2 - box.width / 2))
    setPos({ left, top: below ? r.bottom + 8 : r.top - box.height - 8, below })
  }, [tip])
  const t = tip.term
  return <div ref={ref} className={`gl-tip ${pos.below ? 'below' : 'above'}`} role="tooltip" style={{ left: pos.left, top: pos.top }}>
    <div className="gl-tip-head">
      <b>{t.term}</b>
      <span className="gl-ind">{industryLabel(t.industry)}</span>
    </div>
    {(t.full_name || t.vi_name) && <div className="gl-tip-names">{[t.full_name !== t.term && t.full_name, t.vi_name !== t.term && t.vi_name].filter(Boolean).join(' · ')}</div>}
    <p>{t.short_def}</p>
    <button type="button" className="gl-tip-more" onClick={onMore}>Xem giải thích đầy đủ →</button>
  </div>
}

function Paragraphs({ text }) {
  if (!text) return null
  return String(text).split(/\n{2,}|\n/).filter(s => s.trim()).map((p, i) => <p key={i}>{p}</p>)
}

export function TermDetail({ term: t, byName, onOpen, linkPage = true }) {
  const related = (t.related || []).map(r => ({ name: r, t: byName?.get(String(r).toLowerCase()) }))
  return <div className="gl-detail">
    {t.body && <div className="gl-body"><Paragraphs text={t.body} /></div>}
    {t.formula && <div className="gl-formula"><span>Công thức</span><code>{t.formula}</code></div>}
    {t.example && <div className="gl-example"><span>Ví dụ</span><Paragraphs text={t.example} /></div>}
    {related.length > 0 && <div className="gl-related"><span>Liên quan</span>
      {related.map(r => r.t
        ? (onOpen ? <button key={r.name} type="button" onClick={() => onOpen(r.t)}>{r.t.term}</button>
          : <a key={r.name} href={`/thuat-ngu/${r.t.slug}`}>{r.t.term}</a>)
        : <em key={r.name}>{r.name}</em>)}
    </div>}
    {linkPage && <a className="gl-page-link" href={`/thuat-ngu/${t.slug}`} target="_blank" rel="noreferrer">Mở trong thư viện thuật ngữ ↗</a>}
  </div>
}

function Drawer({ term: t, onClose, onOpen, byName }) {
  const ref = useRef(null)
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return <div className="gl-drawer-wrap" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <aside className="gl-drawer" role="dialog" aria-modal="true" aria-label={`Giải thích ${t.term}`} tabIndex={-1} ref={ref}>
      <div className="gl-drawer-top">
        <span className="gl-kicker">Thuật ngữ · {industryLabel(t.industry)}</span>
        <button type="button" className="gl-close" onClick={onClose} aria-label="Đóng">×</button>
      </div>
      <h2>{t.term}</h2>
      {(t.full_name || t.vi_name) && <div className="gl-names">
        {t.full_name && t.full_name !== t.term && <div>{t.full_name}</div>}
        {t.vi_name && t.vi_name !== t.term && <div className="gl-vi">{t.vi_name}</div>}
      </div>}
      <p className="gl-short">{t.short_def}</p>
      <TermDetail term={t} byName={byName} onOpen={onOpen} />
    </aside>
  </div>
}

/* ---------- Trang tra cứu thuật ngữ ---------- */

const GL_SORTS = {
  az: 'A → Z',
  industry: 'Theo nhóm ngành',
  recent: 'Mới cập nhật'
}

const letterOf = t => { const c = fold(t.term).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#' }

function readGlQuery() {
  const q = new URLSearchParams(window.location.search)
  return { q: q.get('q') || '', ind: q.get('nganh') || '', sort: GL_SORTS[q.get('sort')] ? q.get('sort') : 'az' }
}

export function GlossaryPage({ slug, TopBar, Footer }) {
  const { terms, loading, error } = useGlossaryTerms()
  const [f, setF] = useState(readGlQuery)
  const [open, setOpen] = useState(() => new Set(slug ? [slug] : []))
  const searchRef = useRef(null)
  const set = patch => setF(prev => ({ ...prev, ...patch }))
  const byName = useMemo(() => {
    const m = new Map()
    terms.forEach(t => [t.term, ...(t.aliases || [])].forEach(v => { const k = String(v).toLowerCase(); if (!m.has(k)) m.set(k, t) }))
    return m
  }, [terms])

  useEffect(() => { document.title = 'Thư viện thuật ngữ · InvStock' }, [])
  useEffect(() => {
    const q = new URLSearchParams()
    if (f.q) q.set('q', f.q)
    if (f.ind) q.set('nganh', f.ind)
    if (f.sort !== 'az') q.set('sort', f.sort)
    const s = q.toString()
    const base = window.location.pathname.startsWith('/thuat-ngu') ? window.location.pathname : '/thuat-ngu'
    window.history.replaceState(null, '', s ? `${base}?${s}` : base)
  }, [f])
  useEffect(() => {
    const onKey = e => {
      if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (!slug || loading) return
    requestAnimationFrame(() => document.getElementById(`gl-${slug}`)?.scrollIntoView({ block: 'start' }))
  }, [slug, loading])

  const counts = useMemo(() => {
    const c = {}
    terms.forEach(t => { c[t.industry] = (c[t.industry] || 0) + 1 })
    return Object.entries(c).sort((a, b) => industryOrder(a[0]) - industryOrder(b[0]))
  }, [terms])

  const needle = fold(f.q.trim())
  const list = useMemo(() => {
    const scoreOf = t => {
      if (!needle) return 0
      const name = fold(t.term)
      if (name === needle) return 0
      if (name.startsWith(needle) || (t.aliases || []).some(a => fold(a).startsWith(needle))) return 1
      return 2
    }
    const res = terms
      .filter(t => !f.ind || t.industry === f.ind)
      .filter(t => !needle || fold([t.term, t.full_name, t.vi_name, t.short_def, ...(t.aliases || [])].join(' ')).includes(needle))
    const az = (a, b) => fold(a.term).localeCompare(fold(b.term))
    if (needle) return res.sort((a, b) => scoreOf(a) - scoreOf(b) || az(a, b))
    if (f.sort === 'industry') return res.sort((a, b) => industryOrder(a.industry) - industryOrder(b.industry) || az(a, b))
    if (f.sort === 'recent') return res.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    return res.sort(az)
  }, [terms, needle, f.ind, f.sort])

  const groupKey = !needle && f.sort === 'az' ? letterOf : !needle && f.sort === 'industry' ? t => t.industry : null
  const groups = useMemo(() => {
    if (!groupKey) return [{ key: '', items: list }]
    const out = []
    list.forEach(t => {
      const k = groupKey(t)
      if (!out.length || out[out.length - 1].key !== k) out.push({ key: k, items: [] })
      out[out.length - 1].items.push(t)
    })
    return out
  }, [list, groupKey])
  const letters = useMemo(() => new Set(list.map(letterOf)), [list])
  const toggle = s => setOpen(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n })
  const hasFilter = f.q || f.ind

  return <div className="rl gl-page">
    <TopBar />
    <main className="rl-main">
      <section className="rl-intro">
        <div className="rl-intro-head">
          <h1>Thư viện thuật ngữ</h1>
          {!loading && !error && <span className="rl-intro-meta">{terms.length} thuật ngữ · {counts.length} nhóm ngành</span>}
        </div>
        <p className="gl-lead">Giải thích các từ viết tắt và chỉ số chuyên ngành dùng trong bài nghiên cứu. Trong bài đọc, thuật ngữ có gạch chân chấm: rê chuột hoặc chạm vào để xem nhanh.</p>
        <div className="rl-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input ref={searchRef} type="search" value={f.q} onChange={e => set({ q: e.target.value })}
            placeholder="Tìm thuật ngữ, ví dụ: NIM, nợ xấu, định giá…" aria-label="Tìm thuật ngữ" />
          {f.q ? <button type="button" onClick={() => set({ q: '' })} aria-label="Xóa tìm kiếm">×</button> : <kbd>/</kbd>}
        </div>
      </section>

      <div className="rl-filters">
        <div className="rl-chips" role="group" aria-label="Lọc theo nhóm ngành">
          <button className={!f.ind ? 'active' : ''} onClick={() => set({ ind: '' })}>Tất cả <span className="gl-count">{terms.length}</span></button>
          {counts.map(([code, n]) => <button key={code} className={f.ind === code ? 'active' : ''} onClick={() => set({ ind: f.ind === code ? '' : code })}>
            {industryLabel(code)} <span className="gl-count">{n}</span></button>)}
        </div>
        <div className="rl-filter-row">
          <label className="rl-select"><span>Sắp xếp</span>
            <select value={f.sort} onChange={e => set({ sort: e.target.value })} disabled={!!needle}>
              {Object.entries(GL_SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
          {!loading && !error && <span className="rl-result-line gl-result">
            {hasFilter ? `${list.length} / ${terms.length} thuật ngữ` : `${terms.length} thuật ngữ`}
            {hasFilter && <button className="rl-link" onClick={() => set({ q: '', ind: '' })}>Xóa bộ lọc</button>}
          </span>}
        </div>
        {!needle && f.sort === 'az' && list.length > 12 && <nav className="gl-letters" aria-label="Chữ cái">
          {'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('').map(l => letters.has(l)
            ? <a key={l} href={`#gl-letter-${l}`}>{l}</a> : <span key={l}>{l}</span>)}
        </nav>}
      </div>

      {loading && <div className="rl-skeleton"><div /><div /><div /></div>}
      {error && <div className="rl-empty error">Không tải được thư viện thuật ngữ ({error}).</div>}
      {!loading && !error && !list.length && <div className="rl-empty">{terms.length ? 'Không có thuật ngữ nào khớp với tìm kiếm.' : 'Chưa có thuật ngữ nào.'}</div>}
      <div className="gl-list">
        {groups.map(g => <section key={g.key || 'all'} className="gl-group" id={g.key && f.sort === 'az' ? `gl-letter-${g.key}` : undefined}>
          {g.key && <h2 className="gl-group-title">{f.sort === 'industry' ? industryLabel(g.key) : g.key}<span>{g.items.length}</span></h2>}
          {g.items.map(t => {
            const isOpen = open.has(t.slug)
            const more = t.body || t.formula || t.example || t.related?.length
            return <article key={t.slug} id={`gl-${t.slug}`} className={`gl-entry ${isOpen ? 'open' : ''} ${t.slug === slug ? 'target' : ''}`}>
              <button type="button" className="gl-entry-row" onClick={() => toggle(t.slug)} aria-expanded={isOpen}>
                <span className="gl-entry-term">{t.term}</span>
                <span className="gl-entry-main">
                  <span className="gl-entry-names">{[t.full_name !== t.term && t.full_name, t.vi_name !== t.term && t.vi_name].filter(Boolean).join(' · ')}</span>
                  <span className="gl-entry-def">{t.short_def}</span>
                </span>
                <span className="gl-ind">{industryLabel(t.industry)}</span>
                <span className="gl-chev" aria-hidden="true">{more ? (isOpen ? '−' : '+') : ''}</span>
              </button>
              {isOpen && more && <div className="gl-entry-body"><TermDetail term={t} byName={byName} linkPage={false} /></div>}
            </article>
          })}
        </section>)}
      </div>
    </main>
    <Footer />
  </div>
}
