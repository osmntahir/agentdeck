import { useState } from 'react'
import type { AppState, Project, Session } from '../../shared/types'
import { AGENT_LABELS } from '../../shared/types'

interface Props {
  state: AppState
  activeId: string | null
  onSelect: (id: string) => void
  onNewSession: (project: Project) => void
  onAddProject: (path: string) => void
  onDeleteProject: (id: string) => void
}

export function Sidebar({ state, activeId, onSelect, onNewSession, onAddProject, onDeleteProject }: Props) {
  const [path, setPath] = useState('')
  // Proje silmek tüm oturumlarını ve worktree'lerini de götürür; tek tık yetmemeli.
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!path.trim()) return
    onAddProject(path.trim())
    setPath('')
  }

  return (
    <aside className="sidebar">
      <div className="brand">agentdeck</div>

      <div className="projects">
        {state.projects.length === 0 && <div className="pad muted">Henüz proje yok.</div>}

        {state.projects.map((project) => {
          const owned = state.sessions.filter((s) => s.projectId === project.id)
          return (
            <div key={project.id} className="project">
              <div className="project-head">
                <div className="project-name" title={project.path}>
                  {project.name}
                </div>
                <div className="project-actions">
                  {confirmId === project.id ? (
                    <>
                      <button
                        title={`${owned.length} oturum ve worktree silinecek`}
                        onClick={() => {
                          setConfirmId(null)
                          onDeleteProject(project.id)
                        }}
                      >
                        sil?
                      </button>
                      <button title="Vazgeç" onClick={() => setConfirmId(null)}>
                        ×
                      </button>
                    </>
                  ) : (
                    <>
                      <button title="Yeni oturum" onClick={() => onNewSession(project)}>
                        +
                      </button>
                      <button title="Projeyi kaldır" onClick={() => setConfirmId(project.id)}>
                        ×
                      </button>
                    </>
                  )}
                </div>
              </div>

              {owned.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onSelect={() => onSelect(session.id)}
                />
              ))}
            </div>
          )
        })}
      </div>

      <form className="add-project" onSubmit={submit}>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/proje/yolu"
          spellCheck={false}
        />
        <button type="submit">ekle</button>
      </form>
    </aside>
  )
}

function SessionRow({ session, active, onSelect }: { session: Session; active: boolean; onSelect: () => void }) {
  return (
    <button className={`session-row${active ? ' active' : ''}`} onClick={onSelect}>
      <span className={`dot ${session.status}`} />
      <span className="session-name">{session.name}</span>
      <span className="session-agent">{AGENT_LABELS[session.agent]}</span>
      {session.isolation === 'worktree' && <span className="badge">izole</span>}
    </button>
  )
}
