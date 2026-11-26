import React, { useEffect, useMemo, useState } from 'react'
import './style.css'
import { supabase, SUPABASE_URL, SUPABASE_KEY } from './supabaseClient.js'

const API = `${SUPABASE_URL}/functions/v1/public-research-library`
const API_KEY = SUPABASE_KEY
const READING_PROGRESS_KEY = 'invstock_last_reading_v2'

function saveReadingProgress(path, scrollY = window.scrollY) {
  try {
    localStorage.setItem(READING_PROGRESS_KEY, JSON.stringify({ path, scrollY, savedAt: Date.now() }))
  } catch { /* local storage may be unavailable */ }
}

async function readApi(params) {
  const url = new URL(API)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  // Người đã đăng nhập gửi kèm token để xem thêm nội dung 'members'.
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { apikey: API_KEY }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  const response = await fetch(url, { headers })
  const data = await response.json()
  if (!response.ok || !data.success) throw new Error(data.error || 'Không tải được dữ liệu.')
  return data
}

const dateText = value => value ? new Date(value).toLocaleDateString('vi-VN') : '—'
const numberText = value => value === null || value === undefined || value === '' ? '—' : typeof value === 'number' ? value.toLocaleString('vi-VN') : String(value)
const labelText = key => String(key).replace(/_/g, ' ').replace(/\b\w/g, s => s.toUpperCase())

function DataValue({ value, depth = 0 }) {
  if (value === null || value === undefined || value === '') return <span className="lib-muted">—</span>
  if (typeof value === 'boolean') return <span>{value ? 'Có' : 'Không'}</span>
  if (typeof value === 'number') return <span>{numberText(value)}</span>
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return <a href={value} target="_blank" rel="noreferrer">{value}</a>
    return <div className="lib-value-text">{value}</div>
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="lib-muted">Không có dữ liệu</span>
    if (depth > 3) return <pre className="lib-json">{JSON.stringify(value, null, 2)}</pre>
    return <div className="lib-array">{value.map((item, i) => <div className="lib-array-item" key={i}><DataValue value={item} depth={depth + 1} /></div>)}</div>
  }
  const entries = Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '')
  if (!entries.length) return <span className="lib-muted">Không có dữ liệu</span>
  if (depth > 3) return <pre className="lib-json">{JSON.stringify(value, null, 2)}</pre>
  return <div className="lib-object">{entries.map(([key, val]) => (
    <div className="lib-field" key={key}>
      <div className="lib-field-label">{labelText(key)}</div>
      <div className="lib-field-value"><DataValue value={val} depth={depth + 1} /></div>
    </div>
  ))}</div>
}

function Section({ title, children, defaultOpen = true }) {
  return <details className="lib-section" open={defaultOpen}>
    <summary>{title}</summary>
    <div className="lib-section-body">{children}</div>
  </details>
}

function Header({ subtitle = 'Thư viện nghiên cứu đầu tư chứng khoán' }) {
  return <header className="lib-header">
    <a className="lib-brand" href="/">
      <span className="lib-brand-mark">IS</span>
      <span><strong>INVSTOCK TRACKER</strong><small>INVESTMENT RESEARCH</small></span>
    </a>
    <nav><a href="/">Thư viện Research</a><a href="/admin">Admin / Sync Portal</a></nav>
    <p>{subtitle}</p>
  </header>
}

const pct = v => v === null || v === undefined ? '—' : `${(v * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`
const score = v => v === null || v === undefined ? '—' : v.toLocaleString('vi-VN', { maximumFractionDigits: 1 })

function Home() {
  const [data, setData] = useState({ research: [], screenings: [] })
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState('research')
  const [decision, setDecision] = useState('')
  const [sector, setSector] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    readApi({ action: 'list' }).then(result => { if (active) setData(result) })
      .catch(err => { if (active) setError(err.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const decisions = useMemo(() => [...new Set(data.research.map(r => r.decision_status).filter(Boolean))], [data.research])
  const sectors = useMemo(() => [...new Set(data.research.map(r => r.sector).filter(Boolean))], [data.research])
  const research = useMemo(() => data.research.filter(item =>
    `${item.ticker} ${item.company || ''} ${item.sector || ''}`.toLowerCase().includes(query.toLowerCase()) &&
    (!decision || item.decision_status === decision) && (!sector || item.sector === sector)), [data.research, query, decision, sector])
  const screenings = useMemo(() => data.screenings.filter(item => `${item.universe || ''} ${item.strategy || ''}`.toLowerCase().includes(query.toLowerCase())), [data.screenings, query])

  return <main className="lib-shell">
    <Header />
    <section className="lib-hero">
      <div className="lib-eyebrow">PUBLIC RESEARCH LIBRARY · CHUẨN v2.0.0</div>
      <h1>Research có chiều sâu.<br/><em>Quyết định có cơ sở.</em></h1>
      <p>Thư viện báo cáo phân tích doanh nghiệp, định giá và sàng lọc cổ phiếu của InvStock Tracker. Chỉ hiển thị bản đã được admin duyệt và xuất bản.</p>
      <div className="lib-stats">
        <div><strong>{data.research.length}</strong><span>Full Research đã công bố</span></div>
        <div><strong>{data.screenings.length}</strong><span>Screening đã công bố</span></div>
      </div>
    </section>

    <section className="lib-library">
      <div className="lib-library-top">
        <div><div className="lib-eyebrow">KNOWLEDGE BASE</div><h2>Khám phá báo cáo</h2></div>
        <input className="lib-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm mã, tên công ty, ngành..." />
      </div>
      <div className="lib-tabs">
        <button className={tab === 'research' ? 'active' : ''} onClick={() => setTab('research')}>Full Research ({data.research.length})</button>
        <button className={tab === 'screenings' ? 'active' : ''} onClick={() => setTab('screenings')}>Screening ({data.screenings.length})</button>
        {tab === 'research' && <>
          <select className="lib-search" value={decision} onChange={e => setDecision(e.target.value)}><option value="">Mọi quyết định</option>{decisions.map(d => <option key={d}>{d}</option>)}</select>
          <select className="lib-search" value={sector} onChange={e => setSector(e.target.value)}><option value="">Mọi ngành</option>{sectors.map(d => <option key={d}>{d}</option>)}</select>
        </>}
      </div>
      {loading && <div className="lib-empty">Đang tải thư viện...</div>}
      {error && <div className="lib-error">Không thể tải thư viện: {error}</div>}
      {!loading && !error && tab === 'research' && <div className="lib-cards">
        {research.map(item => <a className="lib-card" href={`/research/${encodeURIComponent(item.ticker)}?exchange=${item.exchange}`} key={item.lineage_key}>
          <div className="lib-card-top"><span className="lib-ticker">{item.ticker}</span><span className="lib-published">{item.decision_status || 'ĐÃ CÔNG BỐ'}</span></div>
          <h3>{item.company || item.ticker}</h3>
          <p>{item.sector || ''} · {item.exchange} · Risk gate {item.risk_gate || '—'}</p>
          <div className="lib-card-metrics"><span>Điểm <b>{score(item.official_total ?? item.normalized_score)}{item.official_total == null && item.normalized_score != null ? ' (tạm)' : ''}</b></span><span>MOS <b>{pct(item.mos)}</b></span><span>Rev <b>R{item.revision}</b></span></div>
          <footer>Dữ liệu đến {dateText(item.cutoff)} <span>Đọc báo cáo →</span></footer>
        </a>)}
        {!research.length && <div className="lib-empty">{data.research.length ? 'Không tìm thấy mã phù hợp.' : 'Chưa có Full Research nào được xuất bản.'}</div>}
      </div>}
      {!loading && !error && tab === 'screenings' && <div className="lib-cards">
        {screenings.map(item => <a className="lib-card" href={`/screening/${encodeURIComponent(item.lineage_key)}`} key={item.lineage_key}>
          <div className="lib-card-top"><span className="lib-ticker">SCREENING</span><span className="lib-published">R{item.revision}</span></div>
          <h3>{item.strategy || 'Screening'}</h3>
          <p>{item.universe || ''}</p>
          <div className="lib-card-metrics"><span>Số mã <b>{item.candidate_count ?? '—'}</b></span><span>As of <b>{dateText(item.as_of)}</b></span></div>
          <footer>Công bố {dateText(item.published_at)} <span>Xem kết quả →</span></footer>
        </a>)}
        {!screenings.length && <div className="lib-empty">Chưa có Screening nào được xuất bản.</div>}
      </div>}
    </section>
    <footer className="lib-footer">InvStock Tracker · Nội dung chỉ phục vụ mục đích nghiên cứu và tham khảo, không phải khuyến nghị mua bán chứng khoán.</footer>
  </main>
}

function useReadingProgress(readingPath, ready) {
  useEffect(() => {
    const save = () => saveReadingProgress(readingPath)
    window.addEventListener('scroll', save, { passive: true })
    return () => { save(); window.removeEventListener('scroll', save) }
  }, [readingPath])
  useEffect(() => {
    if (!ready) return
    try {
      const saved = JSON.parse(localStorage.getItem(READING_PROGRESS_KEY) || 'null')
      if (saved?.path === readingPath && Number.isFinite(Number(saved.scrollY)))
        requestAnimationFrame(() => window.scrollTo({ top: Number(saved.scrollY), behavior: 'instant' }))
    } catch { /* ignore */ }
  }, [ready, readingPath])
}

function Scorecard({ scorecard, criteria }) {
  if (!scorecard) return null
  const names = Object.fromEntries(criteria.map(c => [c.criterion_id, c]))
  return <div className="lib-table-wrap"><table className="lib-table"><thead><tr><th>Tiêu chí</th><th>Trọng số</th><th>Điểm (0–10)</th><th>Nhận định</th></tr></thead><tbody>
    {Object.entries(scorecard.criteria || {}).map(([id, c]) => <tr key={id}>
      <td><strong>{id}</strong> {names[id]?.name || ''}{names[id]?.is_critical ? ' *' : ''}</td><td>{names[id]?.weight ?? '—'}</td>
      <td>{c.score ?? '—'}</td><td>{c.rationale || '—'}</td></tr>)}
  </tbody></table>
  <p className="lib-muted">Coverage {scorecard.coverage}% · Điểm chuẩn hóa {score(scorecard.normalized_score)} · Điểm chính thức {score(scorecard.official_total)} · Độ tin cậy {scorecard.confidence}. * tiêu chí trọng yếu.</p></div>
}

const SECTION_TITLES = { identity: 'Doanh nghiệp', core10: 'Core 10', modules: 'Phân tích chi tiết', committee: 'Hội đồng đầu tư', valuation: 'Định giá', risk: 'Rủi ro', decision: 'Quyết định', catalysts: 'Catalyst', monitoring: 'Theo dõi', sources: 'Nguồn' }

function ResearchPage({ ticker, exchange }) {
  const [data, setData] = useState(null)
  const [criteria, setCriteria] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    Promise.all([readApi({ action: 'research', ticker, exchange }), readApi({ action: 'criteria' }).catch(() => ({ criteria: [] }))])
      .then(([r, c]) => { if (active) { setData(r); setCriteria(c.criteria || []) } })
      .catch(err => { if (active) setError(err.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [ticker, exchange])
  useReadingProgress(`/research/${encodeURIComponent(ticker)}`, Boolean(data))

  const p = data?.payload || {}
  const keys = ['decision', 'valuation', 'risk', 'core10', 'committee', 'modules', 'catalysts', 'monitoring', 'identity'].filter(k => p[k] !== undefined)
  return <main className="lib-shell">
    <Header subtitle={`FULL RESEARCH · ${ticker}`} />
    <div className="lib-breadcrumb"><a href="/">Thư viện</a> / Full Research / {ticker}</div>
    {loading && <div className="lib-empty">Đang tải báo cáo {ticker}...</div>}
    {error && <div className="lib-error">{error}. Báo cáo có thể chưa được công bố công khai.</div>}
    {data && <>
      <section className="lib-report-hero">
        <div className="lib-eyebrow">OFFICIAL RESEARCH · R{data.revision} · DỮ LIỆU ĐẾN {dateText(data.cutoff)}</div>
        <h1>{data.company || ticker} <span>({ticker} · {data.exchange})</span></h1>
        <p>{data.sector} · Kỳ báo cáo: {data.reporting_period}</p>
        <div className="lib-stats">
          <div><strong>{data.decision_status || '—'}</strong><span>Quyết định</span></div>
          <div><strong>{data.risk_gate || '—'}</strong><span>Risk gate</span></div>
          <div><strong>{score(data.official_total ?? data.normalized_score)}</strong><span>{data.official_total == null ? 'Điểm tạm (chưa đủ coverage)' : 'Điểm chính thức'}</span></div>
          <div><strong>{numberText(data.fair_value != null ? Math.round(data.fair_value) : null)}</strong><span>Giá trị hợp lý</span></div>
          <div><strong>{pct(data.mos)}</strong><span>MOS (giá {numberText(data.price)} ngày {dateText(data.price_date)})</span></div>
        </div>
      </section>
      <div className="lib-report-layout">
        <aside className="lib-toc"><strong>NỘI DUNG BÁO CÁO</strong><a href="#section-scorecard">Scorecard</a>{keys.map(k => <a key={k} href={`#section-${k}`}>{SECTION_TITLES[k] || labelText(k)}</a>)}<a href="#section-sources">Nguồn</a></aside>
        <article className="lib-report-content">
          <section className="lib-report-section" id="section-scorecard"><div className="lib-eyebrow">SCORECARD 2.0.0</div><h2>Scorecard 15 tiêu chí</h2><Scorecard scorecard={p.scorecard} criteria={criteria} /></section>
          {keys.map((key, i) => <section className="lib-report-section" id={`section-${key}`} key={key}>
            <div className="lib-eyebrow">SECTION {String(i + 1).padStart(2, '0')}</div>
            <h2>{SECTION_TITLES[key] || labelText(key)}</h2>
            <DataValue value={p[key]} />
          </section>)}
          <section className="lib-report-section" id="section-sources"><div className="lib-eyebrow">REFERENCES</div><h2>Nguồn tham khảo</h2><DataValue value={p.sources || []} /></section>
          <div className="lib-report-meta">Công bố {dateText(data.published_at)} · R{data.revision} · SHA-256 {data.sha256}</div>
        </article>
      </div>
    </>}
    <div className="lib-footer"><a href="/">← Quay lại thư viện</a> · Nội dung phục vụ mục đích nghiên cứu và tham khảo.</div>
  </main>
}

function ScreeningPage({ lineageKey }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    readApi({ action: 'screening', lineage_key: lineageKey }).then(result => { if (active) setData(result) })
      .catch(err => { if (active) setError(err.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [lineageKey])
  const p = data?.payload || {}
  const cands = [...(p.candidates || [])].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
  return <main className="lib-shell">
    <Header subtitle="SCREENING" />
    <div className="lib-breadcrumb"><a href="/">Thư viện</a> / Screening</div>
    {loading && <div className="lib-empty">Đang tải Screening...</div>}
    {error && <div className="lib-error">{error}</div>}
    {data && <><section className="lib-report-hero">
      <div className="lib-eyebrow">SCREENING · R{data.revision} · DỮ LIỆU ĐẾN {dateText(data.cutoff)}</div>
      <h1>{data.strategy || 'Screening'}</h1>
      <p>{data.universe}</p>
      <div className="lib-stats"><div><strong>{cands.length}</strong><span>Số cổ phiếu</span></div><div><strong>{dateText(data.as_of)}</strong><span>As of</span></div><div><strong>{dateText(data.published_at)}</strong><span>Công bố</span></div></div>
    </section>
    <section className="lib-report-section"><h2>Danh sách ứng viên</h2>
      <div className="lib-table-wrap"><table className="lib-table"><thead><tr><th>Rank</th><th>Mã</th><th>Sàn</th><th>Trạng thái</th><th>Điểm</th><th>MOS</th><th>Risk gate</th></tr></thead><tbody>
        {cands.map(c => <tr key={`${c.exchange}-${c.ticker}`}><td>{c.rank ?? '—'}</td><td><strong>{c.ticker}</strong></td><td>{c.exchange}</td><td>{c.disposition}</td><td>{score(c.scorecard?.official_total ?? c.scorecard?.normalized_score)}</td><td>{pct(c.mos)}</td><td>{c.risk_gate || '—'}</td></tr>)}
      </tbody></table></div>
    </section>
    <section className="lib-report-section"><h2>Bộ lọc</h2><DataValue value={p.filters} /></section>
    <section className="lib-report-section"><h2>Giới hạn dữ liệu</h2><DataValue value={p.coverage_limitations} /></section>
    {cands.map(c => <Section key={`${c.exchange}-${c.ticker}`} title={`${c.rank ? `#${c.rank} · ` : ''}${c.ticker}`} defaultOpen={false}><DataValue value={c} /></Section>)}
    <section className="lib-report-section"><h2>Nguồn tham khảo</h2><DataValue value={p.sources} /></section>
    </>}
    <div className="lib-footer"><a href="/">← Quay lại thư viện</a></div>
  </main>
}

export default function PublicLibrary() {
  const path = window.location.pathname.split('/').filter(Boolean)
  const exchange = (new URLSearchParams(window.location.search).get('exchange') || 'HOSE').toUpperCase()
  if (path[0] === 'research' && path[1]) return <ResearchPage ticker={decodeURIComponent(path[1]).toUpperCase()} exchange={exchange} />
  if (path[0] === 'screening' && path[1]) return <ScreeningPage lineageKey={decodeURIComponent(path[1])} />
  return <Home />
}
