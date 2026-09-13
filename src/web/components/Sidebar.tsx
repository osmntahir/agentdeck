import { inProjectNavigation } from '../../shared/workspacePolicy'
import { projectStyle, usePreferences, updatePreferences } from '../preferences'
import { AgentMark } from './AgentMark'
import { Icon } from './Icon'
import { useState } from 'react'
import type { ProjectView, SessionView, StateResponse } from '../../shared/types'
import type { OrphanScanResult, ProjectDeletePreview } from '../api'
import { SESSION_DRAG_TYPE } from '../gridLayout'

interface Props {
  state: StateResponse
  activeId: string | null
  onSelect: (id: string) => void
  onSessionMenu: (id: string, event: React.MouseEvent<HTMLElement>) => void
  onSettings: () => void
  /** Bildirim merkezi; tercih kapalıyken null. */
  notifications: React.ReactNode
  onHome: () => void
  healthy: boolean
  onNewSession: (project: ProjectView) => void
  onAddProject: () => void
  onDeleteProject: (id: string) => void
  /** Oturumu olan projenin silme önizlemesi; onay bu projede gösterilir. */
  projectDelete: ProjectDeletePreview | null
  onPreviewProjectDelete: (id: string) => void
  onConfirmProjectDelete: () => void
  onCancelProjectDelete: () => void
  orphans: OrphanScanResult | null
  onRefreshOrphans: () => void
  view: 'sessions' | 'grid'
  gridCount: number
  onGrid: () => void
  onAddToGrid: (sessionId: string) => void
}

export function Sidebar({
  state,
  activeId,
  onSelect,
  onSessionMenu,
  onSettings,
  notifications,
  onHome,
  healthy,
  onNewSession,
  onAddProject,
  onDeleteProject,
  projectDelete,
  onPreviewProjectDelete,
  onConfirmProjectDelete,
  onCancelProjectDelete,
  orphans,
  onRefreshOrphans,
  view,
  gridCount,
  onGrid,
  onAddToGrid,
}: Props) {
  const preferences = usePreferences()
  const [colorError, setColorError] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [rowFocus, setRowFocus] = useState<string | null>(null)
  const visibleIds = state.projects.flatMap((project) =>
    state.sessions.filter((session) => session.projectId === project.id && inProjectNavigation(session)).map((s) => s.id),
  )
  const tabbableId =
    rowFocus && visibleIds.includes(rowFocus)
      ? rowFocus
      : activeId && visibleIds.includes(activeId)
        ? activeId
        : (visibleIds[0] ?? null)

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-symbol">&gt;_</span>agentdeck<span className="brand-local">LOCAL</span>
      </div>
      <nav className="main-nav">
        <button className={`home-nav${activeId === null && view === 'sessions' ? ' selected' : ''}`} onClick={onHome}>
          <span>▦</span> Tüm oturumlar{' '}
          <span className="nav-count">{state.sessions.filter((s) => s.archivedAt === null).length}</span>
        </button>
        <button className={`home-nav${activeId === null && view === 'grid' ? ' selected' : ''}`} onClick={onGrid}>
          <span>⊞</span> Terminal grid <span className="nav-count">{gridCount}</span>
        </button>
      </nav>
      <div className="sidebar-label">
        PROJELER <span>{state.projects.length}</span>
      </div>

      <div className="projects">
        {state.projects.length === 0 && <div className="pad muted">Projeleriniz burada görünecek.</div>}

        {state.projects.map((project) => {
          const owned = state.sessions.filter((s) => s.projectId === project.id)
          return (
            <div key={project.id} className="project colored-project" style={projectStyle(project.id, preferences)}>
              <div className="project-head">
                <label className="project-color" title={`${project.name} proje rengi`}><input type="color" aria-label={`${project.name} proje rengi`} value={preferences.colors[project.id] ?? '#9aaad4'} onChange={e => {
                  try { updatePreferences({ colors: { ...preferences.colors, [project.id]: e.target.value } }); setColorError(null) }
                  catch { setColorError('Proje rengi kaydedilemedi.') }
                }} /></label>
                <div className="project-name" title={project.degraded ?? project.path}>
                  {project.name}
                  {project.degraded && (
                    <span className="badge warn" title={project.degraded}>
                      !
                    </span>
                  )}
                </div>
                <div className="project-actions">
                  {confirmId === project.id ? (
                    <>
                      <button
                        // Oturumu olmayan projede yalnız kayıt kaldırılır; dosyalara dokunulmaz.
                        title="Proje kaydını kaldır (dosyalara dokunulmaz)"
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
                      <button
                        title="Projeyi kaldır"
                        // Oturumu olan projede önce neyin silineceği gösterilir.
                        onClick={() => (owned.length > 0 ? onPreviewProjectDelete(project.id) : setConfirmId(project.id))}
                      >
                        ×
                      </button>
                    </>
                  )}
                </div>
              </div>

              {projectDelete?.projectId === project.id && (
                <div className="project-delete-confirm" role="alert">
                  <span>{projectDeleteSummary(projectDelete)}</span>
                  {/* Kullanıcı silinecek tam yolları onaydan önce görür. */}
                  <ul>
                    {projectDelete.sessions
                      .filter((s) => s.isolation === 'worktree')
                      .map((s) => (
                        <li key={s.id}>
                          <code>{s.cwd}</code>
                        </li>
                      ))}
                  </ul>
                  <div className="project-actions">
                    <button onClick={onConfirmProjectDelete}>sil (branch'ler kalır)</button>
                    <button onClick={onCancelProjectDelete}>vazgeç</button>
                  </div>
                </div>
              )}

              {/* Arşivlenen oturum gezinmede görünmez; proje silme onayında yine sayılır. */}
              {owned.filter(inProjectNavigation).map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  tabbable={session.id === tabbableId}
                  ids={visibleIds}
                  onFocusRow={() => setRowFocus(session.id)}
                  onSelect={() => onSelect(session.id)}
                  onAddToGrid={() => onAddToGrid(session.id)}
                  onMenu={event => onSessionMenu(session.id, event)}
                />
              ))}
            </div>
          )
        })}
      </div>

      {colorError && <p className="error">{colorError}</p>}
      <OrphanList scan={orphans} onRefresh={onRefreshOrphans} />

      <div className="sidebar-connection">
        <span className={`dot ${healthy ? 'live' : 'orphaned'}`} />
        {healthy ? 'Yerel bağlantı hazır' : 'Bağlantı bekleniyor'}
      </div>
      <div className="sidebar-tools">
        <button className="settings-button" onClick={onSettings}>⚙ Ayarlar</button>
        {notifications}
      </div>
      <div className="add-project">
        <button className="sidebar-add-project" onClick={onAddProject}>
          + Proje ekle
        </button>
      </div>
    </aside>
  )
}

/** Proje silmenin neyi götürüp neyi koruyacağını onaydan önce söyler. */
function projectDeleteSummary(preview: ProjectDeletePreview): string {
  const isolated = preview.sessions.filter((s) => s.isolation === 'worktree')
  const changed = isolated.reduce((sum, s) => sum + s.changedEntries, 0)
  const ignored = isolated.reduce((sum, s) => sum + s.ignoredEntries, 0)
  return (
    `${preview.sessions.length} oturum kaydı kaldırılır, ${isolated.length} izole çalışma kopyası silinir` +
    (changed + ignored > 0 ? ` (${changed} değişiklik ve ${ignored} ignored giriş dahil)` : '') +
    ". Ortak klasör dosyaları ve branch'ler korunur."
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
          Tarama eksik kaldı; bu liste tam değildir
          {scan.unreadable.length > 0 ? ' (okunamayan dizin var)' : ''}.
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
export function stateLabel(session: SessionView): string {
  if (session.lifecycle === 'live') return session.activity === 'idle' ? 'Sessiz · 30 sn' : 'Çalışıyor'
  if (session.lifecycle === 'orphaned') return 'Bağlantı yok'
  if (session.exitCode !== null) return `Çıktı · kod ${session.exitCode}`
  if (session.exitSignal !== null) return `Çıktı · sinyal ${session.exitSignal}`
  return 'Çıktı'
}

function SessionRow({
  session,
  active,
  tabbable,
  ids,
  onFocusRow,
  onSelect,
  onAddToGrid,
  onMenu,
}: {
  session: SessionView
  active: boolean
  tabbable: boolean
  ids: string[]
  onFocusRow: () => void
  onSelect: () => void
  onAddToGrid: () => void
  onMenu: (event: React.MouseEvent<HTMLElement>) => void
}) {
  return (
    <div className="session-row-wrap" onContextMenu={onMenu}>
      <button
        className={`session-row${active ? ' active' : ''}`}
        tabIndex={tabbable ? 0 : -1}
        onClick={onSelect}
        onFocus={onFocusRow}
        title={`${stateLabel(session)} · terminal grid'e sürüklenebilir`}
        draggable
        onDragStart={(e) => e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          e.preventDefault()
          const index = ids.indexOf(session.id)
          const next = ids[e.key === 'ArrowDown' ? Math.min(ids.length - 1, index + 1) : Math.max(0, index - 1)]
          if (next) document.getElementById(`session-row-${next}`)?.focus()
        }}
        id={`session-row-${session.id}`}
      >
        <span className={`dot ${session.lifecycle}`} />
        <AgentMark session={session} />
        <span className="session-name">{session.name}</span>

        {session.degraded && (
          <span className="badge warn" title={session.degraded}>
            !
          </span>
        )}

      </button>
      <button className="row-menu" title="Oturum işlemleri" aria-label={`${session.name} işlemleri`} onClick={onMenu}><Icon name="more" /></button>
      <button
        className="row-grid-add"
        tabIndex={-1}
        title="Terminal grid'e ekle"
        aria-label={`${session.name} oturumunu terminal grid'e ekle`}
        onClick={onAddToGrid}
      >
        ⊞
      </button>
    </div>
  )
}
