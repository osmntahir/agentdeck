import { useEffect, useRef, useState } from 'react'
import type { Work } from '../../shared/types'

/** Seçim: mevcut iş, adı verilecek yeni iş veya işsiz. */
export type WorkChoice = { id: string } | { name: string } | null

/**
 * İş seçici; yeni oturum ve "İşe taşı" pencereleri aynı alanı kullanır.
 * Değer '' işsiz, 'new' yeni iş, diğerleri iş kimliğidir.
 */
export function WorkField({ works, value, onChange, newName, onNewName }: {
  works: Work[]
  value: string
  onChange: (value: string) => void
  newName: string
  onNewName: (name: string) => void
}) {
  return (
    <>
      <label>
        İş
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">İşe bağlama</option>
          {works.map((work) => <option key={work.id} value={work.id}>{work.name}</option>)}
          <option value="new">+ Yeni iş…</option>
        </select>
      </label>
      {value === 'new' && (
        <label>
          Yeni işin adı
          <input autoFocus value={newName} onChange={(e) => onNewName(e.target.value)} placeholder="ör. Çoklu dil desteği" maxLength={80} />
        </label>
      )}
    </>
  )
}

export function workChoice(value: string, newName: string): WorkChoice | undefined {
  if (value === '') return null
  if (value === 'new') return newName.trim() ? { name: newName.trim() } : undefined
  return { id: value }
}

function useModal() {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return dialog
}

/** Yeni iş veya yeniden adlandırma. */
export function WorkNameDialog({ title, initial, submitLabel, busy, error, onSubmit, onCancel }: {
  title: string
  initial: string
  submitLabel: string
  busy: boolean
  error: string | null
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const dialog = useModal()
  const [name, setName] = useState(initial)
  return (
    <dialog ref={dialog} className="session-modal" aria-labelledby="work-name-title" onCancel={(e) => { e.preventDefault(); onCancel() }}>
      <form className="dialog" onSubmit={(e) => { e.preventDefault(); if (!busy && name.trim()) onSubmit(name.trim()) }}>
        <header className="dialog-head"><h2 id="work-name-title">{title}</h2></header>
        <label>
          İşin adı
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="ör. Çoklu dil desteği" />
        </label>
        <p className="dialog-note muted">İş, aynı amaç için açtığın terminalleri ve Claude konuşmalarını bir arada tutar.</p>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>Vazgeç</button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>{submitLabel}</button>
        </div>
      </form>
    </dialog>
  )
}

/** Oturumu başka bir işe taşır; terminal ve dosyalar etkilenmez. */
export function AssignWorkDialog({ sessionName, works, currentWorkId, busy, error, onSubmit, onCancel }: {
  sessionName: string
  works: Work[]
  currentWorkId: string | null
  busy: boolean
  error: string | null
  onSubmit: (choice: WorkChoice) => void
  onCancel: () => void
}) {
  const dialog = useModal()
  const [value, setValue] = useState(currentWorkId ?? '')
  const [newName, setNewName] = useState('')
  const choice = workChoice(value, newName)
  return (
    <dialog ref={dialog} className="session-modal" aria-labelledby="assign-work-title" onCancel={(e) => { e.preventDefault(); onCancel() }}>
      <form className="dialog" onSubmit={(e) => { e.preventDefault(); if (!busy && choice !== undefined) onSubmit(choice) }}>
        <header className="dialog-head">
          <h2 id="assign-work-title">İşe taşı</h2>
          <div className="dialog-sub">{sessionName}</div>
        </header>
        <WorkField works={works} value={value} onChange={setValue} newName={newName} onNewName={setNewName} />
        <p className="dialog-note muted">Terminal çalışmaya devam eder; yalnız hangi işin altında göründüğü değişir.</p>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>Vazgeç</button>
          <button type="submit" className="primary" disabled={busy || choice === undefined}>Taşı</button>
        </div>
      </form>
    </dialog>
  )
}
