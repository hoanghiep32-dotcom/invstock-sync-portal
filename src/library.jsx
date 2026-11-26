import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import './style.css'
import { supabase, SUPABASE_URL, SUPABASE_KEY } from './supabaseClient.js'

// Thư viện công khai v2 – giao diện đọc.
// Chỉ đọc bản đã xuất bản qua Edge Function public-research-library.

const API = `${SUPABASE_URL}/functions/v1/public-research-library`
const READING_PROGRESS_KEY = 'invstock_last_reading_v2'
const READER_SIZE_KEY = 'invstock_reader_size'

const storage = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v) } catch { return fallback }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* local storage may be unavailable */ }
  }
}

async function readApi(params) {
  const url = new URL(API)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  // Người đã đăng nhập gửi kèm token để xem thêm nội dung 'members'.
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { apikey: SUPABASE_KEY }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  const response = await fetch(url, { headers })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

function useApi(params, deps) {
  const [state, setState] = useState({ data: null, loading: true, error: '' })
  useEffect(() => {
    let active = true
    setState({ data: null, loading: true, error: '' })
    readApi(params)
      .then(data => { if (active) setState({ data, loading: false, error: '' }) })
      .catch(err => { if (active) setState({ data: null, loading: false, error: err.message }) })
    return () => { active = false }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

/* ---------- Định dạng ---------- */

const isNum = v => typeof v === 'number' && Number.isFinite(v)
const dateText = v => {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('vi-VN')
}
const num = (v, digits = 2) => isNum(v) ? v.toLocaleString('vi-VN', { maximumFractionDigits: digits }) : '—'
const price = v => isNum(v) ? Math.round(v).toLocaleString('vi-VN') : '—'
const pct = v => isNum(v) ? `${(v * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%` : '—'
const score = v => isNum(v) ? v.toLocaleString('vi-VN', { maximumFractionDigits: 1 }) : '—'
const titleCase = key => String(key).replace(/_/g, ' ').replace(/\b\w/g, s => s.toUpperCase())
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()

/* ---------- Nhãn tiếng Việt ---------- */

const DECISION = {
  WATCH: { vi: 'Theo dõi', tone: 'blue' },
  ACCUMULATE: { vi: 'Tích lũy', tone: 'green' },
  HOLD: { vi: 'Nắm giữ', tone: 'teal' },
  'TAKE PROFIT': { vi: 'Chốt lời', tone: 'amber' },
  'EXIT/RE-EVALUATE': { vi: 'Thoát / đánh giá lại', tone: 'red' }
}
const GATE = {
  PASS: { vi: 'Đạt', tone: 'green' },
  CAUTION: { vi: 'Thận trọng', tone: 'amber' },
  RESTRICTED: { vi: 'Hạn chế', tone: 'orange' },
  BLOCKED: { vi: 'Bị chặn', tone: 'red' }
}
const THESIS = {
  STRENGTHENING: { vi: 'Đang mạnh lên', tone: 'green' },
  INTACT: { vi: 'Giữ nguyên', tone: 'blue' },
  WEAKENING: { vi: 'Đang yếu đi', tone: 'amber' },
  INVALIDATED: { vi: 'Mất hiệu lực', tone: 'red' }
}
const LEVEL = {
  LOW: { vi: 'Thấp', tone: 'green' },
  MEDIUM: { vi: 'Trung bình', tone: 'amber' },
  HIGH: { vi: 'Cao', tone: 'orange' },
  CRITICAL: { vi: 'Nghiêm trọng', tone: 'red' },
  UNKNOWN: { vi: 'Chưa rõ', tone: 'gray' }
}
const CONFIDENCE = { HIGH: { vi: 'Cao', tone: 'green' }, MEDIUM: { vi: 'Trung bình', tone: 'amber' }, LOW: { vi: 'Thấp', tone: 'orange' } }
const CLASSIFICATION = { REPORTED: 'Công bố', CALCULATED: 'Tính toán', ESTIMATED: 'Ước tính', FORECAST: 'Dự phóng', ASSUMPTION: 'Giả định', UNAVAILABLE: 'Không có' }
const DISPOSITION = {
  RANKED: { vi: 'Xếp hạng', tone: 'green' },
  PROVISIONAL: { vi: 'Tạm thời', tone: 'amber' },
  EXCLUDED: { vi: 'Loại', tone: 'red' },
  NOT_CHECKED: { vi: 'Chưa kiểm tra', tone: 'gray' }
}
const GROUP = { business: 'Kinh doanh', financial: 'Tài chính', governance: 'Quản trị', valuation: 'Định giá', timing: 'Thời điểm' }
const MODULES = {
  executive_summary: 'Tóm tắt điều hành',
  company_intelligence: 'Hiểu doanh nghiệp',
  industry_macro: 'Ngành và vĩ mô',
  competitive_advantage: 'Lợi thế cạnh tranh',
  financial_performance: 'Kết quả tài chính',
  financial_forensics: 'Soi chất lượng BCTC',
  debt_liquidity: 'Nợ và thanh khoản',
  ownership_governance: 'Sở hữu và quản trị',
  assets_projects: 'Tài sản và dự án',
  growth_forecast: 'Dự phóng tăng trưởng',
  valuation_engine: 'Mô hình định giá',
  catalysts_expectations: 'Catalyst và kỳ vọng',
  scorecard_risk: 'Scorecard và rủi ro',
  decision_monitoring: 'Quyết định và theo dõi'
}
const COMMITTEE = {
  equity: 'Chuyên gia cổ phiếu',
  forensic: 'Soi số liệu',
  valuation: 'Định giá',
  market: 'Thị trường',
  risk: 'Quản trị rủi ro',
  portfolio: 'Quản lý danh mục'
}

function Badge({ map, value, code = true, className = '' }) {
  if (!value) return <span className="rl-badge tone-gray">—</span>
  const m = map[value]
  return <span className={`rl-badge tone-${m?.tone || 'gray'} ${className}`} title={value}>
    {m?.vi || value}{code && m && m.vi !== value ? <small>{value}</small> : null}
  </span>
}

/* ---------- Nguồn tham khảo ---------- */

const SourcesContext = createContext({})

function Refs({ ids }) {
  const sources = useContext(SourcesContext)
  if (!ids?.length) return null
  return <span className="rl-refs">{ids.map(id => (
    <a key={id} href={`#src-${id}`} className="rl-ref" title={sources[id]?.title || id}>{id}</a>
  ))}</span>
}

function Gaps({ items, title = 'Còn thiếu' }) {
  if (!items?.length) return null
  return <div className="rl-gaps"><strong>{title}</strong><ul>{items.map((g, i) => <li key={i}>{g}</li>)}</ul></div>
}

/* ---------- Khung trang ---------- */

function TopBar({ children, progress }) {
  return <header className="rl-topbar">
    <div className="rl-topbar-inner">
      <a className="rl-brand" href="/" aria-label="Về thư viện">
        <span className="rl-brand-mark">IS</span>
        <span className="rl-brand-text"><strong>INVSTOCK TRACKER</strong><small>INVESTMENT RESEARCH</small></span>
      </a>
      <div className="rl-topbar-mid">{children}</div>
      <nav className="rl-topbar-nav"><a href="/admin">Admin</a></nav>
    </div>
    {progress !== undefined && <div className="rl-progress" style={{ transform: `scaleX(${progress})` }} />}
  </header>
}

function Footer() {
  return <footer className="rl-footer">
    InvStock Tracker · Nội dung chỉ phục vụ nghiên cứu và tham khảo, không phải khuyến nghị mua bán chứng khoán.
  </footer>
}

function Empty({ children, tone = '' }) {
  return <div className={`rl-empty ${tone}`}>{children}</div>
}

function Skeleton({ rows = 3 }) {
  return <div className="rl-skeleton">{Array.from({ length: rows }, (_, i) => <div key={i} />)}</div>
}

/* ---------- Trang chủ ---------- */

const SORTS = {
  recent: { label: 'Mới công bố', fn: (a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')) },
  score: { label: 'Điểm cao nhất', fn: (a, b) => (b.official_total ?? b.normalized_score ?? -1) - (a.official_total ?? a.normalized_score ?? -1) },
  mos: { label: 'MOS cao nhất', fn: (a, b) => (b.mos ?? -9) - (a.mos ?? -9) },
  ticker: { label: 'Mã A → Z', fn: (a, b) => String(a.ticker).localeCompare(String(b.ticker)) }
}

function readQuery() {
  const q = new URLSearchParams(window.location.search)
  return {
    tab: q.get('tab') === 'screening' ? 'screening' : 'research',
    q: q.get('q') || '',
    decision: q.get('decision') || '',
    gate: q.get('gate') || '',
    sector: q.get('sector') || '',
    sort: SORTS[q.get('sort')] ? q.get('sort') : 'recent',
    view: q.get('view') === 'table' ? 'table' : 'cards'
  }
}

function writeQuery(state) {
  const q = new URLSearchParams()
  if (state.tab !== 'research') q.set('tab', state.tab)
  if (state.q) q.set('q', state.q)
  if (state.decision) q.set('decision', state.decision)
  if (state.gate) q.set('gate', state.gate)
  if (state.sector) q.set('sector', state.sector)
  if (state.sort !== 'recent') q.set('sort', state.sort)
  if (state.view !== 'cards') q.set('view', state.view)
  const s = q.toString()
  window.history.replaceState(null, '', s ? `/?${s}` : '/')
}

const researchHref = item => `/research/${encodeURIComponent(item.ticker)}?exchange=${encodeURIComponent(item.exchange || 'HOSE')}`
const screeningHref = item => `/screening/${encodeURIComponent(item.lineage_key)}`

function ScoreMeter({ value, provisional }) {
  const v = isNum(value) ? Math.max(0, Math.min(100, value)) : null
  return <div className="rl-meter" title={provisional ? 'Điểm tạm: chưa đủ coverage để thành điểm chính thức' : 'Điểm chính thức'}>
    <div className="rl-meter-top"><span>Điểm</span><b>{score(value)}<small>/100</small>{provisional && v !== null && <em>tạm</em>}</b></div>
    <div className="rl-meter-bar"><i style={{ width: `${v ?? 0}%` }} className={provisional ? 'provisional' : ''} /></div>
  </div>
}

function ResearchCard({ item }) {
  const provisional = item.official_total == null && item.normalized_score != null
  return <a className="rl-card" href={researchHref(item)}>
    <div className="rl-card-head">
      <div>
        <div className="rl-card-ticker">{item.ticker}<span>{item.exchange}</span></div>
        <h3>{item.company || item.ticker}</h3>
        <div className="rl-card-sector">{item.sector || '—'}</div>
      </div>
      <Badge map={DECISION} value={item.decision_status} code={false} />
    </div>
    <ScoreMeter value={item.official_total ?? item.normalized_score} provisional={provisional} />
    <dl className="rl-card-facts">
      <div><dt>Giá trị hợp lý</dt><dd>{price(item.fair_value)}</dd></div>
      <div><dt>MOS</dt><dd className={isNum(item.mos) && isNum(item.required_mos) && item.mos >= item.required_mos ? 'good' : ''}>{pct(item.mos)}</dd></div>
      <div><dt>Rủi ro</dt><dd><Badge map={GATE} value={item.risk_gate} code={false} /></dd></div>
    </dl>
    <div className="rl-card-foot">
      <span>Dữ liệu đến {dateText(item.cutoff)} · R{item.revision}{item.visibility === 'members' ? ' · Thành viên' : ''}</span>
      <span className="rl-card-cta">Đọc →</span>
    </div>
  </a>
}

function ResearchTable({ items }) {
  return <div className="rl-table-wrap"><table className="rl-table rl-table-list">
    <thead><tr><th>Mã</th><th>Công ty</th><th>Quyết định</th><th>Rủi ro</th><th className="num">Điểm</th><th className="num">Giá trị HL</th><th className="num">MOS</th><th>Dữ liệu đến</th></tr></thead>
    <tbody>{items.map(item => <tr key={item.lineage_key} onClick={() => { window.location.href = researchHref(item) }}>
      <td><a href={researchHref(item)} className="rl-strong">{item.ticker}</a><small className="rl-muted"> {item.exchange}</small></td>
      <td>{item.company}<div className="rl-muted rl-small">{item.sector}</div></td>
      <td><Badge map={DECISION} value={item.decision_status} code={false} /></td>
      <td><Badge map={GATE} value={item.risk_gate} code={false} /></td>
      <td className="num">{score(item.official_total ?? item.normalized_score)}{item.official_total == null && item.normalized_score != null && <small className="rl-muted"> tạm</small>}</td>
      <td className="num">{price(item.fair_value)}</td>
      <td className="num">{pct(item.mos)}</td>
      <td>{dateText(item.cutoff)}</td>
    </tr>)}</tbody>
  </table></div>
}

function ScreeningCard({ item }) {
  return <a className="rl-card" href={screeningHref(item)}>
    <div className="rl-card-head">
      <div>
        <div className="rl-card-ticker">SCREENING<span>R{item.revision}</span></div>
        <h3>{item.strategy || 'Screening'}</h3>
        <div className="rl-card-sector">{item.universe || '—'}</div>
      </div>
    </div>
    <dl className="rl-card-facts">
      <div><dt>Số mã</dt><dd>{item.candidate_count ?? '—'}</dd></div>
      <div><dt>Thời điểm</dt><dd>{dateText(item.as_of)}</dd></div>
      <div><dt>Công bố</dt><dd>{dateText(item.published_at)}</dd></div>
    </dl>
    <div className="rl-card-foot"><span>Dữ liệu đến {dateText(item.cutoff)}</span><span className="rl-card-cta">Xem kết quả →</span></div>
  </a>
}

function ContinueReading() {
  const saved = storage.get(READING_PROGRESS_KEY)
  if (!saved?.path || !saved?.title) return null
  if (Date.now() - (saved.savedAt || 0) > 1000 * 60 * 60 * 24 * 30) return null
  return <a className="rl-continue" href={saved.path}>
    <span className="rl-continue-label">Đọc tiếp</span>
    <strong>{saved.title}</strong>
    <span className="rl-muted">{saved.percent ? `đã đọc ${saved.percent}%` : ''}</span>
    <span className="rl-card-cta">→</span>
  </a>
}

function Home() {
  const { data, loading, error } = useApi({ action: 'list' }, [])
  const [f, setF] = useState(readQuery)
  const searchRef = useRef(null)
  const set = patch => setF(prev => ({ ...prev, ...patch }))
  useEffect(() => { writeQuery(f) }, [f])
  useEffect(() => { document.title = 'Thư viện nghiên cứu · InvStock' }, [])
  useEffect(() => {
    const onKey = e => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'SELECT') {
        e.preventDefault(); searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const all = data?.research || []
  const screenings = data?.screenings || []
  const options = useMemo(() => ({
    decisions: Object.keys(DECISION).filter(d => all.some(r => r.decision_status === d)),
    gates: Object.keys(GATE).filter(g => all.some(r => r.risk_gate === g)),
    sectors: [...new Set(all.map(r => r.sector).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'))
  }), [all])

  const needle = fold(f.q.trim())
  const research = useMemo(() => all
    .filter(r => !needle || fold(`${r.ticker} ${r.company} ${r.sector} ${r.exchange}`).includes(needle))
    .filter(r => !f.decision || r.decision_status === f.decision)
    .filter(r => !f.gate || r.risk_gate === f.gate)
    .filter(r => !f.sector || r.sector === f.sector)
    .sort(SORTS[f.sort].fn), [all, needle, f.decision, f.gate, f.sector, f.sort])
  const screeningList = useMemo(() => screenings.filter(s => !needle || fold(`${s.strategy} ${s.universe}`).includes(needle)), [screenings, needle])
  const lastUpdate = useMemo(() => [...all, ...screenings].map(x => x.published_at).filter(Boolean).sort().pop(), [all, screenings])
  const hasFilters = f.q || f.decision || f.gate || f.sector

  return <div className="rl">
    <TopBar />
    <main className="rl-main">
      <section className="rl-intro">
        <div className="rl-intro-head">
          <h1>Thư viện nghiên cứu</h1>
          {!loading && !error && <span className="rl-intro-meta">{all.length} Full Research · {screenings.length} Screening{lastUpdate ? ` · cập nhật ${dateText(lastUpdate)}` : ''}</span>}
        </div>
        <div className="rl-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input ref={searchRef} type="search" value={f.q} onChange={e => set({ q: e.target.value })}
            placeholder="Tìm mã cổ phiếu, tên công ty hoặc ngành…" aria-label="Tìm kiếm" />
          {f.q ? <button type="button" onClick={() => set({ q: '' })} aria-label="Xóa tìm kiếm">×</button> : <kbd>/</kbd>}
        </div>
        <ContinueReading />
      </section>

      <div className="rl-tabs" role="tablist">
        <button role="tab" aria-selected={f.tab === 'research'} className={f.tab === 'research' ? 'active' : ''} onClick={() => set({ tab: 'research' })}>
          Full Research <span>{all.length}</span>
        </button>
        <button role="tab" aria-selected={f.tab === 'screening'} className={f.tab === 'screening' ? 'active' : ''} onClick={() => set({ tab: 'screening' })}>
          Screening <span>{screenings.length}</span>
        </button>
      </div>

      {f.tab === 'research' && <>
        <div className="rl-filters">
          {options.decisions.length > 0 && <div className="rl-chips" role="group" aria-label="Lọc theo quyết định">
            <button className={!f.decision ? 'active' : ''} onClick={() => set({ decision: '' })}>Tất cả</button>
            {options.decisions.map(d => <button key={d} className={f.decision === d ? `active tone-${DECISION[d].tone}` : ''} onClick={() => set({ decision: f.decision === d ? '' : d })}>{DECISION[d].vi}</button>)}
          </div>}
          <div className="rl-filter-row">
            {options.sectors.length > 1 && <label className="rl-select"><span>Ngành</span>
              <select value={f.sector} onChange={e => set({ sector: e.target.value })}><option value="">Tất cả</option>{options.sectors.map(s => <option key={s}>{s}</option>)}</select></label>}
            {options.gates.length > 0 && <label className="rl-select"><span>Rủi ro</span>
              <select value={f.gate} onChange={e => set({ gate: e.target.value })}><option value="">Tất cả</option>{options.gates.map(g => <option key={g} value={g}>{GATE[g].vi}</option>)}</select></label>}
            <label className="rl-select"><span>Sắp xếp</span>
              <select value={f.sort} onChange={e => set({ sort: e.target.value })}>{Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</select></label>
            <div className="rl-view-toggle" role="group" aria-label="Kiểu hiển thị">
              <button className={f.view === 'cards' ? 'active' : ''} onClick={() => set({ view: 'cards' })} title="Dạng thẻ">▦</button>
              <button className={f.view === 'table' ? 'active' : ''} onClick={() => set({ view: 'table' })} title="Dạng bảng">☰</button>
            </div>
          </div>
        </div>
        {!loading && !error && <div className="rl-result-line">
          {hasFilters ? `${research.length} / ${all.length} báo cáo phù hợp` : `${all.length} báo cáo`}
          {hasFilters && <button className="rl-link" onClick={() => set({ q: '', decision: '', gate: '', sector: '' })}>Xóa bộ lọc</button>}
        </div>}
        {loading && <div className="rl-cards">{[0, 1, 2].map(i => <div className="rl-card rl-card-ghost" key={i}><Skeleton rows={4} /></div>)}</div>}
        {error && <Empty tone="error">Không tải được thư viện ({error}). Hãy thử tải lại trang.</Empty>}
        {!loading && !error && (research.length
          ? (f.view === 'table' ? <ResearchTable items={research} /> : <div className="rl-cards">{research.map(item => <ResearchCard item={item} key={item.lineage_key} />)}</div>)
          : <Empty>{all.length ? 'Không có báo cáo nào khớp với tìm kiếm.' : 'Chưa có Full Research nào được xuất bản.'}</Empty>)}
      </>}

      {f.tab === 'screening' && <>
        {loading && <Skeleton rows={3} />}
        {error && <Empty tone="error">Không tải được thư viện ({error}).</Empty>}
        {!loading && !error && (screeningList.length
          ? <div className="rl-cards">{screeningList.map(item => <ScreeningCard item={item} key={item.lineage_key} />)}</div>
          : <Empty>{screenings.length ? 'Không có Screening nào khớp với tìm kiếm.' : 'Chưa có Screening nào được xuất bản.'}</Empty>)}
      </>}
    </main>
    <Footer />
  </div>
}

/* ---------- Tiện ích trang đọc ---------- */

function useReadingProgress(path, title, ready) {
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    if (!ready) return
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight
        const p = max > 0 ? Math.min(1, window.scrollY / max) : 0
        setProgress(p)
        storage.set(READING_PROGRESS_KEY, { path, title, scrollY: window.scrollY, percent: Math.round(p * 100), savedAt: Date.now() })
      })
    }
    window.addEventListener('scroll', update, { passive: true })
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', update) }
  }, [path, title, ready])
  useEffect(() => {
    if (!ready || window.location.hash) return
    const saved = storage.get(READING_PROGRESS_KEY)
    if (saved?.path === path && Number(saved.scrollY) > 200)
      requestAnimationFrame(() => window.scrollTo({ top: Number(saved.scrollY), behavior: 'instant' }))
  }, [ready, path])
  return progress
}

function useScrollSpy(ids, ready) {
  const [active, setActive] = useState(ids[0])
  useEffect(() => {
    if (!ready) return
    const els = ids.map(id => document.getElementById(id)).filter(Boolean)
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (visible[0]) setActive(visible[0].target.id)
    }, { rootMargin: '-120px 0px -65% 0px' })
    els.forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [ids.join('|'), ready]) // eslint-disable-line react-hooks/exhaustive-deps
  return ids.includes(active) ? active : ids[0]
}

function useReaderSize() {
  const [size, setSize] = useState(() => {
    const v = Number(storage.get(READER_SIZE_KEY, 1))
    return [0.92, 1, 1.1, 1.2].includes(v) ? v : 1
  })
  useEffect(() => { storage.set(READER_SIZE_KEY, size) }, [size])
  return [size, setSize]
}

function SectionNav({ sections, active }) {
  const listRef = useRef(null)
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-id="${active}"]`)
    if (el && listRef.current && window.matchMedia('(max-width: 960px)').matches) {
      const box = listRef.current
      box.scrollTo({ left: el.offsetLeft - box.clientWidth / 2 + el.clientWidth / 2, behavior: 'smooth' })
    }
  }, [active])
  return <nav className="rl-toc" aria-label="Mục lục">
    <div className="rl-toc-title">Mục lục</div>
    <div className="rl-toc-list" ref={listRef}>
      {sections.map(s => <a key={s.id} data-id={s.id} href={`#${s.id}`} className={active === s.id ? 'active' : ''}>{s.title}</a>)}
    </div>
  </nav>
}

function SizeControl({ size, setSize }) {
  const steps = [0.92, 1, 1.1, 1.2]
  const i = steps.indexOf(size)
  return <div className="rl-size" role="group" aria-label="Cỡ chữ">
    <button onClick={() => setSize(steps[Math.max(0, i - 1)])} disabled={i <= 0} title="Chữ nhỏ hơn">A−</button>
    <button onClick={() => setSize(steps[Math.min(steps.length - 1, i + 1)])} disabled={i >= steps.length - 1} title="Chữ lớn hơn">A+</button>
  </div>
}

function BackToTop() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const on = () => setShow(window.scrollY > 900)
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  return show ? <button className="rl-top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="Lên đầu trang">↑</button> : null
}

function ReportSection({ id, title, kicker, children }) {
  return <section className="rl-section" id={id}>
    {kicker && <div className="rl-kicker">{kicker}</div>}
    <h2>{title}</h2>
    {children}
  </section>
}

function Prose({ text }) {
  if (!text) return null
  return <div className="rl-prose">{String(text).split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
}

function BulletList({ items, tone = '' }) {
  if (!items?.length) return <p className="rl-muted">Không có.</p>
  return <ul className={`rl-bullets ${tone}`}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
}

/* ---------- Các khối của Full Research ---------- */

function KeyFacts({ data, p }) {
  const v = p.valuation || {}
  const sc = p.scorecard || {}
  const provisional = data.official_total == null
  const mosOk = isNum(v.mos) && isNum(v.required_mos) && v.mos >= v.required_mos
  return <div className="rl-keyfacts">
    <div className="rl-kf rl-kf-decision">
      <span>Quyết định</span>
      <Badge map={DECISION} value={data.decision_status} className="lg" />
      <small>Luận điểm: <Badge map={THESIS} value={data.thesis_status || p.decision?.thesis_status} code={false} /></small>
    </div>
    <div className="rl-kf">
      <span>Cổng rủi ro</span>
      <Badge map={GATE} value={data.risk_gate} className="lg" />
      <small>{p.risk?.critical_gaps?.length ? `${p.risk.critical_gaps.length} điểm cần xác minh` : 'Không có điểm trọng yếu'}</small>
    </div>
    <div className="rl-kf">
      <span>{provisional ? 'Điểm tạm' : 'Điểm chính thức'}</span>
      <strong>{score(data.official_total ?? data.normalized_score)}<small>/100</small></strong>
      <small>Coverage {num(sc.coverage ?? data.score_coverage, 0)}% · Tin cậy {CONFIDENCE[sc.confidence || data.score_confidence]?.vi || '—'}</small>
    </div>
    <div className="rl-kf">
      <span>Giá trị hợp lý</span>
      <strong>{price(v.fair_value ?? data.fair_value)}</strong>
      <small>Giá {price(v.price ?? data.price)} ngày {dateText(v.price_date ?? data.price_date)}</small>
    </div>
    <div className="rl-kf">
      <span>Biên an toàn (MOS)</span>
      <strong className={mosOk ? 'good' : 'warn'}>{pct(v.mos ?? data.mos)}</strong>
      <small>Yêu cầu tối thiểu {pct(v.required_mos ?? data.required_mos)}{isNum(v.max_buy) ? ` · Mua tối đa ${price(v.max_buy)}` : ''}</small>
    </div>
  </div>
}

function ThesisBlock({ decision }) {
  if (!decision) return null
  return <>
    <div className="rl-two">
      <div className="rl-panel tone-green-soft"><h3>Luận điểm tích cực</h3><BulletList items={decision.bull_thesis} /></div>
      <div className="rl-panel tone-red-soft"><h3>Luận điểm tiêu cực</h3><BulletList items={decision.bear_thesis} /></div>
    </div>
    <div className="rl-two">
      <div className="rl-panel"><h3>Điều kiện hành động</h3><BulletList items={decision.conditions} /></div>
      <div className="rl-panel"><h3>Khi nào luận điểm sai</h3><BulletList items={decision.invalidation} /></div>
    </div>
    <dl className="rl-deflist">
      {decision.investment_type && <div><dt>Loại cơ hội</dt><dd>{decision.investment_type}</dd></div>}
      {decision.horizon && <div><dt>Khung thời gian</dt><dd>{decision.horizon}</dd></div>}
      {decision.position_context && <div><dt>Bối cảnh vị thế</dt><dd>{decision.position_context}</dd></div>}
    </dl>
  </>
}

function ValuationBlock({ v }) {
  if (!v) return null
  const scen = ['bear', 'base', 'bull'].map(k => ({ k, ...(v[k] || {}) }))
  const marks = [...scen.map(s => s.value), v.price, v.max_buy, v.fair_value].filter(isNum)
  const lo = marks.length ? Math.min(...marks) * 0.9 : 0
  const hi = marks.length ? Math.max(...marks) * 1.05 : 1
  const pos = x => `${((x - lo) / (hi - lo || 1)) * 100}%`
  const names = { bear: 'Xấu', base: 'Cơ sở', bull: 'Tốt' }
  return <>
    {marks.length > 1 && <div className="rl-scale" aria-label="Thang định giá">
      <div className="rl-scale-track">
        {isNum(scen[0].value) && isNum(scen[2].value) && <div className="rl-scale-range" style={{ left: pos(scen[0].value), width: `calc(${pos(scen[2].value)} - ${pos(scen[0].value)})` }} />}
        {scen.filter(s => isNum(s.value)).map(s => <div key={s.k} className={`rl-scale-mark scen ${s.k}`} style={{ left: pos(s.value) }}><span>{names[s.k]}<b>{price(s.value)}</b></span></div>)}
        {isNum(v.price) && <div className="rl-scale-mark price" style={{ left: pos(v.price) }}><span>Giá hiện tại<b>{price(v.price)}</b></span></div>}
        {isNum(v.max_buy) && <div className="rl-scale-mark maxbuy" style={{ left: pos(v.max_buy) }}><span>Mua tối đa<b>{price(v.max_buy)}</b></span></div>}
      </div>
    </div>}
    <div className="rl-stat-row">
      <div><span>Tiềm năng tăng</span><b className="good">{pct(v.upside)}</b></div>
      <div><span>Rủi ro giảm</span><b className="warn">{pct(v.downside)}</b></div>
      <div><span>Lợi nhuận / rủi ro</span><b>{isNum(v.reward_risk) ? `${num(v.reward_risk)}x` : "—"}</b></div>
      <div><span>Giá mục tiêu</span><b>{price(v.target_price)}</b></div>
    </div>
    {v.target_horizon && <p className="rl-note">Giá mục tiêu: {v.target_horizon}</p>}
    <div className="rl-scenarios">
      {scen.map(s => <div key={s.k} className={`rl-panel scen-${s.k}`}>
        <div className="rl-scen-head"><h3>Kịch bản {names[s.k].toLowerCase()}</h3><b>{price(s.value)}</b></div>
        {isNum(s.probability) && <div className="rl-muted rl-small">Xác suất {pct(s.probability)}</div>}
        <BulletList items={s.assumptions} />
        {s.method && <p className="rl-note">{s.method} <Refs ids={s.source_ids} /></p>}
      </div>)}
    </div>
    <div className="rl-two">
      {v.methods?.length > 0 && <div className="rl-panel"><h3>Phương pháp</h3><BulletList items={v.methods} /></div>}
      {v.sensitivity?.length > 0 && <div className="rl-panel"><h3>Độ nhạy</h3><BulletList items={v.sensitivity} /></div>}
    </div>
    {v.limitations?.length > 0 && <Gaps items={v.limitations} title="Giới hạn của định giá" />}
  </>
}

function ScoreBar({ value }) {
  if (!isNum(value)) return <div className="rl-scorebar empty"><span>Chưa chấm</span></div>
  return <div className={`rl-scorebar s${Math.round(value)}`}><i style={{ width: `${value * 10}%` }} /><b>{value}</b></div>
}

function ScorecardBlock({ scorecard, criteria }) {
  const [open, setOpen] = useState(null)
  if (!scorecard?.criteria) return <p className="rl-muted">Không có scorecard.</p>
  const meta = Object.fromEntries((criteria || []).map(c => [c.criterion_id, c]))
  const rows = Object.entries(scorecard.criteria).map(([id, c]) => ({ id, ...c, meta: meta[id] }))
  const groups = []
  rows.forEach(r => {
    const g = r.meta?.grp || 'other'
    let grp = groups.find(x => x.g === g)
    if (!grp) { grp = { g, rows: [] }; groups.push(grp) }
    grp.rows.push(r)
  })
  return <>
    <div className="rl-stat-row">
      <div><span>Điểm chuẩn hóa</span><b>{score(scorecard.normalized_score)}</b></div>
      <div><span>Điểm chính thức</span><b>{score(scorecard.official_total)}</b></div>
      <div><span>Coverage</span><b>{num(scorecard.coverage, 0)}%</b></div>
      <div><span>Độ tin cậy</span><b><Badge map={CONFIDENCE} value={scorecard.confidence} code={false} /></b></div>
    </div>
    {scorecard.confidence_reason && <p className="rl-note">{scorecard.confidence_reason}</p>}
    <div className="rl-criteria">
      {groups.map(grp => <div key={grp.g} className="rl-criteria-group">
        <div className="rl-criteria-group-title">{GROUP[grp.g] || (grp.g === 'other' ? 'Tiêu chí' : titleCase(grp.g))}</div>
        {grp.rows.map(r => <div key={r.id} className={`rl-criterion ${open === r.id ? 'open' : ''}`}>
          <button className="rl-criterion-row" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
            <span className="rl-criterion-name"><b>{r.id}</b> {r.meta?.name || ''}{r.meta?.is_critical && <em title="Tiêu chí trọng yếu">trọng yếu</em>}</span>
            <span className="rl-criterion-weight">{r.meta?.weight != null ? `×${r.meta.weight}` : ''}</span>
            <ScoreBar value={r.score} />
          </button>
          {open === r.id && <div className="rl-criterion-detail">
            <p>{r.rationale || '—'} <Refs ids={r.source_ids} /></p>
            {r.benchmark && <p className="rl-muted rl-small">So sánh với: {r.benchmark}</p>}
          </div>}
        </div>)}
      </div>)}
    </div>
    <p className="rl-muted rl-small">Bấm vào từng tiêu chí để xem lý do chấm điểm. Thang điểm 0–10; ×n là trọng số.</p>
  </>
}

function RiskBlock({ risk }) {
  if (!risk) return null
  return <>
    <div className="rl-gate-line">Cổng rủi ro: <Badge map={GATE} value={risk.gate} className="lg" /></div>
    {risk.critical_gaps?.length > 0 && <Gaps items={risk.critical_gaps} title="Điểm trọng yếu chưa xác minh" />}
    <div className="rl-risks">
      {(risk.items || []).map((r, i) => <div className="rl-risk" key={i}>
        <div className="rl-risk-head">
          <h3>{r.description}</h3>
          <div className="rl-risk-tags">
            <span>Khả năng <Badge map={LEVEL} value={r.likelihood} code={false} /></span>
            <span>Tác động <Badge map={LEVEL} value={r.impact} code={false} /></span>
          </div>
        </div>
        <p><span className="rl-muted">Cách theo dõi / giảm thiểu:</span> {r.mitigation} <Refs ids={r.source_ids} /></p>
      </div>)}
    </div>
  </>
}

function OpinionCards({ items, labels, numbered }) {
  return <div className="rl-opinions">{Object.entries(items || {}).map(([key, x], i) => <article className="rl-opinion" key={key}>
    <div className="rl-opinion-head">
      <span className="rl-opinion-key">{numbered ? `Câu ${i + 1}` : (labels?.[key] || titleCase(key))}</span>
      <Badge map={CONFIDENCE} value={x.confidence} code={false} className="sm" />
    </div>
    <h3>{x.conclusion}</h3>
    <p>{x.evidence} <Refs ids={x.source_ids} /></p>
    {x.decision_impact && <p className="rl-opinion-impact"><span>Tác động:</span> {x.decision_impact}</p>}
    {x.gaps?.length > 0 && <p className="rl-opinion-gaps"><span>Còn thiếu:</span> {x.gaps.join('; ')}</p>}
  </article>)}</div>
}

function metricValue(m) {
  if (!isNum(m.value)) return <span className="rl-muted" title={m.missing_reason || ''}>{m.missing_reason ? 'Không có*' : '—'}</span>
  return num(m.value, Math.abs(m.value) >= 1000 ? 0 : 2)
}

function MetricMark({ m }) {
  return <span className={`rl-mark ${m.verification === 'VERIFIED' ? 'ok' : m.verification === 'UNVERIFIED' ? 'no' : ''}`}
    title={`${CLASSIFICATION[m.classification] || m.classification || ''} · ${m.verification === 'VERIFIED' ? 'Đã xác minh' : m.verification === 'UNVERIFIED' ? 'Chưa xác minh' : 'Không áp dụng'}${m.method ? ` · ${m.method}` : ''}`}>
    {m.verification === 'VERIFIED' ? '✓' : m.verification === 'UNVERIFIED' ? '?' : ''}
  </span>
}

function MetricsView({ metrics }) {
  const [mode, setMode] = useState('auto')
  if (!metrics?.length) return null
  // Chỉ tiêu xuất hiện ở nhiều kỳ thì gom thành bảng theo kỳ cho dễ so sánh.
  const byName = new Map()
  metrics.forEach(m => { const k = `${m.name}|${m.unit}`; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(m) })
  const series = [...byName.values()].filter(list => new Set(list.map(m => m.period)).size > 1)
  const seriesSet = new Set(series.flat())
  const singles = metrics.filter(m => !seriesSet.has(m))
  const periods = [...new Set(series.flat().map(m => m.period))]
  const canPivot = series.length > 0 && mode === 'auto'
  return <div className="rl-metrics">
    {series.length > 0 && <div className="rl-metrics-toolbar">
      <button className={mode === 'auto' ? 'active' : ''} onClick={() => setMode('auto')}>Theo kỳ</button>
      <button className={mode === 'flat' ? 'active' : ''} onClick={() => setMode('flat')}>Chi tiết</button>
    </div>}
    {canPivot && <div className="rl-table-wrap"><table className="rl-table rl-pivot">
      <thead><tr><th>Chỉ tiêu</th>{periods.map(p => <th key={p} className="num">{p}</th>)}</tr></thead>
      <tbody>{series.map(list => <tr key={`${list[0].name}|${list[0].unit}`}>
        <th scope="row">{list[0].name}<small>{list[0].unit}</small></th>
        {periods.map(p => { const m = list.find(x => x.period === p); return <td key={p} className="num">{m ? <>{metricValue(m)}<MetricMark m={m} /></> : ''}</td> })}
      </tr>)}</tbody>
    </table></div>}
    {(canPivot ? singles : metrics).length > 0 && <div className="rl-table-wrap"><table className="rl-table rl-flat">
      <thead><tr><th>Chỉ tiêu</th><th>Kỳ</th><th className="num">Giá trị</th><th>Đơn vị</th><th>Loại</th><th>Nguồn</th></tr></thead>
      <tbody>{(canPivot ? singles : metrics).map((m, i) => <tr key={i}>
        <th scope="row">{m.name}{m.method && <small>{m.method}</small>}</th>
        <td>{m.period}</td>
        <td className="num">{metricValue(m)}<MetricMark m={m} /></td>
        <td>{m.unit}</td>
        <td><span className="rl-cls">{CLASSIFICATION[m.classification] || m.classification}</span></td>
        <td><Refs ids={m.source_ids} /></td>
      </tr>)}</tbody>
    </table></div>}
    <p className="rl-muted rl-small">✓ đã xác minh · ? chưa xác minh · rê chuột lên ô để xem phương pháp.</p>
  </div>
}

function ModulesBlock({ modules }) {
  const keys = Object.keys(modules || {}).filter(k => k !== 'executive_summary')
  const [openAll, setOpenAll] = useState(false)
  const [nonce, setNonce] = useState(0)
  if (!keys.length) return null
  return <>
    <div className="rl-modules-toolbar">
      <span className="rl-muted rl-small">{keys.length} phần phân tích</span>
      <button className="rl-link" onClick={() => { setOpenAll(!openAll); setNonce(n => n + 1) }}>{openAll ? 'Thu gọn tất cả' : 'Mở tất cả'}</button>
    </div>
    <div className="rl-modules">{keys.map((k, i) => {
      const m = modules[k] || {}
      return <details className="rl-module" id={`module-${k}`} key={`${k}-${nonce}`} open={openAll || undefined}>
        <summary>
          <span className="rl-module-no">{String(i + 1).padStart(2, '0')}</span>
          <span className="rl-module-title">{MODULES[k] || titleCase(k)}</span>
          <span className="rl-module-meta">{m.metrics?.length ? `${m.metrics.length} chỉ tiêu` : ''}{m.gaps?.length ? ` · ${m.gaps.length} thiếu` : ''}</span>
        </summary>
        <div className="rl-module-body">
          <Prose text={m.analysis} />
          <Refs ids={m.source_ids} />
          <MetricsView metrics={m.metrics} />
          <Gaps items={m.gaps} />
        </div>
      </details>
    })}</div>
  </>
}

function CatalystBlock({ items }) {
  if (!items?.length) return <p className="rl-muted">Không có catalyst.</p>
  return <ol className="rl-timeline">{items.map((c, i) => <li key={i}>
    <div className="rl-timeline-when">{c.window}</div>
    <div className="rl-timeline-body">
      <h3>{c.event} <Refs ids={c.source_ids} /></h3>
      <dl className="rl-deflist compact">
        <div><dt>Điều kiện</dt><dd>{c.condition}</dd></div>
        <div><dt>Nếu xảy ra</dt><dd>{c.impact}</dd></div>
        <div><dt>Nếu không</dt><dd>{c.failure_effect}</dd></div>
      </dl>
    </div>
  </li>)}</ol>
}

function MonitoringBlock({ items }) {
  if (!items?.length) return <p className="rl-muted">Không có chỉ tiêu theo dõi.</p>
  const sorted = [...items].sort((a, b) => String(a.review_date || '9').localeCompare(String(b.review_date || '9')))
  return <div className="rl-table-wrap"><table className="rl-table rl-stack">
    <thead><tr><th>Chỉ tiêu</th><th>Ngưỡng</th><th>Hành động</th><th>Ngày xem lại</th></tr></thead>
    <tbody>{sorted.map((m, i) => <tr key={i}>
      <th scope="row" data-label="Chỉ tiêu">{m.metric}</th><td data-label="Ngưỡng">{m.threshold}</td><td data-label="Hành động">{m.action}</td><td data-label="Xem lại">{dateText(m.review_date)}</td>
    </tr>)}</tbody>
  </table></div>
}

const TIER = { 1: 'Bậc 1 · Công bố chính thức', 2: 'Bậc 2', 3: 'Bậc 3', 4: 'Bậc 4 · Công ty chứng khoán', 5: 'Bậc 5' }

function SourcesBlock({ sources }) {
  if (!sources?.length) return <p className="rl-muted">Không có nguồn.</p>
  return <ol className="rl-sources">{sources.map(s => <li key={s.id} id={`src-${s.id}`}>
    <span className="rl-source-id">{s.id}</span>
    <div>
      <div className="rl-source-title">{/^https?:\/\//i.test(s.locator) ? <a href={s.locator} target="_blank" rel="noreferrer">{s.title}</a> : s.title}</div>
      <div className="rl-muted rl-small">{TIER[s.tier] || `Bậc ${s.tier}`} · Công bố {dateText(s.published_on)} · Truy cập {dateText(s.accessed_on)}{!/^https?:\/\//i.test(s.locator) && s.locator ? ` · ${s.locator}` : ''}</div>
    </div>
  </li>)}</ol>
}

function ReportHeader({ kicker, title, sub, chips }) {
  return <section className="rl-report-head">
    <a className="rl-back" href="/">← Thư viện</a>
    {kicker && <div className="rl-kicker">{kicker}</div>}
    <h1>{title}</h1>
    {sub && <p className="rl-report-sub">{sub}</p>}
    {chips}
  </section>
}

function ResearchPage({ ticker, exchange }) {
  const report = useApi({ action: 'research', ticker, exchange }, [ticker, exchange])
  const crit = useApi({ action: 'criteria' }, [])
  const [size, setSize] = useReaderSize()
  const data = report.data
  const p = data?.payload || {}
  const sourceMap = useMemo(() => Object.fromEntries((p.sources || []).map(s => [s.id, s])), [p.sources])
  const title = data ? `${ticker} · ${data.company || ''}` : ticker
  useEffect(() => { document.title = `${title} · InvStock` }, [title])

  const sections = useMemo(() => {
    if (!data) return []
    return [
      { id: 'tong-quan', title: 'Tổng quan', show: true },
      { id: 'luan-diem', title: 'Luận điểm', show: !!p.decision },
      { id: 'dinh-gia', title: 'Định giá', show: !!p.valuation },
      { id: 'scorecard', title: 'Scorecard', show: !!p.scorecard },
      { id: 'rui-ro', title: 'Rủi ro', show: !!p.risk },
      { id: 'catalyst', title: 'Catalyst', show: !!p.catalysts?.length },
      { id: 'theo-doi', title: 'Theo dõi', show: !!p.monitoring?.length },
      { id: 'core10', title: 'Core 10', show: !!p.core10 },
      { id: 'hoi-dong', title: 'Hội đồng đầu tư', show: !!p.committee },
      { id: 'phan-tich', title: 'Phân tích chi tiết', show: !!p.modules },
      { id: 'nguon', title: 'Nguồn', show: true }
    ].filter(s => s.show)
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps
  const active = useScrollSpy(sections.map(s => s.id), Boolean(data))
  const progress = useReadingProgress(`/research/${encodeURIComponent(ticker)}?exchange=${exchange}`, title, Boolean(data))

  return <SourcesContext.Provider value={sourceMap}>
    <div className="rl rl-reader" style={{ '--reader-scale': size }}>
      <TopBar progress={data ? progress : undefined}>
        {data && <div className="rl-topbar-title"><b>{ticker}</b><span>{data.company}</span></div>}
        {data && <SizeControl size={size} setSize={setSize} />}
      </TopBar>
      <main className="rl-main">
        {report.loading && <><Skeleton rows={2} /><Skeleton rows={5} /></>}
        {report.error && <><a className="rl-back" href="/">← Thư viện</a>
          <Empty tone="error">Không mở được báo cáo {ticker} ({report.error}). Báo cáo có thể chưa được xuất bản hoặc chỉ dành cho thành viên.</Empty></>}
        {data && <>
          <ReportHeader
            kicker={`Full Research · R${data.revision} · Dữ liệu đến ${dateText(data.cutoff)}`}
            title={<>{data.company || ticker} <span className="rl-ticker-pill">{ticker} · {data.exchange}</span></>}
            sub={`${data.sector || ''}${data.reporting_period ? ` · Kỳ báo cáo: ${data.reporting_period}` : ''}`} />
          <KeyFacts data={data} p={p} />
          <div className="rl-layout">
            <SectionNav sections={sections} active={active} />
            <article className="rl-article">
              <ReportSection id="tong-quan" title="Tổng quan" kicker="Đọc nhanh">
                {p.modules?.executive_summary ? <>
                  <Prose text={p.modules.executive_summary.analysis} />
                  <Refs ids={p.modules.executive_summary.source_ids} />
                  <MetricsView metrics={p.modules.executive_summary.metrics} />
                  <Gaps items={p.modules.executive_summary.gaps} />
                </> : <p className="rl-muted">Không có tóm tắt.</p>}
              </ReportSection>
              {p.decision && <ReportSection id="luan-diem" title="Luận điểm đầu tư"><ThesisBlock decision={p.decision} /></ReportSection>}
              {p.valuation && <ReportSection id="dinh-gia" title="Định giá" kicker={`Đơn vị: ${p.valuation.currency || 'VND'}/cổ phiếu`}><ValuationBlock v={p.valuation} /></ReportSection>}
              {p.scorecard && <ReportSection id="scorecard" title="Scorecard 15 tiêu chí"><ScorecardBlock scorecard={p.scorecard} criteria={crit.data?.criteria} /></ReportSection>}
              {p.risk && <ReportSection id="rui-ro" title="Rủi ro"><RiskBlock risk={p.risk} /></ReportSection>}
              {p.catalysts?.length > 0 && <ReportSection id="catalyst" title="Catalyst sắp tới"><CatalystBlock items={p.catalysts} /></ReportSection>}
              {p.monitoring?.length > 0 && <ReportSection id="theo-doi" title="Chỉ tiêu theo dõi"><MonitoringBlock items={p.monitoring} /></ReportSection>}
              {p.core10 && <ReportSection id="core10" title="10 câu hỏi cốt lõi"><OpinionCards items={p.core10} numbered /></ReportSection>}
              {p.committee && <ReportSection id="hoi-dong" title="Hội đồng đầu tư" kicker="6 góc nhìn phản biện"><OpinionCards items={p.committee} labels={COMMITTEE} /></ReportSection>}
              {p.modules && <ReportSection id="phan-tich" title="Phân tích chi tiết"><ModulesBlock modules={p.modules} /></ReportSection>}
              <ReportSection id="nguon" title="Nguồn tham khảo">
                <SourcesBlock sources={p.sources} />
                {p.metadata?.change_log?.length > 0 && <details className="rl-changelog"><summary>Lịch sử thay đổi (R{data.revision})</summary><BulletList items={p.metadata.change_log} /></details>}
                <div className="rl-meta">Công bố {dateText(data.published_at)} · R{data.revision} · Schema {data.schema_version} · SHA-256 <code>{data.sha256}</code></div>
              </ReportSection>
            </article>
          </div>
        </>}
      </main>
      <BackToTop />
      <Footer />
    </div>
  </SourcesContext.Provider>
}

/* ---------- Screening ---------- */

function ScreeningPage({ lineageKey }) {
  const report = useApi({ action: 'screening', lineage_key: lineageKey }, [lineageKey])
  const list = useApi({ action: 'list' }, [])
  const [open, setOpen] = useState(null)
  const [q, setQ] = useState('')
  const data = report.data
  const p = data?.payload || {}
  const sourceMap = useMemo(() => Object.fromEntries((p.sources || []).map(s => [s.id, s])), [p.sources])
  const published = useMemo(() => new Set((list.data?.research || []).map(r => `${r.ticker}:${r.exchange}`)), [list.data])
  const cands = useMemo(() => [...(p.candidates || [])]
    .filter(c => !q || fold(c.ticker).includes(fold(q)))
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || String(a.ticker).localeCompare(String(b.ticker))), [p.candidates, q])
  useEffect(() => { document.title = `${data?.strategy || 'Screening'} · InvStock` }, [data])

  return <SourcesContext.Provider value={sourceMap}>
    <div className="rl rl-reader">
      <TopBar>{data && <div className="rl-topbar-title"><b>Screening</b><span>{data.strategy}</span></div>}</TopBar>
      <main className="rl-main rl-narrow">
        {report.loading && <Skeleton rows={5} />}
        {report.error && <><a className="rl-back" href="/?tab=screening">← Thư viện</a><Empty tone="error">Không mở được Screening ({report.error}).</Empty></>}
        {data && <>
          <ReportHeader kicker={`Screening · R${data.revision} · Dữ liệu đến ${dateText(data.cutoff)}`} title={data.strategy || 'Screening'} sub={data.universe} />
          <div className="rl-stat-row">
            <div><span>Số ứng viên</span><b>{p.candidates?.length ?? 0}</b></div>
            <div><span>Quy mô vũ trụ</span><b>{p.universe_count ?? '—'}</b></div>
            <div><span>Thời điểm</span><b>{dateText(data.as_of)}</b></div>
            <div><span>Công bố</span><b>{dateText(data.published_at)}</b></div>
          </div>
          {p.filters?.length > 0 && <div className="rl-filter-tags"><span>Bộ lọc:</span>{p.filters.map((x, i) => <code key={i}>{x}</code>)}</div>}

          <ReportSection id="ung-vien" title="Danh sách ứng viên">
            {(p.candidates?.length || 0) > 8 && <div className="rl-search sm"><input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Lọc theo mã…" /></div>}
            <div className="rl-candidates">{cands.map(c => {
              const key = `${c.exchange}-${c.ticker}`
              const total = c.scorecard?.official_total ?? c.scorecard?.normalized_score
              return <div className={`rl-candidate ${open === key ? 'open' : ''}`} key={key}>
                <button className="rl-candidate-row" onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}>
                  <span className="rl-candidate-rank">{c.rank ? `#${c.rank}` : '—'}</span>
                  <span className="rl-candidate-ticker"><b>{c.ticker}</b><small>{c.exchange}</small></span>
                  <Badge map={DISPOSITION} value={c.disposition} code={false} />
                  <span className="rl-candidate-num"><small>Điểm</small>{score(total)}</span>
                  <span className="rl-candidate-num"><small>MOS</small>{pct(c.mos)}</span>
                  <Badge map={GATE} value={c.risk_gate} code={false} />
                </button>
                {open === key && <div className="rl-candidate-body">
                  <p>{c.rationale} <Refs ids={c.source_ids} /></p>
                  {published.has(`${c.ticker}:${c.exchange}`) && <a className="rl-button" href={researchHref(c)}>Đọc Full Research {c.ticker} →</a>}
                  {c.scorecard && <ScorecardBlock scorecard={c.scorecard} criteria={[]} />}
                </div>}
              </div>
            })}</div>
            {!cands.length && <Empty>Không có ứng viên.</Empty>}
          </ReportSection>
          {p.coverage_limitations?.length > 0 && <ReportSection id="gioi-han" title="Giới hạn dữ liệu"><BulletList items={p.coverage_limitations} /></ReportSection>}
          <ReportSection id="nguon" title="Nguồn tham khảo"><SourcesBlock sources={p.sources} /></ReportSection>
          <div className="rl-meta">R{data.revision} · SHA-256 <code>{data.sha256}</code></div>
        </>}
      </main>
      <Footer />
    </div>
  </SourcesContext.Provider>
}

export default function PublicLibrary() {
  const path = window.location.pathname.split('/').filter(Boolean)
  const exchange = (new URLSearchParams(window.location.search).get('exchange') || 'HOSE').toUpperCase()
  if (path[0] === 'research' && path[1]) return <ResearchPage ticker={decodeURIComponent(path[1]).toUpperCase()} exchange={exchange} />
  if (path[0] === 'screening' && path[1]) return <ScreeningPage lineageKey={decodeURIComponent(path[1])} />
  return <Home />
}
