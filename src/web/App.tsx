import { useEffect, useState } from 'react'
import * as api from './api'
import { Sidebar } from './components/Sidebar'
import { TerminalPane } from './components/TerminalPane'
import { DiffView } from './components/DiffView'
import { NewSessionDialog } from './components/NewSessionDialog'
import type { Isolation, Project, StateResponse } from '../shared/types'

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
  const [dialogProject, setDialogProject] = useState<Project | null>(null)
  const [pendingDelete, setPendingDelete] = useState<api.DeletePreview | null>(null)
  const [orphans, setOrphans] = useState<api.OrphanScanResult | null>(null)
  const [stateHealthy, setStateHealthy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => api.getState().then((next) => { setState(next); setStateHealthy(true) }).catch((e) => { setStateHealthy(false); setError(e.message) })

  // Yetim keşfi salt okunurdur ve poll edilmez: açılışta ve istenince okunur.
  const refreshOrphans = () => api.getOrphanWorktrees().then(setOrphans).catch(() => setOrphans(null))

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
    return () => { disposed = true; clearTimeout(timer) }
  }, [])

  const active = state.sessions.find((s) => s.id === activeId) ?? null

  const run = (promise: Promise<unknown>) => {
    setError(null)
    promise.then(refresh).catch((e) => setError(e.message))
  }

  const createSession = (input: { name: string; command: string | null; isolation: Isolation }) => {
    if (!dialogProject) return
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
          api.previewSessionDelete(sessionId).then(setPendingDelete).catch(() => setPendingDelete(null))
        }
        return refresh()
      })
  }

  return (
    <div className="app">
      <Sidebar
        state={state}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id)
          setPendingDelete(null)
        }}
        onNewSession={setDialogProject}
        onAddProject={(path) => run(api.addProject(path))}
        onDeleteProject={(id) => run(api.deleteProject(id))}
        orphans={orphans}
        onRefreshOrphans={refreshOrphans}
      />

      <main className="main">
        {active ? (
          <>
            <header className="topbar">
              <div className="topbar-info">
                <div className="title">{active.name}</div>
                <div className="subtitle" title={active.cwd}>
                  {active.branch ?? 'ortak çalışma kopyası'}
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
                      {pendingDelete.changedEntries > 0
                        ? `${pendingDelete.changedEntries} değişiklikle birlikte klasörü sil?`
                        : 'klasörü sil?'}
                    </span>
                    <button onClick={confirmDelete}>sil (branch kalır)</button>
                    <button onClick={() => setPendingDelete(null)}>vazgeç</button>
                  </>
                ) : (
                  <>
                    {active.lifecycle === 'live' && (
                      <button onClick={() => run(api.stopSession(active.id, active.runId))}>durdur</button>
                    )}
                    <button onClick={() => run(api.restartSession(active.id, active.runId))}>
                      {active.lifecycle === 'live' ? 'durdur ve yeniden çalıştır' : 'yeniden çalıştır'}
                    </button>
                    <button onClick={askDelete}>sil</button>
                  </>
                )}
              </div>
            </header>

            {error && <div className="error">{error}</div>}
            {state.serviceError && <div className="error">{state.serviceError}</div>}

            {state.terminals?.[active.id]?.checkpoint.lastError && (
              <div className="error">Terminal geçmişi kaydedilemedi: {state.terminals[active.id].checkpoint.lastError}</div>
            )}
            {state.terminals?.[active.id]?.checkpoint.lastSuccessAt && (
              <div className="muted" style={{ padding: '4px 12px', fontSize: 12 }}>
                Son terminal kaydı: {new Date(state.terminals[active.id].checkpoint.lastSuccessAt!).toLocaleTimeString()}
              </div>
            )}
            <div className="body">
              {tab === 'terminal' && (
                <div className="terminals">
                  <TerminalPane key={`${state.daemonId}:${active.id}:${active.runId}`} session={active} daemonId={state.daemonId} stateHealthy={stateHealthy} />
                </div>
              )}
              {tab === 'diff' && <DiffView sessionId={active.id} />}
            </div>
          </>
        ) : (
          <div className="empty">
            {error && <div className="error">{error}</div>}
            <p>
              Soldan bir proje ekle, sonra <strong>+</strong> ile oturum başlat.
            </p>
          </div>
        )}
      </main>

      {dialogProject && (
        <NewSessionDialog
          project={dialogProject}
          onCancel={() => setDialogProject(null)}
          onCreate={createSession}
        />
      )}
    </div>
  )
}
