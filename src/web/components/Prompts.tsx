import { useEffect, useRef, useState } from 'react'
import type { SessionView } from '../../shared/types'
import { formatAge } from '../../shared/types'
import { PROMPT_STEPS_MAX, suggestedName, type PromptSuggestion, type SavedPrompt } from '../../shared/prompts'
import * as api from '../api'
import { Icon } from './Icon'

/**
 * İstem kuyruğu ve hazır istemler (ADR 0024). Kuyruk Claude turunu bitirince
 * sıradakini gönderir; hazır istemler tek tıkla kuyruğa bütün adımlarıyla girer.
 */

/** Hazır istemleri yönetme penceresini açar; App dinler. */
export function openPromptManager(sessionId?: string): void {
  window.dispatchEvent(new CustomEvent('agentdeck:manage-prompts', { detail: sessionId ?? null }))
}

function useModal() {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return dialog
}

type QueueTone = 'working' | 'waiting' | 'blocked' | 'paused' | 'idle'

function queueStatus(session: SessionView): { tone: QueueTone; text: string } {
  if (session.queuePaused) return { tone: 'paused', text: 'Duraklatıldı · tur bitse de istem gönderilmez' }
  if (session.lifecycle !== 'live') return { tone: 'idle', text: 'Terminal çalışmıyor · sıra, Claude açılıp turunu bitirince işler' }
  if (session.agentTurn === 'working') return { tone: 'working', text: 'Claude çalışıyor · tur bitince sıradaki gönderilir' }
  if (session.agentTurn === 'waiting' && session.attention) return { tone: 'blocked', text: 'Claude yanıtını bekliyor · sen yanıtlayınca sıra devam eder' }
  if (session.agentTurn === 'waiting') return { tone: 'waiting', text: 'Claude bekliyor · eklediğin istem hemen gider' }
  return { tone: 'idle', text: 'Ön planda Claude görünmüyor · sıra, Claude turunu bitirince işler' }
}

/** Başlıktaki düğme: kuyruk doluysa sayıyı gösterir; Claude oturumlarında veya kuyruk varken görünür. */
export function PromptQueueButton({ session, prompts }: { session: SessionView; prompts: SavedPrompt[] }) {
  const [open, setOpen] = useState(false)
  const count = session.promptQueue?.length ?? 0
  if (session.archivedAt !== null || (session.foregroundAgent !== 'claude' && count === 0)) return null
  const tone = queueStatus(session).tone
  return (
    <>
      <button
        className={`queue-trigger${count > 0 ? ' has-items' : ''}`}
        data-tone={tone}
        title={count > 0 ? `İstem sırası: ${count} istem · ${queueStatus(session).text}` : 'İstem sırası: Claude turunu bitirince gönderilecek istemler'}
        aria-label={`İstem sırası${count > 0 ? `, ${count} istem` : ''}`}
        onClick={() => setOpen(true)}
      >
        <Icon name={session.queuePaused ? 'pause' : 'queue'} size={14} />
        {count > 0 && <span className="queue-count">{count}</span>}
      </button>
      {open && <PromptQueueDialog session={session} prompts={prompts} onClose={() => setOpen(false)} />}
    </>
  )
}

function PromptQueueDialog({ session: live, prompts, onClose }: { session: SessionView; prompts: SavedPrompt[]; onClose: () => void }) {
  const dialog = useModal()
  const [local, setLocal] = useState<SessionView | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Durum yoklaması daha yeni kaydı getirince yerel sonuç bırakılır.
  const liveKey = `${JSON.stringify(live.promptQueue ?? [])}:${live.queuePaused ?? false}:${live.agentTurn}`
  useEffect(() => { setLocal(null) }, [liveKey])
  const session = local ?? live
  const queue = session.promptQueue ?? []
  const status = queueStatus(session)
  const sendsNow = status.tone === 'waiting' && queue.length === 0

  const act = async (call: () => Promise<SessionView>) => {
    setBusy(true)
    setError(null)
    try { setLocal(await call()) } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  // Metin hemen temizlenir: art arda yazılan istemler birbirini beklemez, istek başarısızsa geri gelir.
  const add = () => {
    const value = text
    if (!value.trim()) return
    setText('')
    setError(null)
    api.enqueuePrompt(session.id, { text: value })
      .then(setLocal)
      .catch((err: Error) => { setError(err.message); setText((current) => current || value) })
  }

  return (
    <dialog ref={dialog} className="session-modal" aria-labelledby="queue-title" onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog queue-dialog">
        <header className="dialog-head">
          <h2 id="queue-title">İstem sırası</h2>
          <div className="dialog-sub">{session.name}</div>
        </header>
        <div className="queue-status" data-tone={status.tone} role="status">
          <span className="queue-status-dot" aria-hidden="true" />{status.text}
        </div>

        {queue.length > 0 ? (
          <ol className="queue-list">
            {queue.map((item, index) => (
              <li key={item.id} className="queue-item">
                <span className="queue-index">{index + 1}</span>
                <div className="queue-text">
                  <p title={item.text}>{item.text}</p>
                  <small>{item.from ? <><Icon name="bolt" size={11} /> {item.from} · </> : null}{formatAge(Date.now() - item.addedAt)}{formatAge(Date.now() - item.addedAt) === 'az önce' ? '' : ' önce'} eklendi</small>
                </div>
                <button className="icon-button ghost" aria-label="Sıradan çıkar" title="Sıradan çıkar" disabled={busy} onClick={() => void act(() => api.removeQueuedPrompt(session.id, item.id))}>
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="queue-empty">Sıra boş. Buraya eklediğin istemler, Claude her turunu bitirdiğinde sırayla gönderilir; sen başka işe geçebilirsin.</p>
        )}

        <div className="queue-composer">
          <textarea
            autoFocus
            rows={3}
            value={text}
            placeholder={sendsNow ? 'Claude bekliyor: yazdığın istem hemen gider…' : 'Sıraya istem ekle…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); add() }
            }}
          />
          <div className="queue-composer-row">
            <span className="muted"><kbd>↵</kbd> ekle · <kbd>Shift+↵</kbd> yeni satır</span>
            <button className="primary" disabled={!text.trim()} onClick={add}>
              <Icon name={sendsNow ? 'play' : 'plus'} size={13} /> {sendsNow ? 'Gönder' : 'Sıraya ekle'}
            </button>
          </div>
        </div>

        <section className="queue-saved" aria-label="Hazır istemler">
          <div className="queue-saved-head">
            <span>Hazır istemler</span>
            <button className="link-button" onClick={() => { onClose(); openPromptManager(session.id) }}>Yönet ve öneriler</button>
          </div>
          {prompts.length === 0 ? (
            <p className="muted">Sık yazdığın istemleri kaydet; tek tıkla bütün adımlarıyla sıraya girsin.</p>
          ) : (
            <div className="prompt-chips">
              {prompts.map((prompt) => (
                <button key={prompt.id} className="prompt-chip" disabled={busy} title={prompt.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
                  onClick={() => void act(() => api.enqueuePrompt(session.id, { promptId: prompt.id }))}>
                  <Icon name="bolt" size={12} /> {prompt.name}{prompt.steps.length > 1 && <span className="prompt-chip-steps">{prompt.steps.length} adım</span>}
                </button>
              ))}
            </div>
          )}
        </section>

        {error && <div className="error" role="alert">{error}</div>}
        <div className="dialog-actions queue-actions">
          {queue.length > 0 && <button className="ghost-button danger-text" disabled={busy} onClick={() => void act(() => api.removeQueuedPrompt(session.id))}>Sırayı temizle</button>}
          <span className="topbar-spacer" />
          <button disabled={busy} onClick={() => void act(() => api.pauseQueue(session.id, !session.queuePaused))}>
            <Icon name={session.queuePaused ? 'play' : 'pause'} size={13} /> {session.queuePaused ? 'Sürdür' : 'Duraklat'}
          </button>
          <button onClick={onClose}>Kapat</button>
        </div>
      </div>
    </dialog>
  )
}

interface Draft {
  id: string | null
  name: string
  steps: string[]
}

/**
 * Hazır istemler ve tekrar önerileri. Öneriler Claude konuşmalarında sık
 * yazılan istemlerden ve arka arkaya yazılan istem dizilerinden gelir.
 */
export function PromptsDialog({ prompts, target, onChanged, onClose }: {
  prompts: SavedPrompt[]
  /** Gönder düğmesinin hedefi; yoksa yalnız yönetim yapılır. */
  target: SessionView | null
  onChanged: () => void
  onClose: () => void
}) {
  const dialog = useModal()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<{ items: PromptSuggestion[]; pending: number } | null>(null)
  const [round, setRound] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    api.getPromptSuggestions()
      .then((result) => {
        if (cancelled) return
        setSuggestions({ items: result.suggestions, pending: result.pending })
        if (result.pending > 0 && round < 20) timer = window.setTimeout(() => setRound((n) => n + 1), 800)
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [round, prompts.length])

  const run = async (call: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    setError(null)
    try {
      await call()
      onChanged()
      if (done) setNotice(done)
      return true
    } catch (err) {
      setError((err as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!draft) return
    const input = { name: draft.name, steps: draft.steps.filter((s) => s.trim() !== '') }
    const ok = await run(() => (draft.id ? api.updatePrompt(draft.id, input) : api.createPrompt(input)), draft.id ? 'Hazır istem güncellendi.' : `“${input.name.trim()}” kaydedildi.`)
    if (ok) setDraft(null)
  }

  const canSend = target !== null && target.lifecycle === 'live' && target.archivedAt === null

  return (
    <dialog ref={dialog} className="session-modal" aria-labelledby="prompts-title" onCancel={(e) => { e.preventDefault(); if (draft) setDraft(null); else onClose() }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog prompts-dialog">
        <header className="dialog-head">
          <h2 id="prompts-title">Hazır istemler</h2>
          <div className="dialog-sub">
            {canSend ? <>Gönderilince <strong>{target!.name}</strong> oturumunun sırasına girer.</> : 'Tekrarladığın işleri kaydet, tek tıkla sıraya al.'}
          </div>
        </header>

        {draft ? (
          <form className="prompt-editor" onSubmit={(e) => { e.preventDefault(); void save() }}>
            <label>
              Ad
              <input autoFocus value={draft.name} maxLength={80} placeholder="ör. Bitir ve PR aç" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <fieldset className="prompt-steps">
              <legend>Adımlar <span className="muted">· Claude her adımı bitirince sıradaki gönderilir</span></legend>
              {draft.steps.map((step, index) => (
                <div key={index} className="prompt-step">
                  <span className="queue-index">{index + 1}</span>
                  <textarea rows={2} value={step} placeholder={index === 0 ? 'ör. Testleri çalıştır, kırılanları düzelt' : 'Sonraki adım'}
                    onChange={(e) => setDraft({ ...draft, steps: draft.steps.map((s, i) => (i === index ? e.target.value : s)) })} />
                  <button type="button" className="icon-button ghost" aria-label={`${index + 1}. adımı kaldır`} disabled={draft.steps.length === 1}
                    onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
              {draft.steps.length < PROMPT_STEPS_MAX && (
                <button type="button" className="ghost-button add-step" onClick={() => setDraft({ ...draft, steps: [...draft.steps, ''] })}>
                  <Icon name="plus" size={13} /> Adım ekle
                </button>
              )}
            </fieldset>
            {error && <div className="error" role="alert">{error}</div>}
            <div className="dialog-actions">
              <button type="button" disabled={busy} onClick={() => { setDraft(null); setError(null) }}>Vazgeç</button>
              <button type="submit" className="primary" disabled={busy || !draft.name.trim() || draft.steps.every((s) => !s.trim())}>Kaydet</button>
            </div>
          </form>
        ) : (
          <>
            <section className="prompts-section" aria-label="Kayıtlı hazır istemler">
              <div className="prompts-section-head">
                <h3>Kayıtlı</h3>
                <button className="ghost-button" onClick={() => { setNotice(null); setDraft({ id: null, name: '', steps: [''] }) }}><Icon name="plus" size={13} /> Yeni</button>
              </div>
              {prompts.length === 0 ? (
                <p className="muted prompts-empty">Henüz hazır istem yok. Aşağıdaki önerilerden birini kaydedebilir veya yenisini yazabilirsin.</p>
              ) : (
                <ul className="prompt-list">
                  {prompts.map((prompt) => (
                    <li key={prompt.id} className="prompt-row">
                      <span className="prompt-row-icon" aria-hidden="true"><Icon name="bolt" size={14} /></span>
                      <div className="prompt-row-text">
                        <strong>{prompt.name}</strong>
                        <StepPreview steps={prompt.steps} />
                        {(prompt.uses ?? 0) > 0 && <small>{prompt.uses} kez kullanıldı</small>}
                      </div>
                      {canSend && (
                        <button className="primary compact" disabled={busy} onClick={() => void run(() => api.enqueuePrompt(target!.id, { promptId: prompt.id }), `“${prompt.name}” ${target!.name} sırasına girdi.`)}>
                          <Icon name="play" size={12} /> Gönder
                        </button>
                      )}
                      <button className="icon-button ghost" title="Düzenle" aria-label={`${prompt.name} düzenle`} onClick={() => { setNotice(null); setDraft({ id: prompt.id, name: prompt.name, steps: [...prompt.steps] }) }}><Icon name="edit" size={14} /></button>
                      <button className="icon-button ghost" title="Sil" aria-label={`${prompt.name} sil`} disabled={busy} onClick={() => void run(() => api.deletePrompt(prompt.id))}><Icon name="trash" size={14} /></button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="prompts-section" aria-label="Tekrar önerileri">
              <div className="prompts-section-head">
                <h3>Sık tekrarladıkların</h3>
                {suggestions && suggestions.pending > 0 && <span className="muted scanning">{suggestions.pending} konuşma daha taranıyor…</span>}
              </div>
              {!suggestions ? (
                <p className="muted prompts-empty">Konuşmaların taranıyor…</p>
              ) : suggestions.items.length === 0 ? (
                <p className="muted prompts-empty">
                  {suggestions.pending > 0 ? 'Henüz tekrar bulunmadı.' : 'Tekrarlanan istem bulunmadı. Aynı istemi farklı konuşmalarda üç kez yazınca veya aynı istem dizisini iki konuşmada kullanınca burada önerilir.'}
                </p>
              ) : (
                <ul className="prompt-list">
                  {suggestions.items.map((suggestion) => (
                    <li key={suggestion.steps.join('\n')} className="prompt-row suggestion">
                      <span className="prompt-row-icon" aria-hidden="true"><Icon name="refresh" size={14} /></span>
                      <div className="prompt-row-text">
                        <StepPreview steps={suggestion.steps} />
                        <small>
                          {suggestion.steps.length > 1 ? `Bu sırayla ${suggestion.conversations} konuşmada` : `${suggestion.count} kez · ${suggestion.conversations} konuşmada`}
                          {suggestion.lastAt ? ` · son ${formatAge(Date.now() - suggestion.lastAt)} önce` : ''}
                        </small>
                      </div>
                      <button className="ghost-button" onClick={() => { setNotice(null); setDraft({ id: null, name: suggestedName(suggestion.steps), steps: [...suggestion.steps] }) }}>
                        <Icon name="bolt" size={13} /> Kaydet
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {notice && <p className="prompts-notice" role="status"><Icon name="check" size={13} /> {notice}</p>}
            {error && <div className="error" role="alert">{error}</div>}
            <div className="dialog-actions">
              <button onClick={onClose}>Kapat</button>
            </div>
          </>
        )}
      </div>
    </dialog>
  )
}

function StepPreview({ steps }: { steps: string[] }) {
  if (steps.length === 1) return <p className="prompt-step-text" title={steps[0]}>{steps[0]}</p>
  return (
    <ol className="prompt-step-list">
      {steps.map((step, index) => <li key={index} title={step}>{step}</li>)}
    </ol>
  )
}
