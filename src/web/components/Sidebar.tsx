import { ColorDialog } from './ColorDialog'
import { ActionMenu, type MenuPosition } from './ActionMenu'
import { inProjectNavigation } from '../../shared/workspacePolicy'
import { projectStyle, terminalStyle, usePreferences } from '../preferences'
import { AgentMark } from './AgentMark'
import { Icon } from './Icon'
import { useEffect, useState } from 'react'
import type { ProjectView, SessionView, StateResponse } from '../../shared/types'
import type { OrphanScanResult } from '../api'
import { SESSION_DRAG_TYPE } from '../gridLayout'
import { stateLabel, StatusDot } from '../sessionStatus'

/** Kenar çubuğundaki oturum sırası; Alt+rakam ve Ctrl+PgUp/PgDn bu sırayı izler. */
export function navigationIds(state: StateResponse): string[] {
  return state.projects.flatMap((project) =>
    state.sessions.filter((session) => session.projectId === project.id && inProjectNavigation(session)).map((s) => s.id),
  )
}

interface Props {
  state: StateResponse
  activeId: string | null
  onSelect: (id: string) => void
  onSessionMenu: (id: string, event: React.MouseEvent<HTMLElement>) => void
  onSettings: () => void
  onPalette: () => void
  onAddProject: () => void
  /** Bildirim merkezi; tercih kapalıyken null. */
  notifications: React.ReactNode
  onHome: () => void
  healthy: boolean
  onNewSession: (project: ProjectView) => void
  /** Onay penceresini App açar; kenar çubuğu yalnız isteği iletir. */
  onRemoveProject: (project: ProjectView) => void
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
  onPalette,
  onAddProject,
  notifications,
  onHome,
  healthy,
  onNewSession,
  onRemoveProject,
  orphans,
  onRefreshOrphans,
  view,
  gridCount,
  onGrid,
  onAddToGrid,
}: Props) {
  const preferences = usePreferences()
  const [colorProject, setColorProject] = useState<{ id: string; name: string } | null>(null)
  const [projectMenu, setProjectMenu] = useState<{ id: string; name: string; position: MenuPosition } | null>(null)
  const [rowFocus, setRowFocus] = useState<string | null>(null)
  const visibleIds = navigationIds(state)
  const tabbableId =
    rowFocus && visibleIds.includes(rowFocus)
      ? rowFocus
      : activeId && visibleIds.includes(activeId)
        ? activeId
        : (visibleIds[0] ?? null)
  // Alt basılıyken satırlar Alt+rakam numaralarını gösterir.
  useEffect(() => {
    const root = document.documentElement
    const sync = (event: KeyboardEvent) => root.classList.toggle('alt-held', event.altKey && !event.ctrlKey && !event.metaKey)
    const clear = () => root.classList.remove('alt-held')
    window.addEventListener('keydown', sync, true)
    window.addEventListener('keyup', sync, true)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', sync, true)
      window.removeEventListener('keyup', sync, true)
      window.removeEventListener('blur', clear)
      clear()
    }
  }, [])
  const active = state.sessions.filter((s) => s.archivedAt === null)
  const waiting = active.filter((s) => s.lifecycle === 'live' && s.attention).length

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><Icon name="terminal" size={15} /></span>
        <span className="brand-name">agentdeck</span>
      </div>
      <button className="palette-trigger" onClick={onPalette} aria-keyshortcuts="Control+K Control+Shift+P">
        <Icon name="search" size={15} />
        <span>Ara, geç, başlat…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <nav className="main-nav">
        <button className={`home-nav${activeId === null && view === 'sessions' ? ' selected' : ''}`} onClick={onHome}>
          <Icon name="list" /> Tüm oturumlar
          {waiting > 0 && <span className="nav-attention" title={`${waiting} oturum onay veya yanıt bekliyor`}>{waiting}</span>}
          <span className="nav-count">{active.length}</span>
        </button>
        <button className={`home-nav${activeId === null && view === 'grid' ? ' selected' : ''}`} onClick={onGrid}>
          <Icon name="grid" /> Terminal grid <span className="nav-count">{gridCount}</span>
        </button>
      </nav>
      <div className="sidebar-label">
        <span>Projeler</span>
        <button className="icon-button ghost" title="Proje ekle" aria-label="Proje ekle" onClick={onAddProject}><Icon name="plus" size={14} /></button>
      </div>

      <div className="projects">
        {state.projects.length === 0 && <div className="sidebar-empty">Projeleriniz burada görünecek.</div>}

        {state.projects.map((project) => {
          const owned = state.sessions.filter((s) => s.projectId === project.id)
          const rows = owned.filter(inProjectNavigation)
          return (
            <div key={project.id} className="project" style={projectStyle(project.id, preferences)}>
              <div className="project-head" onContextMenu={e => { e.preventDefault(); setProjectMenu({ id: project.id, name: project.name, position: { x: e.clientX, y: e.clientY, origin: e.currentTarget } }) }}>
                <button className="project-swatch" title={`${project.name} proje rengi`} aria-label={`${project.name} proje rengi`} onClick={() => setColorProject({ id: project.id, name: project.name })} />
                <div className="project-name" title={project.degraded ?? project.path}>
                  <span>{project.name}</span>
                  {project.degraded && <span className="badge warn" title={project.degraded}>!</span>}
                </div>
                <div className="project-actions">
                  <button className="icon-button ghost" title="Yeni oturum" aria-label={`${project.name} içinde yeni oturum`} onClick={() => onNewSession(project)}>
                    <Icon name="plus" size={14} />
                  </button>
                  <button className="icon-button ghost project-remove" title="Projeyi kaldır" aria-label={`${project.name} projesini kaldır`} onClick={() => onRemoveProject(project)}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </div>

              {/* Arşivlenen ve biten oturum gezinmede görünmez (ADR 0014); taramada durur. */}
              {rows.map((session) => {
                const index = visibleIds.indexOf(session.id)
                return (
                  <SessionRow
                    key={session.id}
                    session={session}
                    shortcut={index < 9 ? index + 1 : null}
                    active={session.id === activeId}
                    tabbable={session.id === tabbableId}
                    ids={visibleIds}
                    onFocusRow={() => setRowFocus(session.id)}
                    onSelect={() => onSelect(session.id)}
                    onAddToGrid={() => onAddToGrid(session.id)}
                    onMenu={event => onSessionMenu(session.id, event)}
                  />
                )
              })}
              {rows.length === 0 && (
                <button className="project-idle" onClick={() => onNewSession(project)}>
                  {owned.length > 0 ? 'Çalışan oturum yok · başlat' : 'Oturum başlat'}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {projectMenu && <ActionMenu label="Proje işlemleri" position={projectMenu.position} onClose={() => setProjectMenu(null)} actions={[
        { label: 'Yeni oturum…', icon: 'plus', run: () => { const p = state.projects.find(p => p.id === projectMenu.id); if (p) onNewSession(p) } },
        { label: 'Proje rengi…', icon: 'palette', run: () => setColorProject(projectMenu) },
        { label: 'Projeyi kaldır…', icon: 'trash', danger: true, run: () => { const p = state.projects.find(p => p.id === projectMenu.id); if (p) onRemoveProject(p) } },
      ]} />}
      {colorProject && <ColorDialog {...colorProject} onClose={() => setColorProject(null)} />}
      <OrphanList scan={orphans} onRefresh={onRefreshOrphans} />

      <footer className="sidebar-footer">
        <span className={`connection${healthy ? ' ok' : ''}`} title={healthy ? 'Yerel daemon bağlı' : 'Daemon bağlantısı bekleniyor'}>
          <span className="connection-dot" />
          {healthy ? 'Bağlı' : 'Bağlanıyor…'}
        </span>
        {notifications}
        <button className="icon-button ghost" onClick={onSettings} aria-label="Ayarlar" title="Ayarlar"><Icon name="settings" /></button>
      </footer>
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
    <details className="orphans">
      <summary>
        <Icon name="alert" size={14} />
        <span>Kayıtsız çalışma kopyaları</span>
        <span className="nav-count">{scan.entries.length}</span>
      </summary>
      <div className="orphans-body">
        {scan.entries.map((entry) => (
          <div key={entry.path} className="orphan-row" title={entry.gitLink ?? entry.path}>
            {entry.path}
            {entry.kind === 'symlink-skipped' && <span className="badge">symlink</span>}
          </div>
        ))}
        {(scan.truncated || scan.unreadable.length > 0) && (
          <p className="muted">
            Tarama eksik kaldı; bu liste tam değildir
            {scan.unreadable.length > 0 ? ' (okunamayan dizin var)' : ''}.
          </p>
        )}
        <p className="muted">AgentDeck bunları silmez veya sahiplenmez; yerel araçlarla inceleyin.</p>
        <button onClick={onRefresh}><Icon name="refresh" size={14} /> Yeniden tara</button>
      </div>
    </details>
  )
}

function SessionRow({
  session,
  shortcut,
  active,
  tabbable,
  ids,
  onFocusRow,
  onSelect,
  onAddToGrid,
  onMenu,
}: {
  session: SessionView
  shortcut: number | null
  active: boolean
  tabbable: boolean
  ids: string[]
  onFocusRow: () => void
  onSelect: () => void
  onAddToGrid: () => void
  onMenu: (event: React.MouseEvent<HTMLElement>) => void
}) {
  const preferences = usePreferences()
  return (
    <div style={terminalStyle(session, preferences)} className={`session-row-wrap${session.attention ? ' needs-attention' : ''}`} onContextMenu={onMenu}>
      <button
        className={`session-row${active ? ' active' : ''}`}
        tabIndex={tabbable ? 0 : -1}
        onClick={onSelect}
        onFocus={onFocusRow}
        title={`${stateLabel(session)}${shortcut ? ` · Alt+${shortcut}` : ''} · terminal grid'e sürüklenebilir`}
        aria-keyshortcuts={shortcut ? `Alt+${shortcut}` : undefined}
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
        <AgentMark session={session} />
        <span className="session-name">{session.name}</span>
        {session.degraded && <span className="badge warn" title={session.degraded}>!</span>}
        {session.attention && <span className="row-flag">{session.attention.kind === 'approval' ? 'Onay' : 'Yanıt'}</span>}
        <StatusDot session={session} />
        {shortcut && <kbd className="row-key" aria-hidden="true">{shortcut}</kbd>}
      </button>
      <span className="row-actions">
        <button className="row-menu icon-button ghost" title="Oturum işlemleri" aria-label={`${session.name} işlemleri`} onClick={onMenu}><Icon name="more" size={14} /></button>
        <button
          className="row-grid-add icon-button ghost"
          tabIndex={-1}
          title="Terminal grid'e ekle"
          aria-label={`${session.name} oturumunu terminal grid'e ekle`}
          onClick={onAddToGrid}
        >
          <Icon name="grid" size={14} />
        </button>
      </span>
    </div>
  )
}
