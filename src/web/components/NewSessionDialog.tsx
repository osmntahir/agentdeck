import { useEffect, useRef, useState } from 'react'
import type { Isolation, Project } from '../../shared/types'
import { PRESETS } from '../../shared/types'
import { getProjectHead } from '../api'

interface Props {
  busy: boolean
  error: string | null
  project: Project
  onCancel: () => void
  onCreate: (input: { name: string; command: string | null; isolation: Isolation }) => void
}

export function NewSessionDialog({ project, busy, error, onCancel, onCreate }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const [name, setName] = useState('')
  // Preset yalnız başlangıç Command'ını doldurur; kalıcı ajan kimliği değildir.
  const [presetIndex, setPresetIndex] = useState(0)
  const [isolation, setIsolation] = useState<Isolation | null>('shared')
  const [hasHead, setHasHead] = useState<boolean | null>(null)
  useEffect(() => {
    if (project.kind === 'folder') return
    let cancelled = false
    getProjectHead(project.id)
      .then((head) => {
        if (cancelled) return
        setHasHead(head.hasHead)
        if (head.hasHead === false) setIsolation((current) => current === 'worktree' ? 'shared' : current)
      })
      .catch(() => {
        if (!cancelled) setHasHead(null)
      })
    return () => {
      cancelled = true
    }
  }, [project.id, project.kind])

  const worktreeClosed = project.kind === 'git' && hasHead === false
  const ready =
    isolation !== null &&
    (isolation === 'shared' || (isolation === 'worktree' && (project.kind === 'folder' || hasHead === true)))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !ready || isolation === null) return
    onCreate({ name: name.trim(), command: PRESETS[presetIndex].command, isolation })
  }

  return (
    <dialog
      ref={dialog}
      className="session-modal"
      aria-labelledby="new-session-title"
      onCancel={(e) => {
        e.preventDefault()
        onCancel()
      }}
    >
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 id="new-session-title">Yeni oturum</h2>
        <div className="dialog-sub">{project.name}</div>

        <label>
          Görev adı
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="İsteğe bağlı, en çok 80 karakter"
          />
        </label>

        <label>
          Program
          <select value={presetIndex} onChange={(e) => setPresetIndex(Number(e.target.value))}>
            {PRESETS.map((preset, index) => (
              <option key={preset.label} value={index}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <div className="radio-group">
          <label className="radio">
            <input
              type="radio"
              checked={isolation === 'worktree'}
              disabled={worktreeClosed}
              onChange={() => setIsolation('worktree')}
            />
            <span>
              <strong>İzole çalışma</strong> —{' '}
              {worktreeClosed
                ? 'projede commit yok; worktree açılamaz'
                : project.kind === 'folder'
                  ? "alt klasörlerdeki her Git deposu için worktree ve branch"
                  : "kendi worktree'si ve branch'i"}
            </span>
          </label>
          <label className="radio">
            <input type="radio" checked={isolation === 'shared'} onChange={() => setIsolation('shared')} />
            <span>
              <strong>Proje klasörü</strong> — mevcut branch, yeni branch oluşturulmaz
            </span>
          </label>
        </div>
        {worktreeClosed && (
          <p className="dialog-note muted">
            İlk commit sonrası izole çalışma da kullanılabilir.
          </p>
        )}

        {project.kind === 'folder' && (
          <p className="dialog-note muted">
            Bu proje Git deposu değil. Ortak oturum doğrudan klasörde çalışır. İzole oturum yalnız alt
            klasörlerdeki Git depolarını kopyalar; depo dışındaki dosyalar izole kopyada bulunmaz. Diff her
            depoyu ayrı gösterir.
          </p>
        )}
        {/* Yeni klasörde CLI'lar güven veya giriş onayı isteyebilir; bunu
            uygulama vermez, kullanıcı terminalden tamamlar. */}
        <p className="dialog-note muted">
          Ajan, klasör güveni veya giriş onayı isteyebilir; terminalden tamamlayın.
          {isolation === 'worktree' && ' İzole kopyada .env, bağımlılıklar ve servis portları hazır değildir.'}
        </p>

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            vazgeç
          </button>
          <button type="submit" className="primary" disabled={busy || !ready}>
            {busy ? 'Başlatılıyor…' : 'Oturumu başlat'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
