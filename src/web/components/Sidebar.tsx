import { ColorDialog } from './ColorDialog'
import { ActionMenu, type MenuPosition } from './ActionMenu'
import { inProjectNavigation } from '../../shared/workspacePolicy'
import { projectStyle, terminalStyle, toggleWorkCollapsed, usePreferences } from '../preferences'
import { AgentMark } from './AgentMark'
import { AccountsPanel } from './AccountsPanel'
import { Icon } from './Icon'
import { useEffect, useState } from 'react'
import type { ClaudeAgentView, ProjectView, SessionView, StateResponse, Work } from '../../shared/types'
import { claudeStateLabel, claudeStateTone } from './ClaudeSessions'
import { ProgramIcon } from './AgentMark'
import type { OrphanScanResult } from '../api'
import { SESSION_DRAG_TYPE } from '../gridLayout'
import { SHORTCUT_LABELS } from '../../shared/shortcuts'
import { stateLabel, StatusDot } from '../sessionStatus'

/**
 * Projedeki gezinme satırlarının iş grupları. Oturumu hiç olmayan yeni iş de
 * görünür; oturumlarının hepsi bitmiş iş kenar çubuğundan çekilir, taramada kalır.
 */
export function sidebarGroups(state: StateResponse, projectId: string): { works: { work: Work; rows: SessionView[] }[]; loose: SessionView[] } {
  const owned = state.sessions.filter((s) => s.projectId === projectId)
  const rows = owned.filter(inProjectNavigation)
  const projectWorks = (state.works ?? []).filter((w) => w.projectId === projectId)
  const works = projectWorks
    .map((work) => ({ work, rows: rows.filter((s) => s.workId === work.id) }))
    .filter((group) => group.rows.length > 0 || !owned.some((s) => s.workId === group.work.id) || Boolean(group.work.claudeSessions?.length))
  const loose = rows.filter((s) => !projectWorks.some((w) => w.id === s.workId))
  return { works, loose }
}

/**
 * Kenar çubuğundaki oturum sırası; Alt+rakam ve Ctrl+PgUp/PgDn bu sırayı izler.
 * Kapalı işin satırları görünmediği için sıraya girmez.
 */
export function navigationIds(state: StateResponse, collapsedWorks: readonly string[] = []): string[] {
  return state.projects.flatMap((project) => {
    const { works, loose } = sidebarGroups(state, project.id)
    return [...works.filter((group) => !collapsedWorks.includes(group.work.id)).flatMap((group) => group.rows), ...loose].map((s) => s.id)
  })
}

interface Props {
  state: StateResponse
  activeId: string | null
  /** Grid görünümünde açık grid'deki oturumlar; tek oturumdaki gibi vurgulanır. */
  gridSessionIds: string[]
  /** Yalnız simgelerden oluşan dar şerit. */
  collapsed: boolean
  onToggleCollapsed: () => void
  onSelect: (id: string) => void
  onSessionMenu: (id: string, event: React.MouseEvent<HTMLElement>) => void
  onSettings: () => void
  onPalette: () => void
  onAddProject: () => void
  /** Bildirim merkezi; tercih kapalıyken null. */
  notifications: React.ReactNode
  onHome: () => void
  healthy: boolean
  /** workId verilirse yeni oturum o işte açılır. */
  onNewSession: (project: ProjectView, workId?: string) => void
  onWorkMenu: (work: Work, event: React.MouseEvent<HTMLElement>) => void
  onOpenClaude: (work: Work, agent: ClaudeAgentView) => void
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
  gridSessionIds,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onSessionMenu,
  onSettings,
  onPalette,
  onAddProject,
  notifications,
  onHome,
  healthy,
  onNewSession,
  onWorkMenu,
  onOpenClaude,
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
  const visibleIds = navigationIds(state, preferences.collapsedWorks)
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
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><Icon name="terminal" size={15} /></span>
        <span className="brand-name">agentdeck</span>
        <button className="icon-button ghost sidebar-toggle" onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Kenar çubuğunu genişlet' : 'Kenar çubuğunu daralt'}
          title={`${collapsed ? 'Genişlet' : 'Daralt'} · ${SHORTCUT_LABELS.sidebar}`}>
          <Icon name="sidebar" size={16} />
        </button>
      </div>
      <button className="palette-trigger" onClick={onPalette} aria-keyshortcuts="Control+K Control+Shift+P" title="Ara, geç, başlat · Ctrl+K">
        <Icon name="search" size={15} />
        <span>Ara, geç, başlat…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <nav className="main-nav">
        <button className={`home-nav${activeId === null && view === 'sessions' ? ' selected' : ''}`} onClick={onHome} title="Tüm oturumlar">
          <Icon name="list" /> <span className="nav-label">Tüm oturumlar</span>
          {waiting > 0 && <span className="nav-attention" title={`${waiting} oturum onay veya yanıt bekliyor`}>{waiting}</span>}
          <span className="nav-count">{active.length}</span>
        </button>
        <button className={`home-nav${activeId === null && view === 'grid' ? ' selected' : ''}`} onClick={onGrid} title="Terminal grid">
          <Icon name="grid" /> <span className="nav-label">Terminal grid</span> <span className="nav-count">{gridCount}</span>
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
          const groups = sidebarGroups(state, project.id)
          const renderRow = (session: SessionView) => {
            const index = visibleIds.indexOf(session.id)
            return (
              <SessionRow
                key={session.id}
                session={session}
                shortcut={index < 9 ? index + 1 : null}
                active={session.id === activeId || gridSessionIds.includes(session.id)}
                tabbable={session.id === tabbableId}
                ids={visibleIds}
                onFocusRow={() => setRowFocus(session.id)}
                onSelect={() => onSelect(session.id)}
                onAddToGrid={() => onAddToGrid(session.id)}
                onMenu={event => onSessionMenu(session.id, event)}
              />
            )
          }
          return (
            <div key={project.id} className="project" style={projectStyle(project.id, preferences)}>
              <div className="project-head" onContextMenu={e => { e.preventDefault(); setProjectMenu({ id: project.id, name: project.name, position: { x: e.clientX, y: e.clientY, origin: e.currentTarget } }) }}>
                <button className="project-tile" title={`${project.name} · proje işlemleri`} aria-label={`${project.name} proje işlemleri`}
                  onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); setProjectMenu({ id: project.id, name: project.name, position: { x: rect.left, y: rect.bottom + 4, origin: e.currentTarget } }) }}>
                  {/* Proje adları çoğunlukla İngilizce; Türkçe büyük harf "ki" → "Kİ" yapardı. */}
                  {project.name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '•'}
                </button>
                <div className="project-name" title={project.degraded ?? project.path}>
                  <span>{project.name}</span>
                  {project.degraded && <span className="badge warn" title={project.degraded}>!</span>}
                  {rows.length > 0 && <span className="project-count">{rows.length}</span>}
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
              <div className="project-sessions">
              {groups.works.map(({ work, rows: workRows }) => {
                const claude = state.claudeSessions?.[work.id] ?? []
                // Zaten bir terminalde açık olan Claude oturumu ikinci satır olarak gösterilmez.
                const detached = claude.filter((agent) => !workRows.some((s) => s.command === `claude attach ${agent.id}` || (s.lastLaunch?.mode === 'command' && s.lastLaunch.command === `claude attach ${agent.id}`)))
                const waitingInWork = workRows.filter((s) => s.lifecycle === 'live' && s.attention).length + claude.filter((a) => a.state === 'blocked').length
                const collapsed = preferences.collapsedWorks.includes(work.id)
                return (
                  <div key={work.id} className={`work-group${collapsed ? ' collapsed' : ''}`}>
                    <div className="work-head" onContextMenu={(e) => onWorkMenu(work, e)}>
                      <button className="work-toggle" aria-expanded={!collapsed} onClick={() => toggleWorkCollapsed(work.id)}
                        title={`${work.name} · ${collapsed ? 'aç' : 'kapat'}`}>
                        <span className="work-chevron" aria-hidden="true"><Icon name="chevron" size={11} /></span>
                        <span className="work-name">{work.name}</span>
                      </button>
                      {waitingInWork > 0 && <span className="row-flag" title={`${waitingInWork} terminal onay veya yanıt bekliyor`}>{waitingInWork}</span>}
                      {workRows.length > 0 && <span className="project-count">{workRows.length}</span>}
                      <span className="work-actions">
                        <button className="icon-button ghost" title="Bu işte yeni oturum" aria-label={`${work.name} işinde yeni oturum`} onClick={() => onNewSession(project, work.id)}><Icon name="plus" size={13} /></button>
                        <button className="icon-button ghost" title="İş işlemleri" aria-label={`${work.name} iş işlemleri`} onClick={(e) => onWorkMenu(work, e)}><Icon name="more" size={13} /></button>
                      </span>
                    </div>
                    {!collapsed && <div className="work-sessions">
                      {workRows.map(renderRow)}
                      {detached.map((agent) => (
                        <div key={agent.id} className="session-row-wrap claude-row">
                          <button className="session-row" tabIndex={-1} onClick={() => onOpenClaude(work, agent)}
                            title={`${agent.name} · Claude oturumu · ${claudeStateLabel(agent.state)}${agent.detail ? `\n${agent.detail}` : ''}\nTıkla: bu işte terminalde aç (claude attach ${agent.id})`}>
                            <ProgramIcon command="claude" />
                            <span className="session-name">{agent.name}</span>
                            {agent.state === 'blocked' && <span className="row-flag">Girdi</span>}
                            <span className="status-dot" data-tone={claudeStateTone(agent.state)} aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                      {workRows.length === 0 && detached.length === 0 && (
                        <button className="project-idle" onClick={() => onNewSession(project, work.id)}>
                          <Icon name="plus" size={12} /><span>Bu işte oturum başlat</span>
                        </button>
                      )}
                    </div>}
                  </div>
                )
              })}
              {groups.loose.map(renderRow)}
              {rows.length === 0 && groups.works.length === 0 && (
                <button className="project-idle" onClick={() => onNewSession(project)} title={`${project.name} içinde oturum başlat`}>
                  <Icon name="plus" size={12} /><span>{owned.length > 0 ? 'Çalışan oturum yok · başlat' : 'Oturum başlat'}</span>
                </button>
              )}
              </div>
            </div>
          )
        })}
      </div>

      {projectMenu && <ActionMenu label="Proje işlemleri" position={projectMenu.position} onClose={() => setProjectMenu(null)} actions={[
        { label: 'Yeni oturum…', icon: 'plus', run: () => { const p = state.projects.find(p => p.id === projectMenu.id); if (p) onNewSession(p) } },
        { label: 'Yeni iş…', icon: 'work', description: 'Yeni iş ve ilk terminali birlikte açılır.', run: () => { const p = state.projects.find(p => p.id === projectMenu.id); if (p) onNewSession(p, 'new') } },
        { label: 'Proje rengi…', icon: 'palette', run: () => setColorProject(projectMenu) },
        { label: 'Projeyi kaldır…', icon: 'trash', danger: true, run: () => { const p = state.projects.find(p => p.id === projectMenu.id); if (p) onRemoveProject(p) } },
      ]} />}
      {colorProject && <ColorDialog {...colorProject} onClose={() => setColorProject(null)} />}
      <OrphanList scan={orphans} onRefresh={onRefreshOrphans} />
      <AccountsPanel />

      <footer className="sidebar-footer">
        <span className={`connection${healthy ? ' ok' : ''}`} title={healthy ? 'Yerel daemon bağlı' : 'Daemon bağlantısı bekleniyor'}>
          <span className="connection-dot" />
          <span className="connection-label">{healthy ? 'Bağlı' : 'Bağlanıyor…'}</span>
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
        // Orta tık tarayıcı sekmesi gibi: açmadan grid'e ekler.
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onAddToGrid() } }}
        onFocus={onFocusRow}
        title={`${session.name} · ${stateLabel(session)}${shortcut ? ` · Alt+${shortcut}` : ''}${session.conversation?.lastPrompt ? `\nSon istem: ${session.conversation.lastPrompt}` : ''}\nOrta tık veya sürükle: grid'e ekle · Ctrl basılı sürükle: aynı programdan kopya`}
        aria-keyshortcuts={shortcut ? `Alt+${shortcut}` : undefined}
        draggable
        onDragStart={(e) => { e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id); e.dataTransfer.effectAllowed = 'copyMove' }}
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
