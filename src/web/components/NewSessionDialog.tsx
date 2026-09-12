import { useState } from 'react'
import type { AgentKind, Isolation, Project } from '../../shared/types'
import { AGENT_LABELS } from '../../shared/types'

interface Props {
  project: Project
  onCancel: () => void
  onCreate: (input: { name: string; agent: AgentKind; isolation: Isolation }) => void
}

export function NewSessionDialog({ project, onCancel, onCreate }: Props) {
  const [name, setName] = useState('')
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [isolation, setIsolation] = useState<Isolation>('worktree')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    onCreate({ name: name.trim() || 'oturum', agent, isolation })
  }

  return (
    <div className="overlay" onClick={onCancel}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Yeni oturum</h2>
        <div className="dialog-sub">{project.name}</div>

        <label>
          Görev adı
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="örn. auth refactor" />
        </label>

        <label>
          Ajan
          <select value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)}>
            {(Object.keys(AGENT_LABELS) as AgentKind[]).map((key) => (
              <option key={key} value={key}>
                {AGENT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>

        <div className="radio-group">
          <label className="radio">
            <input
              type="radio"
              checked={isolation === 'worktree'}
              onChange={() => setIsolation('worktree')}
            />
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
