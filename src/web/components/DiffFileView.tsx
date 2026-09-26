import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DiffFile, DiffLine } from '../../shared/diffFiles'
import { codeText, hunkContext, intralineSpans, isShownMeta, pairChanges, splitRows, type Span } from '../../shared/diffLayout'
import type { ReviewComment, ReviewSide } from '../../shared/review'
import type { PullRequestComment } from '../../shared/types'
import { Icon } from './Icon'

export const CHANGE_LETTER = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' } as const
const CHANGE_TITLE = { added: 'Yeni dosya', deleted: 'Silinen dosya', renamed: 'Taşınan dosya', modified: 'Değişen dosya' } as const

/** Kullanıcının satır(lar) seçip yazmaya başladığı not; indeksler file.lines içindedir. */
interface Selection { start: number; end: number; side: ReviewSide }

export interface NewComment {
  path: string
  side: ReviewSide
  startLine: number | null
  line: number | null
  snippet: string[]
  body: string
}

/** GitHub satır yorumu ve ona verilen yanıtlar. */
export interface GithubThread { root: PullRequestComment; replies: PullRequestComment[] }

export interface PlacedComment { comment: ReviewComment; index: number; outdated: boolean }

interface Props {
  file: DiffFile
  fileId: string
  layout: 'unified' | 'split'
  wrap: boolean
  collapsed: boolean
  viewed: boolean
  comments: PlacedComment[]
  threads: GithubThread[]
  canComment: boolean
  instant: boolean
  onToggleCollapsed: (fileId: string) => void
  onToggleViewed: (fileId: string) => void
  onAdd: (fileId: string, comment: NewComment) => void
  onEdit: (id: string, body: string) => void
  onDelete: (id: string) => void
  onForward: (thread: GithubThread) => void
  forwarded: Set<number>
}

const sideOf = (line: DiffLine): ReviewSide => line.kind === 'del' ? 'old' : 'new'
const numberOn = (line: DiffLine, side: ReviewSide) => side === 'new' ? line.next : line.kind === 'del' ? line.old : null

function Code({ text, spans, kind }: { text: string; spans: Span[] | undefined; kind: string }) {
  if (!spans || spans.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let at = 0
  spans.forEach((span, i) => {
    if (span.start > at) parts.push(text.slice(at, span.start))
    parts.push(<mark key={i} className={`word-${kind}`}>{text.slice(span.start, span.end)}</mark>)
    at = span.end
  })
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

function when(iso: string): string {
  const time = Date.parse(iso)
  return Number.isNaN(time) ? '' : new Date(time).toLocaleString('tr', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Not yazma kutusu: Ctrl+Enter kaydeder, Esc vazgeçer. */
export function Composer({ initial, label, submitLabel, onSubmit, onCancel }: {
  initial: string
  label: string
  submitLabel: string
  onSubmit: (body: string) => void
  onCancel: () => void
}) {
  const [body, setBody] = useState(initial)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { area.current?.focus(); area.current?.setSelectionRange(initial.length, initial.length) }, [initial])
  const submit = () => { if (body.trim()) onSubmit(body.trim()) }
  return <div className="review-composer" onClick={e => e.stopPropagation()}>
    <textarea ref={area} aria-label={label} placeholder="Ajana ne yapmasını istiyorsun? Markdown kullanılabilir." value={body} rows={3}
      onChange={e => setBody(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
      }} />
    <div className="review-composer-actions">
      <span className="muted"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> kaydet · <kbd>Esc</kbd> vazgeç</span>
      <button type="button" className="ghost-button" onClick={onCancel}>Vazgeç</button>
      <button type="button" className="primary" disabled={!body.trim()} onClick={submit}>{submitLabel}</button>
    </div>
  </div>
}

function CommentCard({ placed, onEdit, onDelete }: { placed: PlacedComment; onEdit: (id: string, body: string) => void; onDelete: (id: string) => void }) {
  const [editing, setEditing] = useState(false)
  const { comment } = placed
  if (editing) return <Composer initial={comment.body} label="Notu düzenle" submitLabel="Kaydet" onCancel={() => setEditing(false)} onSubmit={body => { onEdit(comment.id, body); setEditing(false) }} />
  return <article className="review-card mine" data-sent={comment.sentAt !== null || undefined} id={`review-comment-${comment.id}`}>
    <header>
      <span className="review-avatar" aria-hidden="true"><Icon name="edit" size={11} /></span>
      <strong>Notun</strong>
      {comment.line !== null && comment.startLine !== null && comment.startLine !== comment.line && <span className="muted">satır {comment.startLine}–{comment.line}</span>}
      {placed.outdated && <span className="badge warn" title="Yorumlanan satır farkta artık yok">eskimiş</span>}
      <span className={`review-state ${comment.sentAt !== null ? 'sent' : 'draft'}`}>{comment.sentAt !== null ? 'Ajana gitti' : 'Taslak'}</span>
      {comment.publishedAt ? <span className="review-state sent">GitHub'da</span> : null}
      <span className="review-card-tools">
        <button className="icon-button ghost" title="Düzenle" aria-label="Notu düzenle" onClick={() => setEditing(true)}><Icon name="edit" size={13} /></button>
        <button className="icon-button ghost" title="Sil" aria-label="Notu sil" onClick={() => onDelete(comment.id)}><Icon name="trash" size={13} /></button>
      </span>
    </header>
    <p>{comment.body}</p>
  </article>
}

function ThreadCard({ thread, forwarded, onForward }: { thread: GithubThread; forwarded: boolean; onForward: (thread: GithubThread) => void }) {
  return <article className="review-card github">
    {[thread.root, ...thread.replies].map(c => <div className="review-thread-item" key={c.id}>
      <header>
        <span className="review-avatar gh" aria-hidden="true">{c.author.slice(0, 1).toUpperCase()}</span>
        <strong>@{c.author}</strong>
        <span className="muted">{when(c.createdAt)}</span>
        {c === thread.root && <span className="review-card-tools">
          <a className="icon-button ghost" href={c.url} target="_blank" rel="noreferrer" title="GitHub'da aç" aria-label="GitHub'da aç"><Icon name="external" size={13} /></a>
        </span>}
      </header>
      <p>{c.body}</p>
    </div>)}
    <footer>
      <button className="ghost-button" disabled={forwarded} onClick={() => onForward(thread)}>
        <Icon name={forwarded ? 'check' : 'terminal'} size={13} />{forwarded ? 'Notlarına eklendi' : 'Ajana iletilecek notlara ekle'}
      </button>
    </footer>
  </article>
}

export const DiffFileView = memo(function DiffFileView(props: Props) {
  const { file, fileId, layout, wrap, collapsed, viewed, comments, threads, canComment } = props
  const [selection, setSelection] = useState<Selection | null>(null)
  const anchor = useRef<number | null>(null)

  const intraline = useMemo(() => {
    const result = new Map<number, Span[]>()
    const pairs = pairChanges(file.lines)
    for (const [i, j] of pairs) {
      if (file.lines[i].kind !== 'del') continue
      const spans = intralineSpans(codeText(file.lines[i]), codeText(file.lines[j]))
      if (spans) { result.set(i, spans.old); result.set(j, spans.next) }
    }
    return result
  }, [file])
  const rows = useMemo(() => layout === 'split' ? splitRows(file.lines) : null, [file, layout])

  const byLine = useMemo(() => {
    const map = new Map<number, { mine: PlacedComment[]; threads: GithubThread[] }>()
    const at = (i: number) => { let entry = map.get(i); if (!entry) { entry = { mine: [], threads: [] }; map.set(i, entry) }; return entry }
    for (const placed of comments) if (placed.index >= 0) at(placed.index).mine.push(placed)
    for (const thread of threads) {
      const i = file.lines.findIndex(line => thread.root.line !== null && numberOn(line, thread.root.side) === thread.root.line)
      at(i).threads.push(thread)
    }
    return map
  }, [comments, threads, file])
  const fileLevel = comments.filter(placed => placed.index < 0)
  const orphanThreads = byLine.get(-1)?.threads ?? []

  const pick = (index: number, extend: boolean) => {
    if (!canComment) return
    const line = file.lines[index]
    const side = sideOf(line)
    if (extend && anchor.current !== null && selection && selection.side === side) {
      setSelection({ start: Math.min(anchor.current, index), end: Math.max(anchor.current, index), side })
      return
    }
    anchor.current = index
    setSelection({ start: index, end: index, side })
  }
  const inSelection = (index: number) => selection !== null && index >= selection.start && index <= selection.end &&
    numberOn(file.lines[index], selection.side) !== null

  const save = (body: string) => {
    if (!selection) return
    const picked = file.lines.slice(selection.start, selection.end + 1).filter(line => numberOn(line, selection.side) !== null)
    if (picked.length === 0) return
    props.onAdd(fileId, {
      path: file.path,
      side: selection.side,
      startLine: numberOn(picked[0], selection.side),
      line: numberOn(picked[picked.length - 1], selection.side),
      snippet: picked.map(codeText),
      body,
    })
    setSelection(null)
    anchor.current = null
  }
  const [fileComposer, setFileComposer] = useState(false)

  const gutterButton = (index: number) => canComment && (file.lines[index].kind === 'add' || file.lines[index].kind === 'del' || file.lines[index].kind === 'context') &&
    <button className="line-comment" tabIndex={-1} title="Not ekle · Shift+tık ile aralık seç" aria-label={file.lines[index].kind === 'del' ? `Silinen satır ${file.lines[index].old} için not ekle` : `Satır ${file.lines[index].next} için not ekle`}
      onClick={e => { e.stopPropagation(); pick(index, e.shiftKey) }}><Icon name="plus" size={12} /></button>

  const annotations = (index: number) => {
    const entry = byLine.get(index)
    const composing = selection !== null && selection.end === index
    if (!entry && !composing) return null
    return <div className="diff-annotations">
      {entry?.threads.map(thread => <ThreadCard key={thread.root.id} thread={thread} forwarded={props.forwarded.has(thread.root.id)} onForward={props.onForward} />)}
      {entry?.mine.map(placed => <CommentCard key={placed.comment.id} placed={placed} onEdit={props.onEdit} onDelete={props.onDelete} />)}
      {composing && <Composer initial="" label="Satır notu"
        submitLabel={props.instant ? 'Ekle ve ajana gönder' : 'Not ekle'}
        onCancel={() => { setSelection(null); anchor.current = null }} onSubmit={save} />}
    </div>
  }

  const unifiedLine = (line: DiffLine, index: number) => {
    if (line.kind === 'hunk') return <div className="dl hunk" key={index}><span className="dl-hunk-range">{line.text.match(/^@@[^@]*@@/)?.[0]}</span><span className="dl-hunk-context">{hunkContext(line.text)}</span></div>
    if (line.kind === 'meta') return <div className="dl meta" key={index}><code>{line.text}</code></div>
    return <div key={index}>
      <div className={`dl ${line.kind}${inSelection(index) ? ' selected' : ''}`} onClick={e => { if (e.shiftKey && selection) pick(index, true) }}>
        <span className="ln" aria-hidden="true">{line.old}</span>
        <span className="ln" aria-hidden="true">{line.next}</span>
        {gutterButton(index)}
        <code><span className="dl-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span><Code text={codeText(line)} spans={intraline.get(index)} kind={line.kind} /></code>
      </div>
      {annotations(index)}
    </div>
  }

  const splitSide = (index: number | null, side: 'left' | 'right') => {
    if (index === null) return <><span className="ln empty" /><code className="empty" /></>
    const line = file.lines[index]
    const kind = line.kind === 'context' ? 'context' : line.kind
    return <>
      <span className={`ln ${kind}${inSelection(index) ? ' selected' : ''}`} aria-hidden="true">{side === 'left' ? line.old : line.next}</span>
      <code className={`${kind}${inSelection(index) ? ' selected' : ''}`} onClick={e => { if (e.shiftKey && selection) pick(index, true) }}>
        {gutterButton(index)}
        <Code text={codeText(line)} spans={intraline.get(index)} kind={line.kind} />
      </code>
    </>
  }

  const body = () => {
    if (file.binary) return <p className="diff-empty-note">İkili dosya; içerik gösterilmiyor.</p>
    if (rows) return <div className="diff-split">{rows.map((row, i) => {
      if (row.kind === 'hunk') return <div className="dl hunk split-full" key={i}><span className="dl-hunk-range">{file.lines[row.index].text.match(/^@@[^@]*@@/)?.[0]}</span><span className="dl-hunk-context">{hunkContext(file.lines[row.index].text)}</span></div>
      if (row.kind === 'meta') return <div className="dl meta split-full" key={i}><code>{file.lines[row.index].text}</code></div>
      // Bağlam satırında not sağ (yeni) tarafa bağlıdır; iki tarafın notu satırın altında birlikte görünür.
      const noteRows = [row.left, row.right].filter((index, k, all): index is number => index !== null && all.indexOf(index) === k)
      return <div key={i}>
        <div className="split-row">{splitSide(row.left, 'left')}{splitSide(row.right, 'right')}</div>
        {noteRows.map(index => <div key={index}>{annotations(index)}</div>)}
      </div>
    })}</div>
    return <div className="diff-unified">{file.lines.map((line, index) => isShownMeta(line) ? unifiedLine(line, index) : null)}</div>
  }

  const slash = file.path.lastIndexOf('/')
  const dir = slash === -1 ? '' : file.path.slice(0, slash + 1)
  const name = file.path.slice(slash + 1)
  const total = file.added + file.removed
  const addBlocks = total === 0 ? 0 : Math.round((file.added / total) * 5)
  const blocks = Array.from({ length: 5 }, (_, i) => total === 0 ? 'none' : i < addBlocks ? 'add' : 'del')
  const noteCount = comments.length + threads.length

  return <section className={`diff-file${viewed ? ' viewed' : ''}`} data-file-id={fileId} aria-label={file.path}>
    <header className="diff-file-heading">
      <button className="diff-file-toggle" aria-expanded={!collapsed} onClick={() => props.onToggleCollapsed(fileId)} title={collapsed ? 'Aç' : 'Kapat'}>
        <Icon name="chevron" size={13} />
      </button>
      <span className={`change-letter ${file.change}`} title={CHANGE_TITLE[file.change]}>{CHANGE_LETTER[file.change]}</span>
      <button className="diff-file-path" onClick={() => props.onToggleCollapsed(fileId)} title={file.path}>
        <span className="dir">{dir}</span><span className="name">{name}</span>
      </button>
      {noteCount > 0 && <span className="chip note-chip" title={`${noteCount} not`}><Icon name="chat" size={11} />{noteCount}</span>}
      {!file.binary && <span className="diff-stats" title={`${file.added} ekleme, ${file.removed} silme`}>
        <b>+{file.added}</b><i>−{file.removed}</i>
        <span className="stat-blocks" aria-hidden="true">{blocks.map((b, i) => <span key={i} className={b} />)}</span>
      </span>}
      <button className="icon-button ghost" title="Yolu kopyala" aria-label="Dosya yolunu kopyala" onClick={() => void navigator.clipboard?.writeText(file.path)}><Icon name="copy" size={13} /></button>
      {canComment && <button className="icon-button ghost" title="Dosyaya genel not" aria-label="Dosyaya not ekle" onClick={() => { setFileComposer(true); if (collapsed) props.onToggleCollapsed(fileId) }}><Icon name="chat" size={13} /></button>}
      <label className="viewed-toggle" title="Görüldü olarak işaretle · V">
        <input type="checkbox" checked={viewed} onChange={() => props.onToggleViewed(fileId)} />Görüldü
      </label>
    </header>
    {!collapsed && <>
      {(fileLevel.length > 0 || fileComposer || orphanThreads.length > 0) && <div className="diff-annotations file-level">
        {orphanThreads.map(thread => <ThreadCard key={thread.root.id} thread={thread} forwarded={props.forwarded.has(thread.root.id)} onForward={props.onForward} />)}
        {fileLevel.map(placed => <CommentCard key={placed.comment.id} placed={placed} onEdit={props.onEdit} onDelete={props.onDelete} />)}
        {fileComposer && <Composer initial="" label="Dosya notu" submitLabel={props.instant ? 'Ekle ve ajana gönder' : 'Not ekle'} onCancel={() => setFileComposer(false)}
          onSubmit={text => { props.onAdd(fileId, { path: file.path, side: 'new', startLine: null, line: null, snippet: [], body: text }); setFileComposer(false) }} />}
      </div>}
      <div className={`diff-code${wrap || layout === 'split' ? ' wrap' : ''}`} role="region" aria-label={`${file.path} farkı`} tabIndex={0}>{body()}</div>
    </>}
  </section>
})
