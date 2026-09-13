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
import { commandLabel, type Isolation, type Project, type StateResponse } from '../shared/types'

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
  const [orphans, setOrphans] = useState<api.OrphanScanResult | null>(null)
  const [stateHealthy, setStateHealthy] = useState(false)
  const previewIds = useRef<string[]>([])
  const setPreviewIds = useCallback((ids: string[]) => {
    previewIds.current = ids
  }, [])
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [launchOpen, setLaunchOpen] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = () =>
    api
      .getState(previewIds.current)
      .then((next) => {
        setState(next)
        setStateHealthy(true)
        setConnectionError(null)
      })
      .catch((e) => {
        setStateHealthy(false)
        setConnectionError(e.message)
      })

  // Yetim keşfi salt okunurdur ve poll edilmez: açılışta ve istenince okunur.
  const refreshOrphans = () =>
    api
      .getOrphanWorktrees()
      .then(setOrphans)
      .catch(() => setOrphans(null))

  useEffect(() => {
    refresh()
    refreshOrphans()
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refresh()
      if (!disposed) timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 2000)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [])

  const active = state.sessions.find((s) => s.id === activeId) ?? null

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
        : api.archiveSession(active.id, active.runId, active.lifecycle === 'live'),
    )
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
        setActiveId(null)
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

  return (
    <div className="app">
      <Sidebar
        state={state}
        healthy={stateHealthy}
        onHome={() => {
          setActiveId(null)
          setPendingDelete(null)
          setView('sessions')
        }}
        view={view}
        gridCount={gridIds.length}
        onGrid={() => {
          setActiveId(null)
          setPendingDelete(null)
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
        orphans={orphans}
        onRefreshOrphans={refreshOrphans}
      />

      <main className="main">
        {connectionError && (
          <div className="error" role="alert">
            {connectionError}
          </div>
        )}
        {active ? (
          <>
            <header className="topbar">
              <button
                title={view === 'grid' ? 'Terminal grid’e dön' : 'Tüm oturumlara dön'}
                onClick={() => {
                  setActiveId(null)
                  setPendingDelete(null)
                }}
              >
                {view === 'grid' ? '← Grid' : '← Oturumlar'}
              </button>
              <div className="topbar-info">
                <div className="title">{active.name}</div>
                <div className="subtitle" title={active.cwd}>
                  {active.branch ?? 'ortak çalışma kopyası'}
                  {active.archivedAt !== null && ' · arşivde'}
                </div>
              </div>

              <div className="tabs">
                <button className={tab === 'terminal' ? 'on' : ''} onClick={() => setTab('terminal')}>
                  terminal
                </button>
                <button className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}>
                  diff
                </button>
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
                    {active.lifecycle === 'live' && (
                      <button onClick={() => run(api.stopSession(active.id, active.runId))}>durdur</button>
                    )}
                    <button
                      title={`Son komutu aynı çalışma kopyasında aynen yeniden çalıştırır: ${commandLabel(
                        active.lastLaunch?.mode === 'command' ? active.lastLaunch.command : active.command,
                      )}`}
                      onClick={() => run(api.restartSession(active.id, active.runId))}
                    >
                      {active.lifecycle === 'live' ? 'durdur ve yeniden çalıştır' : 'yeniden çalıştır'}
                    </button>
                    <button
                      title="Bu çalışma kopyasında başka bir komut veya CLI seçicisi çalıştır"
                      onClick={() => {
                        setError(null)
                        setLaunchOpen(true)
                      }}
                    >
                      komut çalıştır…
                    </button>
                    <button onClick={toggleArchive}>
                      {active.archivedAt !== null
                        ? 'arşivden çıkar'
                        : active.lifecycle === 'live'
                          ? 'durdur ve arşivle'
                          : 'arşivle'}
                    </button>
                    <button onClick={() => addToGrid(active.id)}>grid'e ekle</button>
                    <button onClick={askDelete}>sil</button>
                  </>
                )}
              </div>
            </header>

            {error && <div className="error">{error}</div>}
            {state.serviceError && <div className="error">{state.serviceError}</div>}

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
        ) : (
          <>
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
            {view === 'grid' ? (
              <TerminalGrid
                state={state}
                healthy={stateHealthy}
                pendingAdd={pendingGridAdd}
                onPendingHandled={() => setPendingGridAdd(null)}
                onOpen={openSession}
                onPanelsChange={setGridIds}
              />
            ) : (
              <Workspace
                onPreviewIds={setPreviewIds}
                state={state}
                healthy={stateHealthy}
                onSelect={openSession}
                onNewSession={setDialogProject}
                onAddProject={() => setAddingProject(true)}
                onAddToGrid={addToGrid}
              />
            )}
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
