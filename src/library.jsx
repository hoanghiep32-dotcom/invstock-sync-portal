import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

// Bộ nhớ đệm trong phiên: chuyển qua lại giữa các tab không phải tải lại bài.
const CACHE_MS = 5 * 60 * 1000
const apiCache = new Map()
const cacheKey = params => JSON.stringify(params)
const cachedData = params => {
  const c = apiCache.get(cacheKey(params))
  return c && Date.now() - c.at < CACHE_MS ? c.data : null
}
function fetchCached(params) {
  const hit = cachedData(params)
  if (hit) return Promise.resolve(hit)
  return readApi(params).then(data => { apiCache.set(cacheKey(params), { data, at: Date.now() }); return data })
}

function useApi(params, deps) {
  const [state, setState] = useState(() => {
    const hit = cachedData(params)
    return hit ? { data: hit, loading: false, error: '' } : { data: null, loading: true, error: '' }
  })
  useEffect(() => {
    let active = true
    const hit = cachedData(params)
    if (hit) { setState({ data: hit, loading: false, error: '' }); return }
    setState({ data: null, loading: true, error: '' })
    fetchCached(params)
      .then(data => { if (active) setState({ data, loading: false, error: '' }) })
      .catch(err => { if (active) setState({ data: null, loading: false, error: err.message }) })
    return () => { active = false }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

/* ---------- Điều hướng trong thư viện (không tải lại trang) ---------- */

const NAV_EVENT = 'rl:navigate'
const currentPath = () => window.location.pathname + window.location.search

function navigate(to, { replace = false } = {}) {
  if (to === currentPath() + window.location.hash) return
  window.history[replace ? 'replaceState' : 'pushState'](null, '', to)
  window.dispatchEvent(new Event(NAV_EVENT))
}

function useLocationPath() {
  const [path, setPath] = useState(currentPath)
  useEffect(() => {
    const on = () => setPath(currentPath())
    window.addEventListener('popstate', on)
    window.addEventListener(NAV_EVENT, on)
    return () => { window.removeEventListener('popstate', on); window.removeEventListener(NAV_EVENT, on) }
  }, [])
  return path
}

// Bắt các liên kết nội bộ để mở bài ngay trong thư viện. /admin vẫn tải trang bình thường;
// Ctrl/⌘ + click hoặc chuột giữa vẫn mở tab trình duyệt mới như thường.
function useLinkInterceptor() {
  useEffect(() => {
    const onClick = e => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = e.target.closest?.('a[href]')
      if (!a || a.target || a.hasAttribute('download')) return
      const href = a.getAttribute('href')
      if (!href || href.startsWith('#')) return
      const url = new URL(a.href, window.location.href)
      if (url.origin !== window.location.origin || url.pathname.startsWith('/admin')) return
      if (url.pathname + url.search === currentPath() && url.hash) return
      e.preventDefault()
      navigate(url.pathname + url.search + url.hash)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])
}

/* ---------- Nhớ vị trí đọc của từng trang ---------- */

const SCROLL_KEY = 'invstock_scroll_v1'
const scrollState = { key: null, ready: false }

function saveScroll(key, y) {
  const map = storage.get(SCROLL_KEY, {}) || {}
  map[key] = { y: Math.round(y), at: Date.now() }
  const keys = Object.keys(map).sort((a, b) => (map[b].at || 0) - (map[a].at || 0))
  keys.slice(40).forEach(k => { delete map[k] })
  storage.set(SCROLL_KEY, map)
}

function useScrollSaver() {
  useEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
    let timer = 0
    const on = () => {
      if (!scrollState.ready || timer) return
      const key = scrollState.key
      timer = setTimeout(() => { timer = 0; if (scrollState.ready && scrollState.key === key) saveScroll(key, window.scrollY) }, 200)
    }
    window.addEventListener('scroll', on, { passive: true })
    return () => { clearTimeout(timer); window.removeEventListener('scroll', on) }
  }, [])
}

// Trang gọi hook này với khóa riêng; khi nội dung sẵn sàng sẽ cuộn về chỗ đang đọc dở.
function useScrollMemory(key, ready) {
  useLayoutEffect(() => {
    scrollState.key = key; scrollState.ready = false
    if (!window.location.hash) window.scrollTo(0, 0)
  }, [key])
  useEffect(() => {
    if (!ready || scrollState.key !== key) return
    const hash = decodeURIComponent(window.location.hash.slice(1))
    const saved = (storage.get(SCROLL_KEY, {}) || {})[key]
    requestAnimationFrame(() => {
      if (hash && document.getElementById(hash)) document.getElementById(hash).scrollIntoView()
      else window.scrollTo({ top: Number(saved?.y) || 0, behavior: 'instant' })
      scrollState.ready = true
    })
  }, [key, ready])
}

/* ---------- Tab bài đang mở (lưu trong trình duyệt) ---------- */

const TABS_KEY = 'invstock_tabs_v1'
const TABS_EVENT = 'rl:tabs'
const MAX_TABS = 8

function readTabs() {
  const v = storage.get(TABS_KEY, null) || {}
  return {
    tabs: Array.isArray(v.tabs) ? v.tabs.filter(t => t && typeof t.path === 'string' && t.path.startsWith('/')) : [],
    home: typeof v.home === 'string' && v.home.startsWith('/') ? v.home : '/',
    last: typeof v.last === 'string' && v.last.startsWith('/') ? v.last : '/'
  }
}
function writeTabs(next) {
  storage.set(TABS_KEY, next)
  window.dispatchEvent(new Event(TABS_EVENT))
}
function patchTabs(patch) {
  const s = readTabs()
  if (Object.entries(patch).every(([k, v]) => s[k] === v)) return
  writeTabs({ ...s, ...patch })
}
function upsertTab(tab) {
  const s = readTabs()
  const i = s.tabs.findIndex(t => t.path === tab.path)
  if (i >= 0) {
    const merged = { ...s.tabs[i], ...tab }
    if (JSON.stringify(merged) === JSON.stringify(s.tabs[i])) return
    s.tabs[i] = merged
  } else {
    s.tabs.push(tab)
    while (s.tabs.length > MAX_TABS) {
      const drop = s.tabs.findIndex(t => t.path !== currentPath())
      s.tabs.splice(drop < 0 ? 0 : drop, 1)
    }
  }
  writeTabs(s)
}
function closeTab(path) {
  const s = readTabs()
  const i = s.tabs.findIndex(t => t.path === path)
  if (i < 0) return
  s.tabs.splice(i, 1)
  writeTabs(s)
  if (path === currentPath()) navigate((s.tabs[i] || s.tabs[i - 1])?.path || s.home)
}
function useTabs() {
  const [state, setState] = useState(readTabs)
  useEffect(() => {
    const on = () => setState(readTabs())
    const onStorage = e => { if (e.key === TABS_KEY) on() }
    window.addEventListener(TABS_EVENT, on)
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener(TABS_EVENT, on); window.removeEventListener('storage', onStorage) }
  }, [])
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
// Tiền tố id để một bài có thể hiển thị nhiều lần trên cùng trang (chế độ so sánh).
const IdPrefix = createContext('')

function Refs({ ids }) {
  const sources = useContext(SourcesContext)
  const prefix = useContext(IdPrefix)
  if (!ids?.length) return null
  return <span className="rl-refs">{ids.map(id => (
    <a key={id} href={`#${prefix}src-${id}`} className="rl-ref" title={sources[id]?.title || id}>{id}</a>
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
    <TabStrip />
    {progress !== undefined && <div className="rl-progress" style={{ transform: `scaleX(${progress})` }} />}
  </header>
}

const HomeIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 12 5l8 6.5" /><path d="M6.5 10v9h11v-9" /></svg>

// Hàng tab: Thư viện luôn ở đầu, sau đó là các bài đang mở. Đóng tab không xóa bài, chỉ bỏ khỏi hàng.
function TabStrip() {
  const { tabs, home } = useTabs()
  const here = currentPath()
  const onCompare = window.location.pathname === '/compare'
  const research = tabs.filter(t => t.kind === 'research' && t.ticker)
  const stripRef = useRef(null)
  useEffect(() => {
    const el = stripRef.current?.querySelector('.rl-tab.active')
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [here, tabs.length])
  if (!tabs.length && !onCompare) return null
  const isHome = !tabs.some(t => t.path === here) && !onCompare
  return <div className="rl-tabstrip">
    <div className="rl-tabstrip-inner" ref={stripRef} role="tablist" aria-label="Bài đang mở">
      <a href={home} className={`rl-tab rl-tab-home ${isHome ? 'active' : ''}`} role="tab" aria-selected={isHome} title="Thư viện"><HomeIcon /><span>Thư viện</span></a>
      {tabs.map(t => <div key={t.path} className={`rl-tab ${t.path === here ? 'active' : ''}`} role="tab" aria-selected={t.path === here}
        onAuxClick={e => { if (e.button === 1) { e.preventDefault(); closeTab(t.path) } }}>
        <a href={t.path} title={[t.title, t.sub].filter(Boolean).join(' · ')}>
          <b>{t.title}</b>{t.sub && <span>{t.sub}</span>}
        </a>
        <button type="button" onClick={() => closeTab(t.path)} aria-label={`Đóng ${t.title}`} title="Đóng tab">×</button>
      </div>)}
      {(research.length >= 2 || onCompare) && <a href={compareHref(research.slice(-3))} className={`rl-tab rl-tab-compare ${onCompare ? 'active' : ''}`} role="tab" aria-selected={onCompare}
        title="So sánh các bài đang mở"><span aria-hidden="true">⇆</span><span>So sánh</span></a>}
    </div>
  </div>
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
  const path = s ? `/?${s}` : '/'
  if (path !== currentPath()) window.history.replaceState(null, '', path)
  patchTabs({ home: path, last: path })
}

const researchHref = item => `/research/${encodeURIComponent(item.ticker)}?exchange=${encodeURIComponent(item.exchange || 'HOSE')}`
const screeningHref = item => `/screening/${encodeURIComponent(item.lineage_key)}`
const compareHref = items => `/compare?items=${items.map(i => `${i.ticker}.${i.exchange || 'HOSE'}`).join(',')}`
const researchTab = (item, company) => ({ path: researchHref(item), kind: 'research', ticker: item.ticker, exchange: item.exchange || 'HOSE', title: item.ticker, sub: company || item.company || 'Full Research' })

// Nút mở bài vào tab mà không rời trang hiện tại, để gom 2–3 bài rồi đọc/so sánh.
function OpenTabButton({ item, compact = false }) {
  const { tabs } = useTabs()
  const open = tabs.some(t => t.path === researchHref(item))
  return <button type="button" className={`rl-open-tab ${open ? 'is-open' : ''} ${compact ? 'compact' : ''}`}
    title={open ? 'Bài này đang mở trong tab' : 'Mở trong tab, vẫn ở lại trang này'}
    onClick={e => { e.preventDefault(); e.stopPropagation(); if (!open) upsertTab(researchTab(item)) }}>
    {open ? '✓ Đang mở' : '+ Mở tab'}
  </button>
}

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
      <span className="rl-card-actions"><OpenTabButton item={item} /><span className="rl-card-cta">Đọc →</span></span>
    </div>
  </a>
}

function ResearchTable({ items }) {
  return <div className="rl-table-wrap"><table className="rl-table rl-table-list">
    <thead><tr><th>Mã</th><th>Công ty</th><th>Quyết định</th><th>Rủi ro</th><th className="num">Điểm</th><th className="num">Giá trị HL</th><th className="num">MOS</th><th>Dữ liệu đến</th><th><span className="rl-sr">Mở tab</span></th></tr></thead>
    <tbody>{items.map(item => <tr key={item.lineage_key} onClick={() => navigate(researchHref(item))}>
      <td><a href={researchHref(item)} className="rl-strong">{item.ticker}</a><small className="rl-muted"> {item.exchange}</small></td>
      <td>{item.company}<div className="rl-muted rl-small">{item.sector}</div></td>
      <td><Badge map={DECISION} value={item.decision_status} code={false} /></td>
      <td><Badge map={GATE} value={item.risk_gate} code={false} /></td>
      <td className="num">{score(item.official_total ?? item.normalized_score)}{item.official_total == null && item.normalized_score != null && <small className="rl-muted"> tạm</small>}</td>
      <td className="num">{price(item.fair_value)}</td>
      <td className="num">{pct(item.mos)}</td>
      <td>{dateText(item.cutoff)}</td>
      <td><OpenTabButton item={item} compact /></td>
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
  useScrollMemory('home', !loading)
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
  useScrollMemory(path, ready)
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
  const prefix = useContext(IdPrefix)
  return <section className="rl-section" id={prefix + id}>
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
  const sameMethod = scen.every(x => x.method && x.method === scen[0].method)
  return <>
    {marks.length > 1 && <div className="rl-scale" aria-label="Thang định giá">
      <div className="rl-scale-track">
        {isNum(scen[0].value) && isNum(scen[2].value) && <div className="rl-scale-range" style={{ left: pos(scen[0].value), width: `calc(${pos(scen[2].value)} - ${pos(scen[0].value)})` }} />}
        {scen.filter(s => isNum(s.value)).map(s => <div key={s.k} className={`rl-scale-mark scen ${s.k}`} style={{ left: pos(s.value) }}><span>{names[s.k]}<b>{price(s.value)}</b></span></div>)}
        {isNum(v.price) && <div className="rl-scale-mark price" style={{ left: pos(v.price) }}><span>Giá hiện tại<b>{price(v.price)}</b></span></div>}
        {isNum(v.max_buy) && <div className="rl-scale-mark maxbuy" style={{ left: pos(v.max_buy) }}><span>Mua tối đa<b>{price(v.max_buy)}</b></span></div>}
      </div>
    </div>}
    {[v.upside, v.downside, v.reward_risk, v.target_price].some(isNum) && <div className="rl-stat-row">
      <div><span>Tiềm năng tăng</span><b className="good">{pct(v.upside)}</b></div>
      <div><span>Rủi ro giảm</span><b className="warn">{pct(v.downside)}</b></div>
      <div><span>Lợi nhuận / rủi ro</span><b>{isNum(v.reward_risk) ? `${num(v.reward_risk)}x` : "—"}</b></div>
      <div><span>Giá mục tiêu</span><b>{price(v.target_price)}</b></div>
    </div>}
    {v.target_horizon && <p className="rl-note">Giá mục tiêu: {v.target_horizon}</p>}
    <div className="rl-scenarios">
      {scen.map(s => <div key={s.k} className={`rl-panel scen-${s.k}`}>
        <div className="rl-scen-head"><h3>Kịch bản {names[s.k].toLowerCase()}</h3><b>{price(s.value)}</b></div>
        {isNum(s.probability) && <div className="rl-muted rl-small">Xác suất {pct(s.probability)}</div>}
        <BulletList items={s.assumptions} />
        {s.method && !sameMethod && <p className="rl-note">{s.method} <Refs ids={s.source_ids} /></p>}
      </div>)}
    </div>
    {sameMethod && <p className="rl-note"><b>Phương pháp các kịch bản:</b> {scen[0].method} <Refs ids={[...new Set(scen.flatMap(s => s.source_ids || []))]} /></p>}
    {v.limitations?.length > 0 && <Gaps items={v.limitations} title="Giới hạn của định giá" />}
    {(v.methods?.length > 0 || v.sensitivity?.length > 0) && <details className="rl-more">
      <summary>Phương pháp và độ nhạy</summary>
      <div className="rl-two">
        {v.methods?.length > 0 && <div><h3>Phương pháp</h3><BulletList items={v.methods} /></div>}
        {v.sensitivity?.length > 0 && <div><h3>Độ nhạy</h3><BulletList items={v.sensitivity} /></div>}
      </div>
    </details>}
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

/* Danh sách phản biện gọn: mỗi dòng một kết luận, bằng chứng và phần còn thiếu ngay bên dưới. */
function OpinionList({ items, labels, numbered }) {
  const entries = Object.entries(items || {})
  if (!entries.length) return null
  const impacts = [...new Set(entries.map(([, x]) => x.decision_impact).filter(Boolean))]
  const sharedImpact = impacts.length === 1 && entries.length > 2 ? impacts[0] : null
  return <>
    {sharedImpact && <p className="rl-note"><b>Tác động chung đến quyết định:</b> {sharedImpact}</p>}
    <ol className={`rl-qa ${numbered ? 'numbered' : 'labelled'}`}>{entries.map(([key, x], i) => <li key={key}>
      <div className="rl-qa-row">
        <span className="rl-qa-key">{numbered ? String(i + 1).padStart(2, '0') : (labels?.[key] || titleCase(key))}</span>
        <span className="rl-qa-title">{x.conclusion}</span>
        <Badge map={CONFIDENCE} value={x.confidence} code={false} className="sm" />
      </div>
      <div className="rl-qa-body">
        <div className="rl-qa-evidence">{x.evidence} <Refs ids={x.source_ids} /></div>
        {x.decision_impact && !sharedImpact && <div className="rl-qa-extra"><span>Tác động:</span> {x.decision_impact}</div>}
        {x.gaps?.length > 0 && <div className="rl-qa-extra"><span>Còn thiếu:</span> {x.gaps.join('; ')}</div>}
      </div>
    </li>)}</ol>
  </>
}

/* ---------- Số liệu ---------- */

const UNIT_PCT = new Set(['%'])
const UNIT_FRACTION = new Set(['fraction'])
const UNIT_MULTIPLE = new Set(['x', 'lần'])

function formatMetric(m) {
  if (!isNum(m.value)) return null
  const v = m.value
  if (UNIT_FRACTION.has(m.unit)) return `${(v * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`
  if (UNIT_PCT.has(m.unit)) return `${v.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`
  if (UNIT_MULTIPLE.has(m.unit)) return `${v.toLocaleString('vi-VN', { maximumFractionDigits: 2 })}x`
  const abs = Math.abs(v)
  return v.toLocaleString('vi-VN', { maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2 })
}
const unitLabel = u => (UNIT_PCT.has(u) || UNIT_FRACTION.has(u) || UNIT_MULTIPLE.has(u)) ? '' : u

function MetricCell({ m }) {
  const text = formatMetric(m)
  const tip = [m.period, CLASSIFICATION[m.classification], m.verification === 'VERIFIED' ? 'Đã xác minh' : m.verification === 'UNVERIFIED' ? 'Chưa xác minh' : null, m.method, m.missing_reason].filter(Boolean).join(' · ')
  return <span className={`rl-val ${m.verification === 'UNVERIFIED' ? 'unverified' : ''} ${(m.value ?? 0) < 0 ? 'neg' : ''}`} title={tip}>
    {text ?? <span className="rl-muted">—</span>}
  </span>
}

// Nhóm kỳ: năm, quý, lũy kế/khác, để bảng không bị trải dài và thưa.
function periodGroup(p) {
  const s = String(p)
  if (/^(FY)?\d{4}[A-Z]?$/i.test(s)) return 'year'
  if (/^Q\d/i.test(s) || /^\d{4}Q\d/i.test(s)) return 'quarter'
  return 'other'
}
const PERIOD_GROUP_TITLE = { year: 'Theo năm', quarter: 'Theo quý', other: 'Lũy kế / thời điểm khác' }

function PivotTable({ rows, periods, title }) {
  return <div className="rl-pivot-block">
    {title && <div className="rl-pivot-title">{title}</div>}
    <div className="rl-table-wrap"><table className="rl-table rl-pivot">
      <thead><tr><th>Chỉ tiêu</th>{periods.map(p => <th key={p} className="num">{p}</th>)}</tr></thead>
      <tbody>{rows.map(r => <tr key={r.key}>
        <th scope="row">{r.name}{unitLabel(r.unit) && <small>{r.unit}</small>}</th>
        {periods.map(p => { const m = r.byPeriod.get(p); return <td key={p} className="num">{m ? <MetricCell m={m} /> : ''}</td> })}
      </tr>)}</tbody>
    </table></div>
  </div>
}

function MetricTiles({ metrics }) {
  return <div className="rl-tiles">{metrics.map((m, i) => <div className="rl-tile" key={i}>
    <span className="rl-tile-name">{m.name}</span>
    <span className="rl-tile-value"><MetricCell m={m} />{isNum(m.value) && unitLabel(m.unit) && <small>{m.unit}</small>}</span>
    <span className="rl-tile-period">{m.period}{m.verification === 'UNVERIFIED' ? ' · chưa xác minh' : ''}</span>
  </div>)}</div>
}

function MetricsDetail({ metrics }) {
  return <div className="rl-table-wrap"><table className="rl-table rl-flat">
    <thead><tr><th>Chỉ tiêu</th><th>Kỳ</th><th className="num">Giá trị</th><th>Loại</th><th>Nguồn</th></tr></thead>
    <tbody>{metrics.map((m, i) => <tr key={i}>
      <th scope="row">{m.name}{m.method && <small>{m.method}</small>}{m.missing_reason && <small>Thiếu: {m.missing_reason}</small>}</th>
      <td>{m.period}</td>
      <td className="num"><MetricCell m={m} />{isNum(m.value) && unitLabel(m.unit) && <small className="rl-muted"> {m.unit}</small>}</td>
      <td><span className="rl-cls">{CLASSIFICATION[m.classification] || m.classification}{m.verification === 'VERIFIED' ? ' · ✓' : ''}</span></td>
      <td><Refs ids={m.source_ids} /></td>
    </tr>)}</tbody>
  </table></div>
}

function MetricsView({ metrics }) {
  const [detail, setDetail] = useState(false)
  if (!metrics?.length) return null
  const byName = new Map()
  metrics.forEach(m => {
    const key = `${m.name}|${m.unit}`
    if (!byName.has(key)) byName.set(key, { key, name: m.name, unit: m.unit, list: [] })
    byName.get(key).list.push(m)
  })
  const series = [...byName.values()].filter(r => new Set(r.list.map(m => m.period)).size > 1)
  const inSeries = new Set(series.flatMap(r => r.list))
  const singles = metrics.filter(m => !inSeries.has(m))
  const groups = ['year', 'quarter', 'other'].map(g => {
    const periods = [...new Set(series.flatMap(r => r.list.map(m => m.period)).filter(p => periodGroup(p) === g))]
    const rows = series.map(r => ({ ...r, byPeriod: new Map(r.list.filter(m => periodGroup(m.period) === g).map(m => [m.period, m])) }))
      .filter(r => r.byPeriod.size > 0)
    return { g, periods, rows }
  }).filter(x => x.periods.length && x.rows.length)
  const multi = groups.length > 1
  const unverified = metrics.filter(m => m.verification === 'UNVERIFIED').length
  return <div className="rl-metrics">
    {detail ? <MetricsDetail metrics={metrics} /> : <>
      {groups.map(x => <PivotTable key={x.g} rows={x.rows} periods={x.periods} title={multi ? PERIOD_GROUP_TITLE[x.g] : null} />)}
      {singles.length > 0 && <MetricTiles metrics={singles} />}
    </>}
    <div className="rl-metrics-foot">
      <span>{unverified ? `${unverified}/${metrics.length} số liệu chưa xác minh (chữ nghiêng)` : 'Số liệu đã xác minh'}</span>
      <button className="rl-link" onClick={() => setDetail(!detail)}>{detail ? 'Xem dạng gọn' : 'Xem nguồn và phương pháp'}</button>
    </div>
  </div>
}

function ModuleBody({ m, showGaps = true }) {
  if (!m) return null
  return <>
    <Prose text={m.analysis} />
    {m.source_ids?.length > 0 && <div className="rl-refs-line"><span>Nguồn:</span><Refs ids={m.source_ids} /></div>}
    <MetricsView metrics={m.metrics} />
    {showGaps && <Gaps items={m.gaps} />}
  </>
}

function Chapter({ modules, keys }) {
  const prefix = useContext(IdPrefix)
  const present = keys.filter(k => modules?.[k])
  if (!present.length) return null
  return present.map(k => <div className="rl-sub" id={`${prefix}module-${k}`} key={k}>
    {present.length > 1 && <h3 className="rl-sub-title">{MODULES[k] || titleCase(k)}</h3>}
    <ModuleBody m={modules[k]} />
  </div>)
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
  const prefix = useContext(IdPrefix)
  if (!sources?.length) return <p className="rl-muted">Không có nguồn.</p>
  return <ol className="rl-sources">{sources.map(s => <li key={s.id} id={`${prefix}src-${s.id}`}>
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

// Bố cục bài research theo trình tự đọc: kết luận → định giá → doanh nghiệp → tài chính → rủi ro → theo dõi → phản biện.
const CHAPTERS = [
  { id: 'doanh-nghiep', title: 'Doanh nghiệp và ngành', keys: ['company_intelligence', 'industry_macro', 'competitive_advantage', 'assets_projects'] },
  { id: 'tai-chinh', title: 'Tài chính', keys: ['financial_performance', 'financial_forensics', 'debt_liquidity'] },
  { id: 'quan-tri', title: 'Sở hữu và quản trị', keys: ['ownership_governance'] },
  { id: 'du-phong', title: 'Dự phóng tăng trưởng', keys: ['growth_forecast'] }
]
const PLACED = new Set(['executive_summary', 'decision_monitoring', 'valuation_engine', 'scorecard_risk', 'catalysts_expectations', ...CHAPTERS.flatMap(c => c.keys)])

// Danh sách mục của một bài, dùng cho mục lục và cho ô "Đi tới mục" trong chế độ so sánh.
function researchSections(data) {
  if (!data) return []
  const p = data.payload || {}
  const mods = p.modules || {}
  const other = Object.keys(mods).some(k => !PLACED.has(k))
  return [
    { id: 'tom-tat', title: 'Tóm tắt', show: true },
    { id: 'luan-diem', title: 'Luận điểm', show: !!p.decision },
    { id: 'dinh-gia', title: 'Định giá', show: !!p.valuation || !!mods.valuation_engine },
    ...CHAPTERS.map(c => ({ id: c.id, title: c.title, show: c.keys.some(k => mods[k]) })),
    { id: 'khac', title: 'Phân tích khác', show: other },
    { id: 'scorecard', title: 'Scorecard', show: !!p.scorecard },
    { id: 'rui-ro', title: 'Rủi ro', show: !!p.risk },
    { id: 'catalyst', title: 'Catalyst và theo dõi', show: !!p.catalysts?.length || !!p.monitoring?.length || !!mods.catalysts_expectations },
    { id: 'phan-bien', title: 'Phản biện', show: !!p.core10 || !!p.committee },
    { id: 'nguon', title: 'Nguồn', show: true }
  ].filter(s => s.show).map(({ id, title }) => ({ id, title }))
}

// Nội dung bài research; dùng chung cho trang đọc và các khung đọc song song.
function ResearchArticle({ data, criteria }) {
  const p = data.payload || {}
  const mods = p.modules || {}
  const otherKeys = Object.keys(mods).filter(k => !PLACED.has(k))
  return <article className="rl-article">
    <ReportSection id="tom-tat" title="Tóm tắt">
      {mods.executive_summary ? <div className="rl-summary">
        <ModuleBody m={mods.executive_summary} />
      </div> : <p className="rl-muted">Không có tóm tắt.</p>}
    </ReportSection>

    {p.decision && <ReportSection id="luan-diem" title="Luận điểm đầu tư">
      {mods.decision_monitoring?.analysis && <Prose text={mods.decision_monitoring.analysis} />}
      <ThesisBlock decision={p.decision} />
      {mods.decision_monitoring?.metrics?.length > 0 && <MetricsView metrics={mods.decision_monitoring.metrics} />}
      <Gaps items={mods.decision_monitoring?.gaps} />
    </ReportSection>}

    {(p.valuation || mods.valuation_engine) && <ReportSection id="dinh-gia" title="Định giá" kicker={`Đơn vị: ${p.valuation?.currency || 'VND'}/cổ phiếu`}>
      <ValuationBlock v={p.valuation} />
      {mods.valuation_engine && <div className="rl-sub">
        <h3 className="rl-sub-title">Mô hình định giá</h3>
        <ModuleBody m={mods.valuation_engine} />
      </div>}
    </ReportSection>}

    {CHAPTERS.map(c => c.keys.some(k => mods[k]) && <ReportSection id={c.id} title={c.title} key={c.id}>
      <Chapter modules={mods} keys={c.keys} />
    </ReportSection>)}

    {otherKeys.length > 0 && <ReportSection id="khac" title="Phân tích khác"><Chapter modules={mods} keys={otherKeys} /></ReportSection>}

    {p.scorecard && <ReportSection id="scorecard" title="Scorecard 15 tiêu chí"><ScorecardBlock scorecard={p.scorecard} criteria={criteria} /></ReportSection>}

    {p.risk && <ReportSection id="rui-ro" title="Rủi ro">
      {mods.scorecard_risk?.analysis && <Prose text={mods.scorecard_risk.analysis} />}
      <RiskBlock risk={p.risk} />
      {mods.scorecard_risk?.metrics?.length > 0 && <MetricsView metrics={mods.scorecard_risk.metrics} />}
    </ReportSection>}

    {(p.catalysts?.length > 0 || p.monitoring?.length > 0 || mods.catalysts_expectations) && <ReportSection id="catalyst" title="Catalyst và theo dõi">
      {mods.catalysts_expectations && <ModuleBody m={mods.catalysts_expectations} />}
      {p.catalysts?.length > 0 && <><h3 className="rl-sub-title">Sự kiện sắp tới</h3><CatalystBlock items={p.catalysts} /></>}
      {p.monitoring?.length > 0 && <><h3 className="rl-sub-title">Chỉ tiêu cần theo dõi</h3><MonitoringBlock items={p.monitoring} /></>}
    </ReportSection>}

    {(p.core10 || p.committee) && <ReportSection id="phan-bien" title="Phản biện">
      {p.core10 && <div className="rl-sub"><h3 className="rl-sub-title">10 câu hỏi cốt lõi</h3><OpinionList items={p.core10} numbered /></div>}
      {p.committee && <div className="rl-sub"><h3 className="rl-sub-title">Hội đồng đầu tư · 6 góc nhìn</h3><OpinionList items={p.committee} labels={COMMITTEE} /></div>}
    </ReportSection>}

    <ReportSection id="nguon" title="Nguồn tham khảo">
      <SourcesBlock sources={p.sources} />
      {p.metadata?.change_log?.length > 0 && <details className="rl-changelog"><summary>Lịch sử thay đổi (R{data.revision})</summary><BulletList items={p.metadata.change_log} /></details>}
      <div className="rl-meta">Công bố {dateText(data.published_at)} · R{data.revision} · Schema {data.schema_version} · SHA-256 <code>{data.sha256}</code></div>
    </ReportSection>
  </article>
}

const useSourceMap = data => useMemo(() => Object.fromEntries((data?.payload?.sources || []).map(s => [s.id, s])), [data])

function ResearchPage({ ticker, exchange }) {
  const report = useApi({ action: 'research', ticker, exchange }, [ticker, exchange])
  const crit = useApi({ action: 'criteria' }, [])
  const [size, setSize] = useReaderSize()
  const data = report.data
  const p = data?.payload || {}
  const sourceMap = useSourceMap(data)
  const title = data ? `${ticker} · ${data.company || ''}` : ticker
  useEffect(() => { document.title = `${title} · InvStock` }, [title])
  useEffect(() => { upsertTab(researchTab({ ticker, exchange }, data?.company)) }, [ticker, exchange, data?.company])

  const sections = useMemo(() => researchSections(data), [data])
  const active = useScrollSpy(sections.map(s => s.id), Boolean(data))
  const progress = useReadingProgress(researchHref({ ticker, exchange }), title, Boolean(data))

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
            <ResearchArticle data={data} criteria={crit.data?.criteria} />
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
  useEffect(() => { upsertTab({ path: screeningHref({ lineage_key: lineageKey }), kind: 'screening', title: 'Screening', sub: data?.strategy || '' }) }, [lineageKey, data?.strategy])
  useScrollMemory(screeningHref({ lineage_key: lineageKey }), Boolean(data))

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

/* ---------- So sánh 2–3 bài ---------- */

function parseCompare(search) {
  const raw = new URLSearchParams(search).get('items') || ''
  const seen = new Set()
  return raw.split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const [t, e] = x.split('.')
    return { ticker: String(t).toUpperCase(), exchange: String(e || 'HOSE').toUpperCase() }
  }).filter(x => /^[A-Z0-9]{2,10}$/.test(x.ticker) && /^[A-Z]{2,10}$/.test(x.exchange) && !seen.has(x.ticker + x.exchange) && seen.add(x.ticker + x.exchange)).slice(0, 3)
}

function useMany(items) {
  const key = items.map(i => `${i.ticker}.${i.exchange}`).join(',')
  const init = () => items.map(i => {
    const hit = cachedData({ action: 'research', ticker: i.ticker, exchange: i.exchange })
    return hit ? { data: hit, loading: false, error: '' } : { data: null, loading: true, error: '' }
  })
  const [state, setState] = useState(init)
  useEffect(() => {
    let active = true
    setState(init())
    items.forEach((i, n) => {
      fetchCached({ action: 'research', ticker: i.ticker, exchange: i.exchange })
        .then(data => { if (active) setState(s => s.map((x, k) => k === n ? { data, loading: false, error: '' } : x)) })
        .catch(err => { if (active) setState(s => s.map((x, k) => k === n ? { data: null, loading: false, error: err.message } : x)) })
    })
    return () => { active = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

// Hàng của bảng so sánh. best: 'max' tô đậm giá trị tốt nhất giữa các bài.
const COMPARE_ROWS = [
  { group: 'Kết luận' },
  { label: 'Quyết định', cell: d => <Badge map={DECISION} value={d.decision_status} code={false} /> },
  { label: 'Luận điểm', cell: d => <Badge map={THESIS} value={d.thesis_status || d.payload?.decision?.thesis_status} code={false} /> },
  { label: 'Cổng rủi ro', cell: d => <Badge map={GATE} value={d.risk_gate} code={false} /> },
  { label: 'Điểm scorecard', value: d => d.official_total ?? d.normalized_score, best: 'max',
    cell: d => <>{score(d.official_total ?? d.normalized_score)}<small className="rl-muted">/100{d.official_total == null && d.normalized_score != null ? ' · tạm' : ''}</small></> },
  { label: 'Coverage · tin cậy', cell: d => `${num(d.payload?.scorecard?.coverage ?? d.score_coverage, 0)}% · ${CONFIDENCE[d.payload?.scorecard?.confidence || d.score_confidence]?.vi || '—'}` },
  { group: 'Định giá' },
  { label: 'Giá thị trường', cell: d => <>{price(d.payload?.valuation?.price ?? d.price)}<small className="rl-muted"> · {dateText(d.payload?.valuation?.price_date ?? d.price_date)}</small></> },
  { label: 'Giá trị hợp lý', cell: d => price(d.payload?.valuation?.fair_value ?? d.fair_value) },
  { label: 'Biên an toàn (MOS)', value: d => d.payload?.valuation?.mos ?? d.mos, best: 'max',
    cell: d => { const v = d.payload?.valuation || {}; const m = v.mos ?? d.mos; const r = v.required_mos ?? d.required_mos
      return <><span className={isNum(m) && isNum(r) ? (m >= r ? 'good' : 'warn') : ''}>{pct(m)}</span><small className="rl-muted"> · yêu cầu {pct(r)}</small></> } },
  { label: 'Upside / downside', value: d => d.payload?.valuation?.upside ?? d.upside, best: 'max',
    cell: d => `${pct(d.payload?.valuation?.upside ?? d.upside)} / ${pct(d.payload?.valuation?.downside ?? d.downside)}` },
  { label: 'Reward / risk', value: d => d.payload?.valuation?.reward_risk ?? d.reward_risk, best: 'max', cell: d => num(d.payload?.valuation?.reward_risk ?? d.reward_risk) },
  { label: 'Giá mua tối đa', cell: d => price(d.payload?.valuation?.max_buy ?? d.max_buy) },
  { group: 'Dữ liệu' },
  { label: 'Ngành', cell: d => d.sector || '—' },
  { label: 'Kỳ báo cáo', cell: d => d.reporting_period || '—' },
  { label: 'Dữ liệu đến', cell: d => `${dateText(d.cutoff)} · R${d.revision}` }
]

function CompareTable({ items, results }) {
  const cols = items.map((it, i) => ({ it, ...results[i] }))
  return <div className="rl-table-wrap rl-cmp-wrap"><table className="rl-table rl-cmp-table" style={{ '--cols': cols.length }}>
    <thead><tr><th className="rl-cmp-label" />
      {cols.map(({ it, data }) => <th key={it.ticker + it.exchange} scope="col">
        <a href={researchHref(it)} className="rl-cmp-head" title="Mở bài đầy đủ">
          <b>{it.ticker}</b><span>{data?.company || it.exchange}</span>
        </a>
      </th>)}
    </tr></thead>
    <tbody>{COMPARE_ROWS.map((r, ri) => {
      if (r.group) return <tr key={ri} className="rl-cmp-group"><th colSpan={cols.length + 1}>{r.group}</th></tr>
      const vals = r.best ? cols.map(c => (c.data ? r.value(c.data) : null)) : []
      const nums = vals.filter(isNum)
      const top = nums.length > 1 ? Math.max(...nums) : null
      return <tr key={ri}>
        <th scope="row" className="rl-cmp-label">{r.label}</th>
        {cols.map((c, ci) => <td key={ci} className={top !== null && vals[ci] === top ? 'rl-cmp-best' : ''}>
          {c.loading ? <span className="rl-muted">…</span> : c.error ? <span className="rl-muted">Không tải được</span> : r.cell(c.data)}
        </td>)}
      </tr>
    })}</tbody>
  </table></div>
}

function sectionTop(pane, el) {
  return el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 6
}

function ComparePane({ index, item, result, criteria, sectionsRef, onSection }) {
  const paneRef = useRef(null)
  const prefix = `p${index}-`
  const data = result.data
  const sections = useMemo(() => researchSections(data), [data])
  const sourceMap = useSourceMap(data)
  const [active, setActive] = useState('')
  useEffect(() => {
    sectionsRef.current[index] = id => {
      const pane = paneRef.current
      const el = pane?.querySelector(`#${prefix}${id}`)
      if (pane && el) pane.scrollTo({ top: sectionTop(pane, el), behavior: 'smooth' })
    }
  })
  useEffect(() => {
    const pane = paneRef.current
    if (!pane || !data) return
    let frame = 0
    const on = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        let cur = sections[0]?.id || ''
        for (const s of sections) {
          const el = pane.querySelector(`#${prefix}${s.id}`)
          if (el && sectionTop(pane, el) <= pane.scrollTop + 40) cur = s.id
        }
        setActive(cur)
      })
    }
    on()
    pane.addEventListener('scroll', on, { passive: true })
    return () => { cancelAnimationFrame(frame); pane.removeEventListener('scroll', on) }
  }, [data, sections, prefix])
  // Liên kết nguồn [S1] cuộn trong khung thay vì nhảy cả trang.
  const onClick = e => {
    const a = e.target.closest?.('a[href^="#"]')
    if (!a || !paneRef.current) return
    const el = paneRef.current.querySelector(`#${CSS.escape(decodeURIComponent(a.getAttribute('href').slice(1)))}`)
    if (!el) return
    e.preventDefault()
    paneRef.current.scrollTo({ top: sectionTop(paneRef.current, el), behavior: 'smooth' })
  }
  return <section className="rl-pane" aria-label={`Bài ${item.ticker}`}>
    <header className="rl-pane-head">
      <a href={researchHref(item)} className="rl-pane-title" title="Mở bài đầy đủ"><b>{item.ticker}</b><span>{data?.company || item.exchange}</span></a>
      {sections.length > 0 && <label className="rl-select sm"><span className="rl-sr">Đi tới mục</span>
        <select value={active} onChange={e => onSection(index, e.target.value)}>
          {sections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select></label>}
    </header>
    <div className="rl-pane-body" ref={paneRef} onClick={onClick}>
      {result.loading && <Skeleton rows={6} />}
      {result.error && <Empty tone="error">Không mở được {item.ticker} ({result.error}).</Empty>}
      {data && <IdPrefix.Provider value={prefix}><SourcesContext.Provider value={sourceMap}>
        <ResearchArticle data={data} criteria={criteria} />
      </SourcesContext.Provider></IdPrefix.Provider>}
    </div>
  </section>
}

function ComparePage({ search }) {
  const items = useMemo(() => parseCompare(search), [search])
  const results = useMany(items)
  const crit = useApi({ action: 'criteria' }, [])
  const { tabs } = useTabs()
  const [size, setSize] = useReaderSize()
  const [sync, setSync] = useState(true)
  const [mobilePane, setMobilePane] = useState(0)
  const sectionsRef = useRef([])
  const research = tabs.filter(t => t.kind === 'research' && t.ticker)
  const chosen = new Set(items.map(i => `${i.ticker}.${i.exchange}`))
  const pool = [...items, ...research.filter(t => !chosen.has(`${t.ticker}.${t.exchange}`))]
  useEffect(() => { document.title = `So sánh ${items.map(i => i.ticker).join(' · ')} · InvStock` }, [items])
  useEffect(() => { patchTabs({ last: currentPath() }) }, [search])
  useScrollMemory('/compare', results.every(r => !r.loading))
  sectionsRef.current.length = items.length
  useEffect(() => { if (mobilePane >= items.length) setMobilePane(0) }, [items.length, mobilePane])

  const toggle = it => {
    const k = `${it.ticker}.${it.exchange}`
    const next = chosen.has(k) ? items.filter(i => `${i.ticker}.${i.exchange}` !== k) : [...items, { ticker: it.ticker, exchange: it.exchange }].slice(-3)
    navigate(compareHref(next), { replace: true })
  }
  const onSection = (from, id) => {
    sectionsRef.current.forEach((go, i) => { if (go && (sync || i === from)) go(id) })
  }
  const common = useMemo(() => {
    const lists = results.map(r => researchSections(r.data)).filter(l => l.length)
    return lists[0] || []
  }, [results])

  return <div className="rl rl-reader rl-compare" style={{ '--reader-scale': size, '--panes': Math.max(items.length, 1) }}>
    <TopBar>
      <div className="rl-topbar-title"><b>So sánh</b><span>{items.map(i => i.ticker).join(' · ') || 'Chọn bài'}</span></div>
      <SizeControl size={size} setSize={setSize} />
    </TopBar>
    <main className="rl-main rl-wide">
      <section className="rl-cmp-intro">
        <div>
          <h1>So sánh báo cáo</h1>
          <p className="rl-muted">Chọn 2–3 bài đang mở. Bấm tên mã để mở bài đầy đủ trong tab.</p>
        </div>
        <div className="rl-chips" role="group" aria-label="Bài đưa vào so sánh">
          {pool.map(t => {
            const k = `${t.ticker}.${t.exchange}`
            return <button key={k} className={chosen.has(k) ? 'active' : ''} aria-pressed={chosen.has(k)} onClick={() => toggle(t)}>
              {chosen.has(k) ? '✓ ' : '+ '}{t.ticker}
            </button>
          })}
          {!pool.length && <span className="rl-muted">Chưa có bài nào đang mở. Về Thư viện và bấm “+ Mở tab” ở 2–3 bài.</span>}
        </div>
      </section>

      {items.length > 0 && <CompareTable items={items} results={results} />}
      {items.length === 1 && <Empty>Chọn thêm ít nhất 1 bài để so sánh.</Empty>}

      {items.length > 0 && <>
        <div className="rl-cmp-toolbar">
          <h2>Đọc song song</h2>
          {common.length > 0 && <label className="rl-select"><span>Mở cùng mục</span>
            <select defaultValue="" onChange={e => { if (e.target.value) { onSection(-1, e.target.value); e.target.value = '' } }}>
              <option value="" disabled>Chọn mục…</option>
              {common.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select></label>}
          {items.length > 1 && <label className="rl-check"><input type="checkbox" checked={sync} onChange={e => setSync(e.target.checked)} /> Đổi mục ở một khung thì các khung khác đi theo</label>}
          {items.length > 1 && <div className="rl-pane-switch" role="tablist" aria-label="Chọn bài">
            {items.map((it, i) => <button key={i} role="tab" aria-selected={mobilePane === i} className={mobilePane === i ? 'active' : ''} onClick={() => setMobilePane(i)}>{it.ticker}</button>)}
          </div>}
        </div>
        <div className="rl-panes">
          {items.map((it, i) => <div key={`${it.ticker}.${it.exchange}`} className={`rl-pane-slot ${mobilePane === i ? 'mobile-active' : ''}`}>
            <ComparePane index={i} item={it} result={results[i] || { loading: true }} criteria={crit.data?.criteria} sectionsRef={sectionsRef} onSection={onSection} />
          </div>)}
        </div>
      </>}
    </main>
    <Footer />
  </div>
}

/* ---------- Bộ định tuyến ---------- */

export default function PublicLibrary() {
  const loc = useLocationPath()
  useLinkInterceptor()
  useScrollSaver()
  const url = new URL(loc, window.location.origin)
  const path = url.pathname.split('/').filter(Boolean)
  const exchange = (url.searchParams.get('exchange') || 'HOSE').toUpperCase()
  const ticker = path[0] === 'research' && path[1] ? decodeURIComponent(path[1]).toUpperCase() : ''
  // Chuẩn hóa địa chỉ bài để tab nhận ra cùng một bài (ví dụ /research/fpt → /research/FPT?exchange=HOSE).
  const canonical = ticker ? researchHref({ ticker, exchange }) : ''
  useEffect(() => { if (canonical && canonical !== loc) navigate(canonical + window.location.hash, { replace: true }) }, [canonical, loc])
  useEffect(() => { if (path[0] !== 'compare' && path.length) patchTabs({ last: loc }) }, [loc]) // eslint-disable-line react-hooks/exhaustive-deps
  if (ticker) return <ResearchPage key={canonical} ticker={ticker} exchange={exchange} />
  if (path[0] === 'screening' && path[1]) return <ScreeningPage key={loc} lineageKey={decodeURIComponent(path[1])} />
  if (path[0] === 'compare') return <ComparePage search={url.search} />
  return <Home key={loc} />
}
