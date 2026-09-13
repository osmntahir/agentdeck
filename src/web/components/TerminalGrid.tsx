import { createContext, useContext, useEffect, useRef, useState } from 'react'
import {
  DockviewDefaultTab,
  DockviewReact,
  themeDark,
  type Direction,
  type DockviewApi,
  type DockviewDidDropEvent,
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
import { commandLabel } from '../../shared/types'
import { clearGridLayout, loadGridLayout, MAX_GRID_PANELS, saveGridLayout, SESSION_DRAG_TYPE } from '../gridLayout'
import { stateLabel } from './Sidebar'
import { TerminalPane } from './TerminalPane'

interface GridContextValue {
  state: StateResponse
  healthy: boolean
  onOpen: (sessionId: string) => void
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
  session: SessionView,
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
    <div className="grid-panel">
      <TerminalPane
        key={`${grid.state.daemonId}:${session.id}:${session.runId}`}
        session={session}
        daemonId={grid.state.daemonId}
        stateHealthy={grid.healthy}
        autoFocus={false}
        compact
      />
    </div>
  )
}

/** Grup başlığının sağı: öndeki oturumun proje, program ve durum bilgisi. */
function GroupActions({ activePanel }: IDockviewHeaderActionsProps) {
  const grid = useContext(GridContext)
  const session = grid?.state.sessions.find((s) => s.id === activePanel?.id)
  if (!grid || !session) return null
  const project = grid.state.projects.find((p) => p.id === session.projectId)
  return (
    <div className="grid-group-actions">
      <span className={`dot ${session.lifecycle}`} />
      <span className="grid-group-meta" title={session.cwd}>
        {project?.name ?? 'proje kaydı yok'} · {commandLabel(session.command)} · {stateLabel(session)}
      </span>
      <button title="Tek görünümde aç: diff ve oturum eylemleri" onClick={() => grid.onOpen(session.id)}>
        Aç ↗
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
      title={session ? `${session.name} · ${stateLabel(session)}` : undefined}
    />
  )
}

function EmptyGrid() {
  return (
    <div className="grid-empty">
      <div className="grid-empty-mark" aria-hidden="true">
        ⊞
      </div>
      <strong>Terminal grid boş</strong>
      <span>
        Kenar çubuğundaki bir oturumu buraya sürükleyin ya da oturumun yanındaki ⊞ ile ekleyin. Paneller
        kenarlara bırakılarak bölünür.
      </span>
    </div>
  )
}

const COMPONENTS = { terminal: TerminalPanel }

/** Karanlık temanın değişkenleri korunur; gruplar arasında boşluk bırakılır. */
const THEME: DockviewTheme = { ...themeDark, name: 'agentdeck', gap: 8 }

interface Props {
  state: StateResponse
  healthy: boolean
  /** Başka görünümden eklenmek istenen oturum; grid hazır olunca işlenir. */
  pendingAdd: string | null
  onPendingHandled: () => void
  onOpen: (sessionId: string) => void
  onPanelsChange: (sessionIds: string[]) => void
}

export function TerminalGrid({ state, healthy, pendingAdd, onPendingHandled, onOpen, onPanelsChange }: Props) {
  const [api, setApi] = useState<DockviewApi | null>(null)
  const [count, setCount] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const latest = useRef({ sessions: state.sessions, onPanelsChange })
  latest.current = { sessions: state.sessions, onPanelsChange }

  const onReady = ({ api: ready }: DockviewReadyEvent) => {
    const saved = loadGridLayout()
    if (saved) {
      try {
        ready.fromJSON(saved)
      } catch {
        // Okunamayan yerleşim oturumları etkilemez; grid boş başlar.
        ready.clear()
        clearGridLayout()
      }
    }
    const publish = () => {
      saveGridLayout(ready.toJSON())
      setCount(ready.panels.length)
      latest.current.onPanelsChange(ready.panels.map((panel) => panel.id))
    }
    ready.onDidLayoutChange(publish)
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
    if (session) setNotice(addSession(event.api, session, { group: event.group, position: event.position }))
  }

  useEffect(() => {
    if (!api || !pendingAdd || !healthy) return
    const session = state.sessions.find((s) => s.id === pendingAdd)
    setNotice(session ? addSession(api, session) : 'Eklenmek istenen oturum artık yok.')
    onPendingHandled()
  }, [api, pendingAdd, healthy])

  // Silinen oturumun paneli kapanır; kaydı olmayan terminal gösterilmez.
  useEffect(() => {
    if (!api || !healthy) return
    const known = new Set(state.sessions.map((s) => s.id))
    for (const panel of [...api.panels]) if (!known.has(panel.id)) panel.api.close()
  }, [api, healthy, state.sessions])

  return (
    <GridContext.Provider value={{ state, healthy, onOpen }}>
      <section className="terminal-grid">
        <header className="workspace-header">
          <div>
            <span className="breadcrumb">Çalışma alanı</span>
            <h1>Terminal grid</h1>
          </div>
          <div className="grid-header-meta">
            <span className="grid-hint">
              Sekmeyi sürükleyip bir panelin kenarına bırakın; aradaki çizgiyle boyutlandırın.
            </span>
            <span className="grid-count">
              {count} / {MAX_GRID_PANELS} terminal
            </span>
          </div>
        </header>
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
          />
        </div>
      </section>
    </GridContext.Provider>
  )
}
