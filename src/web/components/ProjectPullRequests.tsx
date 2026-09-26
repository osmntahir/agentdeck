import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import { formatAge, type Project, type PullRequestSummary, type SessionView } from '../../shared/types'
import { DiffView } from './DiffView'
import { Icon } from './Icon'

const DECISION: Record<string, { label: string; tone: string }> = {
  APPROVED: { label: 'Onaylandı', tone: 'sent' },
  CHANGES_REQUESTED: { label: 'Değişiklik istendi', tone: 'changes' },
  REVIEW_REQUIRED: { label: 'İnceleme bekliyor', tone: 'draft' },
}
const CHECKS = { success: 'Kontroller geçti', failure: 'Kontroller başarısız', pending: 'Kontroller sürüyor' } as const

function age(iso: string, now: number): string {
  const time = Date.parse(iso)
  return Number.isNaN(time) ? '' : formatAge(now - time)
}

/**
 * Projenin açık PR'ları. Liste tam genişlikte açılır; bir PR seçilince inceleme
 * ekranı gelir ve üstteki seçiciyle PR'lar arasında geçilir. Notlar seçilen
 * terminale veya PR üzerinde başlatılan ajana gider.
 */
export function ProjectPullRequests({ project, sessions, selected, onSelect, onBack, onStartAgent, onOpenSession }: {
  project: Project
  sessions: SessionView[]
  selected: number | null
  onSelect: (pr: number | null) => void
  onBack: () => void
  onStartAgent: (pr: Pick<PullRequestSummary, 'number' | 'title' | 'headRefName'>) => void
  onOpenSession: (id: string) => void
}) {
  const [list, setList] = useState<PullRequestSummary[] | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback((fresh: boolean) => {
    setLoading(true)
    api.listProjectPullRequests(project.id, fresh)
      .then(({ pullRequests }) => { setList(pullRequests); setError(null); setNow(Date.now()) })
      .catch((e: api.ApiCallError) => setError({ code: e.code, message: e.message }))
      .finally(() => setLoading(false))
  }, [project.id])
  useEffect(() => { load(false) }, [load])

  const agentsFor = useCallback((number: number) => sessions.filter(s => s.archivedAt === null && s.pullRequest?.number === number), [sessions])
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return (list ?? []).filter(pr => !q || `#${pr.number} ${pr.title} ${pr.headRefName} ${pr.author ?? ''}`.toLocaleLowerCase().includes(q))
  }, [list, query])
  const current = list?.find(pr => pr.number === selected) ?? null
  const index = list ? list.findIndex(pr => pr.number === selected) : -1
  const step = (delta: number) => { if (list && index !== -1) { const next = list[index + delta]; if (next) onSelect(next.number) } }

  const header = <header className="topbar clean-topbar prs-topbar">
    <nav className="crumbs" aria-label="Konum">
      <button className="topbar-back crumb" title={selected !== null ? 'PR listesine dön · Esc' : 'Oturumlara dön · Esc'} onClick={selected !== null ? () => onSelect(null) : onBack}>
        <Icon name="back" size={14} /><span>{project.name}</span>
      </button>
      <span className="crumb-sep" aria-hidden="true">/</span>
      {selected === null
        ? <h1 className="title">Pull request'ler</h1>
        : <>
            <button className="crumb" onClick={() => onSelect(null)}>Pull request'ler</button>
            <span className="crumb-sep" aria-hidden="true">/</span>
            <h1 className="title" title={current?.title}>#{selected} {current?.title ?? ''}</h1>
          </>}
    </nav>
    <span className="topbar-spacer" />
    {selected !== null && list && <div className="pr-stepper">
      <button className="icon-button ghost" disabled={index <= 0} onClick={() => step(-1)} title="Önceki PR" aria-label="Önceki PR"><Icon name="back" size={14} /></button>
      <select aria-label="PR seç" value={selected} onChange={e => onSelect(Number(e.target.value))}>
        {!current && <option value={selected}>#{selected}</option>}
        {list.map(pr => <option key={pr.number} value={pr.number}>#{pr.number} {pr.title}</option>)}
      </select>
      <button className="icon-button ghost" disabled={index === -1 || index >= list.length - 1} onClick={() => step(1)} title="Sonraki PR" aria-label="Sonraki PR"><Icon name="chevron" size={14} /></button>
    </div>}
    {selected !== null && current && agentsFor(current.number).map(s =>
      <button key={s.id} className="ghost-button" onClick={() => onOpenSession(s.id)} title="Bu PR üzerindeki ajanı aç"><Icon name="terminal" size={13} />{s.name}</button>)}
    {selected === null && <button className="icon-button ghost" title="Yenile" aria-label="PR listesini yenile" disabled={loading} onClick={() => load(true)}><Icon name="refresh" size={14} /></button>}
  </header>

  if (selected !== null) {
    return <div className="prs-view">
      {header}
      <div className="body prs-review">
        <DiffView key={`${project.id}:${selected}`} target={{
          kind: 'project', projectId: project.id, pr: selected,
          sessions,
          onStartAgent: () => onStartAgent(current ?? { number: selected, title: `PR #${selected}`, headRefName: '' }),
        }} />
      </div>
    </div>
  }

  return <div className="prs-view">
    {header}
    <div className="prs-list-scroll">
      <div className="prs-list">
        <div className="prs-toolbar">
          <div className="review-tree-search"><Icon name="search" size={13} /><input autoFocus aria-label="PR ara" placeholder="Numara, başlık, branch veya yazar…" value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (query) setQuery(''); else onBack() } }} /></div>
          {list && <span className="muted">{list.length} açık PR</span>}
        </div>
        {error && <div className="prs-empty">
          <Icon name="alert" size={18} />
          <strong>{error.code === 'gh_missing' || error.code === 'unauthenticated' ? 'GitHub bağlı değil' : 'PR\'lar okunamadı'}</strong>
          <p>{error.message}</p>
          {error.code === 'unauthenticated' && <button className="ghost-button" onClick={() => void navigator.clipboard?.writeText('gh auth login')}><Icon name="copy" size={12} />gh auth login</button>}
        </div>}
        {!list && !error && <div className="diff-skeleton" role="status" aria-label="PR'lar okunuyor">{[0, 1, 2, 3].map(i => <span key={i} className="short" />)}</div>}
        {list && list.length === 0 && <div className="prs-empty"><Icon name="check" size={18} /><strong>Açık PR yok</strong><p>Bu depoda şu an açık pull request bulunmuyor.</p></div>}
        {list && list.length > 0 && shown.length === 0 && <p className="pad muted">Bu aramayla eşleşen PR yok.</p>}
        <ul className="prs-items">
          {shown.map(pr => {
            const agents = agentsFor(pr.number)
            const decision = pr.reviewDecision ? DECISION[pr.reviewDecision] : undefined
            return <li key={pr.number}>
              <button className="pr-row" onClick={() => onSelect(pr.number)}>
                <span className={`pr-dot ${pr.isDraft ? 'draft' : 'open'}`} aria-hidden="true"><Icon name="branch" size={13} /></span>
                <span className="pr-row-main">
                  <span className="pr-row-title"><strong>{pr.title}</strong><span className="muted">#{pr.number}</span>{pr.isDraft && <span className="badge">taslak</span>}</span>
                  <span className="pr-row-meta">
                    <code>{pr.headRefName}</code><span aria-hidden="true">→</span><code>{pr.baseRefName}</code>
                    {pr.author && <span>@{pr.author}</span>}
                    <span>{age(pr.updatedAt, now)} önce güncellendi</span>
                  </span>
                </span>
                <span className="pr-row-side">
                  {pr.checks && <span className={`check-dot ${pr.checks}`} title={CHECKS[pr.checks]}><Icon name={pr.checks === 'failure' ? 'close' : pr.checks === 'success' ? 'check' : 'refresh'} size={11} />{pr.checks === 'failure' ? 'CI' : ''}</span>}
                  {decision && <span className={`review-state ${decision.tone}`}>{decision.label}</span>}
                  {agents.length > 0 && <span className="chip agent-chip" title={agents.map(a => a.name).join(', ')}><Icon name="terminal" size={11} />ajan</span>}
                  <span className="diff-stats"><b>+{pr.additions}</b><i>−{pr.deletions}</i></span>
                </span>
              </button>
              <button className="ghost-button pr-row-action" onClick={() => agents[0] ? onOpenSession(agents[0].id) : onStartAgent(pr)} title={agents[0] ? 'Bu PR üzerindeki ajanı aç' : 'PR branch\'inde izole bir kopyada ajan başlat'}>
                <Icon name={agents[0] ? 'terminal' : 'play'} size={12} />{agents[0] ? 'Ajanı aç' : 'Ajan başlat'}
              </button>
            </li>
          })}
        </ul>
      </div>
    </div>
  </div>
}
