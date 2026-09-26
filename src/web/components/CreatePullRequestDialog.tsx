import { useEffect, useRef, useState } from 'react'

/**
 * Çalışma branch'inden PR açar. Branch önce uzak depoya gönderilir; yalnız
 * commit'lenmiş değişiklikler PR'a girer.
 */
export function CreatePullRequestDialog({ branch, defaultBase, initialTitle, uncommitted, busy, error, onCreate, onCancel }: {
  branch: string
  defaultBase: string
  initialTitle: string
  /** Çalışma kopyasında commit'lenmemiş değişiklik var mı; bilinmiyorsa null. */
  uncommitted: boolean | null
  busy: boolean
  error: string | null
  onCreate: (input: { title: string; body: string; base: string; draft: boolean }) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState(initialTitle)
  const [base, setBase] = useState(defaultBase)
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  useEffect(() => { dialog.current?.showModal() }, [])
  const ready = title.trim() !== '' && base.trim() !== '' && !busy
  return <dialog ref={dialog} className="session-modal" aria-labelledby="create-pr-title" onCancel={e => { e.preventDefault(); if (!busy) onCancel() }}>
    <form className="dialog" onSubmit={e => { e.preventDefault(); if (ready) onCreate({ title: title.trim(), body, base: base.trim(), draft }) }}>
      <header className="dialog-head">
        <h2 id="create-pr-title">Pull request aç</h2>
        <p className="dialog-sub"><code>{branch}</code> branch'i GitHub'a gönderilir ve <code>{base || '…'}</code> hedefine PR açılır.</p>
      </header>
      <label>Başlık<input autoFocus value={title} onChange={e => setTitle(e.target.value)} maxLength={256} /></label>
      <label>Hedef branch<input value={base} onChange={e => setBase(e.target.value)} maxLength={255} /></label>
      <label>Açıklama<textarea rows={6} value={body} onChange={e => setBody(e.target.value)} placeholder="Ne değişti, neden? (isteğe bağlı)" /></label>
      <label className="check-row"><input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)} />Taslak PR olarak aç</label>
      {uncommitted && <p className="dialog-note warn-note">Commit'lenmemiş değişiklikler var; bunlar PR'a girmez. Önce ajandan commit'lemesini isteyebilirsin.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onCancel}>Vazgeç</button>
        <button type="submit" className="primary" disabled={!ready}>{busy ? 'Açılıyor…' : 'PR aç'}</button>
      </div>
    </form>
  </dialog>
}
