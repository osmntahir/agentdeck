import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import { formatAge, type Project, type ProjectPullRequestList, type PullRequestSummary, type SessionView } from '../../shared/types'
import { DiffView } from './DiffView'
import { Icon } from './Icon'

const DECISION: Record<string, { label: string; tone: string }> = {
  APPROVED: { label: 'Onaylandı', tone: 'sent' },
  CHANGES_REQUESTED: { label: 'Değişiklik istendi', tone: 'changes' },
  REVIEW_REQUIRED: { label: 'İnceleme bekliyor', tone: 'draft' },
}
const CHECKS = { success: 'Kontroller geçti', failure: 'Kontroller başarısız', pending: 'Kontroller sürüyor' } as const

type DraftFilter = 'all' | 'ready' | 'draft'
const FILTER_KEY = 'agentdeck.prs.filter.v1'
const FILTERS: { id: DraftFilter; label: string }[] = [{ id: 'all', label: 'Tümü' }, { id: 'ready', label: 'Hazır' }, { id: 'draft', label: 'Taslak' }]
const EMPTY_FILTER: Record<DraftFilter, { title: string; text: string }> = {
  all: { title: 'Açık PR yok', text: 'Bu depoda şu an açık pull request bulunmuyor.' },
  ready: { title: 'İncelemeye hazır PR yok', text: 'Açık PR\'ların hepsi taslak.' },
  draft: { title: 'Taslak PR yok', text: 'Açık PR\'ların hepsi incelemeye hazır.' },
}

function loadFilter(): DraftFilter {
  try {
    const value = localStorage.getItem(FILTER_KEY)
    return value === 'ready' || value === 'draft' ? value : 'all'
  } catch {
    return 'all'
  }
}

/** PR kimliği: klasör projesinde numara depo içinde tekildir. */
export interface PullRef { number: number; repo?: string }
const refKey = (ref: PullRef) => `${ref.repo ?? '.'}#${ref.number}`
const sameRef = (pr: PullRequestSummary, ref: PullRef | null) => ref !== null && pr.number === ref.number && (pr.repo ?? '.') === (ref.repo ?? '.')
const repoName = (repo: string) => repo.split('/').pop() || repo

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
  selected: PullRef | null
  onSelect: (pr: PullRef | null) => void
  onBack: () => void
  onStartAgent: (pr: Pick<PullRequestSummary, 'number' | 'title' | 'headRefName'>) => void
  onOpenSession: (id: string) => void
}) {
  const [list, setList] = useState<PullRequestSummary[] | null>(null)
  /** Klasör projesinde depo başına durum; git projesinde null. */
  const [repos, setRepos] = useState<ProjectPullRequestList['repos'] | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilterState] = useState<DraftFilter>(loadFilter)
  const setFilter = (next: DraftFilter) => {
    setFilterState(next)
    try { localStorage.setItem(FILTER_KEY, next) } catch { /* bu açılışla sınırlı */ }
  }
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback((fresh: boolean) => {
    setLoading(true)
    api.listProjectPullRequests(project.id, fresh)
      .then(({ pullRequests, repos }) => { setList(pullRequests); setRepos(repos ?? null); setError(null); setNow(Date.now()) })
      .catch((e: api.ApiCallError) => setError({ code: e.code, message: e.message }))
      .finally(() => setLoading(false))
  }, [project.id])
  useEffect(() => { load(false) }, [load])

  // PR oturumu yalnız git projesinde açılır; klasör projesindeki PR'ın ajanı olmaz.
  const agentsFor = useCallback((pr: PullRef) => pr.repo ? [] : sessions.filter(s => s.archivedAt === null && s.pullRequest?.number === pr.number), [sessions])
  const counts = useMemo(() => ({
    all: list?.length ?? 0,
    ready: list?.filter(pr => !pr.isDraft).length ?? 0,
    draft: list?.filter(pr => pr.isDraft).length ?? 0,
  }), [list])
  const filtered = useMemo(() => (list ?? []).filter(pr => filter === 'all' || (filter === 'draft') === pr.isDraft), [list, filter])
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return filtered.filter(pr => !q || `#${pr.number} ${pr.title} ${pr.headRefName} ${pr.author ?? ''} ${pr.repo ?? ''}`.toLocaleLowerCase().includes(q))
  }, [filtered, query])
  const current = list?.find(pr => sameRef(pr, selected)) ?? null
  // Üstteki seçici ve oklar listede görünen sırayı izler; süzgeç dışına düşen PR seçici başında kalır.
  const index = shown.findIndex(pr => sameRef(pr, selected))
  const step = (delta: number) => { const next = shown[index + delta]; if (index !== -1 && next) onSelect({ number: next.number, repo: next.repo }) }
  const refOf = (pr: PullRequestSummary): PullRef => ({ number: pr.number, repo: pr.repo })

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
            {selected.repo && <><span className="crumb repo-crumb" title={selected.repo}><Icon name="folder" size={12} />{repoName(selected.repo)}</span><span className="crumb-sep" aria-hidden="true">/</span></>}
            <h1 className="title" title={current?.title}>#{selected.number} {current?.title ?? ''}</h1>
          </>}
    </nav>
    <span className="topbar-spacer" />
    {selected !== null && list && <div className="pr-stepper">
      <button className="icon-button ghost" disabled={index <= 0} onClick={() => step(-1)} title="Önceki PR" aria-label="Önceki PR"><Icon name="back" size={14} /></button>
      <select aria-label="PR seç" value={refKey(selected)} onChange={e => { const pr = list.find(p => refKey(refOf(p)) === e.target.value); if (pr) onSelect(refOf(pr)) }}>
        {index === -1 && <option value={refKey(selected)}>#{selected.number} {current?.title ?? ''}</option>}
        {shown.map(pr => <option key={refKey(refOf(pr))} value={refKey(refOf(pr))}>{pr.repo ? `${repoName(pr.repo)} · ` : ''}#{pr.number} {pr.isDraft ? '[taslak] ' : ''}{pr.title}</option>)}
      </select>
      <button className="icon-button ghost" disabled={index === -1 || index >= shown.length - 1} onClick={() => step(1)} title="Sonraki PR" aria-label="Sonraki PR"><Icon name="chevron" size={14} /></button>
    </div>}
    {selected !== null && current && agentsFor(refOf(current)).map(s =>
      <button key={s.id} className="ghost-button" onClick={() => onOpenSession(s.id)} title="Bu PR üzerindeki ajanı aç"><Icon name="terminal" size={13} />{s.name}</button>)}
    {selected === null && <button className="icon-button ghost" title="Yenile" aria-label="PR listesini yenile" disabled={loading} onClick={() => load(true)}><Icon name="refresh" size={14} /></button>}
  </header>

  if (selected !== null) {
    return <div className="prs-view">
      {header}
      <div className="body prs-review">
        <DiffView key={`${project.id}:${refKey(selected)}`} target={{
          kind: 'project', projectId: project.id, pr: selected.number, repo: selected.repo,
          sessions,
          onChanged: () => load(true),
          onStep: delta => step(delta),
          onStartAgent: selected.repo ? undefined : () => onStartAgent(current ?? { number: selected.number, title: `PR #${selected.number}`, headRefName: '' }),
        }} />
      </div>
    </div>
  }

  const renderRow = (pr: PullRequestSummary) => {
    const ref = refOf(pr)
    const agents = agentsFor(ref)
    const decision = pr.reviewDecision ? DECISION[pr.reviewDecision] : undefined
    return <li key={refKey(ref)}>
      <button className="pr-row" onClick={() => onSelect(ref)}>
        <span className={`pr-dot ${pr.isDraft ? 'draft' : 'open'}`} aria-hidden="true"><Icon name="branch" size={13} /></span>
        <span className="pr-row-main">
          <span className="pr-row-title"><span className="pr-number">#{pr.number}</span><strong>{pr.title}</strong>{pr.isDraft && <span className="badge">taslak</span>}</span>
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
      {pr.repo
        ? <a className="ghost-button pr-row-action" href={pr.url} target="_blank" rel="noreferrer" title="PR'ı GitHub'da aç"><Icon name="external" size={12} />GitHub</a>
        : <button className="ghost-button pr-row-action" onClick={() => agents[0] ? onOpenSession(agents[0].id) : onStartAgent(pr)} title={agents[0] ? 'Bu PR üzerindeki ajanı aç' : 'PR branch\'inde izole bir kopyada ajan başlat'}>
            <Icon name={agents[0] ? 'terminal' : 'play'} size={12} />{agents[0] ? 'Ajanı aç' : 'Ajan başlat'}
          </button>}
    </li>
  }

  return <div className="prs-view">
    {header}
    <div className="prs-list-scroll">
      <div className="prs-list">
        <div className="prs-toolbar">
          <div className="review-tree-search"><Icon name="search" size={13} /><input autoFocus aria-label="PR ara" placeholder="Numara, başlık, branch veya yazar…" value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (query) setQuery(''); else onBack() } }} /></div>
          {list && list.length > 0 && <div className="segmented prs-filter" role="group" aria-label="Taslak süzgeci">
            {FILTERS.map(f => <button key={f.id} className={filter === f.id ? 'on' : ''} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.id === 'draft' && <Icon name="edit" size={11} />}{f.label}<span className="count">{counts[f.id]}</span>
            </button>)}
          </div>}
        </div>
        {error && <div className="prs-empty">
          <Icon name="alert" size={18} />
          <strong>{error.code === 'gh_missing' || error.code === 'unauthenticated' ? 'GitHub bağlı değil' : 'PR\'lar okunamadı'}</strong>
          <p>{error.message}</p>
          {error.code === 'unauthenticated' && <button className="ghost-button mono" onClick={() => void navigator.clipboard?.writeText('gh auth login')}><Icon name="copy" size={12} />gh auth login</button>}
        </div>}
        {!list && !error && <div className="diff-skeleton" role="status" aria-label="PR'lar okunuyor">{[0, 1, 2, 3].map(i => <span key={i} className="short" />)}</div>}
        {list && filtered.length === 0 && !(repos && list.length === 0) && <div className="prs-empty">
          <Icon name={list.length === 0 ? 'check' : 'search'} size={18} /><strong>{EMPTY_FILTER[list.length === 0 ? 'all' : filter].title}</strong>
          <p>{EMPTY_FILTER[list.length === 0 ? 'all' : filter].text}</p>
          {list.length > 0 && <button className="ghost-button" onClick={() => setFilter('all')}>Tümünü göster</button>}
        </div>}
        {filtered.length > 0 && shown.length === 0 && <p className="pad muted">Bu aramayla eşleşen PR yok.</p>}
        {repos ? repos.map(repo => {
          const items = shown.filter(pr => pr.repo === repo.path)
          // Arama veya süzgeç varken boş depo gizlenir; yoksa depo durumuyla birlikte görünür.
          if (items.length === 0 && (query.trim() !== '' || filter !== 'all')) return null
          return <section key={repo.path} className="prs-repo" aria-label={`${repo.path} PR'ları`}>
            <header className="prs-repo-head">
              <Icon name="folder" size={14} />
              <strong title={repo.path}>{repoName(repo.path)}</strong>
              {repo.path.includes('/') && <span className="muted mono">{repo.path}</span>}
              <span className={`prs-repo-count${repo.count > 0 ? ' has' : ''}`}>{repo.count}</span>
            </header>
            {repo.error
              ? <p className="prs-repo-note warn" title={repo.error.message}><Icon name="alert" size={12} />{repo.error.code === 'not_github' ? 'GitHub deposu değil' : repo.error.message}</p>
              : items.length === 0 && <p className="prs-repo-note">Açık PR yok.</p>}
            {items.length > 0 && <ul className="prs-items">{items.map(renderRow)}</ul>}
          </section>
        }) : <ul className="prs-items">{shown.map(renderRow)}</ul>}
      </div>
    </div>
  </div>
}
