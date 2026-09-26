import { ColorDialog } from './components/ColorDialog'
import { ActionMenu, type MenuAction, type MenuPosition } from './components/ActionMenu'
import { Icon } from './components/Icon'
import { AgentMark, ProgramIcon } from './components/AgentMark'
import { BranchPicker } from './components/BranchPicker'
import { ContextMeter, PortLinks } from './components/SessionInsights'
import { PromptQueueButton, PromptsDialog } from './components/Prompts'
import { SettingsDialog } from './components/SettingsDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { usePreferences, terminalStyle, updatePreferences, THEMES, type ThemeName } from './preferences'
import { CommandPalette, type PaletteCommand, type PaletteScope } from './components/CommandPalette'
import { appShortcut, SHORTCUT_LABELS, type AppShortcut } from '../shared/shortcuts'
import { stateLabel, statusTone, StatusDot } from './sessionStatus'
import { duplicateCommand } from '../shared/workspacePolicy'
import { MAX_GRID_PANELS, type GridAdd, type GridPlacement } from './gridLayout'
import type { NoticeKind } from '../shared/notices'
import type { IconName } from './components/Icon'
import { useWorkspaceLifecycle } from './useWorkspaceLifecycle'
import { TRUST_NOTE, trustKey } from './sessionIssues'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as api from './api'
import { AddProjectDialog } from './components/AddProjectDialog'
import { Workspace } from './components/Workspace'
import { Sidebar, navigationIds } from './components/Sidebar'
import { SidebarShell } from './components/SidebarShell'
import { TerminalPane } from './components/TerminalPane'
import { DiffView } from './components/DiffView'
import { ProjectPullRequests } from './components/ProjectPullRequests'
import { NewSessionDialog } from './components/NewSessionDialog'
import { AssignWorkDialog, WorkNameDialog, type WorkChoice } from './components/WorkDialogs'
import { ClaudeSessionPicker } from './components/ClaudeSessions'
import { LaunchDialog } from './components/LaunchDialog'
import { TerminalGrid } from './components/TerminalGrid'
import { ClaudeMascot } from './components/ClaudeMascot'
import { loadGridWorkspaces, saveGridWorkspaces, clearGridLayout, savedGridSessionIds } from './gridLayout'
import { createStatePoller, pollPreviewIds } from '../shared/statePoll'
import { sessionWorkActions, sessionWorkCli } from '../shared/sessionActions'
import {
  formatAge,
  hasRunningProcesses,
  PRESETS,
  type Isolation,
  type Preset,
  type ProjectView,
  type Project,
  type StateResponse,
  type SessionView,
  type ConversationView,
  type ClaudeAgentView,
  type Work,
} from '../shared/types'

const NOTICE_ICONS: Record<NoticeKind, IconName> = { attention: 'alert', quiet: 'terminal', finished: 'check', failed: 'alert', terminal: 'alert' }

function noticeAge(at: number): string {
  const age = formatAge(Date.now() - at)
  return age === 'az önce' ? age : `${age} önce`
}


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

/** Silinecek içeriği onaydan önce söyler; ignored dosyalar da silinir. */
function deleteQuestion(preview: api.DeletePreview): string {
  const parts: string[] = []
  if (preview.changedEntries > 0) parts.push(`${preview.changedEntries} değişiklik`)
  if (preview.ignoredEntries > 0) parts.push(`${preview.ignoredEntries} ignored giriş (.env ve bağımlılıklar dahil)`)
  return parts.length > 0
    ? `Çalışma kopyası ${parts.join(' ve ')} ile birlikte silinir. Bu geri alınamaz.`
    : 'Çalışma kopyası silinir. Bu geri alınamaz.'
}

/** Proje silmenin neyi götürüp neyi koruyacağını onaydan önce söyler. */
function projectDeleteSummary(preview: Pick<api.ProjectDeletePreview, 'sessions'>): string {
  const isolated = preview.sessions.filter((s) => s.isolation === 'worktree')
  const changed = isolated.reduce((sum, s) => sum + s.changedEntries, 0)
  const ignored = isolated.reduce((sum, s) => sum + s.ignoredEntries, 0)
  return (
    `${preview.sessions.length} oturum kaydı kaldırılır, ${isolated.length} izole çalışma kopyası silinir` +
    (changed + ignored > 0 ? ` (${changed} değişiklik ve ${ignored} ignored giriş dahil)` : '') +
    ". Ortak klasör dosyaları ve branch'ler korunur."
  )
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
  const [menu, setMenu] = useState<{ id: string; position: MenuPosition; tabActions?: MenuAction[] } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [state, setState] = useState<StateResponse>(EMPTY)
  const [activeId, setActiveId] = useState<string | null>(null)
  /** Proje PR sayfası; pr null ise liste açıktır. */
  const [prView, setPrView] = useState<{ projectId: string; pr: number | null } | null>(null)
  /** "Bu PR üzerinde ajan başlat": yeni oturum penceresi PR'ın branch'inde izole açılır. */
  const [dialogPr, setDialogPr] = useState<{ number: number; title: string; headRefName: string } | null>(null)
  const [pullCounts, setPullCounts] = useState<Record<string, number>>({})
  const [tab, setTab] = useState<'terminal' | 'diff'>('terminal')
  // Oturum seçili değilken ana alanın gösterdiği görünüm.
  const [view, setView] = useState<'sessions' | 'grid'>('sessions')
  const [grids, setGrids] = useState(loadGridWorkspaces)
  const [gridId, setGridId] = useState(() => loadGridWorkspaces()[0].id)
  const [gridIds, setGridIds] = useState<string[]>(() => savedGridSessionIds(loadGridWorkspaces()[0].id))
  const [pendingGridAdd, setPendingGridAdd] = useState<{ items: GridAdd[]; focus: boolean } | null>(null)
  /** Çalışma alanında her grubun öndeki sekmesi; arka plandaki sekme bildirim üretmeye devam eder. */
  const [visibleGridIds, setVisibleGridIds] = useState<string[]>([])
  const [addMenu, setAddMenu] = useState<MenuPosition | null>(null)
  const closeAddMenu = useCallback(() => setAddMenu(null), [])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteScope, setPaletteScope] = useState<PaletteScope>('all')
  /** Hazır istemler penceresi; hedef, Gönder düğmesinin oturumudur. */
  const [promptsFor, setPromptsFor] = useState<{ sessionId: string | null } | null>(null)
  useEffect(() => {
    const open = (event: Event) => setPromptsFor({ sessionId: ((event as CustomEvent).detail as string | null) ?? null })
    window.addEventListener('agentdeck:manage-prompts', open)
    return () => window.removeEventListener('agentdeck:manage-prompts', open)
  }, [])
  const [renamingGrid, setRenamingGrid] = useState<string | null>(null)
  const [gridMenu, setGridMenu] = useState<MenuPosition | null>(null)
  const closeGridMenu = useCallback(() => setGridMenu(null), [])
  // Bildirim merkezi listeyi tutar; köşedeki kart birkaç saniye sonra kendiliğinden çekilir.
  const [toastsHidden, setToastsHidden] = useState<ReadonlySet<string>>(new Set())
  const [addingProject, setAddingProject] = useState(false)
  const [dialogProject, setDialogProject] = useState<Project | null>(null)
  /** Yeni oturum penceresinde önceden seçili iş: kimlik, 'new' veya ''. */
  const [dialogWork, setDialogWork] = useState('')
  const [workMenu, setWorkMenu] = useState<{ work: Work; position: MenuPosition } | null>(null)
  const closeWorkMenu = useCallback(() => setWorkMenu(null), [])
  const [workDialog, setWorkDialog] = useState<{ mode: 'rename'; work: Work } | { mode: 'create'; projectId: string } | null>(null)
  const [assigning, setAssigning] = useState<SessionView | null>(null)
  const [workBusy, setWorkBusy] = useState(false)
  const [claudePicker, setClaudePicker] = useState<Work | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string; preview: api.DeletePreview } | null>(null)
  const [projectDelete, setProjectDelete] = useState<api.ProjectDeletePreview | null>(null)
  const [workDelete, setWorkDelete] = useState<api.WorkDeletePreview | null>(null)
  const [projectRemove, setProjectRemove] = useState<{ id: string; name: string } | null>(null)
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
  // Kullanıcının o an gördüğü oturumlar bildirim üretmez.
  const lifecycle = useWorkspaceLifecycle(state, stateHealthy, preferences, activeId ? [activeId] : view === 'grid' ? visibleGridIds : [])

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

  // Düğmeler değişince eski açıklama ekranda kalmaz.
  useEffect(() => {
    setTrustHidden(false)
  }, [active?.id, active?.archivedAt, active?.lifecycle])

  const leaveToScan = () => {
    setActiveId(null)
    setPrView(null)
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
      if (addingProject) {
        setAddingProject(false)
        event.preventDefault()
        return
      }
      if (prView) {
        setPrView(prView.pr !== null ? { ...prView, pr: null } : null)
        event.preventDefault()
        return
      }
      if (activeId) {
        leaveToScan()
        event.preventDefault()
      }
    }
    // F6 tarayıcı adres çubuğuna gitmesin diye yakalama aşamasında tutulur. Uygulama
    // kısayolları da burada yakalanır: xterm'e hiç ulaşmaz, PTY'ye gönderilmez.
    const onF6 = (event: KeyboardEvent) => {
      if (event.key === 'F6') { onKey(event); return }
      if (event.repeat && event.key !== 'PageUp' && event.key !== 'PageDown') return
      const shortcut = appShortcut(event, inTerminal(event.target))
      if (!shortcut) return
      // Açık pencere veya menü klavyeyi sahiplenir; palet açıkken yalnız kendi kısayolu onu kapatır.
      if (document.querySelector('dialog[open]:not(.palette-modal), [role=menu]')) return
      if (document.querySelector('dialog.palette-modal[open]') && shortcut.kind !== 'palette' && shortcut.kind !== 'search-conversations') return
      event.preventDefault()
      event.stopPropagation()
      shortcutRef.current(shortcut)
    }
    window.addEventListener('keydown', onF6, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onF6, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [activeId, addingProject, launchOpen, launching, prView])

  useEffect(() => {
    const pending = lifecycle.notices.filter((notice) => notice.toast && !toastsHidden.has(notice.id))
    if (pending.length === 0) return
    const timer = window.setTimeout(() => {
      setToastsHidden((hidden) => new Set([...hidden, ...pending.map((notice) => notice.id)]))
    }, 7000)
    return () => window.clearTimeout(timer)
  }, [lifecycle.notices, toastsHidden])
  const toasts = lifecycle.notices.filter((notice) => notice.toast && !toastsHidden.has(notice.id)).slice(0, 3)

  const run = (promise: Promise<unknown>) => {
    setError(null)
    promise.then(refresh).catch((e) => setError(e.message))
  }

  const works = state.works ?? []
  const workOf = (session: SessionView | null | undefined) => works.find((w) => w.id === session?.workId) ?? null

  /** Yeni oturum penceresini açar; iş verilmezse görünen oturumun işi önceden seçilir. */
  const openNewSession = (project: Project, work?: string) => {
    const context = active ?? gridFocusSession()
    setDialogWork(work ?? (context?.projectId === project.id ? (context.workId ?? '') : ''))
    setDialogPr(null)
    setDialogProject(project)
  }

  const openPulls = (projectId: string, pr: number | null = null) => {
    setActiveId(null)
    setPendingDelete(null)
    setPrView({ projectId, pr })
  }

  const startAgentOnPr = (projectId: string, pr: { number: number; title: string; headRefName: string }) => {
    const project = state.projects.find(p => p.id === projectId)
    if (!project) return
    setDialogWork('')
    setDialogPr(pr)
    setDialogProject(project)
  }

  // Kenar çubuğundaki açık PR sayısı: git projeleri birkaç dakikada bir sorulur.
  // gh yoksa veya depo GitHub değilse sayı gösterilmez; hata kullanıcıya taşınmaz.
  const gitProjectIds = state.projects.filter(p => p.kind === 'git' && !p.general).map(p => p.id).join(',')
  useEffect(() => {
    if (!gitProjectIds) return
    let cancelled = false
    const poll = () => {
      if (document.hidden) return
      for (const id of gitProjectIds.split(',')) {
        api.listProjectPullRequests(id)
          .then(({ pullRequests }) => { if (!cancelled) setPullCounts(c => c[id] === pullRequests.length ? c : { ...c, [id]: pullRequests.length }) })
          .catch(() => { if (!cancelled) setPullCounts(c => { if (!(id in c)) return c; const next = { ...c }; delete next[id]; return next }) })
      }
    }
    poll()
    const timer = window.setInterval(poll, 180_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [gitProjectIds])

  /** Projesiz oturum: ev klasöründeki "Genel" kayıt ilk seferde oluşturulur. */
  const openGeneralSession = () => {
    setError(null)
    api
      .ensureGeneralProject()
      .then(async (project) => {
        await refresh()
        openNewSession(project)
      })
      .catch((e) => setError(e.message))
  }

  /** Seçilen iş kimliği; yeni iş önce oluşturulur. */
  const resolveWork = async (choice: WorkChoice, projectId: string): Promise<string | null> => {
    if (choice === null) return null
    if ('id' in choice) return choice.id
    return (await api.createWork(projectId, choice.name)).id
  }

  const createSession = (input: { name: string; command: string | null; isolation: Isolation; work: WorkChoice }) => {
    if (!dialogProject || creating) return
    setCreating(true)
    setError(null)
    const projectId = dialogProject.id
    resolveWork(input.work, projectId)
      .then((workId) => api.createSession({
        name: input.name || (dialogPr ? `PR #${dialogPr.number}` : ''), command: input.command, isolation: input.isolation, workId, projectId,
        ...(dialogPr ? { pullRequest: dialogPr.number } : {}),
      }))
      .then(async (session) => {
        setDialogProject(null)
        setDialogPr(null)
        await refresh()
        openInWorkspace(session.id, 'tab', true)
      })
      .catch((e) => setError(e.message))
      .finally(() => setCreating(false))
  }

  /** Ayrıntı görünümü: diff, önceki Run'lar ve tam başlık. Esc geldiğin yere döner. */
  const openDetail = (id: string, detailTab: 'terminal' | 'diff' = 'terminal') => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    setPrView(null)
    setActiveId(id)
    setTab(detailTab)
  }

  /**
   * Oturumları çalışma alanında açar (ADR 0019). Açık oldukları bir çalışma
   * alanı varsa oraya geçilir; yoksa şu anki alana sekme veya bölme olarak girer.
   */
  const openItems = (items: GridAdd[], focus: boolean) => {
    // Arka plan sekmesi tarayıcıdaki gibi bulunulan alana eklenir; görünüm değişmez.
    if (items.every((item) => item.place === 'background')) { setPendingGridAdd({ items, focus: false }); return }
    const first = items[0]?.id
    const owner = first ? grids.find(g => (g.id === gridId ? gridIds : savedGridSessionIds(g.id)).includes(first)) : undefined
    if (owner && owner.id !== gridId) { setGridIds(savedGridSessionIds(owner.id)); setGridId(owner.id) }
    setPendingGridAdd({ items, focus })
    setActiveId(null)
    setPrView(null)
    setPendingDelete(null)
    setView('grid')
  }
  const openInWorkspace = (id: string, place: GridPlacement = 'tab', focus = false) => openItems([{ id, place }], focus)
  const openSession = (id: string) => openInWorkspace(id, 'tab', true)
  const selectSession = (id: string, focus = false) => openInWorkspace(id, 'tab', focus)

  // Paletten tek adımda: proje klasöründe varsayılan adla oturum açılır, grid'deysen grid'e eklenir.
  const quickCreate = (project: ProjectView, preset: Preset) => {
    if (creating) return
    setCreating(true)
    setError(null)
    try { updatePreferences({ lastProgram: { ...preferences.lastProgram, [project.id]: preset.label } }) } catch { /* tercih yalnız bu açılışta kalır */ }
    const context = active ?? gridFocusSession()
    api
      .createSession({ name: '', command: preset.command, isolation: 'shared', projectId: project.id, workId: context?.projectId === project.id ? (context.workId ?? null) : null })
      .then(async (session) => {
        await refresh()
        openSession(session.id)
      })
      .catch((e) => setError(e.message))
      .finally(() => setCreating(false))
  }

  /**
   * Sol üstteki +: etkin sekmenin projesinde ve işinde, o projede en son
   * seçilen programla (yoksa kabukla) yeni sekme. Sekme yoksa oturum projesiz açılır.
   */
  const newTab = () => {
    const context = active ?? gridFocusSession()
    const project = state.projects.find((p) => p.id === context?.projectId)
    const presetFor = (id: string) => PRESETS.find((p) => p.label === preferences.lastProgram[id]) ?? PRESETS.find((p) => p.command === null)!
    if (project) return quickCreate(project, presetFor(project.id))
    if (creating) return
    setError(null)
    api
      .ensureGeneralProject()
      .then((general) => quickCreate({ ...general, degraded: null }, presetFor(general.id)))
      .catch((e) => setError(e.message))
  }

  const toggleSidebar = () => {
    try { updatePreferences({ sidebarCollapsed: !preferences.sidebarCollapsed }) } catch { setError('Tercih kaydedilemedi.') }
  }

  const shortcutRef = useRef<(shortcut: AppShortcut) => void>(() => {})
  shortcutRef.current = (shortcut) => {
    if (shortcut.kind === 'palette') { setPaletteScope('all'); setPaletteOpen((open) => !open); return }
    if (shortcut.kind === 'search-conversations') { setPaletteScope('conversations'); setPaletteOpen(true); return }
    if (shortcut.kind === 'sidebar') { toggleSidebar(); return }
    if (shortcut.kind === 'maximize') {
      if (view === 'grid' && !active) window.dispatchEvent(new Event('agentdeck:grid-maximize'))
      return
    }
    const inWorkspace = view === 'grid' && !active
    if (shortcut.kind === 'new-tab') { newTab(); return }
    if (shortcut.kind === 'close-tab') {
      if (inWorkspace) window.dispatchEvent(new Event('agentdeck:tab-close'))
      return
    }
    if (shortcut.kind === 'move-tab') {
      if (inWorkspace) window.dispatchEvent(new CustomEvent('agentdeck:tab-move', { detail: shortcut.delta }))
      return
    }
    if (shortcut.kind === 'cycle' && inWorkspace && gridIds.length > 0) {
      window.dispatchEvent(new CustomEvent('agentdeck:tab-cycle', { detail: shortcut.delta }))
      return
    }
    if (shortcut.kind === 'new-session') {
      // Açık oturum yoksa yeni oturum projesiz açılır.
      const project = state.projects.find((p) => p.id === (active?.projectId ?? gridFocusSession()?.projectId))
      if (project) openNewSession(project)
      else openGeneralSession()
      return
    }
    const ids = navigationIds(state, preferences.collapsedWorks, preferences.collapsedProjects)
    if (ids.length === 0) return
    if (shortcut.kind === 'jump') {
      const id = ids[shortcut.index]
      if (id) selectSession(id, true)
      return
    }
    // Grid'de sıradaki oturum odaktaki panele göre seçilir.
    const focusedPanel = document.activeElement?.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId
    const current = activeId ?? focusedPanel ?? null
    const index = current ? ids.indexOf(current) : -1
    const next = ids[(index + shortcut.delta + ids.length) % ids.length] ?? ids[0]
    if (next) selectSession(next, true)
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
    const next = { id: crypto.randomUUID(), name: `Alan ${grids.length + 1}` }
    try { saveGridWorkspaces([...grids, next]); setGrids([...grids, next]); setGridId(next.id); setGridIds([]); setPendingGridAdd(null) }
    catch { setError('Grid kaydedilemedi.') }
  }

  // Grid'e ekleme grid'i açar. Tek görünüm kapanır; aynı Run için iki terminal açık kalmaz.
  /** Grid'de odaktaki (yoksa öndeki grubun) oturumu. */
  const gridFocusSession = () => {
    const element = document.activeElement?.closest<HTMLElement>('[data-session-id]') ?? document.querySelector<HTMLElement>('.dv-active-group [data-session-id]')
    return state.sessions.find((s) => s.id === element?.dataset.sessionId) ?? null
  }

  // Grid'de olmayan canlı oturumlar panel sınırına kadar eklenir.
  const addLiveToGrid = () => {
    const ids = navigationIds(state).filter((id) => !gridIds.includes(id)).slice(0, Math.max(0, MAX_GRID_PANELS - gridIds.length))
    if (ids.length === 0) return
    openItems(ids.map((id) => ({ id, place: 'split' })), false)
  }

  // Aynı programdan yeni oturum: proje klasöründe açılır, grid'deysen grid'e girer.
  const duplicateSession = (session: SessionView) => {
    if (creating) return
    setCreating(true)
    setError(null)
    api
      .createSession({ projectId: session.projectId, name: '', command: duplicateCommand(session), isolation: 'shared', workId: session.workId ?? null })
      .then(async (created) => {
        await refresh()
        openSession(created.id)
      })
      .catch((e) => setError(e.message))
      .finally(() => setCreating(false))
  }

  /** Yan yana aç: oturum çalışma alanında yeni bir bölmeye girer. */
  const addToGrid = (id: string) => openInWorkspace(id, 'split')

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

  /**
   * Konuşmayı sürdürür. Terminali boştaysa orada, meşgulse aynı klasörde yeni
   * terminalde açılır. Claude konuşmaları klasöre bağlıdır: izole kopyadaki
   * konuşma başka klasörde açılamaz.
   */
  const resumeConversation = (conversation: ConversationView, knownProjectId?: string) => {
    setError(null)
    // Claude oturumunun güncel konuşması o oturuma attach edilerek açılır.
    if (conversation.current && conversation.claudeSessionId) {
      const work = works.find((w) => w.claudeSessions?.includes(conversation.claudeSessionId!))
      const agent = work && state.claudeSessions?.[work.id]?.find((a) => a.id === conversation.claudeSessionId)
      if (work && agent) return openClaudeSession(work, agent)
    }
    const command = `claude --resume ${conversation.id}`
    const session = conversation.sessionId ? state.sessions.find((s) => s.id === conversation.sessionId) : undefined
    if (session && !hasRunningProcesses(session)) {
      api
        .launchSession(session.id, session.runId, command)
        .then(async () => { await refresh(); openSession(session.id) })
        .catch((e) => setError(e.message))
      return
    }
    if (session && session.isolation !== 'shared') {
      return setError(`${session.name} izole çalışma kopyasında ve şu an çalışıyor. Konuşmayı sürdürmek için önce oradaki programı durdurun.`)
    }
    // Claude konuşmaları klasöre bağlıdır: konuşma alt klasörde açıldıysa orada sürdürülür.
    const work = works.find((w) => w.id === session?.workId) ??
      works.find((w) => w.conversationRefs?.includes(conversation.id) || (conversation.claudeSessionId !== null && w.claudeSessions?.includes(conversation.claudeSessionId)))
    const projectId = session?.projectId ?? work?.projectId ?? knownProjectId
    const project = state.projects.find((p) => p.id === projectId)
    if (!project) return setError('Konuşmanın projesi bulunamadı.')
    const cwd = conversation.cwd ?? session?.cwd ?? project.path
    const inProject = cwd === project.path
    if (!inProject && !cwd.startsWith(`${project.path}/`)) return setError(`Konuşma proje dışında bir klasörde açılmış: ${cwd}`)
    if (creating) return
    setCreating(true)
    api
      .createSession({
        projectId: project.id,
        name: (conversation.firstPrompt ?? '').slice(0, 60),
        command: inProject ? command : `cd '${cwd.replace(/'/g, `'\\''`)}' && ${command}`,
        isolation: 'shared',
        workId: work?.id ?? null,
      })
      .then(async (created) => { await refresh(); openSession(created.id) })
      .catch((e) => setError(e.message))
      .finally(() => setCreating(false))
  }

  const moveConversation = async (conversation: ConversationView, _from: Work, toWorkId: string) => {
    setError(null)
    try { await api.moveConversations(toWorkId, [conversation.id]); await refresh() } catch (e) { setError((e as Error).message) }
  }
  const unmoveConversation = async (conversation: ConversationView, work: Work) => {
    setError(null)
    try { await api.unmoveConversation(work.id, conversation.id); await refresh() } catch (e) { setError((e as Error).message) }
  }

  const submitWorkName = (name: string) => {
    if (!workDialog || workBusy) return
    setWorkBusy(true)
    setError(null)
    const request = workDialog.mode === 'rename' ? api.renameWork(workDialog.work.id, name) : api.createWork(workDialog.projectId, name)
    const isNew = workDialog.mode === 'create'
    request
      .then(async (work) => {
        setWorkDialog(null)
        await refresh()
        // Yeni işe hemen bağlanacak Claude oturumu varsa seçici açılır.
        if (isNew) {
          const listing = await api.getClaudeSessions(work.projectId).catch(() => null)
          if (listing?.sessions.some((s) => s.workId === null)) setClaudePicker(work)
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setWorkBusy(false))
  }

  const submitAssign = (choice: WorkChoice) => {
    if (!assigning || workBusy) return
    setWorkBusy(true)
    setError(null)
    resolveWork(choice, assigning.projectId)
      .then((workId) => api.assignWork(assigning.id, workId))
      .then(() => { setAssigning(null); return refresh() })
      .catch((e) => setError(e.message))
      .finally(() => setWorkBusy(false))
  }

  const linkClaude = (ids: string[]) => {
    if (!claudePicker || workBusy) return
    setWorkBusy(true)
    setError(null)
    api
      .linkClaudeSessions(claudePicker.id, ids)
      .then(() => { setClaudePicker(null); return refresh() })
      .catch((e) => setError(e.message))
      .finally(() => setWorkBusy(false))
  }

  const unlinkClaude = (work: Work, agent: ClaudeAgentView) => run(api.unlinkClaudeSession(work.id, agent.id))

  /**
   * Claude arka plan oturumunu iş içinde açar. Aynı oturumu izleyen canlı
   * terminal varsa ona geçilir; ikinci bir attach açılmaz.
   */
  const openClaudeSession = (work: Work, agent: ClaudeAgentView) => {
    const command = `claude attach ${agent.id}`
    const attached = state.sessions.find((s) => s.archivedAt === null && hasRunningProcesses(s) &&
      (s.command === command || (s.lastLaunch?.mode === 'command' && s.lastLaunch.command === command)))
    if (attached) return selectSession(attached.id, true)
    if (creating) return
    setCreating(true)
    setError(null)
    api
      .createSession({ projectId: work.projectId, name: agent.name.slice(0, 80), command, isolation: 'shared', workId: work.id })
      .then(async (created) => {
        await refresh()
        openSession(created.id)
      })
      .catch((e) => setError(e.message))
      .finally(() => setCreating(false))
  }

  const showWorkMenu = (work: Work, event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault(); event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setWorkMenu({ work, position: { x: event.clientX || rect.left, y: event.clientY || rect.bottom, origin: event.currentTarget } })
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
  // Onay bulunulan ekranda açılır; oturuma geçilmez.
  const askDelete = (target: SessionView) => {
    setError(null)
    api
      .previewSessionDelete(target.id)
      .then((preview) => setPendingDelete({ id: target.id, name: target.name, preview }))
      .catch((e) => setError(e.message))
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    const { id: sessionId, name } = pendingDelete
    const token = pendingDelete.preview.confirmationToken
    setPendingDelete(null)
    setError(null)
    api
      .deleteSession(sessionId, token)
      .then(() => {
        const neighbor = nextVisibleSession(boardSessionIds(state), sessionId)
        setActiveId((current) => (current === sessionId ? null : current))
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
            .then((preview) => setPendingDelete({ id: sessionId, name, preview }))
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

  // Oturumu olan iş de taze bir önizlemeyle silinir; boş iş doğrudan kalkar.
  const askWorkDelete = (work: Work) => {
    setError(null)
    if (!state.sessions.some((s) => s.workId === work.id)) return run(api.removeWork(work.id))
    api
      .previewWorkDelete(work.id)
      .then(setWorkDelete)
      .catch((e) => {
        setWorkDelete(null)
        setError(e.message)
      })
  }

  const confirmWorkDelete = () => {
    if (!workDelete) return
    const { workId, confirmationToken } = workDelete
    const work = works.find((w) => w.id === workId)
    setWorkDelete(null)
    setError(null)
    api
      .removeWork(workId, confirmationToken)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        if (work && e instanceof api.ApiCallError && e.code === 'confirmation_stale') askWorkDelete(work)
      })
      .finally(() => {
        refreshOrphans()
        return refresh()
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

  const showMenu = (id: string, event: React.MouseEvent<HTMLElement>, tabActions?: MenuAction[]) => {
    event.preventDefault(); event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ id, position: { x: event.clientX || rect.left, y: event.clientY || rect.bottom, origin: event.currentTarget }, tabActions })
  }
  const executeAction = (session: SessionView, action: ReturnType<typeof sessionWorkActions>[number]) => {
    if (action.kind === 'stop') return run(api.stopSession(session.id, session.runId))
    if (action.kind === 'restart') return run(api.restartSession(session.id, session.runId))
    if (action.kind === 'continue' || action.kind === 'fresh') return run(api.launchSession(session.id, session.runId, action.command, action.kind === 'fresh' ? 'fresh' : 'picker'))
    setActiveId(session.id); setError(null); setLaunchOpen(true)
  }
  const renameGrid = (id: string, value: string) => {
    setRenamingGrid(null)
    const name = value.trim().slice(0, 60)
    if (!name) return
    const next = grids.map(g => g.id === id ? { ...g, name } : g)
    try { saveGridWorkspaces(next); setGrids(next) } catch { setError('Grid adı kaydedilemedi.') }
  }
  const removeGrid = () => {
    const next = grids.filter(g => g.id !== gridId)
    if (next.length === 0) return
    try { saveGridWorkspaces(next); clearGridLayout(gridId); setGrids(next); setGridId(next[0].id); setGridIds(savedGridSessionIds(next[0].id)); setPendingGridAdd(null) } catch { setError('Grid kaldırılamadı.') }
  }
  const goHome = () => { leaveToScan(); setView('sessions') }
  const goGrid = () => { leaveToScan(); setView('grid') }
  const paletteCommands: PaletteCommand[] = [
    ...(active ? [
      { id: 'active-diff', label: `Değişiklikleri incele · ${active.name}`, icon: 'diff' as const, keywords: 'diff fark', run: () => setTab('diff') },
      { id: 'active-grid', label: `Çalışma alanında aç · ${active.name}`, icon: 'grid' as const, keywords: 'sekme grid', run: () => openSession(active.id) },
      { id: 'active-copy', label: `Aynı programla yeni oturum · ${active.name}`, icon: 'copy' as const, keywords: 'kopya çoğalt duplicate', run: () => duplicateSession(active) },
      { id: 'active-launch', label: `Komut çalıştır… · ${active.name}`, icon: 'play' as const, keywords: 'resume devam', run: () => setLaunchOpen(true) },
    ] : []),
    { id: 'search-conversations', label: 'Konuşmalarda ara…', icon: 'chat', hint: SHORTCUT_LABELS.searchConversations, keywords: 'claude geçmiş transcript bul metin', keepOpen: true, run: () => setPaletteScope('conversations') },
    { id: 'prompts', label: 'Hazır istemler ve öneriler…', icon: 'bolt', keywords: 'şablon tekrar otomatik kuyruk sıra makro istem', run: () => setPromptsFor({ sessionId: active?.id ?? document.querySelector<HTMLElement>('.dv-active-group [data-session-id]')?.dataset.sessionId ?? null }) },
    { id: 'home', label: 'Tüm oturumlar', icon: 'list', keywords: 'pano ana sayfa', hint: 'Esc', run: goHome },
    { id: 'grid', label: 'Çalışma alanı', icon: 'grid', keywords: 'sekmeler grid bölünmüş yan yana', run: goGrid },
    { id: 'new-tab', label: 'Yeni sekme', icon: 'plus', hint: SHORTCUT_LABELS.newTab, keywords: 'terminal sekme aç', run: newTab },
    { id: 'reopen-tab', label: 'Kapatılan sekmeyi geri aç', icon: 'refresh', keywords: 'sekme geri al son kapatılan', run: () => { goGrid(); window.setTimeout(() => window.dispatchEvent(new Event('agentdeck:tab-reopen'))) } },
    ...grids.filter(() => grids.length > 1).map(g => ({ id: `grid:${g.id}`, label: `Çalışma alanına geç · ${g.name}`, icon: 'layout' as const, run: () => { leaveToScan(); setGridId(g.id); setGridIds(savedGridSessionIds(g.id)); setPendingGridAdd(null); setView('grid') } })),
    { id: 'new-grid', label: 'Yeni çalışma alanı oluştur', icon: 'plus', keywords: 'grid', run: () => { createGrid(); goGrid() } },
    { id: 'grid-live', label: 'Çalışan oturumları yan yana aç', icon: 'layout', keywords: 'hepsi tümü canlı grid', run: addLiveToGrid },
    { id: 'sidebar', label: preferences.sidebarCollapsed ? 'Kenar çubuğunu genişlet' : 'Kenar çubuğunu daralt', icon: 'sidebar', hint: SHORTCUT_LABELS.sidebar, keywords: 'panel gizle', run: toggleSidebar },
    { id: 'new-session', label: 'Yeni oturum…', icon: 'plus', hint: SHORTCUT_LABELS.newSession, keywords: 'ajan terminal başlat', run: () => shortcutRef.current({ kind: 'new-session' }) },
    ...state.projects.filter(p => p.kind === 'git' && !p.general).map(p => ({ id: `prs:${p.id}`, label: `Pull request'ler · ${p.name}`, icon: 'branch' as const, keywords: 'pr github inceleme review', run: () => openPulls(p.id) })),
    { id: 'add-project', label: 'Proje ekle…', icon: 'folder', keywords: 'klasör depo', run: () => setAddingProject(true) },
    { id: 'settings', label: 'Ayarlar', icon: 'settings', keywords: 'tercih', run: () => setSettingsOpen(true) },
    ...Object.entries(THEMES).filter(([id]) => id !== preferences.theme).map(([id, theme]) => ({ id: `theme:${id}`, label: `Tema: ${theme.label}`, icon: 'palette' as const, keywords: 'renk görünüm', run: () => { try { updatePreferences({ theme: id as ThemeName }) } catch { setError('Tema kaydedilemedi.') } } })),
  ]
  const menuSession = state.sessions.find(session => session.id === menu?.id)
  const menuActions: MenuAction[] = menuSession ? [
    { label: 'Sekmede aç', icon: 'terminal', run: () => openSession(menuSession.id) },
    { label: 'Yan yana aç', icon: 'grid', description: 'Çalışma alanında yeni bir bölmede açar.', run: () => addToGrid(menuSession.id) },
    { label: 'Değişiklikleri incele', icon: 'diff', run: () => openDetail(menuSession.id, 'diff') },
    { label: 'Ayrıntı görünümü', icon: 'external', description: 'Önceki Run’lar ve oturum eylemleri.', run: () => openDetail(menuSession.id) },
    { label: 'Terminal rengi…', icon: 'palette', run: () => setColorSession(menuSession) },
    { label: menuSession.workId ? 'Başka işe taşı…' : 'İşe bağla…', icon: 'work', description: workOf(menuSession) ? `Şu an: ${workOf(menuSession)!.name}` : undefined, disabled: !stateHealthy, run: () => { setError(null); setAssigning(menuSession) } },
    { label: 'Aynı programla yeni sekme', icon: 'copy', description: 'Ctrl basılı tutup çalışma alanına sürüklemek de kopya açar.', disabled: !stateHealthy || creating, run: () => duplicateSession(menuSession) },
    ...(menuSession.archivedAt === null ? sessionWorkActions(menuSession).map(action => ({ label: action.label[0].toLocaleUpperCase('tr') + action.label.slice(1), description: action.description, icon: action.kind === 'stop' ? 'stop' as const : action.kind === 'restart' ? 'refresh' as const : 'play' as const, disabled: !stateHealthy || Boolean(menuSession.degraded && action.kind !== 'stop'), run: () => executeAction(menuSession, action) })) : []),
    { label: menuSession.archivedAt !== null ? 'Arşivden çıkar' : hasRunningProcesses(menuSession) ? 'Durdur ve arşivle' : 'Arşivle', icon: 'archive', disabled: !stateHealthy, run: () => toggleArchive(menuSession) },
    { label: 'Çalışma klasörünün yolunu kopyala', icon: 'copy', run: () => { navigator.clipboard.writeText(menuSession.cwd).catch(() => setError(`Yol kopyalanamadı: ${menuSession.cwd}`)) } },
    { label: 'Silme seçenekleri…', icon: 'trash', danger: true, disabled: !stateHealthy, run: () => askDelete(menuSession) },
  ] : []

  return (
    <div className={`app${preferences.compact ? ' compact-ui' : ''}`}>
      {preferences.notifications && toasts.length > 0 && <aside className="notification-toasts" aria-live="polite" aria-label="Yeni bildirimler">
        {toasts.map(notice => {
          return <article className="notification-toast" key={notice.id} data-kind={notice.kind}>
            <span className="toast-icon" aria-hidden="true"><Icon name={NOTICE_ICONS[notice.kind]} size={16} /></span>
            <button className="notification-toast-open" onClick={() => { lifecycle.dismissNotice(notice.id); selectSession(notice.sessionId, true) }}>
              <strong>{notice.title}</strong><span>{notice.detail}</span>
            </button>
            <button className="notification-toast-close icon-button ghost" aria-label="Bildirimi kapat" onClick={() => lifecycle.dismissNotice(notice.id)}><Icon name="close" size={14} /></button>
          </article>
        })}
      </aside>}

      <SidebarShell>{(navigate, narrow) => <Sidebar
        state={state}
        onSessionMenu={showMenu}
        onSettings={() => setSettingsOpen(true)}
        onPalette={() => navigate(() => setPaletteOpen(true))}
        onAddProject={() => navigate(() => setAddingProject(true))}
        notifications={preferences.notifications && <div className="notification-center">
          <button className="icon-button ghost" aria-label="Bildirim merkezi" title="Bildirimler" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(!notificationsOpen)}>
            <Icon name="bell" />{lifecycle.notices.length > 0 && <span className="bell-badge">{lifecycle.notices.length}</span>}
          </button>
          {notificationsOpen && <div className="notification-list">
            <header><strong>Bildirimler</strong>{lifecycle.notices.length > 0 && <button className="ghost-button" onClick={lifecycle.clearNotices}>Temizle</button>}</header>
            {lifecycle.notices.length === 0 && <p className="muted">Yeni bildirim yok. Bakmadığın bir ajan onay beklediğinde, çıktıyı durdurduğunda veya bittiğinde burada görünür.</p>}
            {lifecycle.notices.map(notice => <button key={notice.id} data-kind={notice.kind} onClick={() => { setNotificationsOpen(false); lifecycle.dismissNotice(notice.id); navigate(() => selectSession(notice.sessionId, true)) }}>
              <span className="toast-icon" aria-hidden="true"><Icon name={NOTICE_ICONS[notice.kind]} size={14} /></span>
              <span className="notice-text"><strong>{notice.title}</strong><span>{notice.detail}</span></span>
              <time>{noticeAge(notice.at)}</time>
            </button>)}
          </div>}
        </div>}
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
        onOpenBackground={(id) => navigate(() => openInWorkspace(id, 'background'))}
        onOpenBeside={(target, dragged) => navigate(() => openItems([{ id: target, place: 'tab' }, { id: dragged, place: 'split', beside: target }], false))}
        activeId={activeId}
        gridSessionIds={view === 'grid' && !active ? gridIds : []}
        collapsed={preferences.sidebarCollapsed && !narrow}
        onToggleCollapsed={toggleSidebar}
        onSelect={(id) => navigate(() => {
          selectSession(id)
        })}
        onNewSession={(project, work) => navigate(() => openNewSession(project, work))}
        onNewGeneralSession={() => navigate(openGeneralSession)}
        onWorkMenu={showWorkMenu}
        onOpenClaude={(work, agent) => navigate(() => openClaudeSession(work, agent))}
        onMoveToWork={(item, workId) => run(item.kind === 'session'
          ? api.assignWork(item.id, workId)
          : workId ? api.linkClaudeSessions(workId, [item.id]) : api.unlinkClaudeSession(item.workId, item.id))}
        pullCounts={pullCounts}
        onPulls={(id) => navigate(() => openPulls(id))}
        onRemoveProject={(project) => {
          // Oturumu olan projede önce neyin silineceği gösterilir; olmayanda yalnız kayıt kalkar.
          if (state.sessions.some((s) => s.projectId === project.id)) askProjectDelete(project.id)
          else setProjectRemove({ id: project.id, name: project.name })
        }}
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
            <span>{error}</span>
            <button className="icon-button ghost" aria-label="Hatayı kapat" onClick={() => setError(null)}><Icon name="close" size={14} /></button>
          </div>
        )}
        {state.serviceError && (
          <div className="error" role="alert">
            {state.serviceError}
          </div>
        )}
        <div className="scan" hidden={Boolean(active) || Boolean(prView) || view !== 'sessions'} inert={Boolean(active) || Boolean(prView) || view !== 'sessions'}>
          <Workspace
            onPreviewIds={setPreviewIds}
            state={state}
            now={now}
            previewsEnabled={preferences.previews && !active && view === 'sessions'}
            focusId={scanFocusId}
            onFocusHandled={() => setScanFocusId(null)}
            onSelect={openSession}
            onSessionMenu={showMenu}
            onNewSession={openNewSession}
            onWorkMenu={showWorkMenu}
            onNewWork={(project) => { setError(null); setWorkDialog({ mode: 'create', projectId: project.id }) }}
            onResumeConversation={resumeConversation}
            onOpenClaude={openClaudeSession}
            onUnlinkClaude={unlinkClaude}
            onLinkClaude={(work) => { setError(null); setClaudePicker(work) }}
            onMoveConversation={moveConversation}
            onUnmoveConversation={unmoveConversation}
            onAddProject={() => setAddingProject(true)}
            onPalette={() => setPaletteOpen(true)}
            onAddToGrid={addToGrid}
          />
        </div>
        {prView && !active && (() => {
          const project = state.projects.find(p => p.id === prView.projectId)
          if (!project) return null
          return <ProjectPullRequests key={project.id} project={project}
            sessions={state.sessions.filter(s => s.projectId === project.id)}
            selected={prView.pr} onSelect={pr => setPrView({ projectId: project.id, pr })} onBack={leaveToScan}
            onStartAgent={pr => startAgentOnPr(project.id, pr)} onOpenSession={openSession} />
        })()}
        {view === 'grid' && !active && !prView && (
          <div className="grid-workspace">
          <TerminalGrid key={gridId} gridId={gridId} onRefresh={refresh}
            state={state}
            healthy={stateHealthy}
            pendingAdd={pendingGridAdd}
            onPendingHandled={() => setPendingGridAdd(null)}
            onDetail={openDetail}
            onAction={executeAction}
            onSessionMenu={showMenu}
            onPanelsChange={setGridIds}
            onVisibleChange={setVisibleGridIds}
            onAddLive={addLiveToGrid}
            onNewTab={newTab}
            toolbar={<>
              <div className="new-tab-split" role="group" aria-label="Yeni sekme">
                <button className="new-tab-button" title={`Yeni sekme · ${SHORTCUT_LABELS.newTab}`} aria-label="Yeni sekme" aria-keyshortcuts="Control+Shift+T" disabled={!stateHealthy || creating} onClick={newTab}>
                  <Icon name="plus" size={15} />
                </button>
                <button className="new-tab-more" title="Program veya proje seç" aria-label="Yeni sekme seçenekleri" aria-haspopup="menu" onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setAddMenu({ x: rect.left, y: rect.bottom + 4, origin: event.currentTarget })
                }}><Icon name="chevron" size={11} /></button>
              </div>
              <div className="grid-workspace-tabs" role="navigation" aria-label="Çalışma alanları">
              {grids.map(g => renamingGrid === g.id
                ? <input key={g.id} className="grid-rename" aria-label="Çalışma alanı adı" autoFocus defaultValue={g.name} maxLength={60}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={(event) => renameGrid(g.id, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
                      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRenamingGrid(null) }
                    }} />
                : <button key={g.id} aria-pressed={gridId === g.id} title="Çift tıkla: yeniden adlandır"
                    onDoubleClick={() => setRenamingGrid(g.id)}
                    onClick={() => { if (g.id !== gridId) { setGridId(g.id); setGridIds(savedGridSessionIds(g.id)); setPendingGridAdd(null) } }}>{g.name}</button>)}
              <button className="icon-button ghost" title="Ayrı bir çalışma alanı oluştur" aria-label="Yeni çalışma alanı" onClick={createGrid}><Icon name="layout" size={14} /></button>
              <button className="icon-button ghost" title="Çalışma alanı işlemleri" aria-label="Çalışma alanı işlemleri" onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setGridMenu({ x: rect.left, y: rect.bottom + 4, origin: event.currentTarget })
              }}><Icon name="more" size={14} /></button>
              </div>
              {preferences.mascot && <ClaudeMascot sessions={state.sessions} now={now} onOpen={(id) => selectSession(id, true)} />}
            </>}
          />
          </div>
        )}
        {active && (
          <>
            <header className="topbar clean-topbar" style={terminalStyle(active, preferences)} onContextMenu={event => showMenu(active.id, event)}>
              <nav className="crumbs" aria-label="Konum">
                <button className="topbar-back crumb" aria-keyshortcuts="F6 Escape" title={`${view === 'grid' ? 'Çalışma alanına' : 'Oturumlara'} dön · Esc`} aria-label={view === 'grid' ? 'Çalışma alanına dön' : 'Oturumlara dön'} onClick={leaveToScan}>
                  <Icon name="back" size={14} /><span>{activeProject?.name ?? 'Oturumlar'}</span>
                </button>
                <span className="crumb-sep" aria-hidden="true">/</span>
                {workOf(active) && <>
                  <button className="crumb work-crumb" title="İş işlemleri" onClick={(event) => showWorkMenu(workOf(active)!, event)}>
                    <Icon name="work" size={13} /><span>{workOf(active)!.name}</span>
                  </button>
                  <span className="crumb-sep" aria-hidden="true">/</span>
                </>}
                <AgentMark session={active} />
                <h1 className="title" title={active.cwd}>{active.name}</h1>
              </nav>
              {!active.workId && <button className="ghost-button work-attach" title="Bu terminali bir işe bağla" onClick={() => { setError(null); setAssigning(active) }}><Icon name="work" size={13} /> İşe bağla</button>}
              <span className="status-pill" data-tone={statusTone(active)} title={active.attention?.message ?? active.degraded ?? undefined}>
                <StatusDot session={active} />{active.archivedAt !== null ? 'Arşiv' : stateLabel(active)}
              </span>
              {active.isolation === 'worktree' && <span className="chip" title="Kendi worktree'sinde çalışır">İzole</span>}
              <BranchPicker key={active.id} session={active} healthy={stateHealthy} />
              <PortLinks session={active} />
              <ContextMeter usage={active.usage} live={active.lifecycle === 'live' && Boolean(active.conversation?.current)} />
              <PromptQueueButton session={active} prompts={state.prompts ?? []} />
              <span className="topbar-spacer" />
              <div className="segmented tabs" role="group" aria-label="Görünüm">
                <button className={tab === 'terminal' ? 'on' : ''} aria-pressed={tab === 'terminal'} onClick={() => setTab('terminal')}><Icon name="terminal" size={14} /> Terminal</button>
                <button className={tab === 'diff' ? 'on' : ''} aria-pressed={tab === 'diff'} onClick={() => setTab('diff')}><Icon name="diff" size={14} /> Değişiklikler</button>
              </div>
              {active.archivedAt === null && active.lifecycle !== 'live' && sessionWorkActions(active).filter(action => action.primary).map(action => <button key={action.kind} className="primary" disabled={!stateHealthy || Boolean(active.degraded)} title={action.description} onClick={() => executeAction(active, action)}><Icon name="play" size={14} />{action.kind === 'continue' ? 'Devam et' : 'Yeniden aç'}</button>)}
              <button className="icon-button ghost" title="Çalışma alanında sekme olarak aç" aria-label="Çalışma alanında aç" onClick={() => openSession(active.id)}><Icon name="grid" /></button>
              <button className="icon-button ghost" aria-label="Oturum işlemleri" title="Oturum işlemleri · sağ tık" onClick={event => showMenu(active.id, event)}><Icon name="more" /></button>
            </header>
            {(active.degraded || activeProject?.degraded) && <div className="error">{active.degraded ?? activeProject?.degraded}</div>}
            {active.attention && active.lifecycle === 'live' && (
              <div className="attention-note" role="status">
                <Icon name="alert" size={14} />
                <span>{active.attention.kind === 'approval' ? 'Terminal onayınızı bekliyor; aşağıdan yanıtlayın.' : `Terminal yanıtınızı bekliyor: ${active.attention.message}`}</span>
              </div>
            )}
            {state.terminals?.[active.id]?.outputPressure && <div className="review-note" role="status">Çıktı işleniyor…</div>}
            {showTrust && (
              <div className="trust-note" role="note">
                <span>{TRUST_NOTE}</span>
                <button
                  className="ghost-button"
                  onClick={() => {
                    sessionStorage.setItem(trustKey(active.id), '1')
                    setTrustHidden(true)
                  }}
                >
                  Anladım
                </button>
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
                      <div className="segmented tabs" role="group" aria-label="Terminal görüntüsü">
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
                            Önceki · {new Date(previous.updatedAt).toLocaleTimeString('tr', { hour: '2-digit', minute: '2-digit' })}
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
                    onLayout={() => openSession(active.id)}
                    runId={inspectRunId}
                    session={active}
                    daemonId={state.daemonId}
                    stateHealthy={stateHealthy}
                  />
                </div>
              )}
              {tab === 'diff' && <DiffView key={active.id} target={{ kind: 'session', session: active, projectKind: activeProject?.kind }} />}
            </div>
          </>
        )}
      </main>

      {menu && menuSession && <ActionMenu position={menu.position} onClose={closeMenu} label={menu.tabActions ? 'Sekme işlemleri' : 'Oturum işlemleri'}
        // Sekmeden açılan menüde sekme işlemleri önce gelir; sekmede zaten karşılığı olanlar ("Sekmede aç", "Yan yana aç") düşer.
        actions={menu.tabActions ? [...menu.tabActions, ...menuActions.filter((a) => a.label !== 'Sekmede aç' && a.label !== 'Yan yana aç').map((a, i) => (i === 0 ? { ...a, divider: true } : a))] : menuActions}
        header={(() => {
        const project = state.projects.find((p) => p.id === menuSession.projectId)
        return <>
          <strong>{menuSession.name}</strong>
          <span>{[project?.general ? 'Projesiz' : project?.name, workOf(menuSession)?.name].filter(Boolean).join(' / ')}{menuSession.isolation === 'worktree' ? ' · İzole' : ''} · {menuSession.archivedAt !== null ? 'Arşiv' : stateLabel(menuSession)}</span>
          <span className="action-menu-path" title={menuSession.cwd}>{menuSession.cwd.replace(/^\/home\/[^/]+/, '~')}</span>
        </>
      })()} />}
      {workMenu && <ActionMenu label="İş işlemleri" position={workMenu.position} onClose={closeWorkMenu} actions={[
        { label: 'Bu işte yeni oturum…', icon: 'plus', run: () => { const p = state.projects.find((p) => p.id === workMenu.work.projectId); if (p) openNewSession(p, workMenu.work.id) } },
        { label: 'Claude oturumu bağla…', icon: 'chat', description: 'Claude’un arka plan oturumlarını bu işe bağlar.', run: () => { setError(null); setClaudePicker(workMenu.work) } },
        { label: 'Yeniden adlandır…', icon: 'edit', run: () => { setError(null); setWorkDialog({ mode: 'rename', work: workMenu.work }) } },
        { label: 'İşi sil…', icon: 'trash', danger: true, description: 'İşin terminalleri de silinir; branch’ler ve ortak klasör dosyaları korunur.', disabled: !stateHealthy, run: () => askWorkDelete(workMenu.work) },
      ]} />}
      {workDialog && <WorkNameDialog
        title={workDialog.mode === 'rename' ? 'İşi yeniden adlandır' : 'Yeni iş'}
        initial={workDialog.mode === 'rename' ? workDialog.work.name : ''}
        submitLabel={workDialog.mode === 'rename' ? 'Kaydet' : 'Oluştur'}
        busy={workBusy}
        error={error}
        onSubmit={submitWorkName}
        onCancel={() => { if (!workBusy) setWorkDialog(null) }}
      />}
      {claudePicker && <ClaudeSessionPicker
        work={claudePicker}
        works={works}
        projectId={claudePicker.projectId}
        now={now}
        busy={workBusy}
        error={error}
        onSubmit={linkClaude}
        onCancel={() => { if (!workBusy) setClaudePicker(null) }}
      />}
      {assigning && <AssignWorkDialog
        sessionName={assigning.name}
        works={works.filter((w) => w.projectId === assigning.projectId)}
        currentWorkId={assigning.workId ?? null}
        busy={workBusy}
        error={error}
        onSubmit={submitAssign}
        onCancel={() => { if (!workBusy) setAssigning(null) }}
      />}
      {addMenu && (() => {
        const context = active ?? gridFocusSession()
        const focusProject = state.projects.find((p) => p.id === context?.projectId)
        const live = navigationIds(state).filter((id) => !gridIds.includes(id)).length
        const full = gridIds.length >= MAX_GRID_PANELS
        return <ActionMenu label="Yeni sekme" position={addMenu} onClose={closeAddMenu} actions={[
          ...(focusProject ? PRESETS.map((preset) => ({ label: `${preset.label} · ${focusProject.general ? 'projesiz' : focusProject.name}`, icon: 'terminal' as const, leading: <ProgramIcon command={preset.command} />, disabled: !stateHealthy || creating || full, run: () => quickCreate(focusProject, preset) })) : []),
          ...(!focusProject?.general ? [{ label: 'Projesiz sekme…', icon: 'terminal' as const, description: 'Ev klasöründe; program ve iş seçilir.', disabled: !stateHealthy || full, run: openGeneralSession }] : []),
          { label: 'Yeni oturum…', icon: 'plus', description: 'Proje, program, iş ve çalışma yeri seçilir.', disabled: !stateHealthy || full, run: () => shortcutRef.current({ kind: 'new-session' }) },
          { label: live > 0 ? `Çalışan ${live} oturumu yan yana aç` : 'Çalışan oturumların hepsi açık', icon: 'layout', disabled: live === 0 || full, run: addLiveToGrid },
          { label: 'Başka proje veya program…', icon: 'command', run: () => setPaletteOpen(true) },
        ]} />
      })()}
      {gridMenu && <ActionMenu label="Çalışma alanı işlemleri" position={gridMenu} onClose={closeGridMenu} actions={[
        { label: 'Yeniden adlandır', icon: 'edit', run: () => setRenamingGrid(gridId) },
        { label: 'Yeni çalışma alanı', icon: 'plus', run: createGrid },
        { label: 'Çalışma alanını kaldır', icon: 'trash', danger: true, disabled: grids.length < 2, description: 'Sekmeleri ve yerleşimi kaldırır; terminaller çalışmaya devam eder.', run: removeGrid },
      ]} />}
      {paletteOpen && (
        <CommandPalette
          state={state}
          sessionOrder={navigationIds(state)}
          commands={paletteCommands}
          onSelectSession={(id) => selectSession(id, true)}
          onQuickCreate={quickCreate}
          scope={paletteScope}
          onScope={setPaletteScope}
          onResumeConversation={resumeConversation}
          resolveTarget={() => active?.id ?? document.querySelector<HTMLElement>('.dv-active-group [data-session-id]')?.dataset.sessionId ?? null}
          onSendPrompt={(prompt, sessionId) => {
            setError(null)
            api.enqueuePrompt(sessionId, { promptId: prompt.id }).then(() => refresh()).catch((e) => setError(e.message))
          }}
          onManagePrompts={(sessionId) => setPromptsFor({ sessionId })}
          onClose={() => { setPaletteOpen(false); setPaletteScope('all') }}
        />
      )}
      {promptsFor && (
        <PromptsDialog
          prompts={state.prompts ?? []}
          target={state.sessions.find((s) => s.id === promptsFor.sessionId) ?? null}
          onChanged={() => void refresh()}
          onClose={() => setPromptsFor(null)}
        />
      )}
      {colorSession && <ColorDialog id={colorSession.id} projectId={colorSession.projectId} name={colorSession.name} onClose={() => setColorSession(null)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {pendingDelete && (
        <ConfirmDialog
          title={`“${pendingDelete.name}” silinsin mi?`}
          confirmLabel={pendingDelete.preview.isolation === 'shared' ? 'Kaydı kaldır' : 'Klasörü sil'}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        >
          <p className="dialog-note">
            {pendingDelete.preview.isolation === 'shared'
              ? 'Yalnız oturum kaydı kaldırılır; proje klasörü ve dosyaları korunur.'
              : deleteQuestion(pendingDelete.preview)}
          </p>
          <div className="confirm-paths">
            <span>{pendingDelete.preview.isolation === 'shared' ? 'Korunacak klasör' : 'Silinecek klasör'}</span>
            <code>{pendingDelete.preview.cwd}</code>
          </div>
          {pendingDelete.preview.branch && <p className="dialog-note muted">Branch korunur: <code>{pendingDelete.preview.branch}</code></p>}
        </ConfirmDialog>
      )}
      {projectDelete && (
        <ConfirmDialog
          title={`“${state.projects.find((p) => p.id === projectDelete.projectId)?.name ?? 'Proje'}” silinsin mi?`}
          confirmLabel="Projeyi sil"
          onConfirm={confirmProjectDelete}
          onCancel={() => setProjectDelete(null)}
        >
          <p className="dialog-note">{projectDeleteSummary(projectDelete)}</p>
          {projectDelete.sessions.some((s) => s.isolation === 'worktree') && (
            <div className="confirm-paths">
              <span>Silinecek klasörler</span>
              {/* Kullanıcı silinecek tam yolları onaydan önce görür. */}
              {projectDelete.sessions.filter((s) => s.isolation === 'worktree').map((s) => <code key={s.id}>{s.cwd}</code>)}
            </div>
          )}
        </ConfirmDialog>
      )}
      {workDelete && (
        <ConfirmDialog
          title={`“${works.find((w) => w.id === workDelete.workId)?.name ?? 'İş'}” silinsin mi?`}
          confirmLabel="İşi sil"
          onConfirm={confirmWorkDelete}
          onCancel={() => setWorkDelete(null)}
        >
          <p className="dialog-note">{projectDeleteSummary(workDelete)} Bağlı Claude oturumları Claude’da kalır; yalnız işten çıkar.</p>
          {workDelete.sessions.some((s) => s.isolation === 'worktree') && (
            <div className="confirm-paths">
              <span>Silinecek klasörler</span>
              {workDelete.sessions.filter((s) => s.isolation === 'worktree').map((s) => <code key={s.id}>{s.cwd}</code>)}
            </div>
          )}
        </ConfirmDialog>
      )}
      {projectRemove && (
        <ConfirmDialog
          title={`“${projectRemove.name}” kaldırılsın mı?`}
          confirmLabel="Kaydı kaldır"
          onConfirm={() => { const { id } = projectRemove; setProjectRemove(null); run(api.deleteProject(id)) }}
          onCancel={() => setProjectRemove(null)}
        >
          <p className="dialog-note">Yalnız proje kaydı kaldırılır; klasöre ve dosyalara dokunulmaz.</p>
        </ConfirmDialog>
      )}
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
          works={works.filter((w) => w.projectId === dialogProject.id)}
          initialWork={dialogWork}
          busy={creating}
          error={error}
          pullRequest={dialogPr}
          onCancel={() => {
            if (!creating) { setDialogProject(null); setDialogPr(null) }
          }}
          onCreate={createSession}
        />
      )}
    </div>
  )
}
