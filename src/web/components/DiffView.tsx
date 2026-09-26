import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api'
import type { DiffResult, GithubStatus, PullRequestDetail, PullRequestNote, PullRequestSummary, SessionView } from '../../shared/types'
import { diffFiles, type DiffFile } from '../../shared/diffFiles'
import { fileKey, fileTree, treeOrder } from '../../shared/diffLayout'
import { composeReviewMessage, locateComment, nextUnviewed, sourceLabel, type ReviewComment } from '../../shared/review'
import { diffDigest, useReviewDraft, useReviewPrefs } from '../reviewDrafts'
import { DiffFileView, type GithubThread, type NewComment, type PlacedComment } from './DiffFileView'
import { DiffFileTree, type TreeRepo } from './DiffFileTree'
import { ReviewPanel, SendDialog, type Delivery } from './ReviewPanel'
import { CreatePullRequestDialog } from './CreatePullRequestDialog'
import { ActionMenu, type MenuAction, type MenuPosition } from './ActionMenu'
import { Icon } from './Icon'

/** İncelenen fark: oturumun yerel farkı veya GitHub'daki bir PR. */
type Source = 'work' | 'uncommitted' | `pr:${number}`
/** Yüklenen veri kaynağıyla etiketlidir; kaynak değişince eski fark yeni sekmenin altında görünmez. */
type Loaded = ({ kind: 'local'; result: DiffResult } | { kind: 'pr'; detail: PullRequestDetail }) & { source: Source }

interface ReviewRepo {
  path: string
  branch: string
  baseCommit: string | null
  files: DiffFile[]
  ids: string[]
  error: string | null
  stale: boolean
  status: string
  truncated: boolean
  empty: boolean
}

/** Büyük dosya farkı açılışta kapalı gelir; kaydırma akıcı kalır. */
const LARGE_FILE_LINES = 1500
const prNumberOf = (source: Source): number | null => source.startsWith('pr:') ? Number(source.slice(3)) : null

function uid(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const PR_STATE = { OPEN: 'Açık', CLOSED: 'Kapandı', MERGED: 'Birleşti' } as const
const DECISION: Record<string, string> = { APPROVED: 'Onaylandı', CHANGES_REQUESTED: 'Değişiklik istendi', REVIEW_REQUIRED: 'İnceleme bekliyor' }

/**
 * İncelemenin hedefi: bir oturumun kendi farkı (ve branch'inin PR'ı) ya da
 * projenin bir PR'ı. Proje PR'ında notlar seçilen terminale gider.
 */
export type ReviewTarget =
  | { kind: 'session'; session: SessionView; projectKind: 'git' | 'folder' | undefined }
  | { kind: 'project'; projectId: string; pr: number; sessions: SessionView[]; onChanged?: () => void
      /** Klasör projesinde PR'ın alt deposu (ADR 0025); git projesinde yoktur. */
      repo?: string
      /** PR üzerinde ajan başlatma; klasör projesinde yoktur. */
      onStartAgent?: () => void
      /** Önceki/sonraki PR'a geçer; odak modunda üst çubuk gizliyken de [ ve ] ile kullanılır. */
      onStep?: (delta: 1 | -1) => void }

export function DiffView({ target }: { target: ReviewTarget }) {
  const session = target.kind === 'session' ? target.session : null
  const projectId = target.kind === 'project' ? target.projectId : null
  const prRepo = target.kind === 'project' ? target.repo : undefined
  const [source, setSource] = useState<Source>(target.kind === 'project' ? `pr:${target.pr}` : target.session.isolation === 'worktree' ? 'work' : 'uncommitted')
  const [fetched, setFetched] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [current, setCurrent] = useState<string | null>(null)
  // Klasör projesinde iki depoda aynı numaralı PR olabilir; taslak depoya da bağlanır.
  const [draft, updateDraft] = useReviewDraft(session ? session.id : prRepo ? `project:${projectId}:${prRepo}` : `project:${projectId}`)
  const [prefs, updatePrefs] = useReviewPrefs()
  const [github, setGithub] = useState<GithubStatus | null>(null)
  const [githubReload, setGithubReload] = useState(0)
  const [prMenu, setPrMenu] = useState<{ position: MenuPosition; list: PullRequestSummary[] | null; error: string | null } | null>(null)
  const [creating, setCreating] = useState<{ busy: boolean; error: string | null } | null>(null)
  const [sending, setSending] = useState<{ text: string; busy: boolean; error: string | null } | null>(null)
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [pendingJump, setPendingJump] = useState<ReviewComment | null>(null)
  const [focus, setFocus] = useState(false)
  const [help, setHelp] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  // Oturumun branch durumu ve PR seçici yalnız oturum incelemesinde vardır.
  const githubCapable = target.kind === 'session' && target.projectKind === 'git'
  const [targetId, setTargetId] = useState<string | null>(null)

  useEffect(() => {
    if (!githubCapable || !session) return
    let cancelled = false
    api.getGithub(session.id).then(next => { if (!cancelled) setGithub(next) })
      .catch(e => { if (!cancelled) setGithub({ state: 'error', message: e.message, repo: null, defaultBranch: null, branch: null, pullRequest: null }) })
    return () => { cancelled = true }
  }, [session, githubCapable, githubReload])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    const pr = prNumberOf(source)
    const request: Promise<Loaded> = pr !== null
      ? (session ? api.getPullRequest(session.id, pr) : api.getProjectPullRequest(projectId!, pr, prRepo)).then(detail => ({ kind: 'pr' as const, detail, source }))
      : api.getDiff(session!.id, source as 'work' | 'uncommitted').then(result => ({ kind: 'local' as const, result, source }))
    request.then(next => { if (!cancelled) setFetched(next) })
      .catch(e => { if (!cancelled) { setError(e.message); setFetched(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  // Oturum görünümü her durum okumasında yeni nesnedir; farkı yalnız kimliği değişince yeniden okuruz.
  }, [session?.id, projectId, source, reload])

  // Aynı kaynağın yenilemesinde eski fark ekranda kalır; kaynak değişince iskelet gösterilir.
  const loaded = fetched?.source === source ? fetched : null
  const repos: ReviewRepo[] = useMemo(() => {
    if (!loaded) return []
    if (loaded.kind === 'pr') {
      const files = ordered(diffFiles(loaded.detail.diff))
      return [{ path: '.', branch: loaded.detail.pullRequest.headRefName, baseCommit: null, files, ids: files.map(f => fileKey('.', f)),
        error: null, stale: false, status: '', truncated: loaded.detail.truncated, empty: loaded.detail.diff.trim() === '' }]
    }
    return loaded.result.repos.map(repo => {
      const files = ordered(diffFiles(repo.diff))
      return { path: repo.path, branch: repo.branch, baseCommit: repo.baseCommit, files, ids: files.map(f => fileKey(repo.path, f)),
        error: repo.error, stale: repo.stale, status: repo.status, truncated: repo.patchTruncated || repo.statusTruncated, empty: !repo.error && !repo.diff }
    })
  }, [loaded])

  const allFiles = useMemo(() => repos.flatMap(repo => repo.files.map((file, i) => ({ repo, file, id: repo.ids[i] }))), [repos])
  const viewedKey = useCallback((id: string) => `${source}|${id}`, [source])
  const digests = useMemo(() => new Map(allFiles.map(({ file, id }) => [id, diffDigest(file.lines)])), [allFiles])
  const viewed = useMemo(() => new Set(allFiles.filter(({ id }) => draft.viewed[viewedKey(id)] === digests.get(id)).map(({ id }) => id)), [allFiles, draft.viewed, digests, viewedKey])

  // Yeni fark yüklenince büyük ve görülmüş dosyalar kapalı başlar; kullanıcının açtığı dosya yenilemede kapanmaz.
  const seen = useRef<Set<string>>(new Set())
  useEffect(() => {
    setCollapsed(previous => {
      const next = new Set([...previous].filter(id => digests.has(id)))
      for (const { file, id } of allFiles) {
        if (seen.current.has(`${source}|${id}|${digests.get(id)}`)) continue
        seen.current.add(`${source}|${id}|${digests.get(id)}`)
        if (file.lines.length > LARGE_FILE_LINES || viewed.has(id)) next.add(id)
      }
      return next
    })
    // viewed bilerek bağımlılık değil: işaretleme kendi kapama davranışını yönetir.
  }, [allFiles, digests, source])

  const single = prefs.fileMode === 'single'
  const matches = useCallback((file: DiffFile) => file.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()), [query])
  // Görülenler gizliyken tek dosya modunda ekrandaki dosya, kullanıcı ilerleyene kadar kaybolmaz.
  const visible = useMemo(() => allFiles.filter(({ file, id }) =>
    matches(file) && (!prefs.hideViewed || !viewed.has(id) || (single && id === current))), [allFiles, matches, prefs.hideViewed, viewed, single, current])
  const singleId = single ? (visible.find(v => v.id === current)?.id ?? visible[0]?.id ?? null) : null
  const allViewed = allFiles.length > 0 && viewed.size === allFiles.length

  const prNumber = prNumberOf(source)
  const detail = loaded?.kind === 'pr' ? loaded.detail : null

  // Notların farktaki yeri: yalnız bu kaynağın notları satırlara yerleşir.
  const placed = useMemo(() => {
    const map = new Map<string, PlacedComment[]>()
    for (const comment of draft.comments) {
      // GitHub'dan iletilen yorum satırda kendi GitHub kartıyla görünür; ikinci kez çizilmez.
      if (comment.source !== source || comment.path === null || comment.author) continue
      const repo = repos.find(r => r.path === comment.repo)
      if (!repo) continue
      const at = locateComment(repo.files, comment)
      if (!at) continue
      const id = repo.ids[at.file]
      map.set(id, [...(map.get(id) ?? []), { comment, index: at.index, outdated: at.outdated }])
    }
    return map
  }, [draft.comments, repos, source])

  const threads = useMemo(() => {
    const map = new Map<string, GithubThread[]>()
    if (!detail) return map
    const roots = new Map<number, GithubThread>()
    for (const c of detail.comments) if (c.inReplyTo === null) roots.set(c.id, { root: c, replies: [] })
    for (const c of detail.comments) if (c.inReplyTo !== null) roots.get(c.inReplyTo)?.replies.push(c)
    for (const thread of roots.values()) {
      const id = fileKey('.', { path: thread.root.path })
      map.set(id, [...(map.get(id) ?? []), thread])
    }
    return map
  }, [detail])

  const forwarded = useMemo(() => new Set(draft.comments.filter(c => c.id.startsWith('gh:')).map(c => Number(c.id.slice(3)))), [draft.comments])
  const forwardedNotes = useMemo(() => new Set(draft.comments.filter(c => c.id.startsWith('ghnote:')).map(c => c.id.slice(7))), [draft.comments])
  const noteCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const { id } of allFiles) counts.set(id, (placed.get(id)?.length ?? 0) + (threads.get(id)?.length ?? 0))
    return counts
  }, [allFiles, placed, threads])

  // Proje PR'ında notların gideceği terminal: kullanıcının seçimi, yoksa bu PR üzerinde açılmış oturum.
  const candidates = useMemo(() => target.kind === 'project' ? target.sessions.filter(s => s.archivedAt === null) : [], [target])
  const prSession = candidates.find(s => s.pullRequest?.number === prNumberOf(source) && s.lifecycle === 'live')
    ?? candidates.find(s => s.pullRequest?.number === prNumberOf(source))
  const receiver = session ?? candidates.find(s => s.id === targetId) ?? prSession ?? null
  const delivery: Delivery = useMemo(() => {
    if (!receiver) return { ok: false, reason: prRepo ? 'Notların gideceği terminali seç' : 'Notların gideceği terminali seç veya bu PR üzerinde ajan başlat', target: 'Terminal seçilmedi' }
    const target = receiver.name
    if (receiver.archivedAt !== null) return { ok: false, reason: 'Oturum arşivde; önce arşivden çıkar', target }
    if (receiver.lifecycle !== 'live' || !receiver.runId) return { ok: false, reason: 'Terminal çalışmıyor; önce oturumu devam ettir', target }
    if (receiver.attention?.kind === 'approval') return { ok: false, reason: 'Terminal bir onay bekliyor; önce onu yanıtla', target }
    return { ok: true, reason: null, target }
  }, [receiver])

  const toggleCollapsed = useCallback((id: string) => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  }), [])

  const scrollToFile = useCallback((id: string) => {
    const section = scroller.current?.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(id)}"]`)
    if (!section || !scroller.current) return
    scroller.current.scrollTo({ top: section.offsetTop - 8, behavior: 'smooth' })
    setCurrent(id)
  }, [])

  /** Dosyayı açar: tek dosya modunda ekrana getirir, listede ona kayar. Kaldığın yer olarak kaydedilir. */
  const openFile = useCallback((id: string) => {
    if (single) {
      setCurrent(id)
      scroller.current?.scrollTo({ top: 0 })
    } else {
      setCollapsed(previous => { if (!previous.has(id)) return previous; const next = new Set(previous); next.delete(id); return next })
      requestAnimationFrame(() => scrollToFile(id))
    }
    updateDraft(d => d.positions[source] === id ? d : { ...d, positions: { ...d.positions, [source]: id } })
  }, [single, scrollToFile, updateDraft, source])

  const toggleViewed = useCallback((id: string) => {
    const key = viewedKey(id)
    const digest = digests.get(id)
    if (!digest) return
    const nowViewed = draft.viewed[key] !== digest
    updateDraft(d => {
      const next = { ...d.viewed }
      if (nowViewed) next[key] = digest; else delete next[key]
      return { ...d, viewed: next }
    })
    setCollapsed(previous => {
      const next = new Set(previous)
      if (nowViewed) next.add(id); else next.delete(id)
      return next
    })
    // Görülen dosya kapanır ve sıradaki görülmemiş dosyaya geçilir; hepsi görüldüyse yerinde kalınır.
    if (nowViewed) {
      const after = new Set(viewed).add(id)
      const next = nextUnviewed(visible.map(v => v.id), after, id)
      if (next) openFile(next)
    }
  }, [digests, draft.viewed, updateDraft, viewedKey, viewed, visible, openFile])

  const resetViewed = useCallback(() => {
    updateDraft(d => ({ ...d, viewed: Object.fromEntries(Object.entries(d.viewed).filter(([k]) => !k.startsWith(`${source}|`))) }))
    setCollapsed(new Set(allFiles.filter(({ file }) => file.lines.length > LARGE_FILE_LINES).map(({ id }) => id)))
  }, [updateDraft, source, allFiles])

  // İncelemeye dönünce kaynağın en son açılan dosyasından devam edilir.
  const resumed = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!loaded || resumed.current.has(source)) return
    resumed.current.add(source)
    const id = draft.positions[source]
    if (id && allFiles.some(f => f.id === id)) openFile(id)
    // Yalnız kaynağın ilk yüklenişinde çalışır.
  }, [loaded, source])

  // Kaydırırken ağaçta işaretlenen dosya: üst kenarı geçmiş son dosya.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const sections = el.querySelectorAll<HTMLElement>('[data-file-id]')
        let found: string | null = null
        for (const section of sections) {
          if (section.offsetTop - el.scrollTop <= 48) found = section.dataset.fileId ?? null
          else break
        }
        setCurrent(found ?? sections[0]?.dataset.fileId ?? null)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => { el.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame) }
  }, [visible])

  const send = useCallback(async (text: string, submit: boolean) => {
    if (!receiver) throw new Error('Terminal seçilmedi')
    await api.sendToAgent(receiver.id, { expectedRunId: receiver.runId, text, submit })
  }, [receiver])

  const addComment = useCallback((id: string, input: NewComment) => {
    const repo = allFiles.find(entry => entry.id === id)?.repo.path ?? '.'
    const comment: ReviewComment = { id: uid(), source, repo, ...input, createdAt: Date.now(), sentAt: null }
    updateDraft(d => ({ ...d, comments: [...d.comments, comment] }))
    if (!prefs.instant) return
    if (!delivery.ok) { setStatus({ tone: 'error', text: `Not taslak kaldı: ${delivery.reason}` }); return }
    const context = prNumberOf(source) !== null ? sourceLabel(source) : undefined
    send(composeReviewMessage([comment], { context }), prefs.submit)
      .then(() => {
        const at = Date.now()
        updateDraft(d => ({ ...d, comments: d.comments.map(c => c.id === comment.id ? { ...c, sentAt: at } : c) }))
        setStatus({ tone: 'ok', text: 'Not ajana gönderildi.' })
      })
      .catch(e => setStatus({ tone: 'error', text: `Not taslak kaldı: ${e.message}` }))
  }, [allFiles, delivery, prefs.instant, prefs.submit, send, source, updateDraft])

  const editComment = useCallback((id: string, body: string) =>
    updateDraft(d => ({ ...d, comments: d.comments.map(c => c.id === id ? { ...c, body } : c) })), [updateDraft])
  const deleteComment = useCallback((id: string) =>
    updateDraft(d => ({ ...d, comments: d.comments.filter(c => c.id !== id) })), [updateDraft])

  const forwardThread = useCallback((thread: GithubThread) => {
    const { root } = thread
    const replies = thread.replies.map(r => `@${r.author}: ${r.body}`)
    const lines = repos[0]?.files.find(f => f.path === root.path)?.lines ?? []
    const line = lines.find(l => root.line !== null && (root.side === 'new' ? l.next === root.line : l.kind === 'del' && l.old === root.line))
    const comment: ReviewComment = {
      id: `gh:${root.id}`, source, repo: '.', path: root.path, side: root.side, startLine: root.startLine ?? root.line, line: root.line,
      snippet: line ? [line.text.slice(1)] : [], body: [root.body, ...replies].join('\n'), createdAt: Date.now(), sentAt: null,
      author: root.author, url: root.url,
    }
    updateDraft(d => d.comments.some(c => c.id === comment.id) ? d : { ...d, comments: [...d.comments, comment] })
  }, [repos, source, updateDraft])

  const forwardNote = useCallback((note: PullRequestNote) => {
    const index = detail?.notes.indexOf(note) ?? 0
    const key = `${note.url}|${note.createdAt}|${index}`
    const comment: ReviewComment = {
      id: `ghnote:${key}`, source, repo: '.', path: null, side: 'new', startLine: null, line: null, snippet: [],
      body: note.body, createdAt: Date.now(), sentAt: null, author: note.author, url: note.url,
    }
    updateDraft(d => d.comments.some(c => c.id === comment.id) ? d : { ...d, comments: [...d.comments, comment] })
  }, [detail, source, updateDraft])

  // Proje incelemesinde her PR'ın notları ayrıdır; başka PR'ın notu bu terminale gönderilmez.
  const scoped = useMemo(() => session ? draft.comments : draft.comments.filter(c => c.source === source), [session, draft.comments, source])
  const pending = scoped.filter(c => c.sentAt === null)
  const openSend = () => {
    const prSources = new Set(pending.map(c => c.source))
    const only = prSources.size === 1 ? [...prSources][0] : null
    const context = only && only.startsWith('pr:') ? sourceLabel(only) : undefined
    setSending({ text: composeReviewMessage(pending, { context, summary: draft.summary }), busy: false, error: null })
  }
  const publishable = prNumber !== null && detail
    ? pending.filter(c => c.source === source && !c.author && c.path !== null && c.line !== null)
    : []

  const confirmSend = async (text: string, options: { submit: boolean; publish: boolean }) => {
    setSending(s => s && { ...s, busy: true, error: null })
    try {
      await send(text, options.submit)
    } catch (e) {
      setSending(s => s && { ...s, busy: false, error: (e as Error).message })
      return
    }
    const at = Date.now()
    const sentIds = new Set(pending.map(c => c.id))
    let published = new Set<string>()
    let publishError: string | null = null
    if (options.publish && detail && prNumber !== null && publishable.length > 0) {
      try {
        const review = {
          repo: '.', commitId: detail.pullRequest.headRefOid, body: '',
          comments: publishable.map(c => ({ path: c.path!, side: c.side, line: c.line!, startLine: c.startLine, body: c.body })),
        }
        await (session ? api.publishReview(session.id, prNumber, review) : api.publishProjectReview(projectId!, prNumber, review, prRepo))
        published = new Set(publishable.map(c => c.id))
      } catch (e) {
        publishError = (e as Error).message
      }
    }
    updateDraft(d => ({
      ...d, summary: '',
      comments: d.comments.map(c => sentIds.has(c.id) ? { ...c, sentAt: at, publishedAt: published.has(c.id) ? at : c.publishedAt ?? null } : c),
    }))
    setSending(null)
    setStatus(publishError
      ? { tone: 'error', text: `Ajana gönderildi, ama GitHub'da yayımlanamadı: ${publishError}` }
      : { tone: 'ok', text: published.size > 0 ? `Ajana gönderildi ve ${published.size} not GitHub'da yayımlandı.` : 'Notlar ajana gönderildi.' })
    if (published.size > 0) setReload(n => n + 1)
  }

  const jump = useCallback((comment: ReviewComment) => {
    if (comment.source !== source) { setSource(comment.source as Source); setPendingJump(comment); return }
    setPendingJump(comment)
  }, [source])
  useEffect(() => {
    if (!pendingJump || loading || loaded?.source !== pendingJump.source) return
    const comment = pendingJump
    setPendingJump(null)
    if (comment.path === null) return
    const id = fileKey(comment.repo, { path: comment.path })
    openFile(id)
    window.setTimeout(() => {
      const card = document.getElementById(`review-comment-${comment.id}`)
      if (card && scroller.current) {
        scroller.current.scrollTo({ top: card.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top + scroller.current.scrollTop - 120, behavior: 'smooth' })
        card.classList.add('flash')
        window.setTimeout(() => card.classList.remove('flash'), 1200)
      }
    }, 120)
  }, [pendingJump, loading, loaded, openFile])

  const focused = single ? singleId : current
  const onStep = target.kind === 'project' ? target.onStep : undefined
  // Klavye (bkz. KEYS): yazı alanında, açık pencerede veya menüde çalışmaz.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const el = event.target as HTMLElement | null
      if (el && (el.closest('input, textarea, select, [contenteditable], .xterm') || document.querySelector('dialog[open], [role=menu]'))) return
      const ids = visible.map(v => v.id)
      const index = focused ? ids.indexOf(focused) : -1
      const act = (fn: () => void) => { event.preventDefault(); fn() }
      switch (event.key) {
        case 'j': case 'k': {
          const next = ids[Math.max(0, Math.min(ids.length - 1, index + (event.key === 'j' ? 1 : -1)))]
          if (next) act(() => openFile(next))
          return
        }
        case 'n': { const next = nextUnviewed(ids, viewed, focused); if (next) act(() => openFile(next)); return }
        case 'v': if (focused) act(() => toggleViewed(focused)); return
        case 'x': if (focused && !single) act(() => toggleCollapsed(focused)); return
        case 's': act(() => updatePrefs({ fileMode: single ? 'all' : 'single' })); return
        case 'h': act(() => updatePrefs({ hideViewed: !prefs.hideViewed })); return
        case 'f': act(() => setFocus(on => !on)); return
        case '[': case ']': if (onStep) act(() => onStep(event.key === ']' ? 1 : -1)); return
        case '?': act(() => setHelp(true)); return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, focused, viewed, single, prefs.hideViewed, openFile, toggleViewed, toggleCollapsed, updatePrefs, onStep])

  /**
   * Odak modu: uygulamanın kenar ve üst çubukları gizlenir, pencere tam ekrana
   * geçer. Esc veya tam ekrandan çıkış odağı kapatır; Esc uygulamaya
   * ulaşmaz, yoksa geldiğin sayfaya da dönülürdü.
   */
  useEffect(() => {
    if (!focus) return
    const root = document.documentElement
    root.dataset.reviewFocus = ''
    let entered = false
    if (!document.fullscreenElement && root.requestFullscreen) root.requestFullscreen().then(() => { entered = true }, () => {})
    const onChange = () => { if (entered && !document.fullscreenElement) setFocus(false) }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const el = event.target as HTMLElement | null
      if (el?.closest('input, textarea, select, .xterm') || document.querySelector('dialog[open], [role=menu]')) return
      event.preventDefault()
      event.stopPropagation()
      setFocus(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    window.addEventListener('keydown', onKey, true)
    return () => {
      delete root.dataset.reviewFocus
      document.removeEventListener('fullscreenchange', onChange)
      window.removeEventListener('keydown', onKey, true)
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    }
  }, [focus])

  const showPrMenu = (origin: HTMLElement) => {
    const rect = origin.getBoundingClientRect()
    setPrMenu({ position: { x: rect.left, y: rect.bottom + 4, origin }, list: null, error: null })
    api.listPullRequests(session!.id)
      .then(({ pullRequests }) => setPrMenu(menu => menu && { ...menu, list: pullRequests }))
      .catch(e => setPrMenu(menu => menu && { ...menu, error: e.message, list: [] }))
  }
  const prActions: MenuAction[] = prMenu === null ? [] : prMenu.list === null
    ? [{ label: 'PR\'lar okunuyor…', icon: 'refresh', run: () => {}, disabled: true }]
    : [
        ...prMenu.list.map(pr => ({
          label: `#${pr.number} ${pr.title}`, icon: 'branch' as const, run: () => setSource(`pr:${pr.number}`),
          description: `${pr.headRefName} → ${pr.baseRefName}${pr.author ? ` · @${pr.author}` : ''}`, hint: pr.isDraft ? 'taslak' : undefined,
        })),
        ...(prMenu.list.length === 0 ? [{ label: prMenu.error ?? 'Açık PR yok', icon: 'alert' as const, run: () => {}, disabled: true }] : []),
        ...(github?.pullRequest ? [{ label: 'PR\'ı GitHub\'da aç', icon: 'external' as const, divider: true, run: () => window.open(github.pullRequest!.url, '_blank', 'noreferrer') }] : []),
      ]

  // Taslak/hazır geçişi GitHub'da yapılır; ardından PR, oturumun PR durumu ve proje listesi yenilenir.
  const setDraft = async (number: number, draft: boolean) => {
    await (session ? api.setPullRequestDraft(session.id, number, draft) : api.setProjectPullRequestDraft(projectId!, number, draft, prRepo))
    setReload(n => n + 1)
    setGithubReload(n => n + 1)
    if (target.kind === 'project') target.onChanged?.()
    setStatus({ tone: 'ok', text: draft ? `PR #${number} taslağa çevrildi.` : `PR #${number} incelemeye hazır işaretlendi.` })
  }

  const createPr = async (input: { title: string; body: string; base: string; draft: boolean }) => {
    setCreating({ busy: true, error: null })
    try {
      const { pullRequest } = await api.createPullRequest(session!.id, { repo: '.', ...input })
      setCreating(null)
      setGithub(g => g && { ...g, pullRequest })
      setSource(`pr:${pullRequest.number}`)
      setStatus({ tone: 'ok', text: `PR #${pullRequest.number} açıldı.` })
    } catch (e) {
      setCreating({ busy: false, error: (e as Error).message })
    }
  }

  const visibleIds = useMemo(() => new Set(visible.map(v => v.id)), [visible])
  const totals = useMemo(() => allFiles.reduce((sum, { file }) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 }), [allFiles])
  const treeRepos: TreeRepo[] = useMemo(() => repos.map(repo => {
    const files = repo.files.map((file, i) => ({ file, id: repo.ids[i] })).filter(({ id }) => visibleIds.has(id))
    return { path: repo.path, label: repo.path === '.' ? repo.branch : repo.path, files, tree: fileTree(files.map(f => f.file.path)) }
  }), [repos, visibleIds])
  const uncommitted = loaded?.kind === 'local' ? loaded.result.repos.some(r => r.status !== '') : null
  const pr = github?.pullRequest ?? null
  const canCreatePr = github?.state === 'ready' && !pr && github.branch !== null && github.branch !== github.defaultBranch

  const singleIndex = singleId ? visible.findIndex(v => v.id === singleId) : -1
  const prevFile = singleIndex > 0 ? visible[singleIndex - 1] : null
  const nextFile = singleIndex !== -1 && singleIndex < visible.length - 1 ? visible[singleIndex + 1] : null
  const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

  return <div className={`diff-view review-view${prefs.tree ? '' : ' no-tree'}${prefs.panel ? '' : ' no-panel'}${focus ? ' focus-mode' : ''}`}>
    <div className="diff-bar">
      {focus && onStep && <div className="pr-step-inline" role="group" aria-label="PR'lar arasında geç">
        <button className="icon-button ghost" onClick={() => onStep(-1)} title="Önceki PR · [" aria-label="Önceki PR"><Icon name="back" size={14} /></button>
        <strong>PR #{prNumber}</strong>
        <button className="icon-button ghost" onClick={() => onStep(1)} title="Sonraki PR · ]" aria-label="Sonraki PR"><Icon name="chevron" size={14} /></button>
      </div>}
      {session && <div className="tabs" aria-label="İncelenen fark" role="group">
        {session.isolation === 'worktree' && <button className={source === 'work' ? 'on' : ''} aria-pressed={source === 'work'} onClick={() => setSource('work')} title="Oturum başladığından beri bütün değişiklikler">Bu çalışma</button>}
        <button className={source === 'uncommitted' ? 'on' : ''} aria-pressed={source === 'uncommitted'} onClick={() => setSource('uncommitted')} title="Son commit'ten sonraki değişiklikler">Commit edilmemiş</button>
        {githubCapable && (pr
          ? <button className={source === `pr:${pr.number}` ? 'on' : ''} aria-pressed={source === `pr:${pr.number}`} onClick={() => setSource(`pr:${pr.number}`)} title={pr.title}>
              <Icon name="branch" size={13} />PR #{pr.number}
            </button>
          : prNumber !== null && <button className="on" aria-pressed="true"><Icon name="branch" size={13} />PR #{prNumber}</button>)}
      </div>}
      {githubCapable && <>
        {canCreatePr && <button className="ghost-button" onClick={() => setCreating({ busy: false, error: null })} title="Bu branch'ten GitHub'da pull request aç"><Icon name="plus" size={13} />PR aç</button>}
        <button className="icon-button ghost" disabled={github?.state !== 'ready'} title={github?.state === 'ready' ? 'Başka bir PR incele' : github?.message ?? 'GitHub durumu okunuyor…'} aria-label="PR seç" onClick={e => showPrMenu(e.currentTarget)}>
          <Icon name="list" size={14} />
        </button>
      </>}
      <span className="diff-summary">
        <span>{allFiles.length} dosya</span>
        {allFiles.length > 0 && <><b>+{totals.added}</b><i>−{totals.removed}</i></>}
        {allFiles.length > 0 && <span className="viewed-progress" title={`${viewed.size}/${allFiles.length} dosya görüldü`}>
          <span className="bar"><span style={{ width: `${(viewed.size / allFiles.length) * 100}%` }} /></span>{viewed.size}/{allFiles.length}
        </span>}
      </span>
      <span className="topbar-spacer" />
      <div className="tabs" role="group" aria-label="Dosya gösterimi">
        <button className={!single ? 'on' : ''} aria-pressed={!single} onClick={() => updatePrefs({ fileMode: 'all' })} title="Bütün dosyalar alt alta · S">Tüm dosyalar</button>
        <button className={single ? 'on' : ''} aria-pressed={single} onClick={() => updatePrefs({ fileMode: 'single' })} title="Yalnız seçili dosya · S">Tek dosya</button>
      </div>
      <div className="tabs" role="group" aria-label="Fark düzeni">
        <button className={`icon-tab${prefs.layout === 'unified' ? ' on' : ''}`} aria-pressed={prefs.layout === 'unified'} onClick={() => updatePrefs({ layout: 'unified' })} title="Birleşik fark" aria-label="Birleşik"><Icon name="rows" size={14} /></button>
        <button className={`icon-tab${prefs.layout === 'split' ? ' on' : ''}`} aria-pressed={prefs.layout === 'split'} onClick={() => updatePrefs({ layout: 'split' })} title="Yan yana fark" aria-label="Yan yana"><Icon name="columns" size={14} /></button>
      </div>
      <button className="icon-button ghost" aria-pressed={prefs.wrap} title="Uzun satırları sar" aria-label="Satırları sar" onClick={() => updatePrefs({ wrap: !prefs.wrap })} disabled={prefs.layout === 'split'}><Icon name="wrap" size={14} /></button>
      <button className="icon-button ghost" aria-pressed={prefs.tree} title="Dosya ağacı" aria-label="Dosya ağacını göster" onClick={() => updatePrefs({ tree: !prefs.tree })}><Icon name="sidebar" size={14} /></button>
      <button className="icon-button ghost" title="Yenile" aria-label="Değişiklikleri yenile" onClick={() => { setReload(n => n + 1); setGithubReload(n => n + 1) }} disabled={loading}><Icon name="refresh" size={14} /></button>
      <button className="icon-button ghost" title="Klavye kısayolları · ?" aria-label="Klavye kısayolları" onClick={() => setHelp(true)}><Icon name="command" size={14} /></button>
      <button className={`icon-button ghost focus-toggle${focus ? ' on' : ''}`} aria-pressed={focus} title={focus ? 'Odaktan çık · Esc' : 'Odak modu: tam ekran inceleme · F'} aria-label={focus ? 'Odaktan çık' : 'Odak modu'} onClick={() => setFocus(!focus)}>
        <Icon name={focus ? 'minimize' : 'maximize'} size={14} />
      </button>
      <button className={`review-toggle${prefs.panel ? ' on' : ''}`} aria-pressed={prefs.panel} onClick={() => updatePrefs({ panel: !prefs.panel })} title="İnceleme notları">
        <Icon name="chat" size={14} />Notlar{pending.length > 0 && <span className="count">{pending.length}</span>}
      </button>
    </div>

    <div className="review-body">
      {prefs.tree && <div className="review-tree">
        <div className="review-tree-search"><Icon name="search" size={13} /><input aria-label="Değişen dosya ara" placeholder="Dosya filtrele…" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <div className="review-tree-actions">
          <span className="muted">{viewed.size}/{allFiles.length} görüldü</span>
          <button className="icon-button ghost" aria-pressed={prefs.hideViewed} onClick={() => updatePrefs({ hideViewed: !prefs.hideViewed })}
            title={prefs.hideViewed ? 'Görülenleri göster · H' : 'Görülenleri gizle · H'} aria-label="Görülen dosyaları gizle"><Icon name="check" size={13} /></button>
          {!single && <>
            <button className="icon-button ghost" onClick={() => setCollapsed(new Set(allFiles.map(f => f.id)))} title="Bütün dosyaları kapat" aria-label="Bütün dosyaları kapat"><Icon name="minimize" size={13} /></button>
            <button className="icon-button ghost" onClick={() => setCollapsed(new Set())} title="Bütün dosyaları aç" aria-label="Bütün dosyaları aç"><Icon name="maximize" size={13} /></button>
          </>}
        </div>
        <DiffFileTree repos={treeRepos} current={focused} viewed={viewed} notes={noteCounts} onOpen={openFile} />
      </div>}

      <div className="review-scroll" ref={scroller}>
        {!prefs.tree && <input className="inline-filter" aria-label="Değişen dosya ara" placeholder="Dosya filtrele…" value={query} onChange={e => setQuery(e.target.value)} />}
        {session?.isolation === 'shared' && prNumber === null && <p className="review-note">Proje klasöründeki ortak değişiklikler. Aynı klasördeki diğer terminaller de bu dosyaları kullanır.</p>}
        {detail && <PullRequestHeader detail={detail} onDraft={setDraft} />}
        {loading && !loaded && <div className="diff-skeleton" role="status" aria-label="Değişiklikler okunuyor">{[0, 1, 2].map(i => <span key={i} />)}</div>}
        {error && <p className="error" role="alert">{error}</p>}
        {loaded?.kind === 'local' && loaded.result.truncated && <p className="error">Depo taraması eksik; tüm depolar gösterilemiyor.</p>}
        {allViewed && <div className="review-done" role="status">
          <span className="review-done-icon" aria-hidden="true"><Icon name="check" size={18} /></span>
          <span className="review-done-text">
            <strong>Bütün dosyalar görüldü</strong>
            <small>{pending.length > 0 ? `${pending.length} not ajana gönderilmeyi bekliyor.` : 'Gönderilmeyi bekleyen not yok.'}</small>
          </span>
          {pending.length > 0 && <button className="primary" disabled={!delivery.ok} title={delivery.reason ?? undefined} onClick={openSend}><Icon name="terminal" size={13} />Notları ajana gönder</button>}
          <button className="ghost-button" onClick={resetViewed}>Görüldü işaretlerini sıfırla</button>
        </div>}
        {repos.map(repo => <section key={repo.path} className="diff-repo" hidden={single && !repo.ids.includes(singleId ?? '')}>
          {(repos.length > 1 || repo.baseCommit || loaded?.kind === 'local') && <header className="diff-repo-head">
            <Icon name="branch" size={13} /><strong>{repo.branch}</strong>{repo.path !== '.' && <span>{repo.path}</span>}
            {repo.baseCommit && source === 'work' && <code title="Başlangıç commit'i">{repo.baseCommit.slice(0, 8)}</code>}
          </header>}
          {repo.error && <p className="error">{repo.error}</p>}
          {repo.stale && <p className="error">Okuma sırasında HEAD değişti; yenileyin.</p>}
          {repo.status && <details className="git-status-details"><summary>Git durumu (git status)</summary><pre>{repo.status}</pre></details>}
          {repo.files.map((file, i) => {
            const id = repo.ids[i]
            if (!visibleIds.has(id) || (single && id !== singleId)) return null
            return <DiffFileView key={id} file={file} fileId={id} layout={prefs.layout} wrap={prefs.wrap} pinned={single}
              collapsed={!single && collapsed.has(id)} viewed={viewed.has(id)} comments={placed.get(id) ?? EMPTY_PLACED} threads={threads.get(id) ?? EMPTY_THREADS}
              canComment instant={prefs.instant} onToggleCollapsed={toggleCollapsed} onToggleViewed={toggleViewed}
              onAdd={addComment} onEdit={editComment} onDelete={deleteComment} onForward={forwardThread} forwarded={forwarded} />
          })}
          {repo.empty && <div className="diff-clean"><Icon name="check" size={16} /><span>{repo.status ? 'Net fark boş. Ayrıntı için yukarıdaki Git durumuna bakın.' : 'Değişiklik yok.'}</span></div>}
          {repo.truncated && <p className="error">Sonuç boyut sınırında kesildi; tüm değişiklikler gösterilemiyor. Tamamını yerel Git ile inceleyin.</p>}
        </section>)}
        {single && singleId && <nav className="single-nav" aria-label="Dosyalar arasında geç">
          <button className="ghost-button" disabled={!prevFile} onClick={() => prevFile && openFile(prevFile.id)} title="Önceki dosya · K">
            <Icon name="back" size={13} /><span>{prevFile ? baseName(prevFile.file.path) : 'Önceki'}</span>
          </button>
          <span className="single-count">{singleIndex + 1} / {visible.length}</span>
          <button className={viewed.has(singleId) ? 'ghost-button' : 'primary'} onClick={() => toggleViewed(singleId)}>
            <Icon name="check" size={13} />{viewed.has(singleId) ? 'Görülmedi yap' : 'Görüldü, sıradaki'}<kbd>V</kbd>
          </button>
          <button className="ghost-button" disabled={!nextFile} onClick={() => nextFile && openFile(nextFile.id)} title="Sonraki dosya · J">
            <span>{nextFile ? baseName(nextFile.file.path) : 'Sonraki'}</span><Icon name="chevron" size={13} />
          </button>
        </nav>}
        {allFiles.length > 0 && visible.length === 0 && !allViewed && <p className="pad muted">Bu filtreyle eşleşen dosya yok.</p>}
        {allFiles.length > 0 && <p className="review-keys muted">
          <kbd>J</kbd>/<kbd>K</kbd> dosyalar · <kbd>V</kbd> görüldü ve sıradaki · <kbd>S</kbd> tek dosya · <kbd>F</kbd> odak · <kbd>?</kbd> bütün kısayollar · satır numarasındaki <span className="kbd-plus">+</span> not ekler
        </p>}
      </div>

      {prefs.panel && <ReviewPanel comments={scoped} current={source} summary={draft.summary}
        onSummary={summary => updateDraft(d => ({ ...d, summary }))} delivery={delivery} instant={prefs.instant} submit={prefs.submit}
        onPrefs={updatePrefs} onJump={jump} onDelete={deleteComment}
        onClearSent={() => updateDraft(d => ({ ...d, comments: d.comments.filter(c => c.sentAt === null) }))}
        onSend={openSend} github={githubCapable ? github : null} notes={detail?.notes ?? null} forwardedNotes={forwardedNotes}
        onForwardNote={forwardNote} onClose={() => updatePrefs({ panel: false })} status={status}
        picker={target.kind === 'project' ? { sessions: candidates, selected: receiver?.id ?? null, onSelect: setTargetId, onStartAgent: target.onStartAgent } : null} />}
    </div>

    {help && <ShortcutHelp project={Boolean(onStep)} onClose={() => setHelp(false)} />}
    {prMenu && <ActionMenu position={prMenu.position} actions={prActions} label="Pull request'ler" onClose={() => setPrMenu(null)} />}
    {sending && <SendDialog initial={sending.text} target={delivery.target} submit={prefs.submit} busy={sending.busy} error={sending.error}
      publishable={prNumber !== null ? { count: publishable.length, pr: prNumber } : null}
      onSend={(text, options) => void confirmSend(text, options)} onCancel={() => setSending(null)} />}
    {creating && github?.branch && <CreatePullRequestDialog branch={github.branch} defaultBase={github.defaultBranch ?? 'main'} initialTitle={session?.name ?? ''}
      uncommitted={uncommitted} busy={creating.busy} error={creating.error} onCreate={input => void createPr(input)} onCancel={() => setCreating(null)} />}
  </div>
}

/** Dosyalar ağaçtaki sırayla listelenir: klasörler önce, sonra ada göre. */
function ordered(files: DiffFile[]): DiffFile[] {
  return treeOrder(fileTree(files.map(f => f.path))).map(i => files[i])
}

/** İnceleme kısayolları; yazı alanında ve açık pencerede çalışmazlar. */
/** combo: tuşlar birlikte basılır (+); yoksa seçeneklerdir (/). */
const KEYS: { keys: string[]; label: string; project?: true; combo?: true }[] = [
  { keys: ['J', 'K'], label: 'Sonraki / önceki dosya' },
  { keys: ['N'], label: 'Sıradaki görülmemiş dosya' },
  { keys: ['V'], label: 'Görüldü işaretle ve sıradakine geç' },
  { keys: ['X'], label: 'Dosyayı kapat / aç (tüm dosyalar)' },
  { keys: ['S'], label: 'Tek dosya / tüm dosyalar' },
  { keys: ['H'], label: 'Görülenleri gizle / göster' },
  { keys: ['F'], label: 'Odak modu (tam ekran)' },
  { keys: ['[', ']'], label: 'Önceki / sonraki PR', project: true },
  { keys: ['Shift', 'tık'], label: 'Satır aralığı seçerek not', combo: true },
  { keys: ['Ctrl', 'Enter'], label: 'Notu kaydet', combo: true },
  { keys: ['Esc'], label: 'Notu bırak · odaktan çık · geri dön' },
]

function ShortcutHelp({ project, onClose }: { project: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="session-modal" aria-labelledby="keys-title" onCancel={e => { e.preventDefault(); onClose() }}
    onClick={e => { if (e.target === dialog.current) onClose() }}>
    <div className="dialog keys-dialog">
      <header className="dialog-head"><h2 id="keys-title">İnceleme kısayolları</h2></header>
      <dl className="keys-list">
        {KEYS.filter(k => project || !k.project).map(k => <div key={k.label}>
          <dt>{k.keys.map((key, i) => <span key={key}>{i > 0 && (k.combo ? '+' : ' / ')}<kbd>{key}</kbd></span>)}</dt>
          <dd>{k.label}</dd>
        </div>)}
      </dl>
      <div className="dialog-actions"><button type="button" autoFocus onClick={onClose}>Kapat</button></div>
    </div>
  </dialog>
}

const EMPTY_PLACED: PlacedComment[] = []
const EMPTY_THREADS: GithubThread[] = []

function PullRequestHeader({ detail, onDraft }: { detail: PullRequestDetail; onDraft: (number: number, draft: boolean) => Promise<void> }) {
  const pr = detail.pullRequest
  const state = pr.isDraft && pr.state === 'OPEN' ? 'draft' : pr.state.toLowerCase()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = () => {
    setBusy(true); setError(null)
    onDraft(pr.number, !pr.isDraft).catch(e => setError((e as Error).message)).finally(() => setBusy(false))
  }
  return <header className="pr-header">
    <div className="pr-title-row">
      <span className={`pr-state ${state}`}><Icon name="branch" size={12} />{pr.isDraft && pr.state === 'OPEN' ? 'Taslak' : PR_STATE[pr.state]}</span>
      <h2><span className="pr-number">#{pr.number}</span> {pr.title}</h2>
      {pr.state === 'OPEN' && (pr.isDraft
        ? <button className="primary pr-ready" disabled={busy} onClick={toggle} title="Taslağı kaldırır; inceleyicilere bildirim gider">
            <Icon name={busy ? 'refresh' : 'check'} size={13} />{busy ? 'Güncelleniyor…' : 'İncelemeye hazır'}
          </button>
        : <button className="ghost-button pr-to-draft" disabled={busy} onClick={toggle} title="PR'ı taslağa çevirir; birleştirme kapanır">
            <Icon name={busy ? 'refresh' : 'edit'} size={13} />{busy ? 'Güncelleniyor…' : 'Taslağa çevir'}
          </button>)}
      <a className="ghost-button pr-link" href={pr.url} target="_blank" rel="noreferrer"><Icon name="external" size={13} />GitHub'da aç</a>
    </div>
    {pr.isDraft && pr.state === 'OPEN' && <p className="pr-draft-note"><Icon name="edit" size={12} />Bu PR taslak: inceleme istenmez ve birleştirilemez. Hazır olunca işaretle.</p>}
    {error && <p className="error pr-error" role="alert">{error}</p>}
    <div className="pr-meta">
      <code>{pr.baseRefName}</code><span aria-hidden="true">←</span><code>{pr.headRefName}</code>
      {pr.author && <span>@{pr.author}</span>}
      <span className="diff-stats"><b>+{pr.additions}</b><i>−{pr.deletions}</i></span>
      <span>{pr.changedFiles} dosya</span>
      {pr.reviewDecision && <span className={`review-state ${pr.reviewDecision === 'APPROVED' ? 'sent' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'draft'}`}>{DECISION[pr.reviewDecision] ?? pr.reviewDecision}</span>}
      {detail.comments.length > 0 && <span><Icon name="chat" size={12} /> {detail.comments.length} satır yorumu</span>}
    </div>
    {pr.body.trim() && <details className="pr-body"><summary>Açıklama</summary><p>{pr.body}</p></details>}
  </header>
}
