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
import { clearGridLayout, loadGridLayout, MAX_GRID_PANELS, saveGridLayout, SESSION_DRAG_TYPE, type GridAdd, type GridPlacement } from '../gridLayout'
import { stateLabel, statusTone, StatusDot } from '../sessionStatus'
import { sessionIssues } from '../sessionIssues'
import { sessionWorkActions, type SessionWorkAction } from '../../shared/sessionActions'
import { Icon } from './Icon'
import type { MenuAction } from './ActionMenu'
import { SHORTCUT_LABELS } from '../../shared/shortcuts'
import { TerminalPane } from './TerminalPane'
import { GridLayoutDialog } from './GridLayoutDialog'
import { ContextMeter, PortLinks } from './SessionInsights'
import { PromptQueueButton } from './Prompts'

interface GridContextValue {
  state: StateResponse
  healthy: boolean
  focusRequest: { sessionId: string; sequence: number; origin: HTMLElement } | null
  onFocusHandled: () => void
  onSessionMenu: (id: string, event: React.MouseEvent<HTMLElement>, tabActions?: MenuAction[]) => void
  onTabMenu: (sessionId: string, event: React.MouseEvent<HTMLElement>) => void
  onDetail: (sessionId: string, tab: 'terminal' | 'diff') => void
  onAction: (session: SessionView, action: SessionWorkAction) => void
  onLayout: (sessionId: string) => void
  maximized: boolean
  onToggleMaximize: (sessionId: string) => void
  onAddLive: () => void
  onNewTab: () => void
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
 * Oturumu çalışma alanına ekler; zaten açıksa yalnız öne getirir (arka plan
 * isteğinde dokunmaz). Sekme etkin gruba girer. Bölme `beside` oturumunun
 * yanında, yoksa en geniş grubun uzun kenarında açılır; bırakma konumu varsa
 * o kullanılır. Sınır doluysa eklemez ve nedenini döner.
 */
function addSession(
  api: DockviewApi,
  session: Pick<SessionView, 'id' | 'name'>,
  how: { place: GridPlacement; beside?: string } | { drop: { group?: DockviewGroupPanel; position: Position } },
): string | null {
  const existing = api.getPanel(session.id)
  if (existing) {
    if (!('place' in how) || how.place === 'tab') existing.api.setActive()
    if ('place' in how && how.place === 'split') {
      // Aynı gruptaki sekme yan yana istenirse yeni bir bölmeye taşınır; ayrı gruplardaysa ikisi de öne gelir.
      const neighbor = how.beside ? api.getPanel(how.beside) : undefined
      neighbor?.api.setActive()
      const group = existing.group
      if (group.panels.length > 1 && (!neighbor || neighbor.group === group)) {
        existing.api.moveTo({ group, position: group.width >= group.height ? 'right' : 'bottom' })
      }
      existing.api.setActive()
    }
    return null
  }
  if (api.panels.length >= MAX_GRID_PANELS) {
    return `Çalışma alanında en çok ${MAX_GRID_PANELS} sekme açık tutulur; önce bir sekmeyi kapatın.`
  }
  const panel = { id: session.id, component: 'terminal', title: session.name, params: { sessionId: session.id } }
  if ('drop' in how) {
    const { drop } = how
    if (drop.group) api.addPanel({ ...panel, position: { referenceGroup: drop.group, direction: DIRECTION[drop.position] } })
    else if (drop.position !== 'center') api.addPanel({ ...panel, position: { direction: DIRECTION[drop.position] } })
    else api.addPanel(panel)
    return null
  }
  if (how.place !== 'split') {
    const group = api.activeGroup ?? api.groups[0]
    api.addPanel({ ...panel, ...(group ? { position: { referenceGroup: group, direction: 'within' as const } } : {}), inactive: how.place === 'background' && Boolean(group) })
    return null
  }
  const neighbor = how.beside ? api.getPanel(how.beside)?.group : undefined
  const reference = neighbor ?? [...api.groups].sort((a, b) => b.width * b.height - a.width * a.height)[0]
  api.addPanel(
    reference
      ? { ...panel, position: { referenceGroup: reference, direction: reference.width >= reference.height ? 'right' : 'below' } }
      : panel,
  )
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
      <EndedCard session={session} />
    </div>
  )
}

/**
 * Program bittiğinde terminalin boş kalan alt kısmında sürdürme eylemleri;
 * program çalışırken hiç görünmez.
 */
function EndedCard({ session }: { session: SessionView }) {
  const grid = useContext(GridContext)
  if (!grid || session.archivedAt !== null || session.lifecycle === 'live') return null
  const actions = sessionWorkActions(session).filter((action) => action.primary)
  if (actions.length === 0) return null
  return (
    <div className="ended-card" role="status">
      <span>{stateLabel(session)}</span>
      {actions.map((action) => (
        <button key={action.kind} className="primary" disabled={!grid.healthy || Boolean(session.degraded)} title={action.description} onClick={() => grid.onAction(session, action)}>
          <Icon name="play" size={13} />{action.kind === 'continue' ? 'Devam et' : 'Yeniden aç'}
        </button>
      ))}
    </div>
  )
}

/** Sekme ve grup başlığında oturumun yeri: proje / iş, izolasyon. */
function sessionPlace(session: SessionView, state: StateResponse): string {
  const project = state.projects.find((p) => p.id === session.projectId)
  const work = state.works?.find((w) => w.id === session.workId)
  const place = [project?.general ? 'Projesiz' : (project?.name ?? 'proje kaydı yok'), work?.name].filter(Boolean).join(' / ')
  return session.isolation === 'worktree' ? `${place} · İzole` : place
}

/** Grup başlığının sağı: öndeki oturumun programı, branch'i ve görünüm eylemleri. */
function GroupActions({ activePanel }: IDockviewHeaderActionsProps) {
  const grid = useContext(GridContext)
  const session = grid?.state.sessions.find((s) => s.id === activePanel?.id)
  if (!grid || !session) return null
  const issues = sessionIssues(session, grid.state)
  return (
    <div className="grid-group-actions" onContextMenu={event => grid.onSessionMenu(session.id, event)}>
      <span className="grid-group-meta" title={session.cwd}>
        {sessionPlace(session, grid.state)} · {stateLabel(session)}
      </span>
      {issues.length > 0 && (
        <button className="icon-button ghost grid-issue" data-tone={issues.some((issue) => issue.tone === 'error') ? 'error' : 'warn'}
          title={`${issues.map((issue) => issue.text).join('\n')}\nTıkla: ayrıntı görünümü`} aria-label={`${session.name}: ${issues.length} uyarı`}
          onClick={() => grid.onDetail(session.id, 'terminal')}>
          <Icon name="alert" size={14} />
        </button>
      )}
      <PortLinks session={session} />
      <ContextMeter usage={session.usage} live={session.lifecycle === 'live' && Boolean(session.conversation?.current)} />
      <PromptQueueButton session={session} prompts={grid.state.prompts ?? []} />
      <BranchPicker session={session} healthy={grid.healthy} />
      <button className="icon-button ghost" title={`${grid.maximized ? 'Önceki yerleşime dön' : 'Paneli büyüt'} · ${SHORTCUT_LABELS.maximize}`} aria-label={grid.maximized ? 'Önceki yerleşime dön' : 'Paneli büyüt'} onClick={() => grid.onToggleMaximize(session.id)}>
        <Icon name={grid.maximized ? 'minimize' : 'maximize'} size={14} />
      </button>
      <button className="icon-button ghost" title="Değişiklikleri incele" aria-label={`${session.name} değişiklikleri`} onClick={() => grid.onDetail(session.id, 'diff')}>
        <Icon name="diff" size={14} />
      </button>
      <button className="icon-button ghost" title="Ayrıntı görünümü: önceki Run'lar ve oturum eylemleri" aria-label="Ayrıntı görünümünde aç" onClick={() => grid.onDetail(session.id, 'terminal')}>
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
      onContextMenu={(event: React.MouseEvent<HTMLElement>) => grid?.onTabMenu(props.api.id, event)}
      data-lifecycle={session?.lifecycle ?? 'orphaned'}
      data-tone={session ? statusTone(session) : 'orphaned'}
      title={session && grid ? [
        `${session.name} · ${stateLabel(session)}`,
        sessionPlace(session, grid.state),
        session.attention && session.lifecycle === 'live' ? (session.attention.kind === 'approval' ? 'Onayınızı bekliyor' : `Yanıtınızı bekliyor: ${session.attention.message}`) : null,
        'Orta tık: kapat · Sağ tık: sekme işlemleri',
      ].filter(Boolean).join('\n') : undefined}
    />
  )
}

function EmptyGrid() {
  const grid = useContext(GridContext)
  return (
    <div className="grid-empty">
      <div className="grid-empty-mark" aria-hidden="true">
        <Icon name="terminal" size={24} />
      </div>
      <strong>Açık sekme yok</strong>
      <span>
        Yeni bir sekme açın veya kenar çubuğundan bir oturuma tıklayın. Sekmeyi bir panelin kenarına sürüklerseniz
        ekran bölünür; kenar çubuğunda bir oturumu diğerinin üstüne bırakmak ikisini yan yana açar.
      </span>
      <div className="grid-empty-actions">
        {grid && <button className="primary" onClick={grid.onNewTab}><Icon name="plus" size={14} /> Yeni sekme</button>}
        {grid && grid.liveOutside > 0 && (
          <button className="ghost-button" onClick={grid.onAddLive}><Icon name="grid" size={14} /> Çalışan {grid.liveOutside} oturumu yan yana aç</button>
        )}
      </div>
      <span className="grid-empty-keys"><kbd>{SHORTCUT_LABELS.newTab}</kbd> yeni sekme · <kbd>{SHORTCUT_LABELS.closeTab}</kbd> sekmeyi kapat · <kbd>Ctrl+PgUp/PgDn</kbd> sekmeler arası · <kbd>Ctrl</kbd> basılı sürükle: aynı programdan kopya</span>
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
  /** Başka görünümden eklenmek istenen oturumlar; alan hazır olunca işlenir. focus klavyeyle gelindiğini söyler. */
  pendingAdd: { items: GridAdd[]; focus: boolean } | null
  onPendingHandled: () => void
  /** tabActions verilirse menünün başına sekme işlemleri eklenir. */
  onSessionMenu: (id: string, event: React.MouseEvent<HTMLElement>, tabActions?: MenuAction[]) => void
  onDetail: (sessionId: string, tab: 'terminal' | 'diff') => void
  /** Biten programı sürdürür veya yeniden açar. */
  onAction: (session: SessionView, action: SessionWorkAction) => void
  /** Açık sekmelerin hepsi. */
  onPanelsChange: (sessionIds: string[]) => void
  /** Her grubun öndeki sekmesi: kullanıcının o an gördükleri. */
  onVisibleChange: (sessionIds: string[]) => void
  /** Araç çubuğunun solu: yeni sekme ve çalışma alanı seçici. */
  toolbar: ReactNode
  /** Açık sekme olmayan canlı oturumları yan yana açar. */
  onAddLive: () => void
  onNewTab: () => void
}

/**
 * Geri açılabilecek son kapatılan sekmeler, çalışma alanı başına; en yenisi
 * sonda. Alan kapanıp açılsa da bu açılış boyunca tutulur.
 */
const CLOSED_LIMIT = 20
const closedTabs = new Map<string, string[]>()

export function TerminalGrid({ gridId, onRefresh, state, healthy, pendingAdd, onPendingHandled, onDetail, onAction, onSessionMenu, onPanelsChange, onVisibleChange, toolbar, onAddLive, onNewTab }: Props) {
  const [api, setApi] = useState<DockviewApi | null>(null)
  const [panelIds, setPanelIds] = useState<string[]>([])
  const [focusRequest, setFocusRequest] = useState<{ sessionId: string; sequence: number; origin: HTMLElement } | null>(null)
  const focusSequence = useRef(0)
  const closed = useRef<string[]>(closedTabs.get(gridId) ?? [])

  const [layoutPanel, setLayoutPanel] = useState<string | null>(null)
  const [maximized, setMaximized] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const latest = useRef({ sessions: state.sessions, onPanelsChange, onVisibleChange })
  latest.current = { sessions: state.sessions, onPanelsChange, onVisibleChange }

  const onReady = ({ api: ready }: DockviewReadyEvent) => {
    const saved = loadGridLayout(gridId)
    if (saved) {
      try {
        ready.fromJSON(saved)
      } catch {
        // Okunamayan yerleşim oturumları etkilemez; alan boş başlar.
        ready.clear()
        clearGridLayout(gridId)
      }
    }
    let previous = new Set<string>()
    const publish = () => {
      const current = ready.panels.map((panel) => panel.id)
      // Taşıma paneli korur; yerleşimden düşen sekme kapatılmış sayılır.
      const closedNow = [...previous].filter((id) => !current.includes(id))
      if (closedNow.length > 0) {
        closed.current = [...closed.current.filter((id) => !closedNow.includes(id)), ...closedNow].slice(-CLOSED_LIMIT)
        closedTabs.set(gridId, closed.current)
      }
      previous = new Set(current)
      saveGridLayout(ready.toJSON(), gridId)
      setPanelIds(ready.panels.map((panel) => panel.id))
      latest.current.onPanelsChange(ready.panels.map((panel) => panel.id))
      latest.current.onVisibleChange(ready.groups.flatMap((group) => (group.activePanel ? [group.activePanel.id] : [])))
    }
    ready.onDidLayoutChange(publish)
    ready.onDidActivePanelChange(publish)
    ready.onDidMaximizedGroupChange(() => setMaximized(ready.hasMaximizedGroup()))
    ready.onUnhandledDragOver((event) => {
      const native = event.nativeEvent
      if (native instanceof DragEvent && native.dataTransfer?.types.includes(SESSION_DRAG_TYPE)) event.accept()
    })
    publish()
    setApi(ready)
  }

  const onDidDrop = (event: DockviewDidDropEvent) => {
    // Alan içindeki sekme taşımalarını dockview kendisi yapar; yalnız dışarıdan gelen oturum eklenir.
    if (event.getData() || !(event.nativeEvent instanceof DragEvent)) return
    const id = event.nativeEvent.dataTransfer?.getData(SESSION_DRAG_TYPE)
    const session = latest.current.sessions.find((s) => s.id === id)
    if (!session) return
    // Ctrl basılı bırakma aynı programdan yeni bir terminal açar; özgün oturum yerinde kalır.
    if (event.nativeEvent.ctrlKey) void duplicateInto(session, { group: event.group, position: event.position })
    else setNotice(addSession(event.api, session, { drop: { group: event.group, position: event.position } }))
  }

  // Alan içindeki sekme Ctrl ile sürüklenirse taşınmaz; bırakılan yere kopyası açılır.
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
      setNotice(`Çalışma alanında en çok ${MAX_GRID_PANELS} sekme açık tutulur; önce bir sekmeyi kapatın.`)
      return
    }
    setNotice(null)
    try {
      const created = await client.createSession({ projectId: session.projectId, name: '', command: duplicateCommand(session), isolation: 'shared', workId: session.workId ?? null })
      await onRefresh()
      // Kopya özgün terminalin arkasına sekme olarak gizlenmesin; ortaya bırakılınca grup bölünür.
      const position: Position = drop.position !== 'center' ? drop.position : drop.group && drop.group.width < drop.group.height ? 'bottom' : 'right'
      setNotice(addSession(api, created, { drop: { ...drop, position } }))
    } catch (e) {
      setNotice(`Kopya açılamadı: ${(e as Error).message}`)
    }
  }

  const focusPanel = (sessionId: string) => {
    if (document.activeElement instanceof HTMLElement) setFocusRequest({ sessionId, sequence: ++focusSequence.current, origin: document.activeElement })
  }

  useEffect(() => {
    if (!api || !pendingAdd || !healthy) return
    let problem: string | null = null
    for (const item of pendingAdd.items) {
      const session = state.sessions.find((s) => s.id === item.id)
      problem = (session ? addSession(api, session, item) : 'Açılmak istenen oturum artık yok.') ?? problem
    }
    setNotice(problem)
    // Kısayolla veya yeni sekmeyle gelinen panel yazmaya hazır olur; tıklamayla eklenen panel odağı çalmaz.
    const target = pendingAdd.items.filter((item) => item.place !== 'background').at(-1)?.id
    if (target && pendingAdd.focus && api.getPanel(target)) focusPanel(target)
    onPendingHandled()
  }, [api, pendingAdd, healthy])

  const toggleMaximize = (sessionId?: string) => {
    if (!api) return
    if (api.hasMaximizedGroup()) { api.exitMaximizedGroup(); return }
    const panel = sessionId ? api.getPanel(sessionId) : api.activePanel
    // Tek grup zaten tüm alanı kaplar; büyütülecek bir şey yoktur.
    if (panel && api.groups.length > 1) api.maximizeGroup(panel)
  }

  /**
   * Sekmeler arasında dolaşır: etkin grupta birden çok sekme varsa onların
   * arasında, yoksa gruplar arasında. Öne gelen terminal odak alır.
   */
  const cycle = (delta: 1 | -1) => {
    if (!api) return
    const group = api.activeGroup ?? api.groups[0]
    if (!group) return
    let next: string | undefined
    if (group.panels.length > 1) {
      const index = group.panels.findIndex((panel) => panel.id === group.activePanel?.id)
      next = group.panels[(index + delta + group.panels.length) % group.panels.length]?.id
    } else {
      const groups = api.groups
      const index = groups.indexOf(group)
      next = groups[(index + delta + groups.length) % groups.length]?.activePanel?.id
    }
    const panel = next ? api.getPanel(next) : undefined
    if (!panel) return
    panel.api.setActive()
    focusPanel(panel.id)
  }

  /** Etkin sekmeyi grubunda bir sola veya sağa taşır. */
  const move = (delta: 1 | -1) => {
    const panel = api?.activePanel
    if (!panel) return
    const group = panel.group
    const index = group.panels.indexOf(panel)
    const next = index + delta
    if (next < 0 || next >= group.panels.length) return
    panel.api.moveTo({ group, position: 'center', index: next })
    focusPanel(panel.id)
  }

  /** Hâlâ kaydı olan en son kapatılan sekmeyi geri açar. */
  const reopen = () => {
    if (!api) return
    const known = new Set(latest.current.sessions.map((s) => s.id))
    let id: string | undefined
    while ((id = closed.current.pop()) && (!known.has(id) || api.getPanel(id))) { /* silinmiş veya zaten açık */ }
    const session = id ? latest.current.sessions.find((s) => s.id === id) : undefined
    if (!session) return
    setNotice(addSession(api, session, { place: 'tab' }))
    focusPanel(session.id)
  }
  const reopenable = () => {
    const known = new Set(state.sessions.map((s) => s.id))
    return closed.current.some((id) => known.has(id) && !api?.getPanel(id))
  }

  /**
   * Sekmenin sağ tık menüsü: kapatma ve yerleşim işlemleri, ardından oturum
   * işlemleri. Kapatmak oturumu durdurmaz.
   */
  const tabMenu = (sessionId: string, event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const panel = api?.getPanel(sessionId)
    if (!api || !panel || !state.sessions.some((s) => s.id === sessionId)) return
    const group = panel.group
    const siblings = group.panels
    const index = siblings.indexOf(panel)
    const closeAll = (panels: typeof siblings) => { for (const p of [...panels]) p.api.close() }
    const split = (position: 'right' | 'bottom') => { panel.api.moveTo({ group, position }); focusPanel(panel.id) }
    const everywhere = api.panels.filter((p) => p !== panel)
    const actions: MenuAction[] = [
      { label: 'Sekmeyi kapat', icon: 'close', hint: SHORTCUT_LABELS.closeTab, description: 'Oturum çalışmaya devam eder. Orta tık da kapatır.', run: () => panel.api.close() },
      { label: 'Diğer sekmeleri kapat', icon: 'close', disabled: siblings.length < 2, run: () => closeAll(siblings.filter((p) => p !== panel)) },
      { label: 'Sağdakileri kapat', icon: 'close', disabled: index >= siblings.length - 1, run: () => closeAll(siblings.slice(index + 1)) },
      { label: 'Soldakileri kapat', icon: 'close', disabled: index <= 0, run: () => closeAll(siblings.slice(0, index)) },
      { label: api.groups.length > 1 ? 'Bu gruptakileri kapat' : 'Tümünü kapat', icon: 'close', run: () => closeAll(siblings) },
      ...(api.groups.length > 1 ? [{ label: 'Bu sekme dışında her şeyi kapat', icon: 'close' as const, description: 'Bütün gruplardaki diğer sekmeler kapanır.', disabled: everywhere.length === 0, run: () => closeAll(everywhere) }] : []),
      { label: 'Kapatılan sekmeyi geri aç', icon: 'refresh', disabled: !reopenable(), run: reopen },
      { label: 'Sağa böl', icon: 'layout', divider: true, disabled: siblings.length < 2, description: 'Sekmeyi yeni bir bölmeye taşır.', run: () => split('right') },
      { label: 'Aşağı böl', icon: 'layout', disabled: siblings.length < 2, run: () => split('bottom') },
      { label: maximized ? 'Önceki yerleşime dön' : 'Grubu büyüt', icon: maximized ? 'minimize' : 'maximize', hint: SHORTCUT_LABELS.maximize, disabled: !maximized && api.groups.length < 2, run: () => toggleMaximize(sessionId) },
      { label: 'Sola taşı', icon: 'back', hint: 'Ctrl+Shift+PgUp', disabled: index <= 0, run: () => { panel.api.setActive(); move(-1) } },
      { label: 'Sağa taşı', icon: 'chevron', hint: 'Ctrl+Shift+PgDn', disabled: index >= siblings.length - 1, run: () => { panel.api.setActive(); move(1) } },
    ]
    onSessionMenu(sessionId, event, actions)
  }

  const handlers = useRef({ toggleMaximize, cycle, move, reopen, close: () => api?.activePanel?.api.close() })
  handlers.current = { toggleMaximize, cycle, move, reopen, close: () => api?.activePanel?.api.close() }
  useEffect(() => {
    const onMaximize = () => handlers.current.toggleMaximize()
    const onCycle = (event: Event) => handlers.current.cycle((event as CustomEvent<1 | -1>).detail)
    const onClose = () => handlers.current.close()
    const onMove = (event: Event) => handlers.current.move((event as CustomEvent<1 | -1>).detail)
    const onReopen = () => handlers.current.reopen()
    const listeners: [string, (event: Event) => void][] = [
      ['agentdeck:grid-maximize', onMaximize], ['agentdeck:tab-cycle', onCycle], ['agentdeck:tab-close', onClose],
      ['agentdeck:tab-move', onMove], ['agentdeck:tab-reopen', onReopen],
    ]
    for (const [name, fn] of listeners) window.addEventListener(name, fn)
    return () => { for (const [name, fn] of listeners) window.removeEventListener(name, fn) }
  }, [])

  // Restored Dockview tabs keep their saved title unless explicitly refreshed.
  useEffect(() => {
    if (!api) return
    for (const session of state.sessions) {
      const panel = api.getPanel(session.id)
      if (panel && panel.title !== session.name) panel.api.setTitle(session.name)
    }
  }, [api, state.sessions])

  // Silinen oturumun sekmesi kapanır; kaydı olmayan terminal gösterilmez.
  useEffect(() => {
    if (!api || !healthy) return
    const known = new Set(state.sessions.map((s) => s.id))
    for (const panel of [...api.panels]) if (!known.has(panel.id)) panel.api.close()
  }, [api, healthy, state.sessions])

  return (
    <GridContext.Provider value={{ state, healthy, onDetail, onAction, onSessionMenu, onTabMenu: tabMenu, onLayout: setLayoutPanel, focusRequest, onFocusHandled: () => setFocusRequest(null), maximized, onToggleMaximize: toggleMaximize, onAddLive, onNewTab, liveOutside: state.sessions.filter((s) => s.archivedAt === null && s.lifecycle === 'live' && !panelIds.includes(s.id)).length }}>
      <section className="terminal-grid">
        <div className="grid-toolbar">{toolbar}</div>

        {layoutPanel && api && <GridLayoutDialog projects={state.projects} healthy={healthy} onRefresh={onRefresh} api={api} panelId={layoutPanel} sessions={state.sessions} works={state.works ?? []}
          onClose={() => setLayoutPanel(null)} />}
        {notice && (
          <div className="error" role="alert">
            {notice}
          </div>
        )}
        {/* Sekme şeridinin boş yerine çift tık yeni sekme açar. */}
        <div className="grid-stage" onDoubleClick={(event) => { if ((event.target as Element).closest('.dv-void-container')) onNewTab() }}>
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
