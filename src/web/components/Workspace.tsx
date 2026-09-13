import { useEffect, useState } from 'react'
import type { Project, StateResponse } from '../../shared/types'
import { commandLabel } from '../../shared/types'
import { stateLabel } from './Sidebar'

interface Props {
  state: StateResponse
  healthy: boolean
  onSelect: (id: string) => void
  onNewSession: (project: Project) => void
  onAddProject: () => void
  onPreviewIds: (ids: string[]) => void
}

export function Workspace({ state, healthy, onSelect, onNewSession, onAddProject, onPreviewIds }: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const live = state.sessions.filter((s) => s.lifecycle === 'live').length
  const sessions = state.sessions.filter(
    (s) =>
      (filter === 'all' || s.lifecycle === filter) &&
      `${s.name} ${commandLabel(s.command)} ${state.projects.find((p) => p.id === s.projectId)?.name ?? ''}`
        .toLocaleLowerCase('tr')
        .includes(query.toLocaleLowerCase('tr')),
  )

  // The daemon bounds preview work to 24 cards; searching brings matching cards into that window.
  const previewKey = sessions
    .slice(0, 24)
    .map((session) => session.id)
    .join(',')
  useEffect(() => {
    onPreviewIds(previewKey ? previewKey.split(',') : [])
    return () => onPreviewIds([])
  }, [previewKey, onPreviewIds])

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
            ].map(([value, label]) => (
              <button
                aria-pressed={filter === value}
                key={value}
                className={filter === value ? 'on' : ''}
                onClick={() => setFilter(value)}
              >
                {label}
                {value === 'all' && <span>{state.sessions.length}</span>}
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
              Yerel Git projenizi ekleyin. Claude Code, Codex, Gemini veya terminal ile kaldığınız yerden
              devam edin.
            </p>
            <button className="primary" onClick={onAddProject}>
              + İlk projeni ekle
            </button>
            <div className="welcome-steps">
              <div>
                <b>01</b>
                <strong>Projeni bağla</strong>
                <span>Bilgisayarındaki Git klasörünü seç.</span>
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
                        {project.name} <span>{owned.length}</span>
                      </h3>
                      <p title={project.path}>{project.path}</p>
                    </div>
                    <button onClick={() => onNewSession(project)}>+ Yeni oturum</button>
                  </header>
                  <div className="session-grid">
                    {owned.map((session) => {
                      const preview = state.previews?.[session.id]
                      return (
                        <button
                          className="session-card"
                          key={session.id}
                          onClick={() => onSelect(session.id)}
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
                          <div className="card-branch">{session.branch ?? 'Ortak çalışma kopyası'}</div>
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
                              {session.isolation === 'worktree' ? 'İzole worktree' : 'Ortak klasör'}
                            </span>
                            <span>Terminali aç ↗</span>
                          </footer>
                        </button>
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
