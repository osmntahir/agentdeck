import { ColorDialog } from './components/ColorDialog'
import { ActionMenu, type MenuAction, type MenuPosition } from './components/ActionMenu'
import { Icon } from './components/Icon'
import { AgentMark } from './components/AgentMark'
import { BranchPicker } from './components/BranchPicker'
import { SettingsDialog } from './components/SettingsDialog'
import { usePreferences, terminalStyle } from './preferences'
import { useWorkspaceLifecycle } from './useWorkspaceLifecycle'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as api from './api'
import { AddProjectDialog } from './components/AddProjectDialog'
import { Workspace } from './components/Workspace'
import { Sidebar, stateLabel } from './components/Sidebar'
import { SidebarShell } from './components/SidebarShell'
import { TerminalPane } from './components/TerminalPane'
import { DiffView } from './components/DiffView'
import { NewSessionDialog } from './components/NewSessionDialog'
import { LaunchDialog } from './components/LaunchDialog'
import { TerminalGrid } from './components/TerminalGrid'
import { loadGridWorkspaces, saveGridWorkspaces, clearGridLayout, savedGridSessionIds } from './gridLayout'
import { createStatePoller, pollPreviewIds } from '../shared/statePoll'
import { sessionWorkActions, sessionWorkCli } from '../shared/sessionActions'
import {
  hasRunningProcesses,
  type Isolation,
  type Project,
  type StateResponse,
  type SessionView,
} from '../shared/types'

const TRUST_NOTE = 'Ajan klasör güveni veya giriş onayı isteyebilir; terminalden tamamlayın.'

function boardSessionIds(state: StateResponse): string[] {
  return state.projects.flatMap((project) =>
    state.sessions.filter((session) => session.projectId === project.id && session.archivedAt === null).map((s) => s.id),
  )
}

function nextVisibleSession(ids: string[], id: string): string | null {
  const index = ids.indexOf(id)
  if (index < 0) return ids[0] ?? null
  return ids[index + 1] ?? ids[index - 1] ?? null
}

function trustKey(id: string): string {
  return `agentdeck.trustNote.${id}`
}

/** Silinecek içeriği onaydan önce söyler; ignored dosyalar da silinir. */
function deleteQuestion(preview: api.DeletePreview): string {
  const parts: string[] = []
  if (preview.changedEntries > 0) parts.push(`${preview.changedEntries} değişiklik`)
  if (preview.ignoredEntries > 0) parts.push(`${preview.ignoredEntries} ignored giriş (.env ve bağımlılıklar dahil)`)
  return parts.length > 0 ? `${parts.join(' ve ')} ile birlikte klasörü sil?` : 'klasörü sil?'
}

const EMPTY: StateResponse = {
  protocolVersion: 2,
  daemonId: '',
  revision: 0,
  serverNow: 0,
  projects: [],
  sessions: [],
  serviceError: null,
}

export function App() {
  const preferences = usePreferences()
  const notificationsEnabled = useRef(preferences.notifications)
  notificationsEnabled.current = preferences.notifications
  useLayoutEffect(() => { document.documentElement.dataset.theme = preferences.theme }, [preferences.theme])
  const [colorSession, setColorSession] = useState<SessionView | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [menu, setMenu] = useState<{ id: string; position: MenuPosition } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [state, setState] = useState<StateResponse>(EMPTY)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [tab, setTab] = useState<'terminal' | 'diff'>('terminal')
  // Oturum seçili değilken ana alanın gösterdiği görünüm.
  const [view, setView] = useState<'sessions' | 'grid'>('sessions')
  const [grids, setGrids] = useState(loadGridWorkspaces)
  const [gridId, setGridId] = useState(() => loadGridWorkspaces()[0].id)
  const [gridIds, setGridIds] = useState<string[]>(() => savedGridSessionIds(loadGridWorkspaces()[0].id))
  const [pendingGridAdd, setPendingGridAdd] = useState<string | null>(null)
  const [addingProject, setAddingProject] = useState(false)
  const [dialogProject, setDialogProject] = useState<Project | null>(null)
  const [pendingDelete, setPendingDelete] = useState<api.DeletePreview | null>(null)
  const [projectDelete, setProjectDelete] = useState<api.ProjectDeletePreview | null>(null)
  const [orphans, setOrphans] = useState<api.OrphanScanResult | null>(null)
  const [stateHealthy, setStateHealthy] = useState(false)
  const previewIds = useRef<string[]>([])
  const pollerRef = useRef<ReturnType<typeof createStatePoller<StateResponse>> | null>(null)
  const scanVisibleRef = useRef(true)
  const inflightState = useRef<AbortController | null>(null)
  const receivedAt = useRef(performance.now())
  const [, setTick] = useState(0)
  const [scanFocusId, setScanFocusId] = useState<string | null>(null)
  const [trustHidden, setTrustHidden] = useState(false)
  const setPreviewIds = useCallback((ids: string[]) => {
    const previous = previewIds.current.join(',')
    previewIds.current = ids
    if (ids.join(',') !== previous) void pollerRef.current?.refresh()
  }, [])
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [launchOpen, setLaunchOpen] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => pollerRef.current?.refresh() ?? Promise.resolve()
  const lifecycle = useWorkspaceLifecycle(state, stateHealthy, preferences)

  // Yetim keşfi salt okunurdur ve poll edilmez: açılışta ve istenince okunur.
  const refreshOrphans = () =>
    api
      .getOrphanWorktrees()
      .then(setOrphans)
      .catch(() => setOrphans(null))

  useEffect(() => {
    const poller = createStatePoller<StateResponse>({
      fetchState: () => {
        inflightState.current?.abort()
        const ac = new AbortController()
        inflightState.current = ac
        return api.getState(pollPreviewIds(scanVisibleRef.current, previewIds.current), ac.signal)
      },
      schedule: (fn, ms) => window.setTimeout(fn, ms),
      cancel: (handle) => window.clearTimeout(handle as number),
      isHidden: () => document.visibilityState === 'hidden' && !notificationsEnabled.current,
      onState: (next) => {
        receivedAt.current = performance.now()
        setState(next)
        setStateHealthy(true)
        setConnectionError(null)
      },
      onFailure: (failure) => {
        setStateHealthy(false)
        setConnectionError(
          failure.retryInMs !== null
            ? `${failure.message} · ${Math.round(failure.retryInMs / 1000)} sn sonra yeniden denenecek`
            : failure.message,
        )
      },
    })
    pollerRef.current = poller
    poller.start()
    refreshOrphans()
    const onVis = () => poller.visibilityChanged()
    document.addEventListener('visibilitychange', onVis)
    const tick = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => {
      poller.stop()
      pollerRef.current = null
      inflightState.current?.abort()
      inflightState.current = null
      document.removeEventListener('visibilitychange', onVis)
      window.clearInterval(tick)
    }
  }, [])

  useEffect(() => {
    pollerRef.current?.visibilityChanged()
  }, [preferences.notifications])

  const now = state.serverNow ? state.serverNow + (performance.now() - receivedAt.current) : Date.now()

  const active = state.sessions.find((s) => s.id === activeId) ?? null
  const scanVisible = !active && view === 'sessions'
  scanVisibleRef.current = scanVisible
  // Gizli taramada 24 kart önizlemesi 5 sn timeout'u aşıp girdiyi kapatmasın.
  useLayoutEffect(() => {
    if (!scanVisible) setPreviewIds([])
  }, [scanVisible, setPreviewIds])
  const activeProject = active ? (state.projects.find((p) => p.id === active.projectId) ?? null) : null
  const showTrust = Boolean(
    active && active.isolation === 'worktree' && active.lifecycle === 'live' && sessionWorkCli(active) !== null && !trustHidden && sessionStorage.getItem(trustKey(active.id)) !== '1',
  )

  // Önceki Run görüntüleri saklanmış kayıtlardan okunur; oturum veya Run değişince seçim güncele döner.
  const [runs, setRuns] = useState<api.RunsResult | null>(null)
  const [inspectRunId, setInspectRunId] = useState<string | null>(null)
  useEffect(() => {
    setInspectRunId(null)
    setRuns(null)
    if (!active) return
    let cancelled = false
    api
      .getRuns(active.id)
      .then((next) => {
        if (!cancelled) setRuns(next)
      })
      .catch(() => {
        if (!cancelled) setRuns(null)
      })
    return () => {
      cancelled = true
    }
  }, [active?.id, active?.runId])

  const [copiedPath, setCopiedPath] = useState(false)
  // Düğmeler değişince eski açıklama ve kopyalama bildirimi ekranda kalmaz.
  useEffect(() => {
    setCopiedPath(false)
    setTrustHidden(false)
  }, [active?.id, active?.archivedAt, active?.lifecycle])

  const leaveToScan = () => {
    setActiveId(null)
    setPendingDelete(null)
    setLaunchOpen(false)
  }

  useEffect(() => {
    const inField = (target: EventTarget | null) =>
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
    const inTerminal = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('.xterm'))
    const chromeStops = () =>
      [
        document.querySelector<HTMLElement>('.mobile-navigation button') ?? document.querySelector<HTMLElement>('.sidebar .home-nav'),
        document.querySelector<HTMLElement>('.topbar-back'),
        document.querySelector<HTMLElement>('.term-host textarea, .term-host canvas, .xterm-helper-textarea'),
      ].filter((el): el is HTMLElement => el !== null && el.getClientRects().length > 0)

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F6') {
        event.preventDefault()
        if (document.querySelector('dialog[open], [role=menu]')) return
        if (inTerminal(event.target)) {
          ;(document.querySelector<HTMLElement>('.topbar-back') ?? document.querySelector<HTMLElement>('.mobile-navigation button') ?? document.querySelector<HTMLElement>('.home-nav'))?.focus()
          return
        }
        const stops = chromeStops()
        if (stops.length === 0) return
        const current = stops.findIndex((el) => el === event.target || el.contains(event.target as Node))
        const next = event.shiftKey
          ? stops[(current <= 0 ? stops.length : current) - 1]
          : stops[(current + 1) % stops.length]
        next?.focus()
        return
      }
      if (event.key !== 'Escape') return
      if (inTerminal(event.target) || inField(event.target)) return
      if (document.querySelector('dialog[open], [role=menu]')) return
      if (launchOpen) {
        if (!launching) setLaunchOpen(false)
        event.preventDefault()
        return
      }
      if (pendingDelete) {
        setPendingDelete(null)
        event.preventDefault()
        return
      }
      if (projectDelete) {
        setProjectDelete(null)
        event.preventDefault()
        return
      }
      if (addingProject) {
        setAddingProject(false)
        event.preventDefault()
        return
      }
      if (activeId) {
        leaveToScan()
        event.preventDefault()
      }
    }
    // F6 tarayıcı adres çubuğuna gitmesin diye yakalama aşamasında tutulur.
    const onF6 = (event: KeyboardEvent) => {
      if (event.key !== 'F6') return
      onKey(event)
    }
    window.addEventListener('keydown', onF6, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onF6, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [activeId, addingProject, launchOpen, launching, pendingDelete, projectDelete])

  const run = (promise: Promise<unknown>) => {
    setError(null)
    promise.then(refresh).catch((e) => setError(e.message))
  }

  const createSession = (input: { name: string; command: string | null; isolation: Isolation }) => {
    if (!dialogProject || creating) return
    setCreating(true)
    setError(null)
    api
      .createSession({ ...input, projectId: dialogProject.id })
      .then((session) => {
        setDialogProject(null)
        setActiveId(session.id)
        setTab('terminal')
        return refresh()
      })
      .catch((e) => setError(e.message))
      .finally(() => setCreating(false))
  }

  const openSession = (id: string) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    setActiveId(id)
    setTab('terminal')
  }

  const selectSession = (id: string) => {
    const owner = grids.find(g => (g.id === gridId ? gridIds : savedGridSessionIds(g.id)).includes(id))
    if (owner) { setGridId(owner.id); setPendingGridAdd(id); setActiveId(null); setView('grid') }
    else openSession(id)
    setPendingDelete(null)
  }
  useEffect(() => {
    const onClick = (event: Event) => {
      const id: unknown = (event as CustomEvent).detail
      if (typeof id === 'string' && id) selectSession(id)
    }
    window.addEventListener('agentdeck:notification-click', onClick)
    const unsubscribe = window.agentdeckDesktop?.onNotificationClick?.(id => { if (id) selectSession(id) })
    return () => { window.removeEventListener('agentdeck:notification-click', onClick); unsubscribe?.() }
  }, [grids, gridId, gridIds])
  const createGrid = () => {
    const next = { id: crypto.randomUUID(), name: `Grid ${grids.length + 1}` }
    try { saveGridWorkspaces([...grids, next]); setGrids([...grids, next]); setGridId(next.id); setGridIds([]); setPendingGridAdd(null) }
    catch { setError('Grid kaydedilemedi.') }
  }

  // Grid'e ekleme grid'i açar. Tek görünüm kapanır; aynı Run için iki terminal açık kalmaz.
  const addToGrid = (id: string) => {
    setPendingGridAdd(id)
    setActiveId(null)
    setPendingDelete(null)
    setView('grid')
  }

  // Arşiv dosyalara dokunmaz; canlı iş yalnız açıkça görünen "durdur ve arşivle" ile kapanır.
  const toggleArchive = (target = active) => {
    if (!target) return
    const active = target
    run(
      active.archivedAt !== null
        ? api.unarchiveSession(active.id)
        : api.archiveSession(active.id, active.runId, hasRunningProcesses(active)),
    )
  }

  const copyPath = () => {
    if (!active) return
    const cwd = active.cwd
    navigator.clipboard
      .writeText(cwd)
      .then(() => setCopiedPath(true))
      .catch(() => setError(`Pano erişimi reddedildi; yolu elle kopyalayın: ${cwd}`))
  }

  // Mevcut çalışma kopyasında yeni Run; başarılıysa terminal yeni Run'a bağlanır.
  const launchCommand = (command: string | null) => {
    if (!active || launching) return
    setLaunching(true)
    setError(null)
    api
      .launchSession(active.id, active.runId, command)
      .then(() => {
        setLaunchOpen(false)
        setTab('terminal')
        return refresh()
      })
      .catch((e) => setError(e.message))
      .finally(() => setLaunching(false))
  }

  // Silme her zaman taze bir önizlemeyle başlar: kullanıcı neyin gideceğini görür.
  const askDelete = (target = active) => {
    if (!target) return
    const active = target
    setActiveId(active.id)
    setError(null)
    api
      .previewSessionDelete(active.id)
      .then(setPendingDelete)
      .catch((e) => setError(e.message))
  }

  const confirmDelete = () => {
    if (!active || !pendingDelete) return
    const sessionId = active.id
    const token = pendingDelete.confirmationToken
    setPendingDelete(null)
    setError(null)
    api
      .deleteSession(sessionId, token)
      .then(() => {
        const neighbor = nextVisibleSession(boardSessionIds(state), sessionId)
        setActiveId(null)
        setScanFocusId(neighbor)
        refreshOrphans()
        return refresh()
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        // Onay eskidiyse oturum durmuş kalır ve yeni bir önizleme sunulur.
        if (e instanceof api.ApiCallError && e.code === 'confirmation_stale') {
          api
            .previewSessionDelete(sessionId)
            .then(setPendingDelete)
            .catch(() => setPendingDelete(null))
        }
        return refresh()
      })
  }

  // Oturumu olan proje taze bir önizlemeyle silinir: bütün oturumlar tek onaya bağlanır.
  const askProjectDelete = (projectId: string) => {
    setError(null)
    api
      .previewProjectDelete(projectId)
      .then(setProjectDelete)
      .catch((e) => {
        setProjectDelete(null)
        setError(e.message)
      })
  }

  const confirmProjectDelete = () => {
    if (!projectDelete) return
    const { projectId, confirmationToken } = projectDelete
    setProjectDelete(null)
    setError(null)
    api
      .deleteProject(projectId, confirmationToken)
      .then(() => {
        refreshOrphans()
        return refresh()
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        // Onay eskidiyse hiçbir şey silinmemiştir; yeni bir önizleme sunulur.
        if (e instanceof api.ApiCallError && e.code === 'confirmation_stale') askProjectDelete(projectId)
        refreshOrphans()
        return refresh()
      })
  }

  const showMenu = (id: string, event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault(); event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ id, position: { x: event.clientX || rect.left, y: event.clientY || rect.bottom, origin: event.currentTarget } })
  }
  const executeAction = (session: SessionView, action: ReturnType<typeof sessionWorkActions>[number]) => {
    if (action.kind === 'stop') return run(api.stopSession(session.id, session.runId))
    if (action.kind === 'restart') return run(api.restartSession(session.id, session.runId))
    if (action.kind === 'continue' || action.kind === 'fresh') return run(api.launchSession(session.id, session.runId, action.command, action.kind === 'fresh' ? 'fresh' : 'picker'))
    setActiveId(session.id); setError(null); setLaunchOpen(true)
  }
  const menuSession = state.sessions.find(session => session.id === menu?.id)
  const menuActions: MenuAction[] = menuSession ? [
    { label: 'Terminali aç', icon: 'terminal', run: () => openSession(menuSession.id) },
    { label: 'Değişiklikleri incele', icon: 'diff', run: () => { openSession(menuSession.id); setTab('diff') } },
    { label: 'Terminal rengi…', icon: 'settings', run: () => setColorSession(menuSession) },
    { label: 'Grid’e ekle', icon: 'grid', run: () => addToGrid(menuSession.id) },
    ...(menuSession.archivedAt === null ? sessionWorkActions(menuSession).map(action => ({ label: action.label[0].toLocaleUpperCase('tr') + action.label.slice(1), description: action.description, icon: action.kind === 'stop' ? 'stop' as const : action.kind === 'restart' ? 'refresh' as const : 'play' as const, disabled: !stateHealthy || Boolean(menuSession.degraded && action.kind !== 'stop'), run: () => executeAction(menuSession, action) })) : []),
    { label: menuSession.archivedAt !== null ? 'Arşivden çıkar' : hasRunningProcesses(menuSession) ? 'Durdur ve arşivle' : 'Arşivle', icon: 'archive', disabled: !stateHealthy, run: () => toggleArchive(menuSession) },
    { label: 'Çalışma klasörünün yolunu kopyala', icon: 'copy', run: () => { navigator.clipboard.writeText(menuSession.cwd).catch(() => setError(`Yol kopyalanamadı: ${menuSession.cwd}`)) } },
    { label: 'Silme seçenekleri…', icon: 'trash', danger: true, disabled: !stateHealthy, run: () => askDelete(menuSession) },
  ] : []

  return (
    <div className={`app${preferences.compact ? ' compact-ui' : ''}`}>
      {preferences.notifications && lifecycle.notices.length > 0 && <aside className="notification-toasts" aria-live="polite" aria-label="Yeni bildirimler">
        {lifecycle.notices.slice(0, 3).map(notice => <article className="notification-toast" key={notice.id}>
          <button className="notification-toast-open" onClick={() => { lifecycle.dismissNotice(notice.id); openSession(notice.sessionId) }}>
            <strong>{notice.title}</strong><span>{notice.detail}</span>
          </button>
          <button className="notification-toast-close" aria-label="Bildirimi kapat" onClick={() => lifecycle.dismissNotice(notice.id)}>×</button>
        </article>)}
      </aside>}

      <SidebarShell>{(navigate) => <Sidebar
        state={state}
        onSessionMenu={showMenu}
        onSettings={() => setSettingsOpen(true)}
        notifications={preferences.notifications && <div className="notification-center"><button aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(!notificationsOpen)}>Bildirimler {lifecycle.notices.length > 0 && <span className="badge">{lifecycle.notices.length}</span>}</button>{notificationsOpen && <div className="notification-list"><header><strong>Terminal çıkışları</strong><button onClick={lifecycle.clearNotices}>Temizle</button></header>{lifecycle.notices.length === 0 && <p className="muted">Yeni bildirim yok.</p>}{lifecycle.notices.map(notice => <button key={notice.id} onClick={() => { setNotificationsOpen(false); navigate(() => openSession(notice.sessionId)) }}><strong>{notice.title}</strong><span>{notice.detail}</span></button>)}</div>}</div>}
        healthy={stateHealthy}
        onHome={() => navigate(() => {
          leaveToScan()
          setView('sessions')
        })}
        view={view}
        gridCount={gridIds.length}
        onGrid={() => navigate(() => {
          leaveToScan()
          setView('grid')
        })}
        onAddToGrid={(id) => navigate(() => addToGrid(id))}
        activeId={activeId}
        onSelect={(id) => navigate(() => {
          selectSession(id)
        })}
        onNewSession={(project) => navigate(() => setDialogProject(project))}
        onDeleteProject={(id) => run(api.deleteProject(id))}
        projectDelete={projectDelete}
        onPreviewProjectDelete={askProjectDelete}
        onConfirmProjectDelete={confirmProjectDelete}
        onCancelProjectDelete={() => setProjectDelete(null)}
        orphans={orphans}
        onRefreshOrphans={refreshOrphans}
      />}</SidebarShell>

      <main className="main">
        {connectionError && (
          <div className="error" role="alert">
            {connectionError}
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {state.serviceError && (
          <div className="error" role="alert">
            {state.serviceError}
          </div>
        )}
        <div className="scan" hidden={Boolean(active) || view !== 'sessions'} inert={Boolean(active) || view !== 'sessions'}>
          <Workspace
            onPreviewIds={setPreviewIds}
            state={state}
            now={now}
            previewsEnabled={preferences.previews && !active && view === 'sessions'}
            focusId={scanFocusId}
            onFocusHandled={() => setScanFocusId(null)}
            onSelect={openSession}
            onSessionMenu={showMenu}
            onNewSession={setDialogProject}
            onAddProject={() => setAddingProject(true)}
            onAddToGrid={addToGrid}
          />
        </div>
        {view === 'grid' && !active && (
          <div className="grid-workspace">
          <div className="grid-workspace-tabs" role="navigation" aria-label="Grid çalışma alanları">
            {grids.map(g => <button key={g.id} aria-pressed={gridId === g.id} onClick={() => { setGridId(g.id); setGridIds(savedGridSessionIds(g.id)); setPendingGridAdd(null) }}>{g.name}</button>)}
            <button title="Ayrı bir terminal gridi oluştur" onClick={createGrid}>+ Yeni grid</button>
            <button title="Grid adını değiştir" onClick={() => {
              const name = window.prompt('Grid adı', grids.find(g => g.id === gridId)?.name)?.trim()
              if (!name) return
              const next = grids.map(g => g.id === gridId ? { ...g, name: name.slice(0, 60) } : g)
              try { saveGridWorkspaces(next); setGrids(next) } catch { setError('Grid adı kaydedilemedi.') }
            }}>Adlandır</button>
            {grids.length > 1 && <button title="Grid yerleşimini kaldır; terminaller çalışmaya devam eder" onClick={() => {
              const next = grids.filter(g => g.id !== gridId)
              try { saveGridWorkspaces(next); clearGridLayout(gridId); setGrids(next); setGridId(next[0].id); setGridIds(savedGridSessionIds(next[0].id)); setPendingGridAdd(null) } catch { setError('Grid kaldırılamadı.') }
            }}>Grid’i kaldır</button>}
          </div>
          <TerminalGrid key={gridId} gridId={gridId} onRefresh={refresh}
            state={state}
            healthy={stateHealthy}
            pendingAdd={pendingGridAdd}
            onPendingHandled={() => setPendingGridAdd(null)}
            onOpen={openSession}
            onSessionMenu={showMenu}
            onPanelsChange={setGridIds}
          />
          </div>
        )}
        {active && (
          <>
            <header className="topbar clean-topbar" style={terminalStyle(active, preferences)} onContextMenu={event => showMenu(active.id, event)}>
              <button className="topbar-back icon-button" aria-keyshortcuts="F6 Escape" title="Oturumlara dön" aria-label="Oturumlara dön" onClick={leaveToScan}><Icon name="back" /></button>
              <AgentMark session={active} />
              <div className="topbar-info"><div className="title">{active.name}</div><button className="workspace-path path-copy" title={copiedPath ? 'Yol kopyalandı' : `Çalışma klasörü: ${active.cwd} · kopyala`} onClick={copyPath}>{activeProject?.name ?? 'Workspace'} · {active.cwd}</button></div>
              <span className={`status-badge ${active.lifecycle}`} title={active.degraded ?? undefined}><span className={`dot ${active.lifecycle}`} />{active.archivedAt !== null ? 'Arşiv' : active.lifecycle === 'live' ? active.activity === 'idle' ? 'Sessiz' : 'Canlı' : stateLabel(active)}</span>
              {active.isolation === 'worktree' && <span className="badge">İzole</span>}
              <BranchPicker key={active.id} session={active} healthy={stateHealthy} />
              <div className="tabs"><button className={tab === 'terminal' ? 'on' : ''} onClick={() => setTab('terminal')}><Icon name="terminal" /> Terminal</button><button className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}><Icon name="diff" /> Değişiklikler</button></div>
              {active.archivedAt === null && active.lifecycle !== 'live' && sessionWorkActions(active).filter(action => action.primary).map(action => <button key={action.kind} className="primary" disabled={!stateHealthy || Boolean(active.degraded)} title={action.description} onClick={() => executeAction(active, action)}><Icon name="play" />{action.kind === 'continue' ? 'Devam et' : 'Yeniden aç'}</button>)}
              <button className="icon-button" aria-label="Oturum işlemleri" title="Oturum işlemleri · sağ tık" onClick={event => showMenu(active.id, event)}><Icon name="more" /></button>
            </header>
            {(active.degraded || activeProject?.degraded) && <div className="error">{active.degraded ?? activeProject?.degraded}</div>}
            {state.terminals?.[active.id]?.outputPressure && <div className="review-note" role="status">Çıktı işleniyor…</div>}
            {pendingDelete && <div className="delete-confirm-bar" role="alert"><span>{pendingDelete.isolation === 'shared' ? 'Yalnız oturum kaydı kaldırılır; klasör korunur.' : deleteQuestion(pendingDelete)}</span><button onClick={confirmDelete}>Sil</button><button onClick={() => setPendingDelete(null)}>Vazgeç</button></div>}
            {showTrust && (
              <div className="trust-note" role="note">
                <span>{TRUST_NOTE}</span>
                <button
                  onClick={() => {
                    sessionStorage.setItem(trustKey(active.id), '1')
                    setTrustHidden(true)
                  }}
                >
                  Kapat
                </button>
              </div>
            )}
            {pendingDelete && (
              <div className="pad muted delete-target">
                {pendingDelete.isolation === 'shared' ? 'Korunacak klasör: ' : 'Silinecek klasör: '}
                <code>{pendingDelete.cwd}</code>
              </div>
            )}

            {state.terminals?.[active.id]?.failure && (
              <div className="error">
                Terminal temsili: {state.terminals[active.id].failure!.message}
              </div>
            )}
            {state.terminals?.[active.id]?.checkpoint.lastError && (
              <div className="error">
                Terminal geçmişi kaydedilemedi: {state.terminals[active.id].checkpoint.lastError}
              </div>
            )}
            <div className="body colored-terminal" style={terminalStyle(active, preferences)}>
              {tab === 'terminal' && (
                <div className="terminals">
                  {runs && runs.previous.length > 0 && (
                    <div className="run-bar">
                      <div className="tabs" role="group" aria-label="Terminal görüntüsü">
                        <button
                          className={inspectRunId === null ? 'on' : ''}
                          aria-pressed={inspectRunId === null}
                          onClick={() => setInspectRunId(null)}
                        >
                          Güncel terminal
                        </button>
                        {runs.previous.map((previous) => (
                          <button
                            key={previous.runId}
                            className={inspectRunId === previous.runId ? 'on' : ''}
                            aria-pressed={inspectRunId === previous.runId}
                            onClick={() => setInspectRunId(previous.runId)}
                          >
                            Önceki görüntü · {new Date(previous.updatedAt).toLocaleTimeString()}
                          </button>
                        ))}
                      </div>
                      <span className="muted">
                        Önceki Run salt okunur açılır; yalnız son iki Run'ın görüntüsü tutulur.
                      </span>
                    </div>
                  )}
                  <TerminalPane
                    key={`${state.daemonId}:${active.id}:${inspectRunId ?? active.runId}`}
                    onLayout={() => addToGrid(active.id)}
                    runId={inspectRunId}
                    session={active}
                    daemonId={state.daemonId}
                    stateHealthy={stateHealthy}
                  />
                </div>
              )}
              {tab === 'diff' && <DiffView key={active.id} sessionId={active.id} isolation={active.isolation} />}
            </div>
          </>
        )}
      </main>

      {menu && menuSession && <ActionMenu position={menu.position} actions={menuActions} onClose={closeMenu} />}
      {colorSession && <ColorDialog id={colorSession.id} projectId={colorSession.projectId} name={colorSession.name} onClose={() => setColorSession(null)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {addingProject && (
        <AddProjectDialog
          onCancel={() => setAddingProject(false)}
          onAdd={async (path) => {
            await api.addProject(path)
            await refresh()
          }}
        />
      )}
      {launchOpen && active && (
        <LaunchDialog
          session={active}
          busy={launching}
          error={error}
          onCancel={() => {
            if (!launching) setLaunchOpen(false)
          }}
          onLaunch={launchCommand}
        />
      )}
      {dialogProject && (
        <NewSessionDialog
          project={dialogProject}
          busy={creating}
          error={error}
          onCancel={() => {
            if (!creating) setDialogProject(null)
          }}
          onCreate={createSession}
        />
      )}
    </div>
  )
}
