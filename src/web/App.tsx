import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import { AddProjectDialog } from './components/AddProjectDialog'
import { Workspace } from './components/Workspace'
import { Sidebar } from './components/Sidebar'
import { TerminalPane } from './components/TerminalPane'
import { DiffView } from './components/DiffView'
import { NewSessionDialog } from './components/NewSessionDialog'
import { LaunchDialog } from './components/LaunchDialog'
import { TerminalGrid } from './components/TerminalGrid'
import { savedGridSessionIds } from './gridLayout'
import { createStatePoller } from '../shared/statePoll'
import {
  commandLabel,
  formatAge,
  hasRunningProcesses,
  lastCommand,
  sessionAgeMs,
  type Isolation,
  type Project,
  type StateResponse,
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
  const [state, setState] = useState<StateResponse>(EMPTY)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [tab, setTab] = useState<'terminal' | 'diff'>('terminal')
  // Oturum seçili değilken ana alanın gösterdiği görünüm.
  const [view, setView] = useState<'sessions' | 'grid'>('sessions')
  const [gridIds, setGridIds] = useState<string[]>(savedGridSessionIds)
  const [pendingGridAdd, setPendingGridAdd] = useState<string | null>(null)
  const [addingProject, setAddingProject] = useState(false)
  const [dialogProject, setDialogProject] = useState<Project | null>(null)
  const [pendingDelete, setPendingDelete] = useState<api.DeletePreview | null>(null)
  const [projectDelete, setProjectDelete] = useState<api.ProjectDeletePreview | null>(null)
  const [orphans, setOrphans] = useState<api.OrphanScanResult | null>(null)
  const [stateHealthy, setStateHealthy] = useState(false)
  const previewIds = useRef<string[]>([])
  const pollerRef = useRef<ReturnType<typeof createStatePoller<StateResponse>> | null>(null)
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

  // Yetim keşfi salt okunurdur ve poll edilmez: açılışta ve istenince okunur.
  const refreshOrphans = () =>
    api
      .getOrphanWorktrees()
      .then(setOrphans)
      .catch(() => setOrphans(null))

  useEffect(() => {
    const poller = createStatePoller<StateResponse>({
      fetchState: () => api.getState(previewIds.current),
      schedule: (fn, ms) => window.setTimeout(fn, ms),
      cancel: (handle) => window.clearTimeout(handle as number),
      isHidden: () => document.visibilityState === 'hidden',
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
      document.removeEventListener('visibilitychange', onVis)
      window.clearInterval(tick)
    }
  }, [])

  const now = state.serverNow ? state.serverNow + (performance.now() - receivedAt.current) : Date.now()

  const active = state.sessions.find((s) => s.id === activeId) ?? null
  const activeProject = active ? (state.projects.find((p) => p.id === active.projectId) ?? null) : null
  const showTrust = Boolean(
    active && active.isolation === 'worktree' && active.lifecycle === 'live' && !trustHidden && sessionStorage.getItem(trustKey(active.id)) !== '1',
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

  const [actionHint, setActionHint] = useState<string | null>(null)
  const [copiedPath, setCopiedPath] = useState(false)
  // Düğmeler değişince eski açıklama ve kopyalama bildirimi ekranda kalmaz.
  useEffect(() => {
    setActionHint(null)
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
        document.querySelector<HTMLElement>('.sidebar .home-nav'),
        document.querySelector<HTMLElement>('.topbar-back'),
        document.querySelector<HTMLElement>('.term-host textarea, .term-host canvas, .xterm-helper-textarea'),
      ].filter((el): el is HTMLElement => el !== null)

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F6') {
        event.preventDefault()
        if (inTerminal(event.target)) {
          ;(document.querySelector<HTMLElement>('.topbar-back') ?? document.querySelector<HTMLElement>('.home-nav'))?.focus()
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
      if (document.querySelector('dialog[open]')) return
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

  // Grid'e ekleme grid'i açar. Tek görünüm kapanır; aynı Run için iki terminal açık kalmaz.
  const addToGrid = (id: string) => {
    setPendingGridAdd(id)
    setActiveId(null)
    setPendingDelete(null)
    setView('grid')
  }

  // Arşiv dosyalara dokunmaz; canlı iş yalnız açıkça görünen "durdur ve arşivle" ile kapanır.
  const toggleArchive = () => {
    if (!active) return
    run(
      active.archivedAt !== null
        ? api.unarchiveSession(active.id)
        : api.archiveSession(active.id, active.runId, hasRunningProcesses(active)),
    )
  }

  // Eylem başlamadan önce ne yapacağını tek cümleyle söyler; fareyle ve klavye odağıyla görünür.
  const describe = (text: string) => ({
    onMouseEnter: () => setActionHint(text),
    onMouseLeave: () => setActionHint(null),
    onFocus: () => setActionHint(text),
    onBlur: () => setActionHint(null),
  })

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
  const askDelete = () => {
    if (!active) return
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

  return (
    <div className="app">
      <Sidebar
        state={state}
        healthy={stateHealthy}
        onHome={() => {
          leaveToScan()
          setView('sessions')
        }}
        view={view}
        gridCount={gridIds.length}
        onGrid={() => {
          leaveToScan()
          setView('grid')
        }}
        onAddToGrid={addToGrid}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id)
          setPendingDelete(null)
        }}
        onNewSession={setDialogProject}
        onAddProject={() => setAddingProject(true)}
        onDeleteProject={(id) => run(api.deleteProject(id))}
        projectDelete={projectDelete}
        onPreviewProjectDelete={askProjectDelete}
        onConfirmProjectDelete={confirmProjectDelete}
        onCancelProjectDelete={() => setProjectDelete(null)}
        orphans={orphans}
        onRefreshOrphans={refreshOrphans}
      />

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
            healthy={stateHealthy}
            now={now}
            previewsEnabled={!active && view === 'sessions'}
            focusId={scanFocusId}
            onFocusHandled={() => setScanFocusId(null)}
            onSelect={openSession}
            onNewSession={setDialogProject}
            onAddProject={() => setAddingProject(true)}
            onAddToGrid={addToGrid}
          />
        </div>
        {view === 'grid' && !active && (
          <TerminalGrid
            state={state}
            healthy={stateHealthy}
            pendingAdd={pendingGridAdd}
            onPendingHandled={() => setPendingGridAdd(null)}
            onOpen={openSession}
            onPanelsChange={setGridIds}
          />
        )}
        {active && (
          <>
            <header className="topbar">
              <button
                className="topbar-back"
                aria-keyshortcuts="F6 Escape"
                title={view === 'grid' ? 'Terminal grid’e dön' : 'Tüm oturumlara dön'}
                onClick={leaveToScan}
              >
                {view === 'grid' ? '← Grid' : '← Oturumlar'}
              </button>
              <div className="topbar-info">
                <div className="title">{active.name}</div>
                <div className="subtitle" title={active.cwd}>
                  {activeProject?.name ?? 'proje kaydı yok'}
                  {' · '}
                  {commandLabel(active.command)}
                  {' · '}
                  {active.branch ?? 'ortak çalışma kopyası'}
                  {active.archivedAt !== null && ' · arşivde'}
                </div>
              </div>

              <div className="tabs">
                <button className={tab === 'terminal' ? 'on' : ''} onClick={() => setTab('terminal')}>
                  Terminal
                </button>
                <button className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}>
                  Değişiklikler
                </button>
              </div>

              <div className="topbar-band">
                <span className="band-chip">
                  <span className={`dot ${active.lifecycle}`} />
                  {active.lifecycle === 'live'
                    ? active.activity === 'idle'
                      ? 'Sessiz'
                      : 'Çalışıyor'
                    : active.lifecycle === 'orphaned'
                      ? 'Bağlantı yok'
                      : active.exitCode !== null
                        ? `Çıktı · kod ${active.exitCode}`
                        : active.exitSignal !== null
                          ? `Çıktı · sinyal ${active.exitSignal}`
                          : 'Çıktı'}
                </span>
                <span className="band-chip muted">{formatAge(sessionAgeMs(active, now))}</span>
                <span className="band-chip muted">{active.isolation === 'worktree' ? 'İzole' : 'Ortak'}</span>
                {active.degraded && (
                  <span className="band-chip warn" title={active.degraded}>
                    {active.degraded}
                  </span>
                )}
                {activeProject?.degraded && (
                  <span className="band-chip warn" title={activeProject.degraded}>
                    {activeProject.degraded}
                  </span>
                )}
              </div>

              <div className="topbar-actions">
                {pendingDelete ? (
                  <>
                    <span className="muted" title={pendingDelete.cwd}>
                      {pendingDelete.isolation === 'shared'
                        ? 'Oturum kaydı kaldırılsın mı? Klasör ve dosyalar korunur.'
                        : deleteQuestion(pendingDelete)}
                    </span>
                    <button onClick={confirmDelete}>
                      {pendingDelete.isolation === 'shared' ? 'Kaydı kaldır' : 'sil (branch kalır)'}
                    </button>
                    <button onClick={() => setPendingDelete(null)}>vazgeç</button>
                  </>
                ) : (
                  <>
                    {hasRunningProcesses(active) && (
                      <button
                        {...describe('Süreç grubunu doğrulanmış biçimde durdurur; kayıt, dosyalar ve branch kalır.')}
                        onClick={() => run(api.stopSession(active.id, active.runId))}
                      >
                        durdur
                      </button>
                    )}
                    {/* Arşivdeki oturum görünmeden canlanmaz; önce arşivden çıkarılır. */}
                    {active.archivedAt === null && (
                      <>
                        <button
                          {...describe(
                            `Komutu bu çalışma kopyasında aynen yeniden çalıştırır: ${commandLabel(lastCommand(active))}`,
                          )}
                          onClick={() => run(api.restartSession(active.id, active.runId))}
                        >
                          {hasRunningProcesses(active) ? 'durdur ve yeniden çalıştır' : 'yeniden çalıştır'}
                        </button>
                        <button
                          {...describe(
                            'Bu çalışma kopyasında başka bir komut veya CLI seçicisi çalıştırır; başlangıç programı değişmez.',
                          )}
                          onClick={() => {
                            setError(null)
                            setLaunchOpen(true)
                          }}
                        >
                          komut çalıştır…
                        </button>
                      </>
                    )}
                    <button
                      {...describe(
                        active.archivedAt !== null
                          ? 'Kaydı aktif taramaya döndürür; Run başlatmaz, dosyalara dokunmaz.'
                          : hasRunningProcesses(active)
                            ? 'Süreç grubunu doğrulanmış biçimde durdurur, sonra kaydı aktif taramadan kaldırır; dosyalar ve branch kalır.'
                            : 'Kaydı aktif taramadan kaldırır; dosyalar, branch ve terminal görüntüleri kalır.',
                      )}
                      onClick={toggleArchive}
                    >
                      {active.archivedAt !== null
                        ? 'arşivden çıkar'
                        : hasRunningProcesses(active)
                          ? 'durdur ve arşivle'
                          : 'arşivle'}
                    </button>
                    <button
                      className="btn-quiet"
                      {...describe(`Çalışma dizininin yolunu kopyalar: ${active.cwd}`)}
                      onClick={copyPath}
                    >
                      {copiedPath ? 'kopyalandı' : 'yolu kopyala'}
                    </button>
                    <button
                      className="btn-quiet"
                      {...describe('Terminali grid görünümünde açar.')}
                      onClick={() => addToGrid(active.id)}
                    >
                      grid'e ekle
                    </button>
                    <button
                      className="btn-quiet"
                      {...describe('Neyin silineceğini önce gösterir; branch her durumda kalır.')}
                      onClick={askDelete}
                    >
                      sil
                    </button>
                  </>
                )}
              </div>
            </header>
            {showTrust && (
              <div className="trust-note" role="note">
                <span>{TRUST_NOTE}</span>
                <button
                  onClick={() => {
                    sessionStorage.setItem(trustKey(active.id), '1')
                    setTrustHidden(true)
                  }}
                >
                  gizle
                </button>
              </div>
            )}

            {pendingDelete && (
              <div className="pad muted delete-target">
                {pendingDelete.isolation === 'shared' ? 'Korunacak klasör: ' : 'Silinecek klasör: '}
                <code>{pendingDelete.cwd}</code>
              </div>
            )}

            {state.terminals?.[active.id]?.checkpoint.lastError && (
              <div className="error">
                Terminal geçmişi kaydedilemedi: {state.terminals[active.id].checkpoint.lastError}
              </div>
            )}
            {state.terminals?.[active.id]?.checkpoint.lastSuccessAt && (
              <div className="muted" style={{ padding: '4px 12px', fontSize: 12 }}>
                Son terminal kaydı:{' '}
                {new Date(state.terminals[active.id].checkpoint.lastSuccessAt!).toLocaleTimeString()}
              </div>
            )}
            <div className="body">
              {actionHint && (
                <div className="action-hint" role="status">
                  {actionHint}
                </div>
              )}
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
                          Güncel Run
                        </button>
                        {runs.previous.map((previous) => (
                          <button
                            key={previous.runId}
                            className={inspectRunId === previous.runId ? 'on' : ''}
                            aria-pressed={inspectRunId === previous.runId}
                            onClick={() => setInspectRunId(previous.runId)}
                          >
                            Önceki Run · {new Date(previous.updatedAt).toLocaleTimeString()}
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
