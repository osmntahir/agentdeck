import { useEffect, useRef, useState } from 'react'
import { sourceLabel, type ReviewComment } from '../../shared/review'
import type { GithubStatus, PullRequestNote, SessionView } from '../../shared/types'
import { Icon } from './Icon'

/** Ajana gönderilebilirlik; neden kullanıcıya olduğu gibi gösterilir. */
export interface Delivery { ok: boolean; reason: string | null; target: string }

function location(comment: ReviewComment): string {
  if (comment.path === null) return 'Genel not'
  const name = comment.path.split('/').pop()
  if (comment.line === null) return name ?? comment.path
  return comment.startLine !== null && comment.startLine !== comment.line ? `${name}:${comment.startLine}–${comment.line}` : `${name}:${comment.line}`
}

function Item({ comment, current, onJump, onDelete }: { comment: ReviewComment; current: string; onJump: (c: ReviewComment) => void; onDelete: (id: string) => void }) {
  return <li className="review-item" data-sent={comment.sentAt !== null || undefined}>
    <button className="review-item-main" onClick={() => onJump(comment)} title={comment.path ?? 'Genel not'}>
      <span className="review-item-loc">
        {comment.author ? <span className="review-avatar gh" aria-hidden="true">{comment.author.slice(0, 1).toUpperCase()}</span> : <Icon name={comment.path ? 'diff' : 'chat'} size={12} />}
        <code>{location(comment)}</code>
        {comment.source !== current && <span className="muted">· {sourceLabel(comment.source)}</span>}
      </span>
      <span className="review-item-body">{comment.author ? `@${comment.author}: ` : ''}{comment.body}</span>
    </button>
    <button className="icon-button ghost" aria-label="Notu sil" title="Sil" onClick={() => onDelete(comment.id)}><Icon name="close" size={12} /></button>
  </li>
}

/** Proje PR incelemesinde notların gideceği terminalin seçimi. */
export interface TargetPicker {
  sessions: SessionView[]
  selected: string | null
  onSelect: (id: string) => void
  onStartAgent?: () => void
}

export function ReviewPanel({ comments, current, summary, onSummary, delivery, instant, submit, onPrefs, onJump, onDelete, onClearSent, onSend, github, notes, forwardedNotes, onForwardNote, onClose, status, picker }: {
  comments: ReviewComment[]
  current: string
  summary: string
  onSummary: (text: string) => void
  delivery: Delivery
  instant: boolean
  submit: boolean
  onPrefs: (change: { instant?: boolean; submit?: boolean }) => void
  onJump: (comment: ReviewComment) => void
  onDelete: (id: string) => void
  onClearSent: () => void
  onSend: () => void
  github: GithubStatus | null
  notes: PullRequestNote[] | null
  forwardedNotes: Set<string>
  onForwardNote: (note: PullRequestNote) => void
  onClose: () => void
  status: { tone: 'ok' | 'error'; text: string } | null
  picker: TargetPicker | null
}) {
  const pending = comments.filter(c => c.sentAt === null)
  const sent = comments.filter(c => c.sentAt !== null)
  const [showSent, setShowSent] = useState(false)
  const canSend = delivery.ok && (pending.length > 0 || summary.trim() !== '')
  return <aside className="review-panel" aria-label="İnceleme notları">
    <header className="review-panel-head">
      <h2>İnceleme</h2>
      <span className="chip">{pending.length} taslak</span>
      <span className="topbar-spacer" />
      <button className="icon-button ghost" aria-label="Paneli kapat" title="Paneli kapat" onClick={onClose}><Icon name="close" size={14} /></button>
    </header>
    <div className="review-panel-scroll">
      <div className={`review-target${delivery.ok ? '' : ' blocked'}`}>
        <Icon name="terminal" size={14} />
        <span><strong>{delivery.target}</strong><small>{delivery.ok ? 'Notlar bu terminale yapıştırılır' : delivery.reason}</small></span>
      </div>
      {picker && <div className="review-picker">
        <label>
          <span>Notların gideceği terminal</span>
          <select value={picker.selected ?? ''} onChange={e => picker.onSelect(e.target.value)}>
            <option value="" disabled>Terminal seç…</option>
            {picker.sessions.map(s => <option key={s.id} value={s.id}>
              {s.name}{s.pullRequest && !s.name.includes(`#${s.pullRequest.number}`) ? ` · PR #${s.pullRequest.number}` : ''}{s.lifecycle === 'live' ? '' : ' (çalışmıyor)'}
            </option>)}
          </select>
        </label>
        {picker.onStartAgent && <button className="ghost-button" onClick={picker.onStartAgent}><Icon name="play" size={12} />Bu PR üzerinde ajan başlat</button>}
      </div>}

      {pending.length === 0 && sent.length === 0 && <div className="review-empty">
        <p><strong>Henüz not yok.</strong></p>
        <p>Satır numarasının yanındaki <span className="kbd-plus">+</span> ile not ekle; <kbd>Shift</kbd> ile tıklayarak birden çok satır seç. Notlar burada toplanır ve tek mesajda ajana gider.</p>
      </div>}

      {pending.length > 0 && <ul className="review-list">{pending.map(c => <Item key={c.id} comment={c} current={current} onJump={onJump} onDelete={onDelete} />)}</ul>}

      <label className="review-summary">
        <span>Genel not</span>
        <textarea rows={3} placeholder="Ör. Testleri de güncelle, commit mesajlarını Türkçe yaz." value={summary} onChange={e => onSummary(e.target.value)} />
      </label>

      <div className="review-options">
        <label><input type="checkbox" checked={instant} onChange={e => onPrefs({ instant: e.target.checked })} />Her notu eklerken hemen gönder</label>
        <label><input type="checkbox" checked={submit} onChange={e => onPrefs({ submit: e.target.checked })} />Gönderince Enter'a bas</label>
      </div>

      {status && <p className={status.tone === 'error' ? 'review-status error-text' : 'review-status'} role="status">{status.text}</p>}

      {sent.length > 0 && <div className="review-sent">
        <button className="ghost-button" aria-expanded={showSent} onClick={() => setShowSent(!showSent)}>
          <Icon name="chevron" size={12} />Ajana gidenler ({sent.length})
        </button>
        <button className="ghost-button" onClick={onClearSent}>Temizle</button>
        {showSent && <ul className="review-list">{sent.map(c => <Item key={c.id} comment={c} current={current} onJump={onJump} onDelete={onDelete} />)}</ul>}
      </div>}

      {notes && notes.length > 0 && <section className="review-gh-notes">
        <h3>GitHub konuşması</h3>
        {notes.map((note, i) => {
          const key = `${note.url}|${note.createdAt}|${i}`
          return <article key={key} className="review-card github compact">
            <header>
              <span className="review-avatar gh" aria-hidden="true">{note.author.slice(0, 1).toUpperCase()}</span>
              <strong>@{note.author}</strong>
              {note.state && note.state !== 'COMMENTED' && <span className={`review-state ${note.state === 'APPROVED' ? 'sent' : 'changes'}`}>{note.state === 'APPROVED' ? 'Onayladı' : note.state === 'CHANGES_REQUESTED' ? 'Değişiklik istedi' : note.state}</span>}
            </header>
            {note.body && <p>{note.body}</p>}
            {note.body && <footer><button className="ghost-button" disabled={forwardedNotes.has(key)} onClick={() => onForwardNote(note)}>
              <Icon name={forwardedNotes.has(key) ? 'check' : 'plus'} size={12} />{forwardedNotes.has(key) ? 'Eklendi' : 'Notlara ekle'}
            </button></footer>}
          </article>
        })}
      </section>}

      {github && github.state !== 'ready' && <div className="review-github-off">
        <strong>GitHub bağlı değil</strong>
        <p>{github.message}</p>
        {github.state === 'unauthenticated' && <button className="ghost-button" onClick={() => void navigator.clipboard?.writeText('gh auth login')}><Icon name="copy" size={12} />gh auth login</button>}
      </div>}
    </div>
    <footer className="review-panel-foot">
      <button className="primary large" disabled={!canSend} title={delivery.ok ? undefined : delivery.reason ?? undefined} onClick={onSend}>
        <Icon name="terminal" size={14} />Ajana gönder{pending.length > 0 ? ` (${pending.length})` : ''}
      </button>
    </footer>
  </aside>
}

/**
 * Gönderim önizlemesi: ajana gidecek metin olduğu gibi gösterilir ve
 * düzenlenebilir. PR incelemesinde notlar GitHub'da da yayımlanabilir.
 */
export function SendDialog({ initial, target, submit, publishable, busy, error, onSend, onCancel }: {
  initial: string
  target: string
  submit: boolean
  /** GitHub'da yayımlanabilecek not sayısı; PR dışında null. */
  publishable: { count: number; pr: number } | null
  busy: boolean
  error: string | null
  onSend: (text: string, options: { submit: boolean; publish: boolean }) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState(initial)
  const [press, setPress] = useState(submit)
  const [publish, setPublish] = useState(false)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="session-modal send-modal" aria-labelledby="send-title" onCancel={e => { e.preventDefault(); if (!busy) onCancel() }}>
    <form className="dialog" onSubmit={e => { e.preventDefault(); if (!busy && text.trim()) onSend(text, { submit: press, publish }) }}>
      <header className="dialog-head">
        <h2 id="send-title">Ajana gönder</h2>
        <p className="dialog-sub">Metin <strong>{target}</strong> terminaline yapıştırılır. Göndermeden önce düzenleyebilirsin.</p>
      </header>
      <textarea className="send-preview" value={text} onChange={e => setText(e.target.value)} rows={14} aria-label="Gönderilecek metin"
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!busy && text.trim()) onSend(text, { submit: press, publish }) } }} />
      <label className="check-row"><input type="checkbox" checked={press} onChange={e => setPress(e.target.checked)} />Enter'a da bas; kapalıysa metin istemde bekler</label>
      {publishable && publishable.count > 0 && <label className="check-row">
        <input type="checkbox" checked={publish} onChange={e => setPublish(e.target.checked)} />
        {publishable.count} notu PR #{publishable.pr} üzerinde GitHub yorumu olarak da yayımla
      </label>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onCancel}>Vazgeç</button>
        <button type="submit" className="primary" disabled={busy || !text.trim()}>{busy ? 'Gönderiliyor…' : 'Gönder'}</button>
      </div>
    </form>
  </dialog>
}
