import { useEffect, useState } from 'react'
import type { ProjectView, SessionView, StateResponse } from '../../shared/types'
import { commandLabel, formatAge, sessionAgeMs } from '../../shared/types'
import { stateLabel } from './Sidebar'
import { SESSION_DRAG_TYPE } from '../gridLayout'
import { ProtectedBranches } from './ProtectedBranches'

interface Props {
  state: StateResponse
  healthy: boolean
  /** Sunucu zamanı + istemci monotonic ilerlemesi (spec §5). */
  now: number
  /** Tarama görünür değilken önizleme istenmez; mount kaydırma için kalır. */
  previewsEnabled: boolean
  /** Silme sonrası komşu karta dön; PTY açılmaz. */
  focusId: string | null
  onFocusHandled: () => void
  onSelect: (id: string) => void
  onNewSession: (project: ProjectView) => void
  onAddProject: () => void
  onPreviewIds: (ids: string[]) => void
  onAddToGrid: (id: string) => void
}

function neighbor(ids: string[], current: string | null, delta: number): string | null {
  if (ids.length === 0) return null
  const index = current ? ids.indexOf(current) : -1
  if (index < 0) return delta >= 0 ? ids[0]! : ids[ids.length - 1]!
  return ids[(index + delta + ids.length) % ids.length]!
}

function sessionAge(session: SessionView, now: number): string {
  return formatAge(sessionAgeMs(session, now))
}

export function Workspace({
  state,
  healthy,
  now,
  previewsEnabled,
  focusId,
  onFocusHandled,
  onSelect,
  onNewSession,
  onAddProject,
  onPreviewIds,
  onAddToGrid,
}: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [candidate, setCandidate] = useState<string | null>(null)
  // Branch okuması yalnız istenince yapılır; poll edilmez.
  const [branchesFor, setBranchesFor] = useState<string | null>(null)
  const live = state.sessions.filter((s) => s.lifecycle === 'live').length
  const archivedCount = state.sessions.filter((s) => s.archivedAt !== null).length
  // Arşivlenen oturum aktif taramada görünmez; yalnız Arşiv filtresiyle bulunur.
  const sessions = state.sessions.filter(
    (s) =>
      (filter === 'archived'
        ? s.archivedAt !== null
        : s.archivedAt === null && (filter === 'all' || s.lifecycle === filter)) &&
      `${s.name} ${commandLabel(s.command)} ${state.projects.find((p) => p.id === s.projectId)?.name ?? ''}`
        .toLocaleLowerCase('tr')
        .includes(query.toLocaleLowerCase('tr')),
  )
  const sessionIds = state.projects.flatMap((project) =>
    sessions.filter((session) => session.projectId === project.id).map((session) => session.id),
  )

  useEffect(() => {
    if (candidate && !sessionIds.includes(candidate)) setCandidate(sessionIds[0] ?? null)
  }, [sessionIds.join(','), candidate])

  useEffect(() => {
    if (!focusId) return
    const id = sessionIds.includes(focusId) ? focusId : (sessionIds[0] ?? null)
    if (id) {
      setCandidate(id)
      document.getElementById(`session-card-${id}`)?.focus()
    }
    onFocusHandled()
  }, [focusId, onFocusHandled])

  // The daemon bounds preview work to 24 cards; searching brings matching cards into that window.
  const previewKey = sessions
    .slice(0, 24)
    .map((session) => session.id)
    .join(',')
  useEffect(() => {
    onPreviewIds(previewsEnabled && previewKey ? previewKey.split(',') : [])
    return () => onPreviewIds([])
  }, [previewKey, onPreviewIds, previewsEnabled])

  const moveCandidate = (delta: number) => {
    const next = neighbor(sessionIds, candidate, delta)
    if (!next) return
    setCandidate(next)
    document.getElementById(`session-card-${next}`)?.focus()
  }

  return (
    <>
      <header className="workspace-header">
        <div>
          <span className="breadcrumb">Çalışma alanı</span>
          <h1>Oturumlar</h1>
        </div>
        <button className="primary" onClick={onAddProject}>
          + Proje ekle
        </button>
      </header>
      <div className="workspace-scroll">
        <div className="workspace-intro">
          <div>
            <h2>Birçok iş. Tek çalışma alanı.</h2>
            <p>Projelerini bir araya getir, ajanlarını paralel çalıştır.</p>
          </div>
          <span className="live-count">
            <span className={`dot ${healthy ? 'live' : 'orphaned'}`} />
            {healthy ? `${live} canlı oturum` : 'Bağlantı kuruluyor'}
          </span>
        </div>
        <div className="workspace-tools">
          <div className="filter-tabs">
            {[
              ['all', 'Tüm oturumlar'],
              ['live', 'Canlı'],
              ['exited', 'Sonlanan'],
              ['orphaned', 'Bağlantısız'],
              ['archived', 'Arşiv'],
            ].map(([value, label]) => (
              <button
                aria-pressed={filter === value}
                key={value}
                className={filter === value ? 'on' : ''}
                onClick={() => setFilter(value)}
              >
                {label}
                {value === 'all' && <span>{state.sessions.length - archivedCount}</span>}
                {value === 'archived' && archivedCount > 0 && <span>{archivedCount}</span>}
              </button>
            ))}
          </div>
          <input
            aria-label="Oturum ara"
            placeholder="Proje veya oturum ara…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {!state.projects.length ? (
          <section className="welcome">
            <div className="welcome-mark" aria-hidden="true">
              &gt;_
            </div>
            <span className="eyebrow">İLK ÇALIŞMA ALANIN</span>
            <h2>İyi işler bir projeyle başlar.</h2>
            <p>
              Git projenizi veya yerel klasörünüzü ekleyin. Claude Code, Codex, Gemini veya terminal ile
              kaldığınız yerden devam edin.
            </p>
            <button className="primary" onClick={onAddProject}>
              + İlk projeni ekle
            </button>
            <div className="welcome-steps">
              <div>
                <b>01</b>
                <strong>Projeni bağla</strong>
                <span>Bilgisayarındaki proje klasörünü seç.</span>
              </div>
              <div>
                <b>02</b>
                <strong>Bir oturum başlat</strong>
                <span>Programını ve çalışma biçimini belirle.</span>
              </div>
              <div>
                <b>03</b>
                <strong>Paralel ilerle</strong>
                <span>Terminal ve değişiklikleri tek yerden izle.</span>
              </div>
            </div>
          </section>
        ) : (
          <>
            {state.projects.map((project) => {
              const owned = sessions.filter((s) => s.projectId === project.id)
              if (!owned.length && (query || filter !== 'all')) return null
              return (
                <section className="project-section" key={project.id}>
                  <header>
                    <div className="project-monogram">{project.name.slice(0, 2).toUpperCase()}</div>
                    <div>
                      <h3>
                        {project.name} <span>{owned.length}</span>{' '}
                        {project.kind === 'folder' && <span>Yerel klasör</span>}
                      </h3>
                      <p title={project.path}>{project.path}</p>
                      {project.degraded && (
                        <p className="degraded-line" title={project.degraded}>
                          {project.degraded}
                        </p>
                      )}
                    </div>
                    <button
                      aria-expanded={branchesFor === project.id}
                      onClick={() => setBranchesFor(branchesFor === project.id ? null : project.id)}
                    >
                      Branch'ler
                    </button>
                    <button onClick={() => onNewSession(project)}>+ Yeni oturum</button>
                  </header>
                  {branchesFor === project.id && <ProtectedBranches project={project} sessions={state.sessions} />}
                  <div className="session-grid" role="list">
                    {owned.map((session) => {
                      const preview = state.previews?.[session.id]
                      const selected = candidate === session.id
                      return (
                        // Kart içinde ayrı "Grid'e ekle" düğmesi olduğu için kart kendisi düğme değildir.
                        <div
                          className={`session-card${selected ? ' candidate' : ''}${session.degraded ? ' is-degraded' : ''}`}
                          key={session.id}
                          id={`session-card-${session.id}`}
                          role="listitem"
                          tabIndex={selected || (candidate === null && session.id === sessionIds[0]) ? 0 : -1}
                          draggable
                          aria-current={selected ? 'true' : undefined}
                          onFocus={() => setCandidate(session.id)}
                          onDragStart={(e) => e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id)}
                          onClick={() => onSelect(session.id)}
                          onKeyDown={(e) => {
                            if (e.target !== e.currentTarget) return
                            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                              e.preventDefault()
                              moveCandidate(1)
                              return
                            }
                            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                              e.preventDefault()
                              moveCandidate(-1)
                              return
                            }
                            if (e.key === 'Home') {
                              e.preventDefault()
                              const first = sessionIds[0]
                              if (first) {
                                setCandidate(first)
                                document.getElementById(`session-card-${first}`)?.focus()
                              }
                              return
                            }
                            if (e.key === 'End') {
                              e.preventDefault()
                              const last = sessionIds[sessionIds.length - 1]
                              if (last) {
                                setCandidate(last)
                                document.getElementById(`session-card-${last}`)?.focus()
                              }
                              return
                            }
                            if (e.key !== 'Enter' && e.key !== ' ') return
                            e.preventDefault()
                            onSelect(session.id)
                          }}
                        >
                          <div className="card-heading">
                            <span className="program-mark">
                              {session.command ? commandLabel(session.command).slice(0, 1) : '>_'}
                            </span>
                            <span className="card-program">{commandLabel(session.command)}</span>
                            <span className="card-state">
                              <span className={`dot ${session.lifecycle}`} />
                              {stateLabel(session)}
                            </span>
                          </div>
                          <h3>{session.name}</h3>
                          <div className="card-meta">
                            <span className="card-project">{project.name}</span>
                            <span aria-hidden="true">·</span>
                            <span className="card-branch">{session.branch ?? 'Ortak çalışma kopyası'}</span>
                          </div>
                          {session.degraded && (
                            <div className="card-degraded" title={session.degraded}>
                              {session.degraded}
                            </div>
                          )}
                          <pre className="card-preview">
                            {preview?.state === 'ready'
                              ? preview.preview?.text || 'Terminal henüz çıktı üretmedi.'
                              : preview?.state === 'unavailable'
                                ? preview.reason || 'Terminal önizlemesi kullanılamıyor.'
                                : sessions.findIndex((s) => s.id === session.id) >= 24
                                  ? 'Önizleme için terminali açın.'
                                  : 'Terminal önizlemesi hazırlanıyor…'}
                          </pre>
                          <footer>
                            <span>
                              {session.archivedAt !== null && 'Arşivde · '}
                              {session.isolation === 'worktree' ? 'İzole worktree' : 'Ortak klasör'}
                              {' · '}
                              <span className="card-age">{sessionAge(session, now)}</span>
                            </span>
                            <span className="card-actions">
                              <button
                                className="card-grid-add"
                                tabIndex={-1}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onAddToGrid(session.id)
                                }}
                              >
                                ⊞ Grid'e ekle
                              </button>
                              <span>Terminali aç ↗</span>
                            </span>
                          </footer>
                        </div>
                      )
                    })}
                    <button className="new-session-card" onClick={() => onNewSession(project)}>
                      <span>+</span>
                      <strong>Yeni bir işe başla</strong>
                      <small>Bu projede bir oturum aç</small>
                    </button>
                  </div>
                </section>
              )
            })}
            {!sessions.length && (query || filter !== 'all') && (
              <div className="no-results">
                <h3>Eşleşen oturum yok</h3>
                <p>Başka bir arama veya filtre deneyin.</p>
                <button
                  onClick={() => {
                    setQuery('')
                    setFilter('all')
                  }}
                >
                  Filtreleri temizle
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <footer className="workspace-footer">
        <span>
          <span className={`dot ${healthy ? 'live' : 'orphaned'}`} />
          {healthy ? 'Yerel daemon bağlı' : 'Daemon bağlantısı bekleniyor'}
        </span>
        <span>
          {state.projects.length} proje · {state.sessions.length} oturum
        </span>
        <span>Oturumlar pencere kapansa da çalışır.</span>
      </footer>
    </>
  )
}
