
import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createClient } from '@supabase/supabase-js'
import './style.css'
import PublicLibrary from './library.jsx'
import './library.css'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

const RESEARCH_APPROVAL =
  'TÔI ĐỒNG Ý ĐỒNG BỘ PAYLOAD NÀY VÀO SUPABASE'

const DEFAULT_EMAIL = 'hoanghiep32@gmail.com'

const supabase = createClient(
  SUPABASE_URL || '',
  SUPABASE_KEY || '',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  }
)

async function sha256(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)

  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function App() {
  const [lastReading] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('invstock_last_reading_v1') || 'null')
      const path = typeof saved?.path === 'string' ? saved.path : ''
      return path.startsWith('/research/') || path.startsWith('/screening/') ? saved : null
    } catch {
      return null
    }
  })
  const [session, setSession] = useState(null)
  const [authReady, setAuthReady] = useState(false)

  const [email, setEmail] = useState(DEFAULT_EMAIL)
  const [password, setPassword] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authPrompt, setAuthPrompt] = useState(false)
  const [pendingSync, setPendingSync] = useState(false)

  const [mode, setMode] = useState('research')
  const [raw, setRaw] = useState('')
  const [payload, setPayload] = useState(null)
  const [payloadHash, setPayloadHash] = useState('')

  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)

  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [promptSummary, setPromptSummary] = useState('')

  // Khôi phục payload đã được người dùng chấp thuận trước khi đăng nhập.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('invstock_pending_sync_v1')
      if (!saved) return
      const pending = JSON.parse(saved)
      const fresh = Date.now() - Number(pending.createdAt || 0) < 30 * 60 * 1000
      if (!fresh || !pending.payload || !pending.payloadHash || pending.consent !== true) {
        sessionStorage.removeItem('invstock_pending_sync_v1')
        return
      }
      setMode(pending.mode === 'screening' ? 'screening' : 'research')
      setPayload(pending.payload)
      setRaw(JSON.stringify(pending.payload, null, 2))
      setPayloadHash(pending.payloadHash)
      setConsent(true)
      setPromptSummary(pending.promptSummary || '')
      setPendingSync(true)
      setMessage('Đã khôi phục payload đã chấp thuận. Đang chờ xác thực để tiếp tục Sync.')
    } catch {
      sessionStorage.removeItem('invstock_pending_sync_v1')
    }
  }, [])

  // =========================================================
  // AUTH INITIALIZATION
  // Restore the existing persistent session.
  // =========================================================
  useEffect(() => {
    let active = true

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return

      setSession(nextSession)
      setAuthReady(true)

      if (event === 'SIGNED_IN') {
        setAuthPrompt(false)
        setPassword('')
        setAuthPrompt(false)
        setMessage('Đăng nhập thành công. Đang tiếp tục đồng bộ payload đã chấp thuận...')
        setError('')
      }

      if (event === 'SIGNED_OUT') {
        setSession(null)
      }
    })

    supabase.auth.getSession()
      .then(({ data, error }) => {
        if (!active) return

        if (error) {
          setError(error.message)
        }

        setSession(data?.session || null)
        setAuthReady(true)
      })
      .catch(err => {
        if (!active) return

        setError(
          err.message ||
          'Không thể khởi tạo phiên đăng nhập Supabase.'
        )

        setAuthReady(true)
      })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  // =========================================================
  // PREVIEW INFORMATION
  // =========================================================
  const previewInfo = useMemo(() => {
    if (!payload) return null

    if (mode === 'research') {
      return {
        type: 'Full Research',
        ticker:
          payload?.metadata?.ticker ||
          'Chưa có metadata.ticker',
        label: payload?.metadata?.company_name || ''
      }
    }

    return {
      type: 'Screening Snapshot',
      ticker: `${payload?.candidates?.length || 0} mã`,
      label: payload?.screening_name || 'Screening'
    }
  }, [payload, mode])

  // =========================================================
  // EMAIL + PASSWORD SIGN-IN (NO EMAIL DELIVERY)
  // =========================================================
  async function signIn(e) {
    e.preventDefault()
    if (authBusy) return

    setError('')
    setMessage('')
    setAuthBusy(true)

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      })

      if (error) throw error

      setPassword('')
      setAuthPrompt(false)
      setMessage('Đăng nhập thành công. Đang tiếp tục đồng bộ payload đã chấp thuận...')
    } catch (err) {
      setError(err.message || 'Đăng nhập không thành công. Hãy kiểm tra email và mật khẩu.')
    } finally {
      setAuthBusy(false)
    }
  }

  // =========================================================
  // SIGN OUT
  // =========================================================
  async function signOut() {
    setError('')
    setMessage('')

    const { error } = await supabase.auth.signOut()

    if (error) {
      setError(error.message)
      return
    }

    setSession(null)
    setPassword('')
    setAuthPrompt(false)
    // Giữ nguyên payload, Preview và Approval khi đăng xuất.
    setMessage('Đã đăng xuất. Payload và Preview hiện tại vẫn được giữ lại.')
  }

  // =========================================================
  // RESET PAYLOAD
  // =========================================================
  function resetPayload(nextMode = mode) {
    setMode(nextMode)
    setRaw('')
    setPayload(null)
    setPayloadHash('')
    setConsent(false)
    setResult(null)
    setError('')
    setMessage('')
    setPromptSummary('')
    setPendingSync(false)
  }

  // =========================================================
  // LOAD JSON FILE
  // =========================================================
  async function loadFile(file) {
    if (!file) return

    try {
      const text = await file.text()

      setRaw(text)
      setPayload(null)
      setPayloadHash('')
      setConsent(false)
      setResult(null)
      setError('')

      setMessage(
        `Đã đọc tệp ${file.name}. Nhấn “Kiểm tra & tạo bản xem trước”.`
      )
    } catch (err) {
      setError(err.message || 'Không đọc được tệp.')
    }
  }

  // =========================================================
  // VALIDATE AND PREVIEW JSON
  // =========================================================
  async function makePreview() {
    setError('')
    setMessage('')
    setResult(null)
    setConsent(false)

    try {
      const parsed = JSON.parse(raw)

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Payload phải là một JSON object.')
      }

      if (mode === 'research') {
        const requiredSections = [
          'metadata', 'company_profile', 'executive_summary', 'investment_thesis',
          'financial_analysis', 'valuation', 'scorecard', 'technical_analysis',
          'ownership_and_flows', 'catalysts', 'risks', 'investment_decision',
          'sources', 'data_quality'
        ]
        const missing = requiredSections.filter(key =>
          !Object.prototype.hasOwnProperty.call(parsed, key)
        )
        const wrongTypes = requiredSections.filter(key => {
          if (!Object.prototype.hasOwnProperty.call(parsed, key)) return false
          return ['catalysts', 'risks', 'sources'].includes(key)
            ? !Array.isArray(parsed[key])
            : (!parsed[key] || typeof parsed[key] !== 'object' || Array.isArray(parsed[key]))
        })

        if (!parsed.metadata?.ticker) {
          throw new Error('Thiếu metadata.ticker trong Full Research JSON.')
        }
        if (missing.length || wrongTypes.length) {
          const details = [
            missing.length ? `Thiếu section bắt buộc: ${missing.join(', ')}.` : '',
            wrongTypes.length ? `Sai kiểu dữ liệu section: ${wrongTypes.join(', ')}.` : ''
          ].filter(Boolean).join(' ')
          throw new Error(`Full Research chưa đủ chuẩn invstock_research_v1. ${details} Chưa tạo Preview/Approval và không thể Sync.`)
        }
        if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
          throw new Error('Full Research phải có ít nhất 1 nguồn trong sources[].')
        }
        const expectedCriteria = [
          'business_quality', 'growth', 'profitability', 'financial_strength',
          'cash_flow', 'management', 'valuation', 'catalysts', 'risk',
          'industry', 'technical', 'ownership', 'transparency',
          'capital_allocation', 'portfolio_fit'
        ]
        if (!Array.isArray(parsed.scorecard?.criteria) || parsed.scorecard.criteria.length !== expectedCriteria.length) {
          throw new Error('Scorecard phải có đủ 15 tiêu chí theo framework invstock_15_v1.')
        }
        const suppliedKeys = parsed.scorecard.criteria.map(item => item?.criterion_key).sort()
        const expectedKeys = [...expectedCriteria].sort()
        if (new Set(suppliedKeys).size !== expectedCriteria.length ||
            expectedKeys.some((key, index) => key !== suppliedKeys[index])) {
          throw new Error('Scorecard phải có đúng 15 criterion_key của framework invstock_15_v1, không thiếu, không trùng và không dùng key lạ.')
        }
        const invalidCriteria = parsed.scorecard.criteria.filter(item => {
          const score = item?.raw_score ?? item?.raw_score_0_10
          return !item?.criterion_key || score === undefined || score === null ||
            score === '' || !Number.isFinite(Number(score)) ||
            Number(score) < 0 || Number(score) > 10
        })
        if (invalidCriteria.length) {
          throw new Error(`Có ${invalidCriteria.length} tiêu chí Scorecard thiếu criterion_key hoặc điểm hợp lệ 0–10.`)
        }
      } else {
        if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
          throw new Error('Screening Snapshot phải có mảng candidates không rỗng.')
        }
        const seen = new Set()
        for (const item of parsed.candidates) {
          const ticker = String(item?.ticker || '').trim().toUpperCase()
          if (!ticker) throw new Error('Mỗi candidate phải có ticker.')
          if (seen.has(ticker)) throw new Error(`Ticker ${ticker} bị trùng trong candidates.`)
          seen.add(ticker)
        }
      }

      const serialized = JSON.stringify(parsed)
      if (new TextEncoder().encode(serialized).length > 2_000_000) {
        throw new Error('Payload vượt quá giới hạn 2 MB.')
      }

      const hash = await sha256(serialized)
      setPayload(parsed)
      setPayloadHash(hash)
      setMessage('Payload đã vượt qua kiểm tra cấu trúc sơ bộ và tạo hash. Hãy kiểm tra nội dung trước khi chấp thuận.')
    } catch (err) {
      setPayload(null)
      setPayloadHash('')
      setConsent(false)
      setError(err.message || 'JSON không hợp lệ.')
    }
  }

  // =========================================================
  // SYNC PAYLOAD
  // =========================================================
  async function syncNow() {
    if (!payload || !consent || !payloadHash) return
    if (!session) {
      try {
        sessionStorage.setItem('invstock_pending_sync_v1', JSON.stringify({
          mode,
          payload,
          payloadHash,
          consent: true,
          promptSummary,
          createdAt: Date.now()
        }))
      } catch {
        setError('Không thể lưu yêu cầu Sync trong phiên trình duyệt. Hãy giữ tab này mở và thử lại.')
        return
      }
      setPendingSync(true)
      setAuthPrompt(true)
      setError('')
      setMessage('Để đồng bộ vào Supabase, bạn cần xác thực tài khoản được cấp quyền. Payload, Preview và Approval sẽ được giữ nguyên.')
      return
    }

    const currentHash = await sha256(JSON.stringify(payload))
    if (currentHash !== payloadHash) {
      setError('Payload đã thay đổi so với SHA-256 được chấp thuận. Hãy tạo Preview và chấp thuận lại.')
      setConsent(false)
      setPendingSync(false)
      sessionStorage.removeItem('invstock_pending_sync_v1')
      return
    }

    setBusy(true)
    setError('')
    setMessage('')
    setResult(null)

    try {
      const isResearch = mode === 'research'

      const functionName = isResearch
        ? 'portal-research-sync'
        : 'portal-screening-sync'

      const body = isResearch
        ? {
            action: 'sync_approved_research',
            payload,
            payload_sha256: payloadHash,
            approval_text: RESEARCH_APPROVAL,
            prompt_summary: promptSummary
          }
        : {
            action: 'sync_approved_snapshot',
            snapshot: payload,
            approval_text: 'đồng ý đồng bộ'
          }

      const { data, error } =
        await supabase.functions.invoke(functionName, {
          body
        })

      if (error) {
        let details =
          error.message || 'Edge Function trả về lỗi.'

        if (error.context?.json) {
          try {
            const responseBody = await error.context.json()

            details =
              responseBody.detail ||
              responseBody.error ||
              details
          } catch {
            // Keep original error
          }
        }

        throw new Error(details)
      }

      if (
        !data?.success ||
        data?.status !== 'SYNCED'
      ) {
        throw new Error(
          data?.error ||
          'Chưa có xác nhận persistence từ Supabase.'
        )
      }

      setResult(data)

      setMessage(
        'Supabase đã xác nhận ghi dữ liệu và kiểm tra persistence thành công.'
      )

      setConsent(false)
      sessionStorage.removeItem('invstock_pending_sync_v1')
    } catch (err) {
      setError(err.message || 'Đồng bộ thất bại.')
    } finally {
      setBusy(false)
    }
  }

  // Sau khi đăng nhập tạo session, tự tiếp tục Sync payload đã được chấp thuận.
  useEffect(() => {
    if (session && pendingSync && authReady && !busy) {
      setPendingSync(false)
      syncNow()
    }
  }, [session, pendingSync, authReady, busy])

  // =========================================================
  // CONFIGURATION CHECK
  // =========================================================
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return (
      <main className="shell">
        <section className="panel">
          <h1>InvStock Sync Portal</h1>

          <p className="danger">
            Thiếu cấu hình VITE_SUPABASE_URL hoặc
            VITE_SUPABASE_PUBLISHABLE_KEY.
          </p>

          <p>
            Hãy khai báo hai biến môi trường trong nền tảng
            hosting rồi build lại.
          </p>
        </section>
      </main>
    )
  }

  // =========================================================
  // MAIN UI
  // =========================================================
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">
            INVSTOCK TRACKER · SECURE SYNC
          </div>

          <h1>Sync Portal</h1>

          <p className="muted">
            Full Research & Screening · Mở trực tiếp, chỉ xác thực khi đồng bộ
          </p>
        </div>

        <nav className="admin-navigation" aria-label="Điều hướng">
          <a className="button secondary" href={lastReading?.path || '/'}>
            ← {lastReading ? 'Quay lại bài đang đọc' : 'Mở Research Library'}
          </a>
          <a className="button subtle" href="/">
            Thư viện Research
          </a>
        </nav>

        {session && (
          <div className="account">
            <span className="online"></span>

            <span>{session.user.email}</span>

            <button
              className="button subtle"
              onClick={signOut}
            >
              Đăng xuất
            </button>
          </div>
        )}
      </header>

      {false ? (
        <></>
      ) : (
        <>
          <section className="notice">
            <strong>Quy tắc an toàn:</strong> Có thể nghiên cứu và xem Preview mà không đăng nhập. Khi Sync, Supabase vẫn xác minh JWT và quyền admin/reviewer ở backend. Dữ liệu chỉ được gửi sau khi bạn kiểm tra Preview và chấp thuận payload.
          </section>

          <section className="panel">
            <div className="section-head">
              <div>
                <h2>1. Chọn loại dữ liệu</h2>

                <p className="muted">
                  Hai hợp đồng dữ liệu riêng biệt,
                  không chuyển đổi lẫn nhau.
                </p>
              </div>

              <div className="tabs">
                <button
                  className={
                    mode === 'research'
                      ? 'tab active'
                      : 'tab'
                  }
                  onClick={() => resetPayload('research')}
                >
                  Full Research
                </button>

                <button
                  className={
                    mode === 'screening'
                      ? 'tab active'
                      : 'tab'
                  }
                  onClick={() => resetPayload('screening')}
                >
                  Screening
                </button>
              </div>
            </div>

            <h2>2. Nạp JSON</h2>

            <div className="file-row">
              <label className="button secondary file-button">
                Chọn tệp JSON

                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={e =>
                    loadFile(e.target.files?.[0])
                  }
                />
              </label>

              <span className="muted">
                hoặc dán JSON trực tiếp vào ô bên dưới
              </span>
            </div>

            <textarea
              value={raw}
              onChange={e => {
                setRaw(e.target.value)
                setPayload(null)
                setPayloadHash('')
                setConsent(false)
                setResult(null)
              }}
              spellCheck="false"
              placeholder={
                mode === 'research'
                  ? 'Dán invstock_research_v1 JSON tại đây…'
                  : 'Dán Screening Snapshot JSON tại đây…'
              }
            />

            {mode === 'research' && (
              <div className="field">
                <label>
                  Ghi chú yêu cầu nghiên cứu (không bắt buộc)
                </label>

                <input
                  value={promptSummary}
                  onChange={e =>
                    setPromptSummary(e.target.value)
                  }
                  placeholder="Ví dụ: Full Research MBB phiên bản đầu tiên"
                />
              </div>
            )}

            <button
              className="button secondary"
              onClick={makePreview}
              disabled={!raw.trim()}
            >
              Kiểm tra & tạo bản xem trước
            </button>
          </section>

          {payload && (
            <section className="panel">
              <h2>3. Bản xem trước & kiểm tra</h2>

              <div className="summary-grid">
                <div className="summary-cell">
                  <span>Loại dữ liệu</span>
                  <strong>{previewInfo.type}</strong>
                </div>

                <div className="summary-cell">
                  <span>Mã chứng khoán / số lượng</span>
                  <strong>{previewInfo.ticker}</strong>
                </div>

                <div className="summary-cell">
                  <span>Hash SHA-256</span>
                  <code>{payloadHash}</code>
                </div>
              </div>

              {previewInfo.label && (
                <p className="muted">{previewInfo.label}</p>
              )}

              <details className="payload-details">
                <summary>
                  Xem toàn bộ JSON (
                  {new TextEncoder()
                    .encode(JSON.stringify(payload))
                    .length.toLocaleString()}
                  {' '}bytes)
                </summary>

                <pre>
                  {JSON.stringify(payload, null, 2)}
                </pre>
              </details>

              <div className="approval">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={e =>
                      setConsent(e.target.checked)
                    }
                  />

                  <span>
                    <strong>
                      Tôi đã kiểm tra bản xem trước và đồng ý
                      đồng bộ chính xác payload này vào Supabase.
                    </strong>

                    <small>
                      Chấp thuận gắn với SHA-256 ở trên.
                      Nếu sửa JSON, bạn phải tạo preview
                      và chấp thuận lại.
                    </small>
                  </span>
                </label>

                <button
                  className="button danger-button"
                  disabled={!consent || busy}
                  onClick={syncNow}
                >
                  {busy
                    ? 'Đang đồng bộ và xác minh…'
                    : `XÁC NHẬN ĐỒNG BỘ ${
                        mode === 'research'
                          ? 'FULL RESEARCH'
                          : 'SCREENING'
                      }`}
                </button>
              </div>
            </section>
          )}

          {result && (
            <section className="panel success-panel">
              <div className="success-title">
                SYNCED · Persistence verified
              </div>

              <p>
                <strong>
                  {result.ticker || previewInfo?.ticker}
                </strong>{' '}
                đã được ghi thành công.
              </p>

              <dl className="result-grid">
                {Object.entries(result).map(
                  ([key, value]) => (
                    <React.Fragment key={key}>
                      <dt>{key}</dt>

                      <dd>
                        {typeof value === 'object'
                          ? JSON.stringify(value)
                          : String(value)}
                      </dd>
                    </React.Fragment>
                  )
                )}
              </dl>
            </section>
          )}
        </>
      )}


      {authPrompt && !session && (
        <section className="panel auth-panel">
          <h2>Đăng nhập để tiếp tục đồng bộ</h2>
          <p className="muted">
            Dùng tài khoản admin đã có trong Supabase. Cách đăng nhập này không gửi email.
            Sau khi đăng nhập, Portal sẽ tự tiếp tục đồng bộ payload đã Preview và chấp thuận.
          </p>
          <form onSubmit={signIn}>
            <label>Email Supabase</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder="email@example.com"
              autoComplete="username"
            />
            <label>Mật khẩu</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              placeholder="Nhập mật khẩu Supabase"
            />
            <button className="button primary" disabled={authBusy || !email.trim() || !password}>
              {authBusy ? 'Đang xác thực…' : 'Đăng nhập & tiếp tục Sync'}
            </button>
          </form>
          <div className="hint">
            Chỉ tài khoản có vai trò admin đang hoạt động mới được phép đồng bộ.
            Mật khẩu không được lưu vào hệ thống hoặc gửi qua email.
          </div>
          <button
            className="button subtle"
            type="button"
            onClick={() => {
              setAuthPrompt(false)
              setPendingSync(false)
              sessionStorage.removeItem('invstock_pending_sync_v1')
              setMessage('Đã hủy yêu cầu Sync. Payload và Preview vẫn được giữ nguyên.')
            }}
          >
            Để sau, quay lại Preview
          </button>
        </section>
      )}

      {message && (
        <div className="message">{message}</div>
      )}

      {error && (
        <div className="error">
          <strong>Chưa hoàn tất:</strong> {error}
        </div>
      )}

      <footer>
        InvStock Tracker · Project ref:
        {' '}uupmlkgnyowlertktsbw · Không kết nối tài khoản
        công ty chứng khoán · Không có quyền đặt lệnh
      </footer>
    </main>
  )
}

const isAdminPortal = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/')
createRoot(document.getElementById('root')).render(isAdminPortal ? <App /> : <PublicLibrary />)
