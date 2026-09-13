import { useEffect, useRef, useState } from 'react'
import type { SessionView } from '../../shared/types'
import { hasRunningProcesses, lastCommand, PRESETS } from '../../shared/types'

/**
 * CLI'ların kendi etkileşimli seçicisini açan literal komutlar. command niyetiyle
 * aynen çalışır; konuşmayı kullanıcı seçer, uygulama kimlik üretmez.
 */
const RESUME_COMMANDS = [
  { label: 'Claude seçicisi', command: 'claude --resume' },
  { label: 'Codex seçicisi', command: 'codex resume' },
  { label: 'Gemini seçicisi', command: 'gemini --resume' },
]

interface Props {
  session: SessionView
  busy: boolean
  error: string | null
  onCancel: () => void
  onLaunch: (command: string | null) => void
}

export function LaunchDialog({ session, busy, error, onCancel, onLaunch }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const initial = lastCommand(session)
  // null etkileşimli kabuk demektir; boş komut çalıştırılamaz.
  const [shell, setShell] = useState(initial === null)
  const [command, setCommand] = useState(initial ?? '')
  const running = hasRunningProcesses(session)
  const ready = shell || command.trim() !== ''

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !ready) return
    onLaunch(shell ? null : command)
  }

  const fill = (value: string | null) => {
    setShell(value === null)
    if (value !== null) setCommand(value)
  }

  return (
    <dialog
      ref={dialog}
      className="session-modal"
      aria-labelledby="launch-title"
      onCancel={(e) => {
        e.preventDefault()
        onCancel()
      }}
    >
      <form className="dialog" onSubmit={submit}>
        <h2 id="launch-title">Bu çalışma kopyasında komut çalıştır</h2>
        <div className="dialog-sub" title={session.cwd}>
          {session.name} · {session.cwd}
        </div>

        <label>
          Komut
          <input
            autoFocus
            value={shell ? '' : command}
            disabled={shell}
            placeholder={shell ? 'Etkileşimli kabuk' : 'örn. claude --resume'}
            onChange={(e) => setCommand(e.target.value)}
          />
        </label>

        <div className="command-fills" role="group" aria-label="Hazır komutlar">
          {[...PRESETS, ...RESUME_COMMANDS].map((shortcut) => {
            const selected = shortcut.command === null ? shell : !shell && command === shortcut.command
            return (
              <button
                type="button"
                key={shortcut.label}
                aria-pressed={selected}
                className={selected ? 'on' : ''}
                onClick={() => fill(shortcut.command)}
              >
                {shortcut.label}
              </button>
            )
          })}
        </div>

        <p className="dialog-note muted">
          Komut aynı klasörde yeni Run olarak aynen çalışır; oturumun başlangıç programı değişmez. Seçiciler
          CLI'ın kendi konuşma listesini açar, hangi konuşmanın süreceğini siz seçersiniz. Ajanlar arasında
          konuşma bağlamı aktarılmaz.
        </p>
        {running && <p className="dialog-note">Çalışan süreç grubu önce doğrulanmış biçimde durdurulur.</p>}

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
            {busy ? 'Başlatılıyor…' : running ? 'Durdur ve çalıştır' : 'Çalıştır'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
