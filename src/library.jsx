import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './style.css'
import { supabase, SUPABASE_URL, SUPABASE_KEY } from './supabaseClient.js'
import { GlossaryProvider, GlossaryScope, GlossaryPage, Term } from './glossary.jsx'

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

function Badge({ map, value, code = false, className = '' }) {
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
  return <div className="rl-gaps"><strong>{title}</strong><ul>{items.map((g, i) => <li key={i}><Term>{g}</Term></li>)}</ul></div>
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
      <nav className="rl-topbar-nav"><a href="/thuat-ngu">Thuật ngữ</a><a href="/admin">Admin</a></nav>
    </div>
    <TabStrip />
    {progress !== undefined && <div className="rl-progress" style={{ transform: `scaleX(${progress})` }} />}
  </header>
}

const HomeIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 12 5l8 6.5" /><path d="M6.5 10v9h11v-9" /></svg>

// Hàng tab: Thư viện luôn ở đầu, sau đó là các bài đang mở. Đóng tab không xóa bài, chỉ bỏ khỏi hàng.
// Tab hồ sơ (Tổng quan / Lịch sử…) vẫn thuộc cùng một tab bài đang mở.
const withoutProfileTab = path => path.replace(/&tab=[a-z-]+/, '').replace(/&so-sanh=[0-9-]+/, '')

function TabStrip() {
  const { tabs, home } = useTabs()
  const here = withoutProfileTab(currentPath())
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

// Độ tươi dữ liệu theo ngày cutoff: quá 1 quý thì nhắc, quá 2 quý thì cần cập nhật. Vừa công bố trong 14 ngày thì báo mới.
const DAY = 86400000
function freshness(item) {
  const age = item.cutoff ? (Date.now() - new Date(item.cutoff).getTime()) / DAY : null
  const sincePub = item.published_at ? (Date.now() - new Date(item.published_at).getTime()) / DAY : null
  if (isNum(age) && age > 190) return { tone: 'orange', vi: 'Cần cập nhật', tip: `Dữ liệu đã ${Math.round(age)} ngày, quá 2 quý báo cáo` }
  if (isNum(age) && age > 100) return { tone: 'amber', vi: 'Dữ liệu hơn 1 quý', tip: `Dữ liệu đã ${Math.round(age)} ngày` }
  if (isNum(sincePub) && sincePub <= 14) return { tone: 'blue', vi: item.previous ? 'Mới cập nhật' : 'Mới công bố', tip: `Công bố ${dateText(item.published_at)}` }
  return null
}
function FreshTag({ item }) {
  const f = freshness(item)
  return f ? <span className={`rl-badge tone-${f.tone} rl-fresh`} title={f.tip}>{f.vi}</span> : null
}
// Mũi tên thay đổi so với bản liền trước (list trả kèm previous khi mã đã có bản lịch sử).
function Delta({ item, value, kind = 'rel' }) {
  const prev = item.previous
  if (!prev) return null
  const a = value(prev), b = value(item)
  if (!isNum(a) || !isNum(b) || a === b) return null
  const up = b > a
  const text = kind === 'rel' ? `${up ? '+' : ''}${((b / a - 1) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`
    : kind === 'pp' ? `${up ? '+' : ''}${((b - a) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} đ%`
    : `${up ? '+' : ''}${(b - a).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}`
  return <small className={`rl-delta ${up ? 'up' : 'down'}`} title={`So với R${prev.revision}`}>{up ? '▲' : '▼'} {text}</small>
}
const scoreOf = d => d.official_total ?? d.normalized_score
function CardChange({ item }) {
  const prev = item.previous
  if (!prev) return null
  const parts = []
  if (prev.decision_status !== item.decision_status) parts.push(<span key="d">kết luận <Badge map={DECISION} value={prev.decision_status} /> → <Badge map={DECISION} value={item.decision_status} /></span>)
  if (prev.risk_gate !== item.risk_gate) parts.push(<span key="g">mức rủi ro <Badge map={GATE} value={prev.risk_gate} /> → <Badge map={GATE} value={item.risk_gate} /></span>)
  if (isNum(scoreOf(prev)) && isNum(scoreOf(item)) && scoreOf(prev) !== scoreOf(item)) parts.push(<span key="s">điểm <Delta item={item} value={scoreOf} kind="abs" /></span>)
  return <div className="rl-card-change">So với R{prev.revision}: {parts.length ? parts : <span className="rl-muted">kết luận và điểm giữ nguyên</span>}</div>
}

function ScoreMeter({ value, provisional }) {
  const v = isNum(value) ? Math.max(0, Math.min(100, value)) : null
  return <div className="rl-meter" title={provisional ? 'Điểm tạm: chưa đủ coverage để thành điểm chính thức' : 'Điểm chính thức'}>
    <div className="rl-meter-top"><span>Điểm chất lượng</span><b>{score(value)}<small>/100</small>{provisional && v !== null && <em>tạm</em>}</b></div>
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
    <CardChange item={item} />
    <dl className="rl-card-facts">
      <div><dt title={KF.value.what}>Giá trị ước tính</dt><dd>{price(item.fair_value)}<Delta item={item} value={d => d.fair_value} /></dd></div>
      <div><dt title={KF.mos.what}>Biên an toàn</dt><dd className={isNum(item.mos) && isNum(item.required_mos) && item.mos >= item.required_mos ? 'good' : ''}>{pct(item.mos)}</dd></div>
      <div><dt title={KF.risk.what}>Mức rủi ro</dt><dd><Badge map={GATE} value={item.risk_gate} code={false} /></dd></div>
    </dl>
    <div className="rl-card-foot">
      <span>Dữ liệu đến {dateText(item.cutoff)} · R{item.revision}{item.visibility === 'members' ? ' · Thành viên' : ''} <FreshTag item={item} /></span>
      <span className="rl-card-actions"><OpenTabButton item={item} /><span className="rl-card-cta">Đọc →</span></span>
    </div>
  </a>
}

function ResearchTable({ items }) {
  return <div className="rl-table-wrap"><table className="rl-table rl-table-list">
    <thead><tr><th>Mã</th><th>Công ty</th><th title={KF.decision.what}>Kết luận</th><th title={KF.risk.what}>Mức rủi ro</th><th className="num" title={KF.score.what}>Điểm</th><th className="num" title={KF.value.what}>Giá trị ước tính</th><th className="num" title={KF.mos.what}>Biên an toàn</th><th>Dữ liệu đến</th><th><span className="rl-sr">Mở tab</span></th></tr></thead>
    <tbody>{items.map(item => <tr key={item.lineage_key} onClick={() => navigate(researchHref(item))}>
      <td><a href={researchHref(item)} className="rl-strong">{item.ticker}</a><small className="rl-muted"> {item.exchange}</small></td>
      <td>{item.company}<div className="rl-muted rl-small">{item.sector}</div></td>
      <td><Badge map={DECISION} value={item.decision_status} code={false} /></td>
      <td><Badge map={GATE} value={item.risk_gate} code={false} /></td>
      <td className="num">{score(item.official_total ?? item.normalized_score)}{item.official_total == null && item.normalized_score != null && <small className="rl-muted"> tạm</small>}<Delta item={item} value={scoreOf} kind="abs" /></td>
      <td className="num">{price(item.fair_value)}<Delta item={item} value={d => d.fair_value} /></td>
      <td className="num">{pct(item.mos)}</td>
      <td>{dateText(item.cutoff)} <small className="rl-muted">R{item.revision}</small><FreshTag item={item} /></td>
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
          {options.decisions.length > 0 && <div className="rl-chips" role="group" aria-label="Lọc theo kết luận">
            <button className={!f.decision ? 'active' : ''} onClick={() => set({ decision: '' })}>Tất cả</button>
            {options.decisions.map(d => <button key={d} className={f.decision === d ? `active tone-${DECISION[d].tone}` : ''} onClick={() => set({ decision: f.decision === d ? '' : d })}>{DECISION[d].vi}</button>)}
          </div>}
          <div className="rl-filter-row">
            {options.sectors.length > 1 && <label className="rl-select"><span>Ngành</span>
              <select value={f.sector} onChange={e => set({ sector: e.target.value })}><option value="">Tất cả</option>{options.sectors.map(s => <option key={s}>{s}</option>)}</select></label>}
            {options.gates.length > 0 && <label className="rl-select"><span>Mức rủi ro</span>
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

function ReportSection({ id, title, kicker, blocks, children }) {
  const prefix = useContext(IdPrefix)
  return <section className="rl-section" id={prefix + id}>
    {kicker && <div className="rl-kicker">{kicker}</div>}
    <h2>{title}{blocks && <BlockTag paths={blocks} />}</h2>
    {children}
  </section>
}

// Mã trạng thái tiếng Anh viết trong văn bản (WATCH, RESTRICTED…) được đọc thành nhãn tiếng Việt.
// Chỉ thay đúng mã viết hoa đứng riêng; nội dung gốc trong JSON không đổi.
const CODE_VI = Object.fromEntries([DECISION, GATE, THESIS].flatMap(m => Object.entries(m).map(([k, v]) => [k, v.vi])))
const CODE_RE = new RegExp(`(?<![A-Za-z0-9_-])(${Object.keys(CODE_VI).sort((a, b) => b.length - a.length).map(k => k.replace(/[/]/g, '\\/')).join('|')})(?![A-Za-z0-9_-])`, 'g')
const viCodes = text => typeof text === 'string' ? text.replace(CODE_RE, m => CODE_VI[m]) : text

function Prose({ text }) {
  if (!text) return null
  return <div className="rl-prose">{viCodes(String(text)).split(/\n{2,}/).map((p, i) => <p key={i}><Term>{p}</Term></p>)}</div>
}

function BulletList({ items, tone = '' }) {
  if (!items?.length) return <p className="rl-muted">Không có.</p>
  return <ul className={`rl-bullets ${tone}`}>{items.map((x, i) => <li key={i}><Term>{viCodes(x)}</Term></li>)}</ul>
}

/* ---------- Các khối của Full Research ---------- */

// Ô giải thích thuật ngữ: rê chuột (hoặc focus bằng bàn phím) để xem nhanh, bấm để ghim mở; Esc hoặc bấm ra ngoài để đóng.
function InfoTip({ label, children }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = e => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const onKey = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  return <span className={`rl-info ${open ? 'open' : ''}`} ref={ref}>
    <button type="button" className="rl-info-btn" aria-expanded={open} aria-label={`Giải thích: ${label}`}
      onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(!open) }}>?</button>
    <span className="rl-info-pop" role="tooltip">{children}</span>
  </span>
}

// Tên dễ hiểu cho 5 chỉ số đầu bài, kèm giải thích; thuật ngữ gốc của khung phân tích vẫn ghi ở cuối mỗi giải thích.
const KF = {
  decision: { label: 'Kết luận', term: 'Quyết định (Decision)',
    what: 'Hành động mà bài nghiên cứu đề xuất với cổ phiếu này ở thời điểm đánh giá.',
    how: 'Theo dõi: quan sát, chưa mua thêm. Tích lũy: có thể mua dần khi giá phù hợp. Nắm giữ: giữ nếu đang có. Chốt lời: cân nhắc bán bớt. Thoát / đánh giá lại: luận điểm không còn đúng.' },
  risk: { label: 'Mức rủi ro', term: 'Cổng rủi ro (Risk Gate)',
    what: 'Bộ lọc an toàn đứng trước kết luận: dù định giá hấp dẫn, rủi ro chưa qua cổng thì vẫn không nâng kết luận lên mua.',
    how: 'Đạt: không có rủi ro chặn. Thận trọng: có rủi ro cần theo dõi. Hạn chế: còn điểm trọng yếu chưa xác minh, chưa mua thêm. Bị chặn: rủi ro nghiêm trọng.' },
  score: { label: 'Điểm chất lượng', term: 'Scorecard 15 tiêu chí',
    what: 'Điểm tổng hợp từ 15 tiêu chí về kinh doanh, tài chính, quản trị, định giá và thời điểm, thang 0–100.',
    how: 'Điểm "tạm" khi dữ liệu chưa đủ để chấm chính thức. Độ phủ dữ liệu cho biết bao nhiêu phần trăm tiêu chí có bằng chứng; độ phủ thấp thì điểm kém chắc chắn.' },
  value: { label: 'Giá trị ước tính', term: 'Giá trị hợp lý (Fair Value)',
    what: 'Giá trị một cổ phiếu theo mô hình định giá của bài (VND/cổ phiếu), không phải giá mục tiêu ngắn hạn.',
    how: 'So với giá tham chiếu: giá thấp hơn giá trị ước tính càng nhiều thì càng có dư địa. Xem mục Định giá để biết phương pháp và các kịch bản.' },
  mos: { label: 'Biên an toàn', term: 'Margin of Safety (MOS)',
    what: 'Phần giá đang thấp hơn giá trị ước tính, tính bằng 1 − giá ÷ giá trị ước tính.',
    how: 'Khung phân tích chỉ xem xét mua khi biên an toàn đạt mức tối thiểu (ví dụ 35%), để chừa chỗ cho sai số của mô hình. "Giá mua tối đa" là mức giá để đạt đúng mức tối thiểu đó.' }
}
const DECISION_PLAIN = { WATCH: 'Quan sát, chưa mua thêm', ACCUMULATE: 'Có thể mua dần', HOLD: 'Giữ nếu đang có, không mua thêm',
  'TAKE PROFIT': 'Cân nhắc bán bớt', 'EXIT/RE-EVALUATE': 'Thoát hoặc đánh giá lại' }
const GATE_PLAIN = { PASS: 'Không có rủi ro chặn quyết định', CAUTION: 'Có rủi ro cần theo dõi', RESTRICTED: 'Chưa mua thêm cho tới khi xác minh xong', BLOCKED: 'Rủi ro nghiêm trọng, không xem xét mua' }

function KfLabel({ k }) {
  const d = KF[k]
  return <span className="rl-kf-label">{d.label}<InfoTip label={d.label}>
    <b>{d.label}</b>{d.what}<span className="rl-info-how">{d.how}</span><small>Thuật ngữ gốc: {d.term}</small>
  </InfoTip></span>
}

function KeyFacts({ data, p }) {
  const v = p.valuation || {}
  const sc = p.scorecard || {}
  const provisional = data.official_total == null
  const fv = v.fair_value ?? data.fair_value, px = v.price ?? data.price
  const mos = v.mos ?? data.mos, req = v.required_mos ?? data.required_mos
  const mosOk = isNum(mos) && isNum(req) && mos >= req
  const gaps = p.risk?.critical_gaps?.length || 0
  const thesis = data.thesis_status || p.decision?.thesis_status
  return <div className="rl-keyfacts">
    <div className="rl-kf">
      <KfLabel k="decision" />
      <Badge map={DECISION} value={data.decision_status} className="lg" />
      <small>{DECISION_PLAIN[data.decision_status] || '—'}{thesis ? <> · luận điểm <span className={`rl-tone-text tone-${THESIS[thesis]?.tone || 'gray'}`}>{(THESIS[thesis]?.vi || thesis).toLowerCase()}</span></> : null}</small>
    </div>
    <div className="rl-kf">
      <KfLabel k="risk" />
      <Badge map={GATE} value={data.risk_gate} className="lg" />
      <small>{gaps ? `${gaps} điểm trọng yếu cần xác minh` : GATE_PLAIN[data.risk_gate] || '—'}</small>
    </div>
    <div className="rl-kf">
      <KfLabel k="score" />
      <strong>{score(data.official_total ?? data.normalized_score)}<small>/100</small>{provisional && <em className="rl-kf-tag">tạm</em>}</strong>
      <small>Dựa trên {num(sc.coverage ?? data.score_coverage, 0)}% dữ liệu cần có · độ tin cậy {(CONFIDENCE[sc.confidence || data.score_confidence]?.vi || '—').toLowerCase()}</small>
    </div>
    <div className="rl-kf">
      <KfLabel k="value" />
      <strong>{price(fv)}<small> đ</small></strong>
      <small>{isNum(px) ? `Giá tham chiếu ${price(px)} (${dateText(v.price_date ?? data.price_date)})` : 'Chưa có giá tham chiếu'}</small>
    </div>
    <div className="rl-kf">
      <KfLabel k="mos" />
      <strong className={isNum(mos) ? (mosOk ? 'good' : 'warn') : ''}>{pct(mos)}</strong>
      {isNum(mos) && isNum(req) && <div className="rl-kf-bar" title={`Biên an toàn ${pct(mos)} / yêu cầu ${pct(req)}`}>
        <i style={{ width: `${Math.max(0, Math.min(100, (mos / req) * 100))}%` }} className={mosOk ? 'ok' : ''} /></div>}
      <small>{isNum(mos) && isNum(req)
        ? (mosOk ? `Đạt mức tối thiểu ${pct(req)}` : `Cần tối thiểu ${pct(req)}${isNum(v.max_buy ?? data.max_buy) ? `, tức giá ≤ ${price(v.max_buy ?? data.max_buy)}` : ''}`)
        : 'Chưa đủ căn cứ để tính'}</small>
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
      {decision.investment_type && <div><dt>Loại cơ hội</dt><dd><Term>{decision.investment_type}</Term></dd></div>}
      {decision.horizon && <div><dt>Khung thời gian</dt><dd><Term>{decision.horizon}</Term></dd></div>}
      {decision.position_context && <div><dt>Bối cảnh vị thế</dt><dd><Term>{decision.position_context}</Term></dd></div>}
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
        {s.method && !sameMethod && <p className="rl-note"><Term>{s.method}</Term> <Refs ids={s.source_ids} /></p>}
      </div>)}
    </div>
    {sameMethod && <p className="rl-note"><b>Phương pháp các kịch bản:</b> <Term>{scen[0].method}</Term> <Refs ids={[...new Set(scen.flatMap(s => s.source_ids || []))]} /></p>}
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
      <div><span>Độ phủ dữ liệu</span><b>{num(scorecard.coverage, 0)}%</b></div>
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
            <p><Term>{r.rationale || '—'}</Term> <Refs ids={r.source_ids} /></p>
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
    <div className="rl-gate-line">Mức rủi ro: <Badge map={GATE} value={risk.gate} className="lg" /></div>
    {risk.critical_gaps?.length > 0 && <Gaps items={risk.critical_gaps} title="Điểm trọng yếu chưa xác minh" />}
    <div className="rl-risks">
      {(risk.items || []).map((r, i) => <div className="rl-risk" key={i}>
        <div className="rl-risk-head">
          <h3><Term>{r.description}</Term></h3>
          <div className="rl-risk-tags">
            <span>Khả năng <Badge map={LEVEL} value={r.likelihood} code={false} /></span>
            <span>Tác động <Badge map={LEVEL} value={r.impact} code={false} /></span>
          </div>
        </div>
        <p><span className="rl-muted">Cách theo dõi / giảm thiểu:</span> <Term>{r.mitigation}</Term> <Refs ids={r.source_ids} /></p>
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
    {sharedImpact && <p className="rl-note"><b>Tác động chung đến quyết định:</b> <Term>{sharedImpact}</Term></p>}
    <ol className={`rl-qa ${numbered ? 'numbered' : 'labelled'}`}>{entries.map(([key, x], i) => <li key={key}>
      <div className="rl-qa-row">
        <span className="rl-qa-key">{numbered ? String(i + 1).padStart(2, '0') : (labels?.[key] || titleCase(key))}</span>
        <span className="rl-qa-title"><Term>{x.conclusion}</Term></span>
        <Badge map={CONFIDENCE} value={x.confidence} code={false} className="sm" />
      </div>
      <div className="rl-qa-body">
        <div className="rl-qa-evidence"><Term>{x.evidence}</Term> <Refs ids={x.source_ids} /></div>
        {x.decision_impact && !sharedImpact && <div className="rl-qa-extra"><span>Tác động:</span> <Term>{x.decision_impact}</Term></div>}
        {x.gaps?.length > 0 && <div className="rl-qa-extra"><span>Còn thiếu:</span> <Term>{x.gaps.join('; ')}</Term></div>}
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
        <th scope="row"><Term>{r.name}</Term>{unitLabel(r.unit) && <small>{r.unit}</small>}</th>
        {periods.map(p => { const m = r.byPeriod.get(p); return <td key={p} className="num">{m ? <MetricCell m={m} /> : ''}</td> })}
      </tr>)}</tbody>
    </table></div>
  </div>
}

function MetricTiles({ metrics }) {
  return <div className="rl-tiles">{metrics.map((m, i) => <div className="rl-tile" key={i}>
    <span className="rl-tile-name"><Term>{m.name}</Term></span>
    <span className="rl-tile-value"><MetricCell m={m} />{isNum(m.value) && unitLabel(m.unit) && <small>{m.unit}</small>}</span>
    <span className="rl-tile-period">{m.period}{m.verification === 'UNVERIFIED' ? ' · chưa xác minh' : ''}</span>
  </div>)}</div>
}

function MetricsDetail({ metrics }) {
  return <div className="rl-table-wrap"><table className="rl-table rl-flat">
    <thead><tr><th>Chỉ tiêu</th><th>Kỳ</th><th className="num">Giá trị</th><th>Loại</th><th>Nguồn</th></tr></thead>
    <tbody>{metrics.map((m, i) => <tr key={i}>
      <th scope="row"><Term>{m.name}</Term>{m.method && <small>{m.method}</small>}{m.missing_reason && <small>Thiếu: {m.missing_reason}</small>}</th>
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
    {present.length > 1 ? <h3 className="rl-sub-title">{MODULES[k] || titleCase(k)}<BlockTag paths={[`/modules/${k}`]} /></h3>
      : <BlockTag paths={[`/modules/${k}`]} standalone />}
    <ModuleBody m={modules[k]} />
  </div>)
}

function CatalystBlock({ items }) {
  if (!items?.length) return <p className="rl-muted">Không có catalyst.</p>
  return <ol className="rl-publine">{items.map((c, i) => <li key={i}>
    <div className="rl-timeline-when">{c.window}</div>
    <div className="rl-timeline-body">
      <h3><Term>{c.event}</Term> <Refs ids={c.source_ids} /></h3>
      <dl className="rl-deflist compact">
        <div><dt>Điều kiện</dt><dd><Term>{c.condition}</Term></dd></div>
        <div><dt>Nếu xảy ra</dt><dd><Term>{c.impact}</Term></dd></div>
        <div><dt>Nếu không</dt><dd><Term>{c.failure_effect}</Term></dd></div>
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
      <th scope="row" data-label="Chỉ tiêu"><Term>{m.metric}</Term></th><td data-label="Ngưỡng"><Term>{m.threshold}</Term></td><td data-label="Hành động"><Term>{m.action}</Term></td><td data-label="Xem lại">{dateText(m.review_date)}</td>
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

function ReportHeader({ kicker, title, sub, chips, back }) {
  return <section className="rl-report-head">
    {back || <a className="rl-back" href="/">← Thư viện</a>}
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
  return <GlossaryScope sector={data.sector}><article className="rl-article">
    <ReportSection id="tom-tat" title="Tóm tắt" blocks={['/modules/executive_summary']}>
      {mods.executive_summary ? <div className="rl-summary">
        <ModuleBody m={mods.executive_summary} />
      </div> : <p className="rl-muted">Không có tóm tắt.</p>}
    </ReportSection>

    {p.decision && <ReportSection id="luan-diem" title="Luận điểm đầu tư" blocks={['/decision', '/modules/decision_monitoring']}>
      {mods.decision_monitoring?.analysis && <Prose text={mods.decision_monitoring.analysis} />}
      <ThesisBlock decision={p.decision} />
      {mods.decision_monitoring?.metrics?.length > 0 && <MetricsView metrics={mods.decision_monitoring.metrics} />}
      <Gaps items={mods.decision_monitoring?.gaps} />
    </ReportSection>}

    {(p.valuation || mods.valuation_engine) && <ReportSection id="dinh-gia" title="Định giá" blocks={['/valuation', '/modules/valuation_engine']} kicker={`Đơn vị: ${p.valuation?.currency || 'VND'}/cổ phiếu`}>
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

    {p.scorecard && <ReportSection id="scorecard" title="Scorecard 15 tiêu chí" blocks={['/scorecard']}><ScorecardBlock scorecard={p.scorecard} criteria={criteria} /></ReportSection>}

    {p.risk && <ReportSection id="rui-ro" title="Rủi ro" blocks={['/risk', '/modules/scorecard_risk']}>
      {mods.scorecard_risk?.analysis && <Prose text={mods.scorecard_risk.analysis} />}
      <RiskBlock risk={p.risk} />
      {mods.scorecard_risk?.metrics?.length > 0 && <MetricsView metrics={mods.scorecard_risk.metrics} />}
    </ReportSection>}

    {(p.catalysts?.length > 0 || p.monitoring?.length > 0 || mods.catalysts_expectations) && <ReportSection id="catalyst" title="Catalyst và theo dõi" blocks={['/catalysts', '/monitoring', '/modules/catalysts_expectations']}>
      {mods.catalysts_expectations && <ModuleBody m={mods.catalysts_expectations} />}
      {p.catalysts?.length > 0 && <><h3 className="rl-sub-title">Sự kiện sắp tới</h3><CatalystBlock items={p.catalysts} /></>}
      {p.monitoring?.length > 0 && <><h3 className="rl-sub-title">Chỉ tiêu cần theo dõi</h3><MonitoringBlock items={p.monitoring} /></>}
    </ReportSection>}

    {(p.core10 || p.committee) && <ReportSection id="phan-bien" title="Phản biện" blocks={['/core10', '/committee']}>
      {p.core10 && <div className="rl-sub"><h3 className="rl-sub-title">10 câu hỏi cốt lõi</h3><OpinionList items={p.core10} numbered /></div>}
      {p.committee && <div className="rl-sub"><h3 className="rl-sub-title">Hội đồng đầu tư · 6 góc nhìn</h3><OpinionList items={p.committee} labels={COMMITTEE} /></div>}
    </ReportSection>}

    <ReportSection id="nguon" title="Nguồn tham khảo">
      <SourcesBlock sources={p.sources} />
      {p.metadata?.change_log?.length > 0 && <details className="rl-changelog"><summary>Lịch sử thay đổi (R{data.revision})</summary><BulletList items={p.metadata.change_log} /></details>}
      <div className="rl-meta">Công bố {dateText(data.published_at)} · R{data.revision} · Schema {data.schema_version} · SHA-256 <code>{data.sha256}</code></div>
    </ReportSection>
  </article></GlossaryScope>
}

const useSourceMap = data => useMemo(() => Object.fromEntries((data?.payload?.sources || []).map(s => [s.id, s])), [data])

/* ---------- Khối nội dung (tài liệu 13, giai đoạn 2: đọc trực tiếp 14 module và cấu phần top-level) ---------- */

// Danh mục khối theo key của schema 02. Chưa có registry/manifest chính thức: trạng thái "đổi / giữ nguyên"
// dưới đây là so sánh hiển thị giữa các bản đã xuất bản, không phải content hash hay block version.
const BLOCKS = [
  ...Object.keys(MODULES).map(k => ({ path: `/modules/${k}`, title: MODULES[k], kind: 'module' })),
  { path: '/valuation', title: 'Định giá (số liệu chính thức)', kind: 'component' },
  { path: '/scorecard', title: 'Scorecard (điểm chính thức)', kind: 'component' },
  { path: '/risk', title: 'Rủi ro (cổng rủi ro)', kind: 'component' },
  { path: '/decision', title: 'Quyết định', kind: 'component' },
  { path: '/core10', title: '10 câu hỏi cốt lõi', kind: 'component' },
  { path: '/committee', title: 'Hội đồng 6 góc nhìn', kind: 'component' },
  { path: '/catalysts', title: 'Catalyst', kind: 'component' },
  { path: '/monitoring', title: 'Chỉ tiêu theo dõi', kind: 'component' },
  { path: '/sources', title: 'Nguồn', kind: 'component' },
  { path: '/identity', title: 'Định danh', kind: 'component' }
]
const pointer = (obj, path) => path.split('/').slice(1).reduce((o, k) => (o == null ? undefined : o[k]), obj)
const stable = v => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  : JSON.stringify(v ?? null)

// Với chuỗi các bản đã xuất bản (theo revision), tính cho từng khối: mới / đổi / giữ nguyên so với bản liền trước.
function blockLineage(versions) {
  const out = {}
  BLOCKS.forEach(b => {
    let prev = null, since = null
    out[b.path] = versions.map((v, i) => {
      const cur = pointer(v.payload, b.path)
      const key = cur === undefined ? null : stable(cur)
      let state
      if (key === null) state = 'ABSENT'
      else if (i === 0 || prev === null) state = 'INITIAL'
      else state = key === prev ? 'INHERITED' : 'CHANGED'
      if (state === 'INITIAL' || state === 'CHANGED') since = v.revision
      prev = key
      return { revision: v.revision, record_id: v.record_id, state, since: key === null ? null : since }
    })
  })
  return out
}

// Tải nội dung các bản đã xuất bản (được phép xem) cùng chuỗi, đến revision đang đọc.
function useVersions(history, upToRevision) {
  const items = (history?.items || []).filter(i => i.role !== 'withdrawn' && (upToRevision == null || i.revision <= upToRevision))
  const key = items.map(i => i.record_id).join(',')
  const [state, setState] = useState({ key: '', versions: [] })
  useEffect(() => {
    if (!items.length) return
    let active = true
    Promise.all(items.map(i => fetchCached({ action: 'record', id: i.record_id }).catch(() => null)))
      .then(rs => { if (active) setState({ key, versions: rs.filter(Boolean).sort((a, b) => a.revision - b.revision) }) })
    return () => { active = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return state.key === key ? state.versions : []
}

const BlockContext = createContext(null)
const BLOCK_STATE = {
  CHANGED: { vi: 'Cập nhật', tone: 'blue' },
  INHERITED: { vi: 'Giữ nguyên', tone: 'gray' },
  INITIAL: { vi: 'Bản đầu', tone: 'gray' }
}

// Nhãn cạnh tiêu đề mục: khối này đổi ở bản đang đọc hay giữ nguyên từ bản trước.
function BlockTag({ paths, standalone = false }) {
  const ctx = useContext(BlockContext)
  const notes = useContext(NotesContext)
  const linked = notes ? [...new Map(paths.flatMap(p => notes.byPath[p] || []).map(n => [n.note_version_id, n])).values()] : []
  const noteTag = linked.length > 0 && <a className="rl-block-tag rl-note-tag" href={notes.href(linked.length === 1 ? linked[0] : null)}
    title={linked.map(n => n.title).join('\n')}>{linked.length === 1 ? 'Chuyên đề liên quan' : `${linked.length} chuyên đề liên quan`}</a>
  let tag = null
  if (ctx && ctx.count >= 2) {
    const rows = paths.map(p => ctx.at[p]).filter(r => r && r.state !== 'ABSENT')
    if (rows.length) {
      const changed = rows.some(r => r.state === 'CHANGED')
      const since = Math.max(...rows.map(r => r.since || 0))
      const text = changed ? `Cập nhật ở R${ctx.revision}` : rows.every(r => r.state === 'INITIAL') ? `Từ R${ctx.revision}` : `Giữ nguyên từ R${since}`
      tag = <span className={`rl-block-tag ${changed ? 'changed' : ''}`} title={changed ? `Nội dung khác bản R${ctx.prevRevision}` : `Nội dung giống bản R${ctx.prevRevision}`}>{text}</span>
    }
  }
  if (!tag && !noteTag) return null
  return standalone ? <div className="rl-block-tag-line">{tag}{noteTag}</div> : <>{tag}{noteTag}</>
}

// Chuyên đề đã xuất bản theo mục (chỉ dùng cho bản hiện hành: không ghép chuyên đề mới vào bản lịch sử).
const NotesContext = createContext(null)
const noteHref = (item, id) => `/research/${encodeURIComponent(item.ticker)}/n/${id}?exchange=${encodeURIComponent(item.exchange || 'HOSE')}`
function NotesProvider({ item, notes, children }) {
  const value = useMemo(() => {
    if (!notes?.length) return null
    const byPath = {}
    notes.forEach(n => (n.links || []).forEach(l => { (byPath[`/modules/${l.module_key}`] ||= []).push(n) }))
    return { byPath, href: n => n ? noteHref(item, n.note_version_id) : profileHref(item, 'chuyen-de') }
  }, [notes, item.ticker, item.exchange]) // eslint-disable-line react-hooks/exhaustive-deps
  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>
}

function BlockProvider({ data, history, children }) {
  const versions = useVersions(history, data?.revision)
  const value = useMemo(() => {
    if (!data || versions.length < 2) return null
    const lin = blockLineage(versions)
    const idx = versions.findIndex(v => v.record_id === data.record_id)
    if (idx < 1) return null
    return { count: versions.length, revision: data.revision, prevRevision: versions[idx - 1].revision,
      at: Object.fromEntries(Object.entries(lin).map(([p, row]) => [p, row[idx]])) }
  }, [data, versions])
  return <BlockContext.Provider value={value}>{children}</BlockContext.Provider>
}

// Bảng khối × bản: đọc nhanh khối nào đổi ở từng revision.
// Mặc định chỉ hiện các khối có cập nhật ở ít nhất một bản; đường dẫn kỹ thuật (/modules/…) chỉ hiện khi rê chuột.
const REG_STATE = { CHANGED: 'Cập nhật', INHERITED: 'Giữ nguyên', INITIAL: 'Bản đầu' }
function MatrixTable({ heads, cells, intro }) {
  const [all, setAll] = useState(false)
  const changed = BLOCKS.filter(b => cells(b).some(c => c?.state === 'CHANGED'))
  const rows = all || !changed.length ? BLOCKS : changed
  return <>
    <h2 className="rl-ptab-h">Khối nội dung theo từng bản</h2>
    <p className="rl-muted rl-small">{intro}</p>
    <div className="rl-matrix-bar">
      <span>{changed.length ? `${changed.length} / ${BLOCKS.length} khối có cập nhật` : 'Chưa khối nào thay đổi giữa các bản'}</span>
      {changed.length > 0 && <button type="button" className="rl-link" onClick={() => setAll(!all)}>{all ? 'Chỉ hiện khối có cập nhật' : `Hiện cả ${BLOCKS.length} khối`}</button>}
    </div>
    <div className="rl-table-wrap"><table className="rl-table rl-block-matrix">
      <thead><tr><th scope="col">Khối</th>{heads}</tr></thead>
      <tbody>{rows.map(b => <tr key={b.path}>
        <th scope="row" title={b.path}>{b.title}</th>
        {cells(b).map((c, i) => <td key={i} className={c ? `rl-bm-${c.state.toLowerCase()}` : ''}>
          {!c || c.state === 'ABSENT' ? <span className="rl-muted">—</span> : <>
            {c.state === 'CHANGED' ? <b>{REG_STATE.CHANGED}</b> : c.state === 'INHERITED' ? <span className="rl-muted">{REG_STATE.INHERITED}</span> : REG_STATE.INITIAL}
            {c.note && <small className="rl-bm-rev">{c.note}</small>}</>}
        </td>)}
      </tr>)}</tbody>
    </table></div>
  </>
}

function BlockMatrix({ history, item }) {
  const versions = useVersions(history, null)
  const reg = useApi(item ? { action: 'blocks', ticker: item.ticker, exchange: item.exchange } : null, [item?.ticker, item?.exchange])
  const regRecords = reg.data?.records || []
  if (regRecords.length >= 1 && regRecords.length >= versions.length) return <RegistryMatrix records={regRecords} />
  if (versions.length < 2) return null
  const lin = blockLineage(versions)
  const changedCount = v => BLOCKS.filter(b => lin[b.path][v].state === 'CHANGED').length
  return <MatrixTable
    intro="So sánh nội dung giữa các bản đã xuất bản để biết khối nào được cập nhật, khối nào giữ nguyên."
    heads={versions.map((v, i) => <th key={v.record_id} scope="col">R{v.revision}{i > 0 && <small>{changedCount(i)} khối đổi</small>}</th>)}
    cells={b => lin[b.path]} />
}

// Bảng khối × bản theo manifest chính thức (registry, tài liệu 13): B<n> là phiên bản của khối.
function RegistryMatrix({ records }) {
  const at = records.map(r => Object.fromEntries(r.blocks.map(b => [b.path, b])))
  const changedCount = i => BLOCKS.filter(b => at[i][b.path]?.disposition === 'CHANGED').length
  return <MatrixTable
    intro={<>Theo manifest khối của từng bản, dựng từ dữ liệu gốc đã duyệt. <b>B</b> là phiên bản của khối: khối giữ nguyên thì giữ số cũ, khối cập nhật thì tăng số.{records.some(r => r.provenance_kind === 'LEGACY_BACKFILL') && ' Manifest của các bản cũ được lập bổ sung sau khi xuất bản.'}</>}
    heads={records.map((r, i) => <th key={r.record_id} scope="col">R{r.revision}{i > 0 && <small>{changedCount(i)} khối đổi</small>}</th>)}
    cells={b => at.map(row => { const c = row[b.path]; return c && { state: c.disposition, note: `B${c.block_revision}${c.change_class === 'SOURCE_REMAP' ? ' · chỉ đổi mã nguồn' : ''}` } })} />
}

// Hồ sơ cổ phiếu (tài liệu 12): Tổng quan = bản hiện hành; Chuyên đề; Cập nhật; Lịch sử các bản từng xuất bản.
const PROFILE_TABS = [
  { id: 'tong-quan', title: 'Tổng quan' },
  { id: 'chuyen-de', title: 'Chuyên đề' },
  { id: 'phien-ban', title: 'Phiên bản' }
]
// Hai tab cũ Cập nhật và Lịch sử đã gộp vào Phiên bản; địa chỉ cũ vẫn mở đúng tab mới.
const LEGACY_TABS = { 'cap-nhat': 'phien-ban', 'lich-su': 'phien-ban' }
const ROLE = {
  current: { vi: 'Hiện hành', tone: 'green' },
  historical: { vi: 'Bản lịch sử', tone: 'gray' },
  withdrawn: { vi: 'Đã thu hồi', tone: 'red' }
}
const recordHref = (item, id) => `/research/${encodeURIComponent(item.ticker)}/r/${id}?exchange=${encodeURIComponent(item.exchange || 'HOSE')}`
const profileHref = (item, tab) => researchHref(item) + (tab && tab !== 'tong-quan' ? `&tab=${tab}` : '')

function ProfileTabs({ item, tab, history, noteCount = 0 }) {
  const n = history?.items?.length || 0
  return <nav className="rl-ptabs" aria-label="Hồ sơ cổ phiếu">
    {PROFILE_TABS.map(t => <a key={t.id} href={profileHref(item, t.id)} className={tab === t.id ? 'active' : ''} aria-current={tab === t.id ? 'page' : undefined}>
      {t.title}{t.id === 'phien-ban' && n > 0 && <small>{n}</small>}{t.id === 'chuyen-de' && noteCount > 0 && <small>{noteCount}</small>}
    </a>)}
  </nav>
}

// Dòng trạng thái: các mốc thời gian và độ phủ của bản đang đọc.
function RecordStatus({ data, role, item, history }) {
  const sc = data.payload?.scorecard || {}
  return <div className="rl-status-line">
    {item && history?.items?.some(i => i.role !== 'withdrawn' && i.record_id !== data.record_id)
      ? <RevisionSwitcher item={item} items={history.items} data={data} />
      : <>{role && <Badge map={ROLE} value={role} />}<span>R{data.revision}</span></>}
    <span>Thời điểm đánh giá <b>{dateText(data.as_of)}</b></span>
    <span>Dữ liệu đến <b>{dateText(data.cutoff)}</b></span>
    <span>Công bố <b>{dateText(data.published_at)}</b></span>
    <span>Độ phủ dữ liệu <b>{num(sc.coverage ?? data.score_coverage, 0)}%</b> · Tin cậy <b>{CONFIDENCE[sc.confidence || data.score_confidence]?.vi || '—'}</b></span>
  </div>
}

// Bộ chọn phiên bản trên đầu bài: thấy ngay có bao nhiêu bản và chuyển sang bản khác.
function RevisionSwitcher({ item, items, data }) {
  const readable = [...items].filter(i => i.role !== 'withdrawn').reverse()
  const me = readable.find(i => i.record_id === data.record_id)
  const role = me?.role || data.role || 'current'
  return <details className="rl-rev-switch">
    <summary><Badge map={ROLE} value={role} /><b>R{data.revision}</b><span className="rl-muted">· {readable.length} phiên bản</span><span aria-hidden="true">▾</span></summary>
    <ul role="list">{readable.map(i => <li key={i.record_id}>
      <a href={i.role === 'current' ? profileHref(item) : recordHref(item, i.record_id)} aria-current={i.record_id === data.record_id ? 'page' : undefined}
        className={i.record_id === data.record_id ? 'active' : ''}>
        <b>R{i.revision}</b><span>{ROLE[i.role]?.vi}</span><small>Công bố {dateText(i.first_published_at)} · Dữ liệu đến {dateText(i.cutoff)}</small>
        {Array.isArray(i.change_log) && i.change_log[0] && <em>{viCodes(String(i.change_log[0])).slice(0, 140)}</em>}
      </a></li>)}
      <li className="rl-rev-switch-all"><a href={profileHref(item, 'phien-ban')}>So sánh các phiên bản →</a></li>
    </ul>
  </details>
}

// "Có gì mới từ lần bạn đọc trước": trình duyệt nhớ bản đã đọc của từng mã; khi có bản mới hơn thì tóm tắt thay đổi chính
// và liệt kê các mục có khối nội dung đổi (theo manifest), bấm là nhảy tới mục đó.
const SEEN_KEY = 'invstock_seen_v1'
const PATH_SECTION = {
  '/modules/executive_summary': 'tom-tat', '/decision': 'luan-diem', '/modules/decision_monitoring': 'luan-diem',
  '/valuation': 'dinh-gia', '/modules/valuation_engine': 'dinh-gia', '/scorecard': 'scorecard',
  '/risk': 'rui-ro', '/modules/scorecard_risk': 'rui-ro', '/catalysts': 'catalyst', '/monitoring': 'catalyst',
  '/modules/catalysts_expectations': 'catalyst', '/core10': 'phan-bien', '/committee': 'phan-bien', '/sources': 'nguon',
  ...Object.fromEntries(CHAPTERS.flatMap(c => c.keys.map(k => [`/modules/${k}`, c.id])))
}
function useSeenRevision(item, data) {
  const key = `${item.ticker}:${item.exchange}`
  const [before] = useState(() => (storage.get(SEEN_KEY, {}) || {})[key] || null)
  useEffect(() => {
    if (!data) return
    const all = storage.get(SEEN_KEY, {}) || {}
    if (all[key]?.revision >= data.revision) return
    all[key] = { revision: data.revision, record_id: data.record_id, at: Date.now() }
    storage.set(SEEN_KEY, all)
  }, [key, data?.record_id]) // eslint-disable-line react-hooks/exhaustive-deps
  return before
}

function WhatsNew({ item, data, history, sections }) {
  const seen = useSeenRevision(item, data)
  const [open, setOpen] = useState(true)
  const reg = useApi({ action: 'blocks', ticker: item.ticker, exchange: item.exchange }, [item.ticker, item.exchange])
  if (!open || !seen || !(seen.revision < data.revision)) return null
  const items = history?.items || []
  const old = items.find(i => i.revision === seen.revision && i.role !== 'withdrawn')
  const cur = items.find(i => i.record_id === data.record_id) || data
  const facts = []
  if (old) {
    if (old.decision_status !== cur.decision_status) facts.push(<>Kết luận: <Badge map={DECISION} value={old.decision_status} /> → <Badge map={DECISION} value={cur.decision_status} /></>)
    if (old.risk_gate !== cur.risk_gate) facts.push(<>Mức rủi ro: <Badge map={GATE} value={old.risk_gate} /> → <Badge map={GATE} value={cur.risk_gate} /></>)
    const rows = [['Giá trị ước tính', d => d.fair_value, price, 'rel'], ['Biên an toàn', d => d.mos, pct, 'pp'], ['Điểm chất lượng', d => d.official_total ?? d.normalized_score, score, 'abs']]
    rows.forEach(([label, value, fmt, delta]) => {
      const a = value(old), b = value(cur)
      if (isNum(a) && isNum(b) && a !== b) facts.push(<>{label}: {fmt(a)} → <b>{fmt(b)}</b> <span className="rl-muted">({deltaText({ value, delta }, old, cur)})</span></>)
    })
  }
  const recs = reg.data?.records || []
  const ra = recs.find(r => r.revision === seen.revision), rb = recs.find(r => r.record_id === data.record_id)
  let changedSections = []
  if (ra && rb) {
    const va = Object.fromEntries(ra.blocks.map(b => [b.path, b.block_revision]))
    const ids = new Set(rb.blocks.filter(b => va[b.path] !== b.block_revision).map(b => PATH_SECTION[b.path]).filter(Boolean))
    changedSections = sections.filter(s => ids.has(s.id))
  }
  return <div className="rl-banner rl-whatsnew" role="note">
    <button type="button" className="rl-banner-close" onClick={() => setOpen(false)} aria-label="Ẩn">×</button>
    <b>Có gì mới từ lần bạn đọc trước.</b> Lần trước bạn đọc R{seen.revision}{seen.at ? ` (${dateText(new Date(seen.at).toISOString())})` : ''}; bản hiện hành là R{data.revision}.
    {facts.length > 0 && <ul>{facts.map((f, i) => <li key={i}>{f}</li>)}</ul>}
    {changedSections.length > 0 && <div className="rl-whatsnew-secs"><span>Mục có cập nhật:</span>{changedSections.map(s => <a key={s.id} href={`#${s.id}`}>{s.title}</a>)}</div>}
    <a href={profileHref(item, 'phien-ban') + `&so-sanh=${seen.revision}-${data.revision}`}>So sánh R{seen.revision} với R{data.revision} →</a>
  </div>
}

function ResearchPage({ ticker, exchange, tab }) {
  const item = { ticker, exchange }
  const report = useApi({ action: 'research', ticker, exchange }, [ticker, exchange])
  const history = useApi({ action: 'history', ticker, exchange }, [ticker, exchange])
  const notes = useApi({ action: 'notes', ticker, exchange }, [ticker, exchange])
  const crit = useApi({ action: 'criteria' }, [])
  const [size, setSize] = useReaderSize()
  const data = report.data
  const p = data?.payload || {}
  const sourceMap = useSourceMap(data)
  const title = data ? `${ticker} · ${data.company || ''}` : ticker
  const overview = tab === 'tong-quan'
  useEffect(() => { document.title = `${title} · InvStock` }, [title])
  useEffect(() => { upsertTab(researchTab(item, data?.company)) }, [ticker, exchange, data?.company]) // eslint-disable-line react-hooks/exhaustive-deps

  const sections = useMemo(() => researchSections(data), [data])
  const active = useScrollSpy(sections.map(s => s.id), Boolean(data) && overview)
  const progress = useReadingProgress(researchHref(item), title, Boolean(data) && overview)
  // Mã chưa có bản hiện hành (ví dụ vừa thu hồi) vẫn mở được tab Lịch sử nếu còn bản lịch sử được phép xem.
  const hasHistory = (history.data?.items || []).some(i => i.role !== 'withdrawn')

  return <SourcesContext.Provider value={sourceMap}>
    <div className="rl rl-reader" style={{ '--reader-scale': size }}>
      <TopBar progress={data && overview ? progress : undefined}>
        {data && <div className="rl-topbar-title"><b>{ticker}</b><span>{data.company}</span></div>}
        {data && overview && <SizeControl size={size} setSize={setSize} />}
      </TopBar>
      <main className="rl-main">
        {report.loading && <><Skeleton rows={2} /><Skeleton rows={5} /></>}
        {report.error && <><a className="rl-back" href="/">← Thư viện</a>
          <Empty tone="error">Không mở được bản hiện hành của {ticker} ({report.error}). Báo cáo có thể chưa được xuất bản, đã thu hồi, hoặc chỉ dành cho thành viên.</Empty>
          {hasHistory && <><ProfileTabs item={item} tab="phien-ban" history={history.data} /><VersionsTab item={item} history={history} currentId={null} /></>}</>}
        {data && <>
          <ReportHeader
            kicker={`Báo cáo phân tích đầy đủ · Dữ liệu đến ${dateText(data.cutoff)}`}
            title={<>{data.company || ticker} <span className="rl-ticker-pill">{ticker} · {data.exchange}</span></>}
            sub={`${data.sector || ''}${data.reporting_period ? ` · Kỳ báo cáo: ${data.reporting_period}` : ''}`} />
          <ProfileTabs item={item} tab={tab} history={history.data} noteCount={notes.data?.notes?.length || 0} />
          {overview && <>
            <RecordStatus data={data} role="current" item={item} history={history.data} />
            <WhatsNew item={item} data={data} history={history.data} sections={sections} />
            <KeyFacts data={data} p={p} />
            <NotesProvider item={item} notes={notes.data?.notes}><BlockProvider data={data} history={history.data}><div className="rl-layout">
              <SectionNav sections={sections} active={active} />
              <ResearchArticle data={data} criteria={crit.data?.criteria} />
            </div></BlockProvider></NotesProvider>
          </>}
          {tab === 'chuyen-de' && <TopicsTab item={item} notes={notes} current={data} />}
          {tab === 'phien-ban' && <VersionsTab item={item} history={history} currentId={data.record_id} />}
        </>}
      </main>
      {overview && <BackToTop />}
      <Footer />
    </div>
  </SourcesContext.Provider>
}

const NOTE_TOPIC = { OWNERSHIP: 'Sở hữu', FORENSICS: 'Chất lượng lợi nhuận', RISK: 'Rủi ro', EVENT: 'Sự kiện', INDUSTRY: 'Ngành',
  VALUATION: 'Định giá', GOVERNANCE: 'Quản trị', OTHER: 'Chuyên đề' }
const NOTE_OUTCOME = {
  SUPPLEMENT_ONLY: { vi: 'Bổ sung tham khảo', tone: 'gray' },
  PROPOSE_INTEGRATION: { vi: 'Đề xuất đưa vào bản sau', tone: 'blue' },
  URGENT_REVIEW: { vi: 'Cần rà soát gấp', tone: 'red' }
}

function TopicsTab({ item, notes, current }) {
  const list = notes.data?.notes || []
  return <section className="rl-ptab-body">
    {notes.loading && <Skeleton rows={2} />}
    {notes.error && <Empty tone="error">Chưa tải được chuyên đề ({notes.error}).</Empty>}
    {!notes.loading && !notes.error && !list.length && <Empty>Chưa có bài chuyên đề nào cho {item.ticker}.<br />
      <span className="rl-small">Chuyên đề (Deep Dive, sở hữu, chất lượng lợi nhuận…) được duyệt và xuất bản riêng, hiển thị tại đây và tại đúng mục của bài. Chuyên đề không tự thay đổi định giá, điểm hay quyết định của bản hiện hành.</span>
    </Empty>}
    {list.length > 0 && <>
      <p className="rl-muted rl-small">Chuyên đề được duyệt và xuất bản riêng. Chúng không tự thay đổi định giá, điểm hay quyết định của bản hiện hành{current ? ` (R${current.revision})` : ''}; khi được tích hợp sẽ có bản mới.</p>
      <div className="rl-note-list">{list.map(n => <NoteCard key={n.note_version_id} item={item} n={n} current={current} />)}</div>
    </>}
  </section>
}

function NoteCard({ item, n, current }) {
  const primary = (n.links || []).find(l => l.role === 'PRIMARY')
  const other = (n.links || []).filter(l => l.role !== 'PRIMARY')
  return <a className="rl-note-card" href={noteHref(item, n.note_version_id)}>
    <div className="rl-note-kicker">{NOTE_TOPIC[n.topic] || n.topic} · Dữ liệu đến {dateText(n.cutoff)}{n.note_version > 1 ? ` · Phiên bản ${n.note_version}` : ''}</div>
    <h3>{n.title}</h3>
    <div className="rl-note-meta">
      <Badge map={NOTE_OUTCOME} value={n.outcome} code={false} />
      {primary && <span>Mục chính: <b>{MODULES[primary.module_key] || primary.module_key}</b></span>}
      {other.length > 0 && <span>Liên quan: {other.map(l => MODULES[l.module_key] || l.module_key).join(', ')}</span>}
      {current && n.base_record_id && n.base_record_id !== current.record_id && <span className="rl-muted">Viết trên một bản trước bản hiện hành</span>}
      {n.visibility === 'members' && <span className="rl-muted">Dành cho thành viên</span>}
    </div>
  </a>
}

// Markdown tối giản và an toàn (không dùng HTML thô): tiêu đề, đoạn, danh sách, trích dẫn, code, đậm/nghiêng, liên kết http(s).
function mdInline(text, key = 0) {
  const out = []
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g
  let last = 0, m, i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Term key={`${key}-t${i++}`}>{text.slice(last, m.index)}</Term>)
    const t = m[0]
    if (t.startsWith('**')) out.push(<strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith('`')) out.push(<code key={`${key}-${i++}`}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('[')) out.push(<a key={`${key}-${i++}`} href={m[2]} target="_blank" rel="noopener noreferrer">{t.slice(1, t.indexOf(']'))}</a>)
    else out.push(<em key={`${key}-${i++}`}>{t.slice(1, -1)}</em>)
    last = m.index + t.length
  }
  if (last < text.length) out.push(<Term key={`${key}-t${i++}`}>{text.slice(last)}</Term>)
  return out
}
function Markdown({ text }) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (line.startsWith('```')) {
      const body = []; i++
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      i++; blocks.push(<pre key={blocks.length}><code>{body.join('\n')}</code></pre>); continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) { const L = Math.min(h[1].length + 1, 5); blocks.push(React.createElement(`h${L}`, { key: blocks.length }, mdInline(h[2], blocks.length))); i++; continue }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line), items = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''))
      const Tag = ordered ? 'ol' : 'ul'
      blocks.push(<Tag key={blocks.length}>{items.map((t, k) => <li key={k}>{mdInline(t, `${blocks.length}-${k}`)}</li>)}</Tag>); continue
    }
    if (line.startsWith('>')) {
      const body = []
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={blocks.length}>{mdInline(body.join(' '), blocks.length)}</blockquote>); continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++])
    blocks.push(<p key={blocks.length}>{mdInline(para.join(' '), blocks.length)}</p>)
  }
  return <div className="rl-md">{blocks}</div>
}

const EVIDENCE_KIND = { FACT: 'Dữ kiện', METRIC: 'Chỉ số', ASSUMPTION: 'Giả định', EXTERNAL_VIEW: 'Quan điểm bên ngoài', COUNTEREVIDENCE: 'Phản chứng' }
const EVIDENCE_STATUS = { VERIFIED: 'Đã xác minh', REPORTED: 'Theo công bố', ESTIMATED: 'Ước tính', UNVERIFIED: 'Chưa xác minh' }
const IMPACT = { CHANGE: { vi: 'Cần thay đổi', tone: 'blue' }, NO_CHANGE: { vi: 'Không đổi', tone: 'gray' }, NEEDS_REVIEW: { vi: 'Cần rà soát', tone: 'amber' } }

// Trang đọc một chuyên đề (đường dẫn cố định theo note_version_id).
function NotePage({ ticker, exchange, id }) {
  const item = { ticker, exchange }
  const res = useApi({ action: 'note', id }, [id])
  const n = res.data
  const p = n?.payload || {}
  const sourceMap = useMemo(() => Object.fromEntries((p.sources || []).map(s => [s.id, s])), [p.sources])
  const path = noteHref(item, id)
  const title = n ? n.title : `${ticker} · chuyên đề`
  useEffect(() => { document.title = `${title} · InvStock` }, [title])
  useEffect(() => { if (n) upsertTab({ path, kind: 'note', title: `${ticker} · ${NOTE_TOPIC[n.topic] || 'Chuyên đề'}`, sub: n.title }) }, [path, n?.title]) // eslint-disable-line react-hooks/exhaustive-deps
  const primary = (n?.links || []).find(l => l.role === 'PRIMARY')
  return <SourcesContext.Provider value={sourceMap}>
    <div className="rl rl-reader">
      <TopBar>{n && <div className="rl-topbar-title"><b>{ticker}</b><span>{NOTE_TOPIC[n.topic] || 'Chuyên đề'}</span></div>}</TopBar>
      <main className="rl-main rl-note-page">
        {!n && <a className="rl-back" href={profileHref(item, 'chuyen-de')}>← Chuyên đề của {ticker}</a>}
        {res.loading && <Skeleton rows={4} />}
        {res.error && <Empty tone="error">Không mở được chuyên đề ({res.error}). Chuyên đề có thể đã thu hồi hoặc chỉ dành cho thành viên.</Empty>}
        {n && <>
          <ReportHeader back={<a className="rl-back" href={profileHref(item, 'chuyen-de')}>← Chuyên đề của {ticker}</a>}
            kicker={`${NOTE_TOPIC[n.topic] || 'Chuyên đề'} · ${ticker} · Dữ liệu đến ${dateText(n.cutoff)}`} title={n.title}
            sub={`Thời điểm đánh giá ${dateText(n.as_of)} · Công bố ${dateText(n.published_at)}${n.note_version > 1 ? ` · Phiên bản ${n.note_version}` : ''}`} />
          <div className="rl-status-line">
            <Badge map={NOTE_OUTCOME} value={n.outcome} code={false} />
            {primary && <span>Mục chính <b>{MODULES[primary.module_key] || primary.module_key}</b></span>}
            {p.base && <span>Viết trên <a href={recordHref(item, p.base.record_id)}>R{p.base.revision}</a></span>}
            {!p.base && <span className="rl-muted">Chưa có bản Full Research làm cơ sở</span>}
          </div>
          <div className="rl-note-notice">Chuyên đề là nghiên cứu bổ sung. Nó không tự thay đổi định giá, điểm hay quyết định của bản hiện hành.</div>
          <section className="rl-section"><h2>Câu hỏi nghiên cứu</h2><p><Term>{p.research_question}</Term></p><p className="rl-muted rl-small">Phạm vi: <Term>{p.scope}</Term></p></section>
          <section className="rl-section"><Markdown text={p.body?.text} /></section>
          {p.evidence?.length > 0 && <section className="rl-section"><h2>Bằng chứng</h2>
            <div className="rl-table-wrap"><table className="rl-table"><thead><tr><th>Loại</th><th>Nội dung</th><th className="num">Giá trị</th><th>Kỳ</th><th>Trạng thái</th><th>Nguồn</th></tr></thead>
              <tbody>{p.evidence.map((e, k) => <tr key={k}><td>{EVIDENCE_KIND[e.kind] || e.kind}</td><td><Term>{e.statement}</Term></td>
                <td className="num">{e.value == null ? '—' : typeof e.value === 'number' ? num(e.value) : e.value}{e.unit ? ` ${e.unit}` : ''}</td>
                <td>{e.period || '—'}</td><td>{EVIDENCE_STATUS[e.status] || e.status}</td><td><Refs ids={e.source_ids} /></td></tr>)}</tbody></table></div>
          </section>}
          {p.risks?.length > 0 && <section className="rl-section"><h2>Rủi ro</h2><BulletList items={p.risks} /></section>}
          {p.gaps?.length > 0 && <section className="rl-section"><Gaps title="Còn thiếu" items={p.gaps.map(g => `${g.description} (${g.materiality === 'MATERIAL' ? 'trọng yếu' : 'nhỏ'}): ${g.impact}`)} /></section>}
          {p.impact_review?.length > 0 && <section className="rl-section"><h2>Tác động tới bài chính</h2>
            <ul className="rl-impact">{p.impact_review.map((r, k) => <li key={k}><code>{r.path}</code> <Badge map={IMPACT} value={r.result} code={false} /> <Term>{r.reason}</Term></li>)}</ul>
          </section>}
          {p.sources?.length > 0 && <SourcesBlock sources={p.sources} />}
        </>}
      </main>
      <Footer />
    </div>
  </SourcesContext.Provider>
}

function HistoryState({ history }) {
  if (history.loading) return <Skeleton rows={3} />
  if (history.error) return <Empty tone="error">Chưa tải được lịch sử xuất bản ({history.error}).</Empty>
  if (!history.data?.items?.length) return <Empty>Chưa có lịch sử xuất bản.</Empty>
  return null
}

// Dòng thời gian: các lần công bố, thay thế, thu hồi, kèm nhật ký thay đổi của từng bản (mới nhất ở trên).
function PublicationTimeline({ item, items }) {
  const byId = Object.fromEntries(items.map(i => [i.record_id, i]))
  const events = []
  items.forEach(i => {
    if (i.role === 'withdrawn') {
      events.push({ at: i.withdrawn_at, kind: 'withdrawn', i })
      return
    }
    events.push({ at: i.first_published_at, kind: 'published', i })
    if (i.superseded_at) events.push({ at: i.superseded_at, kind: 'superseded', i, by: byId[i.superseded_by] })
  })
  events.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  if (!events.length) return null
  return <ol className="rl-publine">
    {events.map((e, n) => <li key={n} className={`rl-pl-${e.kind}`}>
      <time>{dateText(e.at)}</time>
      {e.kind === 'published' && <div>
        <b>Công bố R{e.i.revision}</b>{e.i.role === 'current' && <> <Badge map={ROLE} value="current" /></>}
        <p className="rl-muted rl-small">Thời điểm đánh giá {dateText(e.i.as_of)} · Dữ liệu đến {dateText(e.i.cutoff)} · <Badge map={DECISION} value={e.i.decision_status} /> <Badge map={GATE} value={e.i.risk_gate} /> · Giá trị ước tính {price(e.i.fair_value)}</p>
        {Array.isArray(e.i.change_log) && e.i.change_log.length > 0 && <details className="rl-changelog"><summary>Nhật ký thay đổi ({e.i.change_log.length})</summary><BulletList items={e.i.change_log} /></details>}
        <a href={e.i.role === 'current' ? profileHref(item) : recordHref(item, e.i.record_id)}>Đọc R{e.i.revision} →</a>
      </div>}
      {e.kind === 'superseded' && <div><b>R{e.i.revision} chuyển thành bản lịch sử</b>
        <p className="rl-muted rl-small">{e.by ? `Được thay bằng R${e.by.revision}.` : 'Được thay bằng bản mới hơn.'}</p></div>}
      {e.kind === 'withdrawn' && <div><b>R{e.i.revision} đã thu hồi</b><p className="rl-muted rl-small">Nội dung bản này không còn hiển thị.</p></div>}
    </li>)}
  </ol>
}

const DIFF_ROWS = [
  { label: 'Kết luận', cell: d => <Badge map={DECISION} value={d.decision_status} code={false} />, key: d => d.decision_status },
  { label: 'Mức rủi ro', cell: d => <Badge map={GATE} value={d.risk_gate} code={false} />, key: d => d.risk_gate },
  { label: 'Giá trị ước tính', value: d => d.fair_value, fmt: price, delta: 'rel' },
  { label: 'Giá tham chiếu', value: d => d.price, fmt: price, delta: 'rel', note: d => dateText(d.price_date) },
  { label: 'Biên an toàn', value: d => d.mos, fmt: pct, delta: 'pp' },
  { label: 'Upside', value: d => d.upside, fmt: pct, delta: 'pp' },
  { label: 'Điểm chất lượng', value: d => d.official_total ?? d.normalized_score, fmt: score, delta: 'abs' },
  { label: 'Độ phủ dữ liệu', value: d => d.score_coverage, fmt: v => `${num(v, 0)}%`, delta: 'abs' },
  { label: 'Thời điểm đánh giá', cell: d => dateText(d.as_of), key: d => d.as_of },
  { label: 'Dữ liệu đến (cutoff)', cell: d => dateText(d.cutoff), key: d => d.cutoff },
  { label: 'Kỳ báo cáo', cell: d => d.reporting_period || '—', key: d => d.reporting_period },
  { label: 'Rubric · schema', cell: d => `${d.scorecard_version || '—'} · ${d.schema_version || '—'}`, key: d => `${d.scorecard_version}|${d.schema_version}` }
]
function deltaText(r, a, b) {
  const x = r.value(a), y = r.value(b)
  if (!isNum(x) || !isNum(y)) return ''
  if (r.delta === 'rel') return x === 0 ? '' : `${y >= x ? '+' : ''}${((y / x - 1) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`
  if (r.delta === 'pp') return `${y >= x ? '+' : ''}${((y - x) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} điểm %`
  return `${y >= x ? '+' : ''}${(y - x).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}`
}

// So sánh hai revision: tách các yếu tố, cảnh báo khi khác cutoff/kỳ/rubric (tài liệu 12, mục 9).
function RevisionDiff({ a, b }) {
  const warn = []
  if (a.scorecard_version !== b.scorecard_version || a.schema_version !== b.schema_version) warn.push('Hai bản dùng rubric hoặc schema khác nhau: điểm số không so sánh trực tiếp được.')
  if (a.reporting_period !== b.reporting_period) warn.push('Hai bản khác kỳ báo cáo.')
  if (a.cutoff !== b.cutoff) warn.push('Hai bản khác ngày dữ liệu (cutoff).')
  else warn.push('Hai bản cùng cutoff: chênh lệch đến từ giả định, phương pháp, chất lượng nguồn hoặc tiêu chuẩn chấm điểm, không phải dữ liệu thị trường mới.')
  return <div className="rl-rev-diff">
    <div className="rl-table-wrap"><table className="rl-table">
      <thead><tr><th /><th scope="col">R{a.revision}</th><th scope="col">R{b.revision}</th><th scope="col">Thay đổi</th></tr></thead>
      <tbody>{DIFF_ROWS.map(r => {
        const changed = r.key ? r.key(a) !== r.key(b) : deltaText(r, a, b) && r.value(a) !== r.value(b)
        return <tr key={r.label} className={changed ? 'rl-changed' : ''}>
          <th scope="row">{r.label}</th>
          {[a, b].map((d, i) => <td key={i} className={r.value ? 'num' : ''}>{r.cell ? r.cell(d) : r.fmt(r.value(d))}{r.note && <small className="rl-muted"> · {r.note(d)}</small>}</td>)}
          <td className="num">{r.value ? deltaText(r, a, b) : (changed ? 'Khác' : '—')}</td>
        </tr>
      })}</tbody>
    </table></div>
    <ul className="rl-diff-notes">{warn.map((w, i) => <li key={i}>{w}</li>)}</ul>
    <p className="rl-muted rl-small">Độ phủ dữ liệu thấp hơn không có nghĩa doanh nghiệp xấu đi: có thể do tiêu chuẩn bằng chứng chặt hơn. Giá trị lịch sử lấy nguyên từ từng bản, không tính lại theo giá hiện tại.</p>
  </div>
}

// Tab Phiên bản (gộp Cập nhật + Lịch sử): bảng các bản, so sánh hai bản bất kỳ, khối nội dung đã đổi, dòng thời gian.
// Hai bản được so sánh nằm trong địa chỉ (&so-sanh=1-2) để gửi cho người khác đúng phần so sánh.
function VersionsTab({ item, history, currentId }) {
  const items = history.data?.items || []
  const readable = items.filter(i => i.role !== 'withdrawn')
  const fromUrl = (new URLSearchParams(window.location.search).get('so-sanh') || '').split('-').map(Number)
  const urlPick = readable.filter(i => fromUrl.includes(i.revision)).map(i => i.record_id)
  const [pick, setPick] = useState(urlPick.length === 2 ? urlPick : null)
  const sel = pick || readable.slice(-2).map(i => i.record_id)
  const pair = readable.filter(i => sel.includes(i.record_id))
  const toggle = id => {
    const cur = sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id].slice(-2)
    setPick(cur)
    const revs = readable.filter(i => cur.includes(i.record_id)).map(i => i.revision)
    if (revs.length === 2) window.history.replaceState(null, '', profileHref(item, 'phien-ban') + `&so-sanh=${revs.join('-')}`)
  }
  return <section className="rl-ptab-body">
    <HistoryState history={history} />
    {items.length > 0 && <div className="rl-table-wrap"><table className="rl-table rl-history">
      <thead><tr><th scope="col">Bản</th><th scope="col">Vai trò</th><th scope="col">Thời điểm đánh giá</th><th scope="col">Công bố</th><th scope="col">Kết luận</th><th scope="col" className="num">Giá trị ước tính</th><th scope="col" className="num">Độ phủ</th><th scope="col">So sánh</th></tr></thead>
      <tbody>{[...items].reverse().map(i => i.role === 'withdrawn'
        ? <tr key={i.record_id} className="rl-withdrawn"><th scope="row">R{i.revision}</th><td><Badge map={ROLE} value="withdrawn" /></td><td colSpan={6} className="rl-muted">Đã thu hồi ngày {dateText(i.withdrawn_at)}. Nội dung không còn hiển thị.</td></tr>
        : <tr key={i.record_id}>
          <th scope="row"><a href={i.record_id === currentId ? profileHref(item) : recordHref(item, i.record_id)}>R{i.revision}</a><small>Dữ liệu đến {dateText(i.cutoff)}</small></th>
          <td><Badge map={ROLE} value={i.role} />{i.superseded_at && <small className="rl-muted rl-block">Thay thế {dateText(i.superseded_at)}</small>}</td>
          <td>{dateText(i.as_of)}</td>
          <td>{dateText(i.first_published_at)}</td>
          <td><Badge map={DECISION} value={i.decision_status} /> <Badge map={GATE} value={i.risk_gate} /></td>
          <td className="num">{price(i.fair_value)}</td>
          <td className="num">{num(i.score_coverage, 0)}%</td>
          <td><label className="rl-check"><input type="checkbox" checked={sel.includes(i.record_id)} onChange={() => toggle(i.record_id)} disabled={readable.length < 2} /> Chọn</label></td>
        </tr>)}</tbody>
    </table></div>}
    {readable.length > 2 && <p className="rl-muted rl-small">Đánh dấu hai bản bất kỳ ở cột So sánh để xem khác biệt.</p>}
    {pair.length === 2 && <><h2 className="rl-ptab-h">So sánh R{pair[0].revision} và R{pair[1].revision}</h2><RevisionDiff a={pair[0]} b={pair[1]} /></>}
    <BlockMatrix history={history.data} item={item} />
    {items.length > 0 && <><h2 className="rl-ptab-h">Dòng thời gian xuất bản</h2><PublicationTimeline item={item} items={items} /></>}
    {readable.length === 1 && <p className="rl-muted rl-small">Mới có một bản được xuất bản. Khi có bản mới, bản cũ vẫn đọc được tại đây.</p>}
  </section>
}

// Trong biểu ngữ bản cũ: bản hiện hành là R mấy, giá trị hợp lý đã đổi bao nhiêu, và lối tắt sang so sánh.
function CurrentHint({ item, data, history }) {
  const cur = history?.items?.find(i => i.record_id === data.current_record_id)
  if (!cur) return <> <a href={profileHref(item)}>Mở bản hiện hành →</a></>
  const fv = isNum(data.fair_value) && isNum(cur.fair_value) && data.fair_value !== cur.fair_value
    ? ` Giá trị ước tính ở R${cur.revision}: ${price(cur.fair_value)} (${deltaText({ value: d => d.fair_value, delta: 'rel' }, data, cur)}).` : ''
  return <>{` Bản hiện hành là R${cur.revision}.${fv}`} <a href={profileHref(item)}>Đọc R{cur.revision} →</a>{' · '}
    <a href={profileHref(item, 'phien-ban') + `&so-sanh=${data.revision}-${cur.revision}`}>Xem khác biệt</a></>
}

// Đường dẫn cố định một bản theo record_id. Bản lịch sử luôn có cảnh báo, không tự chuyển sang bản hiện hành.
function RecordPage({ ticker, exchange, id }) {
  const item = { ticker, exchange }
  const report = useApi({ action: 'record', id }, [id])
  const history = useApi({ action: 'history', ticker, exchange }, [ticker, exchange])
  const crit = useApi({ action: 'criteria' }, [])
  const [size, setSize] = useReaderSize()
  const data = report.data
  const p = data?.payload || {}
  const sourceMap = useSourceMap(data)
  const historical = data && data.role !== 'current'
  const title = data ? `${data.ticker} R${data.revision}${historical ? ' (lịch sử)' : ''}` : `${ticker} · bản lưu`
  const path = recordHref(item, id)
  useEffect(() => { document.title = `${title} · InvStock` }, [title])
  useEffect(() => { if (data) upsertTab({ path, kind: 'record', title: `${data.ticker} R${data.revision}`, sub: historical ? 'Bản lịch sử' : 'Bản hiện hành' }) }, [path, data?.revision, historical]) // eslint-disable-line react-hooks/exhaustive-deps
  const sections = useMemo(() => researchSections(data), [data])
  const active = useScrollSpy(sections.map(s => s.id), Boolean(data))
  const progress = useReadingProgress(path, title, Boolean(data))
  const wrongTicker = data && (data.ticker !== ticker || data.exchange !== exchange)

  return <SourcesContext.Provider value={sourceMap}>
    <div className="rl rl-reader" style={{ '--reader-scale': size }}>
      <TopBar progress={data ? progress : undefined}>
        {data && <div className="rl-topbar-title"><b>{data.ticker} · R{data.revision}</b><span>{historical ? 'Bản lịch sử' : data.company}</span></div>}
        {data && <SizeControl size={size} setSize={setSize} />}
      </TopBar>
      <main className="rl-main">
        {report.loading && <><Skeleton rows={2} /><Skeleton rows={5} /></>}
        {report.error && <><a className="rl-back" href={profileHref(item, 'phien-ban')}>← Hồ sơ {ticker}</a>
          <Empty tone="error">{report.error === 'record_withdrawn' ? 'Bản này đã được thu hồi, nội dung không còn hiển thị.' : `Không mở được bản này (${report.error}). Bản có thể chưa được xuất bản hoặc chỉ dành cho thành viên.`}</Empty></>}
        {wrongTicker && <Empty tone="error">Mã bản ghi không khớp đường dẫn. <a href={recordHref(data, id)}>Mở đúng địa chỉ</a></Empty>}
        {data && !wrongTicker && <>
          {historical
            ? <div className="rl-banner warn" role="note">
                <b>Không phải đánh giá hiện hành.</b> Đây là bản R{data.revision} (thời điểm đánh giá {dateText(data.as_of)}){data.superseded_at ? `, đã được thay thế ngày ${dateText(data.superseded_at)}` : ''}. Định giá, điểm và quyết định trong bản này chỉ có giá trị tham khảo lịch sử.
                {data.current_record_id ? <CurrentHint item={item} data={data} history={history.data} /> : <> Hiện chưa có bản hiện hành bạn được phép xem.</>}
              </div>
            : <div className="rl-banner" role="note">Đây là bản hiện hành của {data.ticker}. <a href={profileHref(item)}>Mở hồ sơ {data.ticker} →</a></div>}
          <ReportHeader back={<a className="rl-back" href={profileHref(item, 'phien-ban')}>← Các phiên bản {data.ticker}</a>}
            kicker={`Báo cáo phân tích đầy đủ · Dữ liệu đến ${dateText(data.cutoff)}`}
            title={<>{data.company || ticker} <span className="rl-ticker-pill">{data.ticker} · {data.exchange}</span></>}
            sub={`${data.sector || ''}${data.reporting_period ? ` · Kỳ báo cáo: ${data.reporting_period}` : ''}`} />
          <RecordStatus data={data} role={data.role} item={item} history={history.data} />
          <KeyFacts data={data} p={p} />
          <BlockProvider data={data} history={history.data}><div className="rl-layout">
            <SectionNav sections={sections} active={active} />
            <ResearchArticle data={data} criteria={crit.data?.criteria} />
          </div></BlockProvider>
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
                  <p><Term>{c.rationale}</Term> <Refs ids={c.source_ids} /></p>
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
  { group: 'Tổng quan' },
  { label: 'Kết luận', cell: d => <Badge map={DECISION} value={d.decision_status} code={false} /> },
  { label: 'Luận điểm', cell: d => <Badge map={THESIS} value={d.thesis_status || d.payload?.decision?.thesis_status} code={false} /> },
  { label: 'Mức rủi ro', cell: d => <Badge map={GATE} value={d.risk_gate} code={false} /> },
  { label: 'Điểm chất lượng', value: d => d.official_total ?? d.normalized_score, best: 'max',
    cell: d => <>{score(d.official_total ?? d.normalized_score)}<small className="rl-muted">/100{d.official_total == null && d.normalized_score != null ? ' · tạm' : ''}</small></> },
  { label: 'Độ phủ · tin cậy', cell: d => `${num(d.payload?.scorecard?.coverage ?? d.score_coverage, 0)}% · ${CONFIDENCE[d.payload?.scorecard?.confidence || d.score_confidence]?.vi || '—'}` },
  { group: 'Định giá' },
  { label: 'Giá thị trường', cell: d => <>{price(d.payload?.valuation?.price ?? d.price)}<small className="rl-muted"> · {dateText(d.payload?.valuation?.price_date ?? d.price_date)}</small></> },
  { label: 'Giá trị ước tính', cell: d => price(d.payload?.valuation?.fair_value ?? d.fair_value) },
  { label: 'Biên an toàn', value: d => d.payload?.valuation?.mos ?? d.mos, best: 'max',
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

function LibraryRoutes() {
  const loc = useLocationPath()
  useLinkInterceptor()
  useScrollSaver()
  const url = new URL(loc, window.location.origin)
  const path = url.pathname.split('/').filter(Boolean)
  const exchange = (url.searchParams.get('exchange') || 'HOSE').toUpperCase()
  const ticker = path[0] === 'research' && path[1] ? decodeURIComponent(path[1]).toUpperCase() : ''
  const recordId = ticker && path[2] === 'r' && /^[0-9a-f-]{36}$/i.test(path[3] || '') ? path[3].toLowerCase() : ''
  const noteId = ticker && path[2] === 'n' && /^[0-9a-f-]{36}$/i.test(path[3] || '') ? path[3].toLowerCase() : ''
  const tabParam = LEGACY_TABS[url.searchParams.get('tab')] || url.searchParams.get('tab')
  const tab = PROFILE_TABS.some(t => t.id === tabParam) ? tabParam : 'tong-quan'
  // Chuẩn hóa địa chỉ bài để tab nhận ra cùng một bài (ví dụ /research/fpt → /research/FPT?exchange=HOSE).
  const pair = tab === 'phien-ban' && /^\d+-\d+$/.test(url.searchParams.get('so-sanh') || '') ? url.searchParams.get('so-sanh') : ''
  const canonical = recordId ? recordHref({ ticker, exchange }, recordId) : noteId ? noteHref({ ticker, exchange }, noteId)
    : ticker ? profileHref({ ticker, exchange }, tab) + (pair ? `&so-sanh=${pair}` : '') : ''
  useEffect(() => { if (canonical && canonical !== loc) navigate(canonical + window.location.hash, { replace: true }) }, [canonical, loc])
  useEffect(() => { if (path[0] !== 'compare' && path.length) patchTabs({ last: loc }) }, [loc]) // eslint-disable-line react-hooks/exhaustive-deps
  if (noteId) return <NotePage key={canonical} ticker={ticker} exchange={exchange} id={noteId} />
  if (recordId) return <RecordPage key={canonical} ticker={ticker} exchange={exchange} id={recordId} />
  if (ticker) return <ResearchPage key={researchHref({ ticker, exchange })} ticker={ticker} exchange={exchange} tab={tab} />
  if (path[0] === 'screening' && path[1]) return <ScreeningPage key={loc} lineageKey={decodeURIComponent(path[1])} />
  if (path[0] === 'compare') return <ComparePage search={url.search} />
  if (path[0] === 'thuat-ngu') return <GlossaryPage key={url.pathname} slug={path[1] ? decodeURIComponent(path[1]) : ''} TopBar={TopBar} Footer={Footer} />
  return <Home key={loc} />
}

// GlossaryProvider bọc toàn bộ thư viện: thuật ngữ trong mọi bài đọc đều có tooltip.
export default function PublicLibrary() {
  return <GlossaryProvider><LibraryRoutes /></GlossaryProvider>
}
