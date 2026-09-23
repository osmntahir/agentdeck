import { useEffect, useRef, useState } from 'react'
import type { ClaudeAgentView, Work } from '../../shared/types'
import { formatAge } from '../../shared/types'
import { getClaudeSessions, type ClaudeSessionListing } from '../api'
import type { StatusTone } from '../sessionStatus'
import { ProgramIcon } from './AgentMark'
import { Icon } from './Icon'

/** Claude'un kendi durumu; blocked oturum kullanıcı girdisi bekler. */
export function claudeStateTone(state: string): StatusTone {
  if (state === 'working') return 'active'
  if (state === 'blocked') return 'attention'
  if (state === 'failed') return 'error'
  if (state === 'done') return 'done'
  return 'orphaned'
}

export function claudeStateLabel(state: string): string {
  if (state === 'working') return 'Çalışıyor'
  if (state === 'blocked') return 'Girdi bekliyor'
  if (state === 'done') return 'Tamamlandı'
  if (state === 'failed') return 'Başarısız'
  if (state === 'unknown') return 'Listede yok'
  return state
}

function age(agent: ClaudeAgentView, now: number): string | null {
  const at = agent.updatedAt ?? agent.startedAt
  return at === null ? null : formatAge(now - at)
}

/** İşe bağlı Claude arka plan oturumları; "Aç" oturumu iş içinde bir terminalde açar. */
export function ClaudeSessionRows({ agents, projectPath, now, onOpen, onUnlink }: {
  agents: ClaudeAgentView[]
  projectPath: string
  now: number
  onOpen: (agent: ClaudeAgentView) => void
  onUnlink: (agent: ClaudeAgentView) => void
}) {
  return (
    <ul className="claude-session-list">
      {agents.map((agent) => {
        const where = agent.cwd !== projectPath && agent.cwd.startsWith(`${projectPath}/`) ? agent.cwd.slice(projectPath.length + 1) : null
        const when = age(agent, now)
        return (
          <li key={agent.id} className="claude-session-row" data-tone={claudeStateTone(agent.state)}>
            <ProgramIcon command="claude" />
            <div className="claude-session-text">
              <strong title={agent.name}>{agent.name}</strong>
              {agent.detail && <span className="claude-session-detail" title={agent.detail}>{agent.detail}</span>}
              <span className="conversation-meta">
                <span className="claude-state"><span className="status-dot" data-tone={claudeStateTone(agent.state)} /> {claudeStateLabel(agent.state)}</span>
                {when && <><span aria-hidden="true">·</span><span>{when === 'az önce' ? when : `${when} önce`}</span></>}
                {where && <><span aria-hidden="true">·</span><span title={agent.cwd}>{where}</span></>}
                <span aria-hidden="true">·</span><code>{agent.id}</code>
              </span>
            </div>
            <button className="ghost-button" onClick={() => onOpen(agent)} disabled={agent.state === 'unknown'} title={`claude attach ${agent.id}`}>
              <Icon name="terminal" size={14} /> Aç
            </button>
            <button className="icon-button ghost" title="İşten çıkar" aria-label={`${agent.name} oturumunu işten çıkar`} onClick={() => onUnlink(agent)}>
              <Icon name="close" size={14} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** Projenin Claude arka plan oturumlarından işe bağlanacakları seçtirir. */
export function ClaudeSessionPicker({ work, works, projectId, now, busy, error, onSubmit, onCancel }: {
  work: Work
  works: Work[]
  projectId: string
  now: number
  busy: boolean
  error: string | null
  onSubmit: (ids: string[]) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const [listing, setListing] = useState<ClaudeSessionListing | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  useEffect(() => {
    let cancelled = false
    getClaudeSessions(projectId)
      .then((result) => { if (!cancelled) setListing(result) })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    return () => { cancelled = true }
  }, [projectId])

  const needle = query.toLocaleLowerCase('tr')
  const sessions = (listing?.sessions ?? []).filter((s) => s.workId !== work.id && `${s.name} ${s.detail ?? ''} ${s.id}`.toLocaleLowerCase('tr').includes(needle))
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <dialog ref={dialog} className="session-modal" aria-labelledby="claude-picker-title" onCancel={(e) => { e.preventDefault(); onCancel() }}>
      <form className="dialog claude-picker" onSubmit={(e) => { e.preventDefault(); if (!busy && selected.size > 0) onSubmit([...selected]) }}>
        <header className="dialog-head">
          <h2 id="claude-picker-title">Claude oturumu bağla</h2>
          <div className="dialog-sub">{work.name}</div>
        </header>
        <label className="search-field">
          <Icon name="search" size={14} />
          <input autoFocus aria-label="Claude oturumu ara" placeholder="Ad veya özet ara" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="claude-picker-list" role="list">
          {failed && <p className="conversation-empty">Liste okunamadı: {failed}</p>}
          {!failed && !listing && <p className="conversation-empty">Claude oturumları okunuyor…</p>}
          {listing && !listing.supported && <p className="conversation-empty">Bu daemon'da Claude oturumu listesi kapalı.</p>}
          {listing?.error && <p className="conversation-empty">{listing.error}</p>}
          {listing?.supported && !listing.error && sessions.length === 0 && <p className="conversation-empty">Bu projede bağlanabilecek Claude arka plan oturumu yok.</p>}
          {sessions.map((session) => {
            const other = session.workId ? works.find((w) => w.id === session.workId) : null
            const when = age(session, now)
            return (
              <label key={session.id} className={`claude-pick${selected.has(session.id) ? ' on' : ''}`} role="listitem">
                <input type="checkbox" checked={selected.has(session.id)} onChange={() => toggle(session.id)} />
                <span className="status-dot" data-tone={claudeStateTone(session.state)} aria-hidden="true" />
                <span className="claude-session-text">
                  <strong>{session.name}</strong>
                  {session.detail && <span className="claude-session-detail">{session.detail}</span>}
                  <span className="conversation-meta">
                    <span>{claudeStateLabel(session.state)}</span>
                    {when && <><span aria-hidden="true">·</span><span>{when}</span></>}
                    {other && <><span aria-hidden="true">·</span><span className="claude-owner">Şu an: {other.name}</span></>}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>Vazgeç</button>
          <button type="submit" className="primary" disabled={busy || selected.size === 0}>
            {selected.size > 1 ? `${selected.size} oturumu bağla` : 'Bağla'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
