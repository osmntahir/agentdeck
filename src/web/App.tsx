import { useEffect, useState } from 'react'
import * as api from './api'
import { Sidebar } from './components/Sidebar'
import { TerminalPane } from './components/TerminalPane'
import { DiffView } from './components/DiffView'
import { NewSessionDialog } from './components/NewSessionDialog'
import type { AgentKind, AppState, Isolation, Project } from '../shared/types'

export function App() {
  const [state, setState] = useState<AppState>({ projects: [], sessions: [] })
  const [activeId, setActiveId] = useState<string | null>(null)
  const [tab, setTab] = useState<'terminal' | 'diff'>('terminal')
  const [epochs, setEpochs] = useState<Record<string, number>>({})
  const [dialogProject, setDialogProject] = useState<Project | null>(null)
  const [pendingDelete, setPendingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => api.getState().then(setState).catch((e) => setError(e.message))

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [])

  const active = state.sessions.find((s) => s.id === activeId) ?? null

  const run = (promise: Promise<unknown>) => {
    setError(null)
    promise.then(refresh).catch((e) => setError(e.message))
  }

  const createSession = (input: { name: string; agent: AgentKind; isolation: Isolation }) => {
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

  const restart = () => {
    if (!active) return
    const id = active.id
    setError(null)
    // Epoch'u önceden artırırsak terminal, yeni PTY daha doğmadan bağlanmaya
    // çalışır; sunucu "canlı değil" deyip kapatır ve pane kalıcı olarak ölür.
    // Önce API bitsin, sonra remount.
    api
      .restartSession(id)
      .then(() => {
        setEpochs((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))
        return refresh()
      })
      .catch((e) => setError(e.message))
  }

  const remove = (deleteBranch: boolean) => {
    if (!active) return
    setPendingDelete(false)
    setActiveId(null)
    run(api.deleteSession(active.id, deleteBranch))
  }

  return (
    <div className="app">
      <Sidebar
        state={state}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id)
          setPendingDelete(false)
        }}
        onNewSession={setDialogProject}
        onAddProject={(path) => run(api.addProject(path))}
        onDeleteProject={(id) => run(api.deleteProject(id))}
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
                    <span className="muted">sil:</span>
                    <button onClick={() => remove(false)}>oturum</button>
                    <button onClick={() => remove(true)}>oturum + branch</button>
                    <button onClick={() => setPendingDelete(false)}>vazgeç</button>
                  </>
                ) : (
                  <>
                    <button onClick={restart}>yeniden başlat</button>
                    <button onClick={() => setPendingDelete(true)}>sil</button>
                  </>
                )}
              </div>
            </header>

            {error && <div className="error">{error}</div>}

            <div className="body">
              {/* Tüm terminaller mount'ta kalır; sadece aktif olan görünür.
                  Oturumlar arası geçişte state ve scroll korunur. */}
              <div className="terminals" style={{ display: tab === 'terminal' ? 'block' : 'none' }}>
                {state.sessions.map((session) => (
                  <TerminalPane
                    key={session.id}
                    session={session}
                    active={session.id === activeId && tab === 'terminal'}
                    epoch={epochs[session.id] ?? 0}
                  />
                ))}
              </div>
              {tab === 'diff' && <DiffView sessionId={active.id} />}
            </div>
          </>
        ) : (
          <div className="empty">
            {error && <div className="error">{error}</div>}
            <p>Soldan bir proje ekle, sonra <strong>+</strong> ile oturum başlat.</p>
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
