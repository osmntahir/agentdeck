import { useState } from 'react'
import type { Project, SessionView, StateResponse } from '../../shared/types'
import { commandLabel } from '../../shared/types'
import type { OrphanScanResult } from '../api'

interface Props {
  state: StateResponse
  activeId: string | null
  onSelect: (id: string) => void
  onNewSession: (project: Project) => void
  onAddProject: (path: string) => void
  onDeleteProject: (id: string) => void
  orphans: OrphanScanResult | null
  onRefreshOrphans: () => void
}

export function Sidebar({
  state,
  activeId,
  onSelect,
  onNewSession,
  onAddProject,
  onDeleteProject,
  orphans,
  onRefreshOrphans,
}: Props) {
  const [path, setPath] = useState('')
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
                        // Proje kaydı kaldırılır; oturum dosyaları buradan silinmez.
                        title={
                          owned.length > 0
                            ? `${owned.length} oturum kaydı var; proje kaldırılmadan önce onlar silinmeli`
                            : 'Proje kaydını kaldır (dosyalara dokunulmaz)'
                        }
                        onClick={() => {
                          setConfirmId(null)
                          onDeleteProject(project.id)
                        }}
                      >
                        kaldır?
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

      <OrphanList scan={orphans} onRefresh={onRefreshOrphans} />

      <form className="add-project" onSubmit={submit}>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/proje/yolu" spellCheck={false} />
        <button type="submit">ekle</button>
      </form>
    </aside>
  )
}

/**
 * Yönetilen alanda bulunup hiçbir kayıtta görünmeyen çalışma kopyaları. Liste
 * salt okunurdur: uygulama bunları temizlemez ve sahiplenmez. Eksik tarama
 * açıkça söylenir; "temiz" sonucu çıkarılmaz.
 */
function OrphanList({ scan, onRefresh }: { scan: OrphanScanResult | null; onRefresh: () => void }) {
  if (!scan) return null
  if (scan.entries.length === 0 && !scan.truncated && scan.unreadable.length === 0) return null

  return (
    <div className="orphans">
      <div className="project-head">
        <div className="project-name">Kayıtsız çalışma kopyaları</div>
        <div className="project-actions">
          <button title="Yeniden tara" onClick={onRefresh}>
            ↻
          </button>
        </div>
      </div>
      {scan.entries.map((entry) => (
        <div key={entry.path} className="orphan-row" title={entry.gitLink ?? entry.path}>
          {entry.path}
          {entry.kind === 'symlink-skipped' && <span className="badge">symlink</span>}
        </div>
      ))}
      {(scan.truncated || scan.unreadable.length > 0) && (
        <div className="pad muted">
          Tarama eksik kaldı; bu liste tam değildir{scan.unreadable.length > 0 ? ' (okunamayan dizin var)' : ''}.
        </div>
      )}
      <div className="pad muted">AgentDeck bunları silmez veya sahiplenmez; yerel araçlarla inceleyin.</div>
    </div>
  )
}

/**
 * Canlı etiket sessizliği sessizlik olarak söyler: "bekliyor" veya "hata"
 * sonucu çıkarılmaz. Dikkat bilgisi yalnız açık hata ve orphaned ile ayrılır.
 */
function stateLabel(session: SessionView): string {
  if (session.lifecycle === 'live') return session.activity === 'idle' ? 'Sessiz · 30 sn' : 'Çalışıyor'
  if (session.lifecycle === 'orphaned') return 'Bağlantı yok'
  if (session.exitCode !== null) return `Çıktı · kod ${session.exitCode}`
  if (session.exitSignal !== null) return `Çıktı · sinyal ${session.exitSignal}`
  return 'Çıktı'
}

function SessionRow({
  session,
  active,
  onSelect,
}: {
  session: SessionView
  active: boolean
  onSelect: () => void
}) {
  return (
    <button className={`session-row${active ? ' active' : ''}`} onClick={onSelect} title={stateLabel(session)}>
      <span className={`dot ${session.lifecycle}`} />
      <span className="session-name">{session.name}</span>
      <span className="session-agent">{commandLabel(session.command)}</span>
      {session.isolation === 'worktree' && <span className="badge">izole</span>}
    </button>
  )
}
