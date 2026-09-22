import { projectStyle, usePreferences } from '../preferences'
import { AgentMark } from './AgentMark'
import { Icon } from './Icon'
import { useEffect, useRef, useState } from 'react'
import type { ProjectView, SessionView, StateResponse } from '../../shared/types'
import { commandLabel, formatAge, sessionAgeMs } from '../../shared/types'
import { stateLabel, statusTone, StatusDot } from '../sessionStatus'
import { SESSION_DRAG_TYPE } from '../gridLayout'
import { ProtectedBranches } from './ProtectedBranches'
import { SHORTCUT_LABELS } from '../../shared/shortcuts'

interface Props {
  state: StateResponse
  /** Sunucu zamanı + istemci monotonic ilerlemesi (spec §5). */
  now: number
  /** Tarama görünür değilken önizleme istenmez; mount kaydırma için kalır. */
  previewsEnabled: boolean
  /** Silme sonrası komşu karta dön; PTY açılmaz. */
  focusId: string | null
  onFocusHandled: () => void
  onSelect: (id: string) => void
  onSessionMenu: (id: string, event: React.MouseEvent<HTMLElement>) => void
  onNewSession: (project: ProjectView) => void
  onAddProject: () => void
  onPalette: () => void
  onPreviewIds: (ids: string[]) => void
  onAddToGrid: (id: string) => void
}

type Filter = 'all' | 'attention' | 'live' | 'exited' | 'orphaned' | 'archived'

function neighbor(ids: string[], current: string | null, delta: number): string | null {
  if (ids.length === 0) return null
  const index = current ? ids.indexOf(current) : -1
  if (index < 0) return delta >= 0 ? ids[0]! : ids[ids.length - 1]!
  return ids[(index + delta + ids.length) % ids.length]!
}

function matchesFilter(session: SessionView, filter: Filter): boolean {
  if (filter === 'archived') return session.archivedAt !== null
  if (session.archivedAt !== null) return false
  if (filter === 'all') return true
  if (filter === 'attention') return session.lifecycle === 'live' && session.attention !== null
  return session.lifecycle === filter
}

export function Workspace({
  state,
  now,
  previewsEnabled,
  focusId,
  onFocusHandled,
  onSelect,
  onSessionMenu,
  onNewSession,
  onAddProject,
  onPalette,
  onPreviewIds,
  onAddToGrid,
}: Props) {
  const preferences = usePreferences()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [candidate, setCandidate] = useState<string | null>(null)
  const search = useRef<HTMLInputElement>(null)
  // Branch okuması yalnız istenince yapılır; poll edilmez.
  const [branchesFor, setBranchesFor] = useState<string | null>(null)
  const current = state.sessions.filter((s) => s.archivedAt === null)
  const counts = {
    attention: current.filter((s) => statusTone(s) === 'attention').length,
    running: current.filter((s) => s.lifecycle === 'live').length,
    finished: current.filter((s) => s.lifecycle !== 'live').length,
    archived: state.sessions.length - current.length,
  }
  // Arşivlenen oturum aktif taramada görünmez; yalnız Arşiv filtresiyle bulunur.
  const sessions = state.sessions.filter(
    (s) =>
      matchesFilter(s, filter) &&
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

  // "/" taramada aramaya odaklanır; metin alanı veya terminal içindeyken yazılır.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return
      if (target instanceof Element && target.closest('.xterm, dialog')) return
      if (!search.current || search.current.getClientRects().length === 0) return
      event.preventDefault()
      search.current.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The daemon bounds preview work to 24 cards; searching brings matching cards into that window.
  const previewKey = sessions
    .slice(0, 24)
    .map((session) => session.id)
    .join(',')
  useEffect(() => {
    onPreviewIds(previewsEnabled && previewKey ? previewKey.split(',') : [])
    return () => onPreviewIds([])
  }, [previewKey, onPreviewIds, previewsEnabled])

  const focusCard = (id: string | null | undefined) => {
    if (!id) return
    setCandidate(id)
    document.getElementById(`session-card-${id}`)?.focus()
  }

  const filters: Array<[Filter, string, number | null]> = [
    ['all', 'Tümü', current.length],
    ['attention', 'Bekleyen', counts.attention || null],
    ['live', 'Canlı', null],
    ['exited', 'Sonlanan', null],
    ['orphaned', 'Bağlantısız', null],
    ['archived', 'Arşiv', counts.archived || null],
  ]

  return (
    <>
      <header className="workspace-header">
        <div className="workspace-title">
          <h1>Oturumlar</h1>
          {state.projects.length > 0 && (
            <div className="workspace-stats" aria-label="Oturum özeti">
              {counts.attention > 0 && (
                <button className="stat stat-attention" onClick={() => setFilter('attention')}>
                  <span className="status-dot" data-tone="attention" /> {counts.attention} onay/yanıt bekliyor
                </button>
              )}
              <span className="stat"><span className="status-dot" data-tone="active" /> {counts.running} çalışıyor</span>
              <span className="stat"><span className="status-dot" data-tone="done" /> {counts.finished} sonlandı</span>
            </div>
          )}
        </div>
        {state.projects.length > 0 && (
          <div className="workspace-header-actions">
            <button className="ghost-button" onClick={onPalette} title={`Komut paleti · ${SHORTCUT_LABELS.palette}`}>
              <Icon name="command" size={14} /> Hızlı başlat
            </button>
            <button className="primary" onClick={onAddProject}>
              <Icon name="plus" size={14} /> Proje ekle
            </button>
          </div>
        )}
      </header>
      <div className="workspace-scroll">
        {state.projects.length > 0 && (
          <div className="workspace-tools">
            <div className="segmented filter-tabs" role="group" aria-label="Oturum filtresi">
              {filters.map(([value, label, count]) => (
                <button aria-pressed={filter === value} key={value} className={filter === value ? 'on' : ''} onClick={() => setFilter(value)}>
                  {label}
                  {count !== null && <span className={value === 'attention' ? 'count attention' : 'count'}>{count}</span>}
                </button>
              ))}
            </div>
            <label className="search-field">
              <Icon name="search" size={14} />
              <input
                ref={search}
                aria-label="Oturum ara"
                placeholder="Oturum veya proje ara"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') }
                  if (e.key === 'ArrowDown') { e.preventDefault(); focusCard(sessionIds[0]) }
                }}
              />
              {!query && <kbd>/</kbd>}
            </label>
          </div>
        )}
        {!state.projects.length ? (
          <section className="welcome">
            <div className="welcome-mark" aria-hidden="true"><Icon name="terminal" size={28} /></div>
            <h2>Ajanlarını tek ekrandan yönet.</h2>
            <p>
              Bir Git deposu veya yerel klasör ekle. Claude Code, Codex, Gemini ya da düz bir terminali yan yana
              çalıştır; pencereyi kapatsan da çalışmaya devam etsinler.
            </p>
            <button className="primary large" onClick={onAddProject}>
              <Icon name="plus" size={16} /> İlk projeni ekle
            </button>
            <div className="welcome-steps">
              <div><b>1</b><strong>Projeni bağla</strong><span>Bilgisayarındaki klasörü seç.</span></div>
              <div><b>2</b><strong>Ajanı başlat</strong><span>Tek tıkla ya da <kbd>Ctrl K</kbd> ile.</span></div>
              <div><b>3</b><strong>Yan yana izle</strong><span>Grid'de terminalleri böl, <kbd>Alt+1…9</kbd> ile geç.</span></div>
            </div>
          </section>
        ) : (
          <>
            {state.projects.map((project) => {
              const owned = sessions.filter((s) => s.projectId === project.id)
              if (!owned.length && (query || filter !== 'all')) return null
              return (
                <section className="project-section" key={project.id} style={projectStyle(project.id, preferences)}>
                  <header>
                    <div className="project-monogram" aria-hidden="true">{project.name.slice(0, 2).toUpperCase()}</div>
                    <div className="project-section-title">
                      <h2>
                        {project.name} <span className="count">{owned.length}</span>
                        {project.kind === 'folder' && <span className="chip">Yerel klasör</span>}
                      </h2>
                      <p title={project.path}>{project.path}</p>
                      {project.degraded && (
                        <p className="degraded-line" title={project.degraded}>
                          {project.degraded}
                        </p>
                      )}
                    </div>
                    <button
                      className="ghost-button"
                      aria-expanded={branchesFor === project.id}
                      onClick={() => setBranchesFor(branchesFor === project.id ? null : project.id)}
                    >
                      <Icon name="branch" size={14} /> Branch'ler
                    </button>
                    <button className="ghost-button" onClick={() => onNewSession(project)}><Icon name="plus" size={14} /> Yeni oturum</button>
                  </header>
                  {branchesFor === project.id && <ProtectedBranches project={project} sessions={state.sessions} />}
                  <div className="session-grid" role="list">
                    {owned.map((session) => {
                      const preview = state.previews?.[session.id]
                      const selected = candidate === session.id
                      const tone = statusTone(session)
                      return (
                        // Kart içinde ayrı "Grid'e ekle" düğmesi olduğu için kart kendisi düğme değildir.
                        <div
                          className={`session-card${selected ? ' candidate' : ''}${session.degraded ? ' is-degraded' : ''}`}
                          data-tone={tone}
                          key={session.id}
                          id={`session-card-${session.id}`}
                          role="listitem"
                          tabIndex={selected || (candidate === null && session.id === sessionIds[0]) ? 0 : -1}
                          draggable
                          aria-current={selected ? 'true' : undefined}
                          onFocus={() => setCandidate(session.id)}
                          onDragStart={(e) => e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id)}
                          onClick={() => onSelect(session.id)}
                          onContextMenu={event => onSessionMenu(session.id, event)}
                          onKeyDown={(e) => {
                            if (e.target !== e.currentTarget) return
                            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                              e.preventDefault()
                              focusCard(neighbor(sessionIds, candidate, 1))
                              return
                            }
                            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                              e.preventDefault()
                              focusCard(neighbor(sessionIds, candidate, -1))
                              return
                            }
                            if (e.key === 'Home' || e.key === 'End') {
                              e.preventDefault()
                              focusCard(e.key === 'Home' ? sessionIds[0] : sessionIds[sessionIds.length - 1])
                              return
                            }
                            if (e.key !== 'Enter' && e.key !== ' ') return
                            e.preventDefault()
                            onSelect(session.id)
                          }}
                        >
                          <div className="card-heading">
                            <AgentMark session={session} />
                            <h3 title={session.name}>{session.name}</h3>
                            <span className="card-state" data-tone={tone}>
                              <StatusDot session={session} />
                              {stateLabel(session)}
                            </span>
                          </div>
                          <div className="card-meta">
                            <span title={session.cwd}>{session.isolation === 'worktree' ? 'İzole çalışma' : 'Proje klasörü'}</span>
                            <span aria-hidden="true">·</span>
                            <span className="card-age">{session.archivedAt !== null && 'Arşivde · '}{formatAge(sessionAgeMs(session, now))}</span>
                          </div>
                          {session.attention && session.lifecycle === 'live' && (
                            <div className="card-attention" title={session.attention.message}>
                              <Icon name="alert" size={14} />
                              <span>{session.attention.message || 'Terminal girdinizi bekliyor'}</span>
                            </div>
                          )}
                          {session.degraded && (
                            <div className="card-degraded" title={session.degraded}>
                              {session.degraded}
                            </div>
                          )}
                          {preferences.previews && <pre className="card-preview">
                            {preview?.state === 'ready'
                              ? preview.preview?.text || 'Terminal henüz çıktı üretmedi.'
                              : preview?.state === 'unavailable'
                                ? preview.reason || 'Terminal önizlemesi kullanılamıyor.'
                                : sessions.findIndex((s) => s.id === session.id) >= 24
                                  ? 'Önizleme için terminali açın.'
                                  : 'Terminal önizlemesi hazırlanıyor…'}
                          </pre>}
                          <div className="card-actions">
                            <button
                              className="icon-button ghost card-grid-add"
                              title="Grid’e ekle"
                              aria-label="Grid’e ekle"
                              tabIndex={-1}
                              onClick={(e) => {
                                e.stopPropagation()
                                onAddToGrid(session.id)
                              }}
                            >
                              <Icon name="grid" size={14} />
                            </button>
                            <button className="icon-button ghost" title="Oturum işlemleri" aria-label={`${session.name} işlemleri`} onClick={e => { e.stopPropagation(); onSessionMenu(session.id, e) }}><Icon name="more" size={14} /></button>
                          </div>
                        </div>
                      )
                    })}
                    {filter !== 'archived' && (
                      <button className="new-session-card" onClick={() => onNewSession(project)}>
                        <span className="new-session-plus"><Icon name="plus" size={18} /></span>
                        <strong>Yeni oturum</strong>
                        <small>{project.name} içinde ajan veya terminal başlat</small>
                      </button>
                    )}
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
          {state.projects.length} proje · {current.length} oturum
          {counts.archived > 0 && ` · ${counts.archived} arşivde`}
          {/* Kayıt tavanı yalnız yaklaşınca söylenir; arşivler de sayılır. */}
          {state.sessions.length >= 200 && ` · en çok 256 kayıt (arşivler dahil)`}
        </span>
        <span className="footer-hints">
          <span><kbd>Ctrl K</kbd> palet</span>
          <span><kbd>Alt+1…9</kbd> oturuma geç</span>
          <span><kbd>/</kbd> ara</span>
          <span>Oturumlar pencere kapansa da çalışır.</span>
        </span>
      </footer>
    </>
  )
}
