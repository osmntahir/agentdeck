import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClaudeAccountsResponse, ClaudeAccountView, ClaudeLoginView } from '../../shared/types'
import {
  ApiCallError,
  activateClaudeAccount,
  cancelClaudeLogin,
  getClaudeAccounts,
  removeClaudeAccount,
  saveLiveClaudeAccount,
  sendClaudeLoginInput,
  startClaudeLogin,
} from '../api'
import { ConfirmDialog } from './ConfirmDialog'
import { Icon } from './Icon'

const accountName = (account: { email: string | null }) => account.email ?? 'Adı bilinmeyen hesap'

/**
 * Kenar çubuğundaki Claude hesapları (ADR 0017). Satıra tıklamak hesabı
 * sistem genelinde etkinleştirir.
 */
export function AccountsPanel() {
  const [data, setData] = useState<ClaudeAccountsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [removing, setRemoving] = useState<ClaudeAccountView | null>(null)

  const refresh = useCallback(async () => {
    try {
      setData(await getClaudeAccounts())
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  if (!data?.supported) return null
  const active = data.accounts.find((a) => a.active)

  return (<>
    <details className="accounts" onToggle={(e) => { if (e.currentTarget.open) void refresh() }}>
      <summary title="Claude hesapları">
        <img src="/agents/claude.svg" alt="" className="accounts-mark" />
        <span className="accounts-current">{active ? accountName(active) : data.unsaved ? accountName(data.unsaved) : 'Claude hesapları'}</span>
        {data.accounts.length > 0 && <span className="nav-count">{data.accounts.length}</span>}
        <Icon name="chevron" size={12} />
      </summary>
      <div className="accounts-body">
        {data.accounts.map((account) => (
          <div key={account.id} className={`account-row${account.active ? ' active' : ''}`}>
            <button type="button" disabled={busy || account.active} aria-pressed={account.active}
              title={account.active ? 'Etkin hesap' : `${accountName(account)} hesabına geç`}
              onClick={() => run(() => activateClaudeAccount(account.id))}>
              <span className="account-check">{account.active && <Icon name="check" size={13} />}</span>
              <span className="account-text">
                <span>{accountName(account)}</span>
                <small>{[account.subscription, account.organization].filter(Boolean).join(' · ') || 'Claude'}</small>
              </span>
            </button>
            {!account.active && (
              <button type="button" className="icon-button ghost account-remove" disabled={busy}
                title="Hesabı listeden kaldır" aria-label={`${accountName(account)} hesabını kaldır`} onClick={() => setRemoving(account)}>
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        ))}
        {data.unsaved && (
          <div className="account-unsaved">
            <span>{data.unsaved.email ? `${data.unsaved.email} açık ama kayıtlı değil.` : 'Açık Claude oturumu kayıtlı değil.'}</span>
            <button type="button" disabled={busy} onClick={() => run(saveLiveClaudeAccount)}>Kaydet</button>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="button" className="ghost-button" disabled={busy} onClick={() => setLoggingIn(true)}>
          <Icon name="plus" size={13} /> Hesap ekle
        </button>
      </div>
    </details>
    {/* Kapalı <details> içeriği çizilmez; pencereler dışarıda durur. */}
      {loggingIn && <LoginDialog onClose={() => { setLoggingIn(false); void refresh() }} />}
      {removing && (
        <ConfirmDialog title="Hesabı kaldır" confirmLabel="Kaldır"
          onCancel={() => setRemoving(null)}
          onConfirm={() => { const id = removing.id; setRemoving(null); void run(() => removeClaudeAccount(id)) }}>
          <p className="dialog-sub">{accountName(removing)} AgentDeck listesinden kaldırılır. Tekrar eklemek için yeniden giriş yapmanız gerekir.</p>
        </ConfirmDialog>
      )}
  </>)
}

/** `claude auth login` geçici bir dizinde yürür; tarayıcı açılmazsa adres ve kod alanı buradadır. */
function LoginDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [login, setLogin] = useState<ClaudeLoginView | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ref.current?.showModal()
    let stopped = false
    // Yalnız bu pencerenin başlattığı iş izlenir; önceki bitmiş giriş gösterilmez.
    let loginId: string | null = null
    startClaudeLogin()
      .then(({ login }) => { loginId = login.id; setLogin(login) })
      .catch(async (err) => {
        // StrictMode'da efekt iki kez çalışır: ikinci istek süren işi bulur ve onu izler.
        if (err instanceof ApiCallError && err.code === 'login_running') loginId = (await getClaudeAccounts()).login?.id ?? null
        else setError((err as Error).message)
      })
    const timer = setInterval(async () => {
      try {
        const next = (await getClaudeAccounts()).login
        if (!stopped && next && next.id === loginId) setLogin(next)
      } catch { /* bir sonraki turda yeniden denenir */ }
    }, 700)
    return () => { stopped = true; clearInterval(timer) }
  }, [])

  const running = login?.state === 'running'
  const close = () => {
    if (running) void cancelClaudeLogin()
    onClose()
  }

  return (
    <dialog ref={ref} className="session-modal" aria-labelledby="login-title" onCancel={(e) => { e.preventDefault(); close() }}>
      <div className="dialog login-dialog">
        <header className="dialog-head">
          <h2 id="login-title">Claude hesabı ekle</h2>
          <p className="dialog-sub">Tarayıcıda eklemek istediğiniz hesapla giriş yapın. Etkin hesabınız bu sırada değişmez.</p>
        </header>
        {!login && !error && <p className="muted">Giriş başlatılıyor…</p>}
        {login?.url && running && (
          <p className="dialog-sub">Tarayıcı açılmadıysa: <a href={login.url} target="_blank" rel="noreferrer">giriş sayfasını aç <Icon name="external" size={12} /></a></p>
        )}
        {running && (
          <form className="login-code" onSubmit={(e) => {
            e.preventDefault()
            if (!code.trim()) return
            sendClaudeLoginInput(`${code.trim()}\r`).then(() => setCode('')).catch((err) => setError((err as Error).message))
          }}>
            <label>Tarayıcı bir kod verdiyse
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Kodu yapıştırın" autoComplete="off" spellCheck={false} />
            </label>
            <button type="submit" disabled={!code.trim()}>Gönder</button>
          </form>
        )}
        {login?.state === 'done' && login.account && (
          <p className="dialog-sub"><Icon name="check" size={14} /> {accountName(login.account)} eklendi. Kenar çubuğundan tek tıkla geçebilirsiniz.</p>
        )}
        {login?.state === 'failed' && <p className="error" role="alert">{login.message}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {login && login.state !== 'done' && login.output.trim() && (
          <details className="login-output"><summary>CLI çıktısı</summary><pre>{login.output.trim()}</pre></details>
        )}
        <div className="dialog-actions">
          <button type="button" className={running ? '' : 'primary'} onClick={close}>{running ? 'Vazgeç' : 'Kapat'}</button>
        </div>
      </div>
    </dialog>
  )
}
