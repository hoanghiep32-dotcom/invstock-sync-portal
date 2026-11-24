import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createClient } from '@supabase/supabase-js'
import './style.css'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const RESEARCH_APPROVAL = 'TÔI ĐỒNG Ý ĐỒNG BỘ PAYLOAD NÀY VÀO SUPABASE'
const DEFAULT_EMAIL = 'hoanghiep32@gmail.com'

const supabase = createClient(SUPABASE_URL || '', SUPABASE_KEY || '', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
})

async function sha256(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function App() {
  const [session, setSession] = useState(null)
  const [email, setEmail] = useState(DEFAULT_EMAIL)
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [authBusy, setAuthBusy] = useState(false)
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

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  const previewInfo = useMemo(() => {
    if (!payload) return null
    if (mode === 'research') {
      return {
        type: 'Full Research',
        ticker: payload?.metadata?.ticker || 'Chưa có metadata.ticker',
        label: payload?.metadata?.company_name || '',
      }
    }
    return {
      type: 'Screening Snapshot',
      ticker: `${payload?.candidates?.length || 0} mã`,
      label: payload?.screening_name || 'Screening',
    }
  }, [payload, mode])

  async function sendOtp(e) {
    e.preventDefault()
    setError(''); setMessage(''); setAuthBusy(true)
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false, emailRedirectTo: window.location.origin }
      })
      if (error) throw error
      setOtpSent(true)
      setMessage('Đã gửi mã OTP. Hãy kiểm tra hộp thư và cả mục Spam/Junk.')
    } catch (err) {
      setError(err.message || 'Không gửi được OTP.')
    } finally { setAuthBusy(false) }
  }

  async function verifyOtp(e) {
    e.preventDefault()
    setError(''); setMessage(''); setAuthBusy(true)
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: email.trim(), token: otp.trim(), type: 'email'
      })
      if (error) throw error
      setSession(data.session)
      setMessage('Đăng nhập thành công.')
    } catch (err) {
      setError(err.message || 'Mã OTP không hợp lệ hoặc đã hết hạn.')
    } finally { setAuthBusy(false) }
  }

  async function signOut() {
    await supabase.auth.signOut()
    setSession(null); setOtp(''); setOtpSent(false)
    setMessage('Đã đăng xuất.')
  }

  function resetPayload(nextMode = mode) {
    setMode(nextMode); setRaw(''); setPayload(null); setPayloadHash('')
    setConsent(false); setResult(null); setError(''); setMessage('')
  }

  async function loadFile(file) {
    if (!file) return
    setRaw(await file.text())
    setPayload(null); setPayloadHash(''); setConsent(false); setResult(null)
    setError(''); setMessage(`Đã đọc tệp ${file.name}. Nhấn “Kiểm tra & tạo bản xem trước”.`)
  }

  async function makePreview() {
    setError(''); setMessage(''); setResult(null); setConsent(false)
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Payload phải là một JSON object.')
      }
      if (mode === 'research') {
        if (!parsed.metadata?.ticker) throw new Error('Thiếu metadata.ticker trong Full Research JSON.')
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
      setPayload(parsed)
      setPayloadHash(await sha256(serialized))
      setMessage('Payload đã được parse và tạo hash. Hãy kiểm tra nội dung trước khi chấp thuận.')
    } catch (err) {
      setPayload(null); setPayloadHash('')
      setError(err.message || 'JSON không hợp lệ.')
    }
  }

  async function syncNow() {
    if (!session || !payload || !consent || !payloadHash) return
    setBusy(true); setError(''); setMessage(''); setResult(null)
    try {
      const isResearch = mode === 'research'
      const functionName = isResearch ? 'portal-research-sync' : 'portal-screening-sync'
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
      const { data, error } = await supabase.functions.invoke(functionName, { body })
      if (error) {
        let details = error.message || 'Edge Function trả về lỗi.'
        if (error.context?.json) {
          try {
            const body = await error.context.json()
            details = body.detail || body.error || details
          } catch {}
        }
        throw new Error(details)
      }
      if (!data?.success || data?.status !== 'SYNCED') {
        throw new Error(data?.error || 'Chưa có xác nhận persistence từ Supabase.')
      }
      setResult(data)
      setMessage('Supabase đã xác nhận ghi dữ liệu và kiểm tra persistence thành công.')
      setConsent(false)
    } catch (err) {
      setError(err.message || 'Đồng bộ thất bại.')
    } finally { setBusy(false) }
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return <main className="shell"><section className="panel"><h1>InvStock Sync Portal</h1><p className="danger">Thiếu cấu hình VITE_SUPABASE_URL hoặc VITE_SUPABASE_PUBLISHABLE_KEY.</p><p>Hãy khai báo hai biến môi trường trong nền tảng hosting rồi build lại.</p></section></main>
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">INVSTOCK TRACKER · SECURE SYNC</div>
          <h1>Sync Portal</h1>
          <p className="muted">Cổng đồng bộ có xác thực · Option B · Không tự động ghi dữ liệu</p>
        </div>
        {session && <div className="account"><span className="online"></span><span>{session.user.email}</span><button className="button subtle" onClick={signOut}>Đăng xuất</button></div>}
      </header>

      {!session ? (
        <section className="panel auth-panel">
          <h2>Đăng nhập Supabase</h2>
          <p className="muted">Dùng email đã được cấp quyền admin trong project Stock Analysis. Portal gửi mã OTP một lần; không tạo tài khoản mới.</p>
          <form onSubmit={sendOtp}>
            <label>Email Supabase</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="email@example.com" />
            <button className="button primary" disabled={authBusy}>{authBusy ? 'Đang gửi…' : 'Gửi mã OTP'}</button>
          </form>
          {otpSent && <form onSubmit={verifyOtp} className="otp-form">
            <label>Mã OTP trong email</label>
            <input value={otp} onChange={e => setOtp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} required placeholder="Nhập mã OTP" />
            <button className="button primary" disabled={authBusy || !otp.trim()}>{authBusy ? 'Đang xác thực…' : 'Xác thực và đăng nhập'}</button>
          </form>}
          <div className="hint">Chỉ tài khoản có vai trò admin đang hoạt động mới được phép đồng bộ. Đăng nhập thành công không đồng nghĩa được cấp quyền ghi.</div>
        </section>
      ) : (
        <>
          <section className="notice">
            <strong>Quy tắc an toàn:</strong> Portal chỉ gửi dữ liệu sau khi bạn kiểm tra bản xem trước và tích xác nhận. Hash được kiểm tra lại ở Edge Function. `service_role` không được đưa xuống trình duyệt.
          </section>
          <section className="panel">
            <div className="section-head">
              <div><h2>1. Chọn loại dữ liệu</h2><p className="muted">Hai hợp đồng dữ liệu riêng biệt, không chuyển đổi lẫn nhau.</p></div>
              <div className="tabs">
                <button className={mode === 'research' ? 'tab active' : 'tab'} onClick={() => resetPayload('research')}>Full Research</button>
                <button className={mode === 'screening' ? 'tab active' : 'tab'} onClick={() => resetPayload('screening')}>Screening</button>
              </div>
            </div>

            <h2>2. Nạp JSON</h2>
            <div className="file-row">
              <label className="button secondary file-button">Chọn tệp JSON<input type="file" accept=".json,application/json" onChange={e => loadFile(e.target.files?.[0])} /></label>
              <span className="muted">hoặc dán JSON trực tiếp vào ô bên dưới</span>
            </div>
            <textarea value={raw} onChange={e => { setRaw(e.target.value); setPayload(null); setPayloadHash(''); setConsent(false); setResult(null); }} spellCheck="false" placeholder={mode === 'research' ? 'Dán invstock_research_v1 JSON tại đây…' : 'Dán Screening Snapshot JSON tại đây…'} />
            {mode === 'research' && <div className="field">
              <label>Ghi chú yêu cầu nghiên cứu (không bắt buộc)</label>
              <input value={promptSummary} onChange={e => setPromptSummary(e.target.value)} placeholder="Ví dụ: Full Research MBB phiên bản đầu tiên" />
            </div>}
            <button className="button secondary" onClick={makePreview} disabled={!raw.trim()}>Kiểm tra & tạo bản xem trước</button>
          </section>

          {payload && <section className="panel">
            <h2>3. Bản xem trước & kiểm tra</h2>
            <div className="summary-grid">
              <div className="summary-cell"><span>Loại dữ liệu</span><strong>{previewInfo.type}</strong></div>
              <div className="summary-cell"><span>Mã chứng khoán / số lượng</span><strong>{previewInfo.ticker}</strong></div>
              <div className="summary-cell"><span>Hash SHA-256</span><code>{payloadHash}</code></div>
            </div>
            {previewInfo.label && <p className="muted">{previewInfo.label}</p>}
            <details className="payload-details">
              <summary>Xem toàn bộ JSON ({new TextEncoder().encode(JSON.stringify(payload)).length.toLocaleString()} bytes)</summary>
              <pre>{JSON.stringify(payload, null, 2)}</pre>
            </details>
            <div className="approval">
              <label className="check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span><strong>Tôi đã kiểm tra bản xem trước và đồng ý đồng bộ chính xác payload này vào Supabase.</strong><small>Chấp thuận gắn với SHA-256 ở trên. Nếu sửa JSON, bạn phải tạo preview và chấp thuận lại.</small></span></label>
              <button className="button danger-button" disabled={!consent || busy} onClick={syncNow}>
                {busy ? 'Đang đồng bộ và xác minh…' : `XÁC NHẬN ĐỒNG BỘ ${mode === 'research' ? 'FULL RESEARCH' : 'SCREENING'}`}
              </button>
            </div>
          </section>}

          {result && <section className="panel success-panel">
            <div className="success-title">SYNCED · Persistence verified</div>
            <p><strong>{result.ticker || previewInfo?.ticker}</strong> đã được ghi thành công.</p>
            <dl className="result-grid">
              {Object.entries(result).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></React.Fragment>)}
            </dl>
          </section>}
        </>
      )}

      {message && <div className="message">{message}</div>}
      {error && <div className="error"><strong>Chưa hoàn tất:</strong> {error}</div>}
      <footer>InvStock Tracker · Project ref: uupmlkgnyowlertktsbw · Không kết nối tài khoản công ty chứng khoán · Không có quyền đặt lệnh</footer>
    </main>
  )
}

createRoot(document.getElementById('root')).render(<App />)
