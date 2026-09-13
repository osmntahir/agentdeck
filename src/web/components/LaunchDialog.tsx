import { useEffect, useRef, useState } from 'react'
import type { SessionView } from '../../shared/types'
import { PRESETS } from '../../shared/types'

/** CLI'ların kendi etkileşimli seçicileri: konuşmayı kullanıcı seçer, uygulama kimlik üretmez. */
const PICKERS = [
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
  const initial = session.lastLaunch?.mode === 'command' ? session.lastLaunch.command : session.command
  // null etkileşimli kabuk demektir; boş komut çalıştırılamaz.
  const [shell, setShell] = useState(initial === null)
  const [command, setCommand] = useState(initial ?? '')
  const live = session.lifecycle === 'live'
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
          {[...PRESETS, ...PICKERS].map((preset) => (
            <button
              type="button"
              key={preset.label}
              aria-pressed={preset.command === null ? shell : !shell && command === preset.command}
              className={(preset.command === null ? shell : !shell && command === preset.command) ? 'on' : ''}
              onClick={() => fill(preset.command)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <p className="dialog-note muted">
          Komut aynı klasörde yeni Run olarak aynen çalışır; oturumun başlangıç programı değişmez. Seçiciler
          CLI'ın kendi konuşma listesini açar, hangi konuşmanın süreceğini siz seçersiniz. Ajanlar arasında
          konuşma bağlamı aktarılmaz.
        </p>
        {live && <p className="dialog-note">Canlı Run önce doğrulanmış biçimde durdurulur.</p>}

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
            {busy ? 'Başlatılıyor…' : live ? 'Durdur ve çalıştır' : 'Çalıştır'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
