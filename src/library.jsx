import React, { useEffect, useMemo, useState } from 'react'
import './style.css'

const API = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/public-research-library`
const API_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

async function readApi(params) {
  const url = new URL(API)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const response = await fetch(url, { headers: { apikey: API_KEY } })
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

function Home() {
  const [data, setData] = useState({ research: [], screenings: [] })
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState('research')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    readApi({ action: 'list' }).then(result => { if (active) setData(result) })
      .catch(err => { if (active) setError(err.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const research = useMemo(() => data.research.filter(item => `${item.ticker} ${item.thesis_summary || ''}`.toLowerCase().includes(query.toLowerCase())), [data.research, query])
  const screenings = useMemo(() => data.screenings.filter(item => `${item.screening_name || ''} ${item.id}`.toLowerCase().includes(query.toLowerCase())), [data.screenings, query])

  return <main className="lib-shell">
    <Header />
    <section className="lib-hero">
      <div className="lib-eyebrow">PUBLIC RESEARCH LIBRARY</div>
      <h1>Research có chiều sâu.<br/><em>Quyết định có cơ sở.</em></h1>
      <p>Thư viện báo cáo phân tích doanh nghiệp, định giá và sàng lọc cổ phiếu của InvStock Tracker.</p>
      <div className="lib-stats">
        <div><strong>{data.research.length}</strong><span>Full Research đã công bố</span></div>
        <div><strong>{data.screenings.length}</strong><span>Screening đã đồng bộ</span></div>
      </div>
    </section>

    <section className="lib-library">
      <div className="lib-library-top">
        <div><div className="lib-eyebrow">KNOWLEDGE BASE</div><h2>Khám phá báo cáo</h2></div>
        <input className="lib-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm mã cổ phiếu hoặc tên báo cáo..." />
      </div>
      <div className="lib-tabs">
        <button className={tab === 'research' ? 'active' : ''} onClick={() => setTab('research')}>Full Research ({data.research.length})</button>
        <button className={tab === 'screenings' ? 'active' : ''} onClick={() => setTab('screenings')}>Screening ({data.screenings.length})</button>
      </div>
      {loading && <div className="lib-empty">Đang tải thư viện...</div>}
      {error && <div className="lib-error">Không thể tải thư viện: {error}</div>}
      {!loading && !error && tab === 'research' && <div className="lib-cards">
        {research.map(item => <a className="lib-card" href={`/research/${encodeURIComponent(item.ticker)}`} key={item.ticker}>
          <div className="lib-card-top"><span className="lib-ticker">{item.ticker}</span><span className="lib-published">ĐÃ CÔNG BỐ</span></div>
          <h3>{item.ticker} · {item.overall_rating || item.official_grade || 'Full Research'}</h3>
          <p>{item.thesis_summary || 'Báo cáo phân tích doanh nghiệp và định giá.'}</p>
          <div className="lib-card-metrics"><span>Score <b>{numberText(item.score)}</b></span><span>Risk <b>{item.risk_level || '—'}</b></span><span>Version <b>{item.version_no ?? '—'}</b></span></div>
          <footer>Ngày nghiên cứu {dateText(item.research_date)} <span>Đọc báo cáo →</span></footer>
        </a>)}
        {!research.length && <div className="lib-empty">{data.research.length ? 'Không tìm thấy mã phù hợp.' : 'Chưa có Full Research nào được công bố. Các báo cáo sẽ tự xuất hiện sau khi được duyệt và đồng bộ thành công.'}</div>}
      </div>}
      {!loading && !error && tab === 'screenings' && <div className="lib-cards">
        {screenings.map(item => <a className="lib-card" href={`/screening/${item.id}`} key={item.id}>
          <div className="lib-card-top"><span className="lib-ticker">SCREENING</span><span className="lib-published">SYNCED</span></div>
          <h3>{item.screening_name || 'Screening Snapshot'}</h3>
          <p>{item.summary?.overview || item.summary?.summary || 'Báo cáo sàng lọc cổ phiếu và xếp hạng ứng viên.'}</p>
          <div className="lib-card-metrics"><span>Ngày <b>{dateText(item.screening_date)}</b></span><span>Universe <b>{item.universe?.name || item.universe?.market || 'VN'}</b></span></div>
          <footer>Đã đồng bộ {dateText(item.approved_at)} <span>Xem kết quả →</span></footer>
        </a>)}
        {!screenings.length && <div className="lib-empty">Chưa có Screening Snapshot nào được đồng bộ thành công.</div>}
      </div>}
    </section>
    <footer className="lib-footer">InvStock Tracker · Nội dung chỉ phục vụ mục đích nghiên cứu và tham khảo, không phải khuyến nghị mua bán chứng khoán.</footer>
  </main>
}

function ResearchPage({ ticker }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    readApi({ action: 'research', ticker }).then(result => { if (active) setData(result) })
      .catch(err => { if (active) setError(err.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [ticker])

  const payload = data?.version?.payload || {}
  const preferred = ['metadata','executive_summary','investment_thesis','company_profile','financial_analysis','valuation','scorecard','technical_analysis','ownership_and_flows','catalysts','risks','investment_decision','data_quality','sources']
  const keys = [...preferred.filter(k => payload[k] !== undefined), ...Object.keys(payload).filter(k => !preferred.includes(k))]
  return <main className="lib-shell">
    <Header subtitle={`FULL RESEARCH · ${ticker}`} />
    <div className="lib-breadcrumb"><a href="/">Thư viện</a> / Full Research / {ticker}</div>
    {loading && <div className="lib-empty">Đang tải báo cáo {ticker}...</div>}
    {error && <div className="lib-error">{error}. Báo cáo có thể chưa được công bố công khai.</div>}
    {data && <>
      <section className="lib-report-hero">
        <div className="lib-eyebrow">OFFICIAL RESEARCH · VERSION {data.version.version_no}</div>
        <h1>{payload.metadata?.company_name || ticker} <span>({ticker})</span></h1>
        <p>{payload.executive_summary?.summary || data.version.thesis_summary || 'Báo cáo phân tích đầu tư.'}</p>
        <div className="lib-stats">
          <div><strong>{numberText(data.version.score ?? data.publication.official_score)}</strong><span>Investment Score</span></div>
          <div><strong>{data.version.overall_rating || data.publication.official_grade || '—'}</strong><span>Rating</span></div>
          <div><strong>{data.version.risk_level || '—'}</strong><span>Risk Level</span></div>
          <div><strong>{dateText(data.session?.research_date)}</strong><span>Research date</span></div>
        </div>
      </section>
      <div className="lib-report-layout">
        <aside className="lib-toc"><strong>NỘI DUNG BÁO CÁO</strong>{keys.map(k => <a key={k} href={`#section-${k}`}>{labelText(k)}</a>)}<a href="#research-sources">Nguồn tham khảo</a></aside>
        <article className="lib-report-content">
          {keys.map((key, i) => <section className="lib-report-section" id={`section-${key}`} key={key}>
            <div className="lib-eyebrow">SECTION {String(i + 1).padStart(2, '0')}</div>
            <h2>{labelText(key)}</h2>
            <DataValue value={payload[key]} />
          </section>)}
          <section className="lib-report-section" id="research-sources"><div className="lib-eyebrow">REFERENCES</div><h2>Nguồn tham khảo</h2>
            {data.sources.length ? data.sources.map((source, i) => <div className="lib-source" key={i}><strong>{source.source_title || 'Nguồn dữ liệu'}</strong><span>{source.publisher} · {dateText(source.published_at || source.retrieved_at)}</span>{source.url && <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>}{source.notes && <p>{source.notes}</p>}</div>) : <DataValue value={payload.sources || []} />}
          </section>
          <div className="lib-report-meta">Công bố {dateText(data.publication.published_at)} · Phiên bản {data.version.version_no} · InvStock Tracker</div>
        </article>
      </div>
    </>}
    <div className="lib-footer"><a href="/">← Quay lại thư viện</a> · Nội dung phục vụ mục đích nghiên cứu và tham khảo.</div>
  </main>
}

function ScreeningPage({ id }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    readApi({ action: 'screening', id }).then(result => { if (active) setData(result) })
      .catch(err => { if (active) setError(err.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [id])
  return <main className="lib-shell">
    <Header subtitle="SCREENING SNAPSHOT" />
    <div className="lib-breadcrumb"><a href="/">Thư viện</a> / Screening</div>
    {loading && <div className="lib-empty">Đang tải Screening Snapshot...</div>}
    {error && <div className="lib-error">{error}</div>}
    {data && <><section className="lib-report-hero">
      <div className="lib-eyebrow">SCREENING · SYNCED & VERIFIED</div>
      <h1>{data.run.screening_name || 'Screening Snapshot'}</h1>
      <p>{data.run.summary?.overview || data.run.summary?.summary || 'Kết quả sàng lọc cổ phiếu.'}</p>
      <div className="lib-stats"><div><strong>{data.candidates.length}</strong><span>Số cổ phiếu</span></div><div><strong>{dateText(data.run.screening_date)}</strong><span>Ngày sàng lọc</span></div><div><strong>{dateText(data.run.approved_at)}</strong><span>Ngày đồng bộ</span></div></div>
    </section>
    <section className="lib-report-section"><h2>Danh sách ứng viên</h2>
      <div className="lib-table-wrap"><table className="lib-table"><thead><tr><th>Rank</th><th>Ticker</th><th>Doanh nghiệp</th><th>Score</th><th>Rating</th><th>Decision</th></tr></thead><tbody>
        {data.candidates.map(c => <tr key={c.ticker}><td>{c.rank ?? '—'}</td><td><strong>{c.ticker}</strong></td><td>{c.company_name || '—'}</td><td>{numberText(c.score)}</td><td>{c.rating || '—'}</td><td>{c.decision || '—'}</td></tr>)}
      </tbody></table></div>
    </section>
    <section className="lib-report-section"><h2>Phương pháp và tiêu chí</h2><DataValue value={data.run.methodology} /></section>
    <section className="lib-report-section"><h2>Tóm tắt và chất lượng dữ liệu</h2><DataValue value={{summary:data.run.summary,data_quality:data.run.data_quality,filters:data.run.filters,universe:data.run.universe}} /></section>
    {data.candidates.map(c => <Section key={c.ticker} title={`${c.rank ? `#${c.rank} · ` : ''}${c.ticker} · ${c.company_name || ''}`} defaultOpen={false}>
      <DataValue value={c.candidate_snapshot || {score:c.score,rating:c.rating,decision:c.decision,reasons:c.reasons,metrics:c.metrics,risks:c.risks,source_refs:c.source_refs}} />
    </Section>)}
    <section className="lib-report-section"><h2>Nguồn tham khảo</h2><DataValue value={data.run.source_refs} /></section>
    </>}
    <div className="lib-footer"><a href="/">← Quay lại thư viện</a></div>
  </main>
}

export default function PublicLibrary() {
  const path = window.location.pathname.split('/').filter(Boolean)
  if (path[0] === 'research' && path[1]) return <ResearchPage ticker={decodeURIComponent(path[1]).toUpperCase()} />
  if (path[0] === 'screening' && path[1]) return <ScreeningPage id={decodeURIComponent(path[1])} />
  return <Home />
}
