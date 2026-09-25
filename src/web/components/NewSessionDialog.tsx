import { ProgramIcon } from './AgentMark'
import { useEffect, useRef, useState } from 'react'
import type { Isolation, Project, Work } from '../../shared/types'
import { PRESETS } from '../../shared/types'
import { getProjectHead } from '../api'
import { updatePreferences, usePreferences } from '../preferences'
import { WorkField, workChoice, type WorkChoice } from './WorkDialogs'

interface Props {
  busy: boolean
  error: string | null
  project: Project
  /** Projenin işleri. */
  works: Work[]
  /** Önceden seçili iş: kimlik, 'new' (yeni iş) veya '' (işsiz). */
  initialWork: string
  onCancel: () => void
  onCreate: (input: { name: string; command: string | null; isolation: Isolation; work: WorkChoice }) => void
}

export function NewSessionDialog({ project, works, initialWork, busy, error, onCancel, onCreate }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const preferences = usePreferences()
  const [name, setName] = useState('')
  // Preset yalnız başlangıç Command'ını doldurur; kalıcı ajan kimliği değildir.
  // Projede son kullanılan program önceden seçilir.
  const [presetIndex, setPresetIndex] = useState(() => Math.max(0, PRESETS.findIndex((p) => p.label === preferences.lastProgram[project.id])))
  const [isolation, setIsolation] = useState<Isolation | null>('shared')
  const [workValue, setWorkValue] = useState(initialWork)
  const [newWorkName, setNewWorkName] = useState('')
  const work = workChoice(workValue, newWorkName)
  const workName = workValue === 'new' ? newWorkName.trim() : works.find((w) => w.id === workValue)?.name ?? ''
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
    work !== undefined &&
    isolation !== null &&
    (isolation === 'shared' || (isolation === 'worktree' && (project.kind === 'folder' || hasHead === true)))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !ready || isolation === null || work === undefined) return
    try { updatePreferences({ lastProgram: { ...preferences.lastProgram, [project.id]: PRESETS[presetIndex].label } }) } catch { /* tercih yalnız bu açılışta kalır */ }
    onCreate({ name: name.trim(), command: PRESETS[presetIndex].command, isolation, work })
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
        <header className="dialog-head">
          <h2 id="new-session-title">Yeni oturum</h2>
          <div className="dialog-sub">{project.general ? `Projesiz · ${project.path}` : project.name}</div>
        </header>

        <fieldset className="program-picker">
          <legend>Program</legend>
          <div className="program-tiles">
            {PRESETS.map((preset, index) => (
              <label key={preset.label} className="program-tile">
                <input type="radio" name="program" checked={presetIndex === index} onChange={() => setPresetIndex(index)} />
                <ProgramIcon command={preset.command} />
                <span>{preset.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <WorkField works={works} value={workValue} onChange={setWorkValue} newName={newWorkName} onNewName={setNewWorkName} />

        <label>
          Terminal adı
          <input
            autoFocus={workValue !== 'new'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={workName ? `İsteğe bağlı · boş kalırsa “${workName}”` : 'İsteğe bağlı · boş kalırsa programdan adlandırılır'}
            maxLength={80}
          />
        </label>

        {!project.general && <fieldset className="isolation-picker">
          <legend>Çalışma yeri</legend>
          <div className="radio-group">
            <label className="radio">
              <input type="radio" checked={isolation === 'shared'} onChange={() => setIsolation('shared')} />
              <span>
                <strong>Proje klasörü</strong>
                <small>Mevcut branch; yeni branch oluşturulmaz.</small>
              </span>
            </label>
            <label className="radio">
              <input
                type="radio"
                checked={isolation === 'worktree'}
                disabled={worktreeClosed}
                onChange={() => setIsolation('worktree')}
              />
              <span>
                <strong>İzole çalışma</strong>
                <small>
                  {worktreeClosed
                    ? 'Projede commit yok; worktree açılamaz.'
                    : project.kind === 'folder'
                      ? 'Her alt Git deposu için worktree ve branch.'
                      : "Kendi worktree'si ve branch'i."}
                </small>
              </span>
            </label>
          </div>
        </fieldset>}
        {worktreeClosed && !project.general && (
          <p className="dialog-note muted">
            İlk commit sonrası izole çalışma da kullanılabilir.
          </p>
        )}

        {project.kind === 'folder' && !project.general && (
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
            Vazgeç
          </button>
          <button type="submit" className="primary" disabled={busy || !ready}>
            {busy ? 'Başlatılıyor…' : 'Oturumu başlat'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
