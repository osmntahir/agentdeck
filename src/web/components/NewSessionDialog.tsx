import { useState } from 'react'
import type { Isolation, Project } from '../../shared/types'
import { PRESETS } from '../../shared/types'

interface Props {
  project: Project
  onCancel: () => void
  onCreate: (input: { name: string; command: string | null; isolation: Isolation }) => void
}

export function NewSessionDialog({ project, onCancel, onCreate }: Props) {
  const [name, setName] = useState('')
  // Preset yalnız başlangıç Command'ını doldurur; kalıcı ajan kimliği değildir.
  const [presetIndex, setPresetIndex] = useState(0)
  const [isolation, setIsolation] = useState<Isolation>('worktree')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    onCreate({ name: name.trim(), command: PRESETS[presetIndex].command, isolation })
  }

  return (
    <div className="overlay" onClick={onCancel}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Yeni oturum</h2>
        <div className="dialog-sub">{project.name}</div>

        <label>
          Görev adı
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="isteğe bağlı — örn. auth refactor"
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
            <input type="radio" checked={isolation === 'worktree'} onChange={() => setIsolation('worktree')} />
            <span>
              <strong>İzole</strong> — kendi worktree'si ve branch'i
            </span>
          </label>
          <label className="radio">
            <input type="radio" checked={isolation === 'shared'} onChange={() => setIsolation('shared')} />
            <span>
              <strong>Ortak</strong> — ana çalışma kopyasında
            </span>
          </label>
        </div>

        {/* Yeni klasörde CLI'lar güven veya giriş onayı isteyebilir; bunu
            uygulama vermez, kullanıcı terminalden tamamlar. */}
        <p className="dialog-note muted">
          Ajan, klasör güveni veya giriş onayı isteyebilir; terminalden tamamlayın. İzole kopyada `.env`, bağımlılıklar
          ve servis portları hazır değildir.
        </p>

        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            vazgeç
          </button>
          <button type="submit" className="primary">
            başlat
          </button>
        </div>
      </form>
    </div>
  )
}
