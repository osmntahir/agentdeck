import { spawn } from 'node:child_process'
import type {
  GithubState,
  GithubStatus,
  PullRequestComment,
  PullRequestDetail,
  PullRequestNote,
  PullRequestSummary,
} from '../shared/types'

/**
 * GitHub erişimi kullanıcının `gh` CLI oturumu üzerinden yapılır. AgentDeck
 * token okumaz, saklamaz; yetki ve hesap `gh auth` kararıdır. Her çağrı süre
 * ve çıktı boyutuyla sınırlıdır; etkileşimli istem kapalıdır.
 */

const GH_TIMEOUT_MS = 20_000
const MAX_JSON_BYTES = 8 * 1024 * 1024
export const MAX_PR_DIFF_BYTES = 1024 * 1024

export class GithubError extends Error {
  constructor(readonly state: Exclude<GithubState, 'ready'>, message: string) {
    super(message)
    this.name = 'GithubError'
  }
}

/** gh hata metnini kullanıcıya gösterilecek duruma çevirir. */
export function classifyGhFailure(stderr: string): GithubError {
  const text = stderr.trim()
  if (/gh auth login|not logged in|authentication required|bad credentials|HTTP 401/i.test(text)) {
    return new GithubError('unauthenticated', 'GitHub oturumu yok. Terminalde `gh auth login` çalıştırın.')
  }
  if (/none of the git remotes|no git remotes|not a git repository|could not determine base repo|unable to determine|not a github/i.test(text)) {
    return new GithubError('not_github', 'Bu deponun GitHub uzak deposu bulunamadı.')
  }
  return new GithubError('error', text.split('\n').filter(Boolean).slice(-3).join(' ') || 'gh komutu başarısız oldu')
}

interface RunOptions {
  input?: string
  capBytes?: number
  timeoutMs?: number
  /** true: sınır aşılırsa hata yerine kesik çıktı döner. */
  allowTruncate?: boolean
}

async function run(bin: string, cwd: string, args: string[], options: RunOptions = {}): Promise<{ out: string; truncated: boolean }> {
  const cap = options.capBytes ?? MAX_JSON_BYTES
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0', GH_PAGER: '', GIT_TERMINAL_PROMPT: '0' },
    })
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs ?? GH_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      if (size + chunk.length > cap) {
        chunks.push(chunk.subarray(0, cap - size))
        size = cap
        truncated = true
        child.kill('SIGKILL')
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString() })
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(err.code === 'ENOENT'
        ? new GithubError('gh_missing', bin === 'gh' ? 'GitHub CLI (gh) kurulu değil. https://cli.github.com adresinden kurup `gh auth login` çalıştırın.' : `${bin} bulunamadı`)
        : err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new GithubError('error', `${bin} ${GH_TIMEOUT_MS / 1000} sn içinde yanıt vermedi`))
      if (truncated && !options.allowTruncate) return reject(new GithubError('error', 'GitHub yanıtı boyut sınırını aştı'))
      if (!truncated && code !== 0) return reject(bin === 'gh' ? classifyGhFailure(stderr) : new GithubError('error', stderr.trim() || `${bin} çıkış kodu ${code}`))
      const out = Buffer.concat(chunks)
      // Kesik metin son tam satırda biter; yarım UTF-8 karakteri taşınmaz.
      resolve({ out: (truncated ? out.subarray(0, out.lastIndexOf(0x0a) + 1) : out).toString('utf8'), truncated })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
  })
}

const gh = (cwd: string, args: string[], options?: RunOptions) => run('gh', cwd, args, options)

async function ghJson<T>(cwd: string, args: string[]): Promise<T> {
  const { out } = await gh(cwd, args)
  try {
    return JSON.parse(out) as T
  } catch {
    throw new GithubError('error', 'gh beklenmeyen bir yanıt verdi')
  }
}

const SUMMARY_FIELDS = 'number,title,url,state,isDraft,baseRefName,headRefName,author,additions,deletions,changedFiles,reviewDecision,updatedAt'

interface RawSummary {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  baseRefName: string
  headRefName: string
  author?: { login?: string } | null
  additions?: number
  deletions?: number
  changedFiles?: number
  reviewDecision?: string | null
  updatedAt?: string
}

export function toSummary(raw: RawSummary): PullRequestSummary {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state === 'MERGED' || raw.state === 'CLOSED' ? raw.state : 'OPEN',
    isDraft: Boolean(raw.isDraft),
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    author: raw.author?.login ?? null,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    reviewDecision: raw.reviewDecision || null,
    updatedAt: raw.updatedAt ?? '',
  }
}

/** Branch'ten açılmış PR'lar arasında açık olan, yoksa en yenisi. */
export function pickBranchPullRequest(list: PullRequestSummary[]): PullRequestSummary | null {
  return list.find(pr => pr.state === 'OPEN') ?? list[0] ?? null
}

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const { out } = await run('git', cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 5000 })
    return out.trim() || null
  } catch {
    return null
  }
}

/** Depo, varsayılan branch ve bu branch'in PR'ı. Hata durumu alanlarda döner, fırlatılmaz. */
export async function githubStatus(cwd: string): Promise<GithubStatus> {
  const branch = await currentBranch(cwd)
  const status: GithubStatus = { state: 'ready', message: null, repo: null, defaultBranch: null, branch, pullRequest: null }
  try {
    const repo = await ghJson<{ nameWithOwner: string; defaultBranchRef?: { name?: string } | null }>(cwd, ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'])
    status.repo = repo.nameWithOwner
    status.defaultBranch = repo.defaultBranchRef?.name ?? null
    if (branch && branch !== status.defaultBranch) {
      const list = await ghJson<RawSummary[]>(cwd, ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '10', '--json', SUMMARY_FIELDS])
      status.pullRequest = pickBranchPullRequest(list.map(toSummary))
    }
  } catch (err) {
    if (!(err instanceof GithubError)) throw err
    status.state = err.state
    status.message = err.message
  }
  return status
}

export async function listPullRequests(cwd: string): Promise<PullRequestSummary[]> {
  const list = await ghJson<RawSummary[]>(cwd, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', SUMMARY_FIELDS])
  return list.map(toSummary)
}

interface RawReviewComment {
  id: number
  path: string
  line: number | null
  start_line: number | null
  side: string | null
  body: string
  user: string | null
  created_at: string
  html_url: string
  in_reply_to_id: number | null
}

export function toComment(raw: RawReviewComment): PullRequestComment {
  return {
    id: raw.id,
    path: raw.path,
    line: raw.line ?? null,
    startLine: raw.start_line ?? null,
    side: raw.side === 'LEFT' ? 'old' : 'new',
    body: raw.body,
    author: raw.user ?? 'ghost',
    createdAt: raw.created_at,
    url: raw.html_url,
    inReplyTo: raw.in_reply_to_id ?? null,
  }
}

interface RawDetail extends RawSummary {
  body: string
  headRefOid: string
  comments?: { author?: { login?: string } | null; body: string; createdAt: string; url: string }[]
  reviews?: { author?: { login?: string } | null; body: string; submittedAt?: string; state: string; id?: string }[]
}

/** Satıra bağlı olmayan konuşma: boş gövdeli onaylar da sonuç olarak listelenir. */
export function toNotes(raw: RawDetail): PullRequestNote[] {
  const notes: PullRequestNote[] = [
    ...(raw.comments ?? []).map(c => ({ kind: 'comment' as const, author: c.author?.login ?? 'ghost', body: c.body, createdAt: c.createdAt, url: c.url, state: null })),
    ...(raw.reviews ?? [])
      .filter(r => r.body.trim() !== '' || r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
      .map(r => ({ kind: 'review' as const, author: r.author?.login ?? 'ghost', body: r.body, createdAt: r.submittedAt ?? '', url: raw.url, state: r.state })),
  ]
  return notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

const COMMENT_JQ = '.[] | {id, path, line, start_line, side, body, user: .user.login, created_at, html_url, in_reply_to_id}'

export async function pullRequestDetail(cwd: string, number: number): Promise<PullRequestDetail> {
  const [raw, diff, commentLines] = await Promise.all([
    ghJson<RawDetail>(cwd, ['pr', 'view', String(number), '--json', `${SUMMARY_FIELDS},body,headRefOid,comments,reviews`]),
    gh(cwd, ['pr', 'diff', String(number), '--color', 'never'], { capBytes: MAX_PR_DIFF_BYTES, allowTruncate: true }),
    gh(cwd, ['api', '--paginate', `repos/{owner}/{repo}/pulls/${number}/comments`, '--jq', COMMENT_JQ]),
  ])
  const comments = commentLines.out.split('\n').filter(line => line.trim() !== '').map(line => toComment(JSON.parse(line) as RawReviewComment))
  return {
    pullRequest: { ...toSummary(raw), body: raw.body ?? '', headRefOid: raw.headRefOid },
    diff: diff.out,
    truncated: diff.truncated,
    comments,
    notes: toNotes(raw),
  }
}

export interface CreatePullRequestInput {
  branch: string
  base: string
  title: string
  body: string
  draft: boolean
}

/** Branch uzak depoya gönderilir, sonra PR açılır. Mevcut PR varsa gh hatası olduğu gibi döner. */
export async function createPullRequest(cwd: string, input: CreatePullRequestInput): Promise<PullRequestSummary> {
  await run('git', cwd, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${input.branch}`], { timeoutMs: 60_000 })
  const args = ['pr', 'create', '--head', input.branch, '--base', input.base, '--title', input.title, '--body-file', '-']
  if (input.draft) args.push('--draft')
  await gh(cwd, args, { input: input.body, timeoutMs: 60_000 })
  const list = await ghJson<RawSummary[]>(cwd, ['pr', 'list', '--head', input.branch, '--state', 'open', '--limit', '1', '--json', SUMMARY_FIELDS])
  const created = pickBranchPullRequest(list.map(toSummary))
  if (!created) throw new GithubError('error', 'PR açıldı ama okunamadı; GitHub\'da kontrol edin')
  return created
}

export interface ReviewDraftComment {
  path: string
  side: 'new' | 'old'
  line: number
  startLine: number | null
  body: string
}

/** GitHub inceleme isteğinin gövdesi; tek satırlık yorumda start alanları gönderilmez. */
export function reviewPayload(commitId: string, body: string, comments: ReviewDraftComment[]): Record<string, unknown> {
  return {
    commit_id: commitId,
    body,
    event: 'COMMENT',
    comments: comments.map(comment => {
      const side = comment.side === 'old' ? 'LEFT' : 'RIGHT'
      return comment.startLine !== null && comment.startLine < comment.line
        ? { path: comment.path, body: comment.body, line: comment.line, side, start_line: comment.startLine, start_side: side }
        : { path: comment.path, body: comment.body, line: comment.line, side }
    }),
  }
}

/** Yorumlar tek bir "COMMENT" incelemesi olarak yayımlanır; onay veya değişiklik isteği gönderilmez. */
export async function publishReview(cwd: string, number: number, commitId: string, body: string, comments: ReviewDraftComment[]): Promise<{ url: string }> {
  const { out } = await gh(cwd, ['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--input', '-'], {
    input: JSON.stringify(reviewPayload(commitId, body, comments)),
  })
  try {
    return { url: (JSON.parse(out) as { html_url?: string }).html_url ?? '' }
  } catch {
    return { url: '' }
  }
}
