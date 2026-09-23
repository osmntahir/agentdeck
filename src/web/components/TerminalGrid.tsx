import { BranchPicker } from './BranchPicker'
import { terminalStyle, usePreferences } from '../preferences'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DockviewDefaultTab,
  DockviewReact,
  themeDark,
  type Direction,
  type DockviewApi,
  type DockviewDidDropEvent,
  type DockviewWillDropEvent,
  type DockviewGroupPanel,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type Position,
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import type { SessionView, StateResponse } from '../../shared/types'
import { duplicateCommand } from '../../shared/workspacePolicy'
import * as client from '../api'
import { clearGridLayout, loadGridLayout, MAX_GRID_PANELS, saveGridLayout, SESSION_DRAG_TYPE } from '../gridLayout'
import { stateLabel, statusTone, StatusDot } from '../sessionStatus'
import { Icon } from './Icon'
import { SHORTCUT_LABELS } from '../../shared/shortcuts'
import { TerminalPane } from './TerminalPane'
import { GridLayoutDialog } from './GridLayoutDialog'

interface GridContextValue {
  state: StateResponse
  healthy: boolean
  focusRequest: { sessionId: string; sequence: number; origin: HTMLElement } | null
  onFocusHandled: () => void
  onSessionMenu: (id: string, event: React.MouseEvent<HTMLElement>) => void
  onOpen: (sessionId: string) => void
  onLayout: (sessionId: string) => void
  maximized: boolean
  onToggleMaximize: (sessionId: string) => void
  onAddLive: () => void
  liveOutside: number
}

/** Paneller dockview portallarında çizilir; güncel state bağlamdan okunur. */
const GridContext = createContext<GridContextValue | null>(null)

interface PanelParams {
  sessionId: string
}

const DIRECTION: Record<Position, Direction> = {
  top: 'above',
  bottom: 'below',
  left: 'left',
  right: 'right',
  center: 'within',
}

/**
 * Oturumu grid'e ekler; zaten açıksa yalnız öne getirir. Bırakma konumu yoksa
 * en geniş grup uzun kenarından bölünür ve terminaller dengeli dağılır. Sınır
 * doluysa eklemez ve nedenini döner.
 */
function addSession(
  api: DockviewApi,
  session: Pick<SessionView, 'id' | 'name'>,
  drop?: { group?: DockviewGroupPanel; position: Position },
): string | null {
  const existing = api.getPanel(session.id)
  if (existing) {
    existing.api.setActive()
    return null
  }
  if (api.panels.length >= MAX_GRID_PANELS) {
    return `Grid'de en çok ${MAX_GRID_PANELS} terminal açık tutulur; önce bir paneli kapatın.`
  }
  const panel = { id: session.id, component: 'terminal', title: session.name, params: { sessionId: session.id } }
  if (drop?.group) {
    api.addPanel({ ...panel, position: { referenceGroup: drop.group, direction: DIRECTION[drop.position] } })
  } else if (drop && drop.position !== 'center') {
    api.addPanel({ ...panel, position: { direction: DIRECTION[drop.position] } })
  } else {
    const largest = [...api.groups].sort((a, b) => b.width * b.height - a.width * a.height)[0]
    api.addPanel(
      largest
        ? { ...panel, position: { referenceGroup: largest, direction: largest.width >= largest.height ? 'right' : 'below' } }
        : panel,
    )
  }
  return null
}

function TerminalPanel({ params, api }: IDockviewPanelProps) {
  const grid = useContext(GridContext)
  const preferences = usePreferences()
  const [visible, setVisible] = useState(api.isVisible)
  useEffect(() => {
    const listener = api.onDidVisibilityChange((event) => setVisible(event.isVisible))
    return () => listener.dispose()
  }, [api])

  const { sessionId } = params as PanelParams
  const session = grid?.state.sessions.find((s) => s.id === sessionId)
  if (!grid || !session) return <div className="grid-empty">Oturum kaydı bulunamadı.</div>
  // Gizli sekmede xterm açık tutulmaz; öne gelince ekran daemon'dan yeniden kurulur.
  if (!visible) return null
  return (
    <div className="grid-panel colored-terminal" data-session-id={session.id} style={terminalStyle(session, preferences)}>
      <TerminalPane
        key={`${grid.state.daemonId}:${session.id}:${session.runId}`}
        session={session}
        daemonId={grid.state.daemonId}
        stateHealthy={grid.healthy}
        autoFocus={false}
        focusRequest={grid.focusRequest?.sessionId === session.id ? grid.focusRequest : undefined}
        onFocusHandled={grid.onFocusHandled}
        compact
        onLayout={() => grid.onLayout(session.id)}
      />
    </div>
  )
}

/** Grup başlığının sağı: öndeki oturumun programı, branch'i ve görünüm eylemleri. */
function GroupActions({ activePanel }: IDockviewHeaderActionsProps) {
  const grid = useContext(GridContext)
  const session = grid?.state.sessions.find((s) => s.id === activePanel?.id)
  if (!grid || !session) return null
  const project = grid.state.projects.find((p) => p.id === session.projectId)
  return (
    <div className="grid-group-actions" onContextMenu={event => grid.onSessionMenu(session.id, event)}>
      <span className="grid-group-meta" title={session.degraded ?? session.cwd}>
        {project?.name ?? 'proje kaydı yok'} · {stateLabel(session)}
        {session.degraded ? ' · dizin kullanılamıyor' : ''}
      </span>
      <BranchPicker session={session} healthy={grid.healthy} />
      <button className="icon-button ghost" title={`${grid.maximized ? 'Önceki yerleşime dön' : 'Paneli büyüt'} · ${SHORTCUT_LABELS.maximize}`} aria-label={grid.maximized ? 'Önceki yerleşime dön' : 'Paneli büyüt'} onClick={() => grid.onToggleMaximize(session.id)}>
        <Icon name={grid.maximized ? 'minimize' : 'maximize'} size={14} />
      </button>
      <button className="icon-button ghost" title="Tek görünümde aç: diff ve oturum eylemleri" aria-label="Tek görünümde aç" onClick={() => grid.onOpen(session.id)}>
        <Icon name="external" size={14} />
      </button>
      <button className="icon-button ghost" title="Oturum işlemleri" aria-label={`${session.name} işlemleri`} onClick={event => grid.onSessionMenu(session.id, event)}>
        <Icon name="more" size={14} />
      </button>
    </div>
  )
}

/** Varsayılan sekmenin sürükleme ve kapatma davranışı korunur; durum noktası CSS'ten çizilir. */
function SessionTab(props: IDockviewPanelHeaderProps) {
  const grid = useContext(GridContext)
  const session = grid?.state.sessions.find((s) => s.id === props.api.id)
  return (
    <DockviewDefaultTab
      {...props}
      data-lifecycle={session?.lifecycle ?? 'orphaned'}
      data-tone={session ? statusTone(session) : 'orphaned'}
      title={session ? `${session.name} · ${stateLabel(session)}` : undefined}
    />
  )
}

function EmptyGrid() {
  const grid = useContext(GridContext)
  return (
    <div className="grid-empty">
      <div className="grid-empty-mark" aria-hidden="true">
        <Icon name="layout" size={24} />
      </div>
      <strong>Terminalleri yan yana koy</strong>
      <span>
        Kenar çubuğundan bir oturumu buraya sürükleyin ya da satırdaki grid simgesine tıklayın. Sekmeyi bir
        panelin kenarına bırakırsanız ekran bölünür.
      </span>
      {grid && grid.liveOutside > 0 && (
        <button className="primary" onClick={grid.onAddLive}><Icon name="grid" size={14} /> Çalışan {grid.liveOutside} oturumu ekle</button>
      )}
      <span className="grid-empty-keys"><kbd>Ctrl</kbd> basılı sürükle: aynı programdan kopya · <kbd>{SHORTCUT_LABELS.maximize}</kbd> paneli büyüt</span>
    </div>
  )
}

const COMPONENTS = { terminal: TerminalPanel }

/** Karanlık temanın değişkenleri korunur; gruplar arasında boşluk bırakılır. */
const THEME: DockviewTheme = { ...themeDark, name: 'agentdeck', gap: 6 }

interface Props {
  gridId: string
  onRefresh: () => Promise<void>
  state: StateResponse
  healthy: boolean
  /** Başka görünümden eklenmek istenen oturumlar; grid hazır olunca işlenir. focus klavyeyle gelindiğini söyler. */
  pendingAdd: { ids: string[]; focus: boolean } | null
  onPendingHandled: () => void
  onSessionMenu: (id: string, event: React.MouseEvent<HTMLElement>) => void
  onOpen: (sessionId: string) => void
  onPanelsChange: (sessionIds: string[]) => void
  /** Grid seçici; panel gezinmesiyle aynı satırda çizilir. */
  toolbar: ReactNode
  /** Çubuğun sağ ucundaki eylemler. */
  actions: ReactNode
  /** Grid'de olmayan canlı oturumları ekler. */
  onAddLive: () => void
}

export function TerminalGrid({ gridId, onRefresh, state, healthy, pendingAdd, onPendingHandled, onOpen, onSessionMenu, onPanelsChange, toolbar, actions, onAddLive }: Props) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      document.documentElement.classList.toggle('grid-cursor-off', Math.floor(Date.now() / 600) % 2 === 1)
      timer = setTimeout(tick, 600 - Date.now() % 600)
    }
    tick()
    return () => { clearTimeout(timer); document.documentElement.classList.remove('grid-cursor-off') }
  }, [])
  const [api, setApi] = useState<DockviewApi | null>(null)
  const [panelIds, setPanelIds] = useState<string[]>([])
  const [candidate, setCandidate] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ sessionId: string; sequence: number; origin: HTMLElement } | null>(null)
  const focusSequence = useRef(0)
  const navigation = useRef<HTMLDivElement>(null)
  const count = panelIds.length
  const candidateId = candidate && panelIds.includes(candidate) ? candidate : panelIds[0]

  const [layoutPanel, setLayoutPanel] = useState<string | null>(null)
  const [maximized, setMaximized] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const latest = useRef({ sessions: state.sessions, onPanelsChange })
  latest.current = { sessions: state.sessions, onPanelsChange }

  const onReady = ({ api: ready }: DockviewReadyEvent) => {
    const saved = loadGridLayout(gridId)
    if (saved) {
      try {
        ready.fromJSON(saved)
      } catch {
        // Okunamayan yerleşim oturumları etkilemez; grid boş başlar.
        ready.clear()
        clearGridLayout(gridId)
      }
    }
    const publish = () => {
      saveGridLayout(ready.toJSON(), gridId)
      setPanelIds(ready.panels.map((panel) => panel.id))
      latest.current.onPanelsChange(ready.panels.map((panel) => panel.id))
    }
    ready.onDidLayoutChange(publish)
    ready.onDidMaximizedGroupChange(() => setMaximized(ready.hasMaximizedGroup()))
    ready.onUnhandledDragOver((event) => {
      const native = event.nativeEvent
      if (native instanceof DragEvent && native.dataTransfer?.types.includes(SESSION_DRAG_TYPE)) event.accept()
    })
    publish()
    setApi(ready)
  }

  const onDidDrop = (event: DockviewDidDropEvent) => {
    // Grid içindeki panel taşımalarını dockview kendisi yapar; yalnız dışarıdan gelen oturum eklenir.
    if (event.getData() || !(event.nativeEvent instanceof DragEvent)) return
    const id = event.nativeEvent.dataTransfer?.getData(SESSION_DRAG_TYPE)
    const session = latest.current.sessions.find((s) => s.id === id)
    if (!session) return
    // Ctrl basılı bırakma aynı programdan yeni bir terminal açar; özgün oturum yerinde kalır.
    if (event.nativeEvent.ctrlKey) void duplicateInto(session, { group: event.group, position: event.position })
    else setNotice(addSession(event.api, session, { group: event.group, position: event.position }))
  }

  // Grid içindeki sekme Ctrl ile sürüklenirse taşınmaz; bırakılan yere kopyası açılır.
  const onWillDrop = (event: DockviewWillDropEvent) => {
    const panelId = event.getData()?.panelId
    if (!panelId || !event.nativeEvent.ctrlKey) return
    const session = latest.current.sessions.find((s) => s.id === panelId)
    if (!session) return
    event.preventDefault()
    void duplicateInto(session, { group: event.group, position: event.position })
  }

  const duplicateInto = async (session: SessionView, drop: { group?: DockviewGroupPanel; position: Position }) => {
    if (!api) return
    if (api.panels.length >= MAX_GRID_PANELS) {
      setNotice(`Grid'de en çok ${MAX_GRID_PANELS} terminal açık tutulur; önce bir paneli kapatın.`)
      return
    }
    setNotice(null)
    try {
      const created = await client.createSessionInWork({ projectId: session.projectId, name: '', command: duplicateCommand(session), isolation: 'shared', workId: session.workId ?? null })
      await onRefresh()
      // Kopya özgün terminalin arkasına sekme olarak gizlenmesin; ortaya bırakılınca grup bölünür.
      const position: Position = drop.position !== 'center' ? drop.position : drop.group && drop.group.width < drop.group.height ? 'bottom' : 'right'
      setNotice(addSession(api, created, { ...drop, position }))
    } catch (e) {
      setNotice(`Kopya açılamadı: ${(e as Error).message}`)
    }
  }

  useEffect(() => {
    if (!api || !pendingAdd || !healthy) return
    let problem: string | null = null
    for (const id of pendingAdd.ids) {
      const session = state.sessions.find((s) => s.id === id)
      problem = (session ? addSession(api, session) : 'Eklenmek istenen oturum artık yok.') ?? problem
    }
    setNotice(problem)
    // Kısayolla gelinen panel yazmaya hazır olur; tıklamayla eklenen panel odağı çalmaz.
    const target = pendingAdd.ids.at(-1)
    if (target && pendingAdd.focus && api.getPanel(target) && document.activeElement instanceof HTMLElement) {
      setFocusRequest({ sessionId: target, sequence: ++focusSequence.current, origin: document.activeElement })
    }
    onPendingHandled()
  }, [api, pendingAdd, healthy])

  const toggleMaximize = (sessionId?: string) => {
    if (!api) return
    if (api.hasMaximizedGroup()) { api.exitMaximizedGroup(); return }
    const panel = sessionId ? api.getPanel(sessionId) : api.activePanel
    // Tek grup zaten tüm alanı kaplar; büyütülecek bir şey yoktur.
    if (panel && api.groups.length > 1) api.maximizeGroup(panel)
  }
  const toggleRef = useRef(toggleMaximize)
  toggleRef.current = toggleMaximize
  useEffect(() => {
    const onMaximize = () => toggleRef.current()
    window.addEventListener('agentdeck:grid-maximize', onMaximize)
    return () => window.removeEventListener('agentdeck:grid-maximize', onMaximize)
  }, [])

  // Restored Dockview tabs keep their saved title unless explicitly refreshed.
  useEffect(() => {
    if (!api) return
    for (const session of state.sessions) {
      const panel = api.getPanel(session.id)
      if (panel && panel.title !== session.name) panel.api.setTitle(session.name)
    }
  }, [api, state.sessions])

  // Silinen oturumun paneli kapanır; kaydı olmayan terminal gösterilmez.
  useEffect(() => {
    if (!api || !healthy) return
    const known = new Set(state.sessions.map((s) => s.id))
    for (const panel of [...api.panels]) if (!known.has(panel.id)) panel.api.close()
  }, [api, healthy, state.sessions])

  return (
    <GridContext.Provider value={{ state, healthy, onOpen, onSessionMenu, onLayout: setLayoutPanel, focusRequest, onFocusHandled: () => setFocusRequest(null), maximized, onToggleMaximize: toggleMaximize, onAddLive, liveOutside: state.sessions.filter((s) => s.archivedAt === null && s.lifecycle === 'live' && !panelIds.includes(s.id)).length }}>
      <section className="terminal-grid">
        <div className="grid-toolbar">
        {toolbar}
        {panelIds.length > 0 && (
          <div className="grid-panel-navigation" role="toolbar" aria-label="Grid terminalleri" ref={navigation}>
            <span className="grid-count" title={`En çok ${MAX_GRID_PANELS} panel`}>{count}/{MAX_GRID_PANELS}</span>
            {panelIds.map((id) => (
              <button
                key={id}
                type="button"
                data-grid-session={id}
                tabIndex={id === candidateId ? 0 : -1}
                onFocus={() => setCandidate(id)}
                onKeyDown={(event) => {
                  if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
                  const index = panelIds.indexOf(id)
                  let next: number
                  switch (event.key) {
                    case 'ArrowRight': case 'ArrowDown': next = (index + 1) % panelIds.length; break
                    case 'ArrowLeft': case 'ArrowUp': next = (index + panelIds.length - 1) % panelIds.length; break
                    case 'Home': next = 0; break
                    case 'End': next = panelIds.length - 1; break
                    default: return
                  }
                  event.preventDefault()
                  navigation.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
                }}
                onClick={(event) => {
                  const origin = event.currentTarget
                  origin.focus()
                  const panel = api?.getPanel(id)
                  if (!panel) return
                  panel.api.setActive()
                  setFocusRequest({ sessionId: id, sequence: ++focusSequence.current, origin })
                }}
              >
                {(() => {
                  const session = state.sessions.find((item) => item.id === id)
                  return session ? <><StatusDot session={session} />{session.name}</> : id
                })()}
              </button>
            ))}
          </div>
        )}
        {actions}
        </div>

        {layoutPanel && api && <GridLayoutDialog projects={state.projects} healthy={healthy} onRefresh={onRefresh} api={api} panelId={layoutPanel} sessions={state.sessions} works={state.works ?? []}
          onClose={() => setLayoutPanel(null)} />}
        {notice && (
          <div className="error" role="alert">
            {notice}
          </div>
        )}
        <div className="grid-stage">
          <DockviewReact
            className="grid-dock"
            theme={THEME}
            components={COMPONENTS}
            defaultTabComponent={SessionTab}
            rightHeaderActionsComponent={GroupActions}
            watermarkComponent={EmptyGrid}
            disableFloatingGroups
            onReady={onReady}
            onDidDrop={onDidDrop}
            onWillDrop={onWillDrop}
          />
        </div>
      </section>
    </GridContext.Provider>
  )
}
