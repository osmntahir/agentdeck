import type {
  ClaudeAccountsResponse,
  ClaudeAgentView,
  ClaudeLoginView,
  ConversationView,
  DiffResult,
  DiffScope,
  Isolation,
  Project,
  SessionView,
  StateResponse,
  StoredRun,
  Work,
} from '../shared/types'
import { createMutationIds } from '../shared/mutationIds'

// Token URL'den bir kez alınır, sonra adres çubuğundan temizlenir.
const fromUrl = new URLSearchParams(location.search).get('token')
if (fromUrl) {
  localStorage.setItem('agentdeck_token', fromUrl)
  history.replaceState({}, '', location.pathname)
}
export const TOKEN = localStorage.getItem('agentdeck_token') ?? ''

/** Sunucu hatası {code,message,details?} biçimindedir; kod çağırana taşınır. */
export class ApiCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** HTTP durum kodu; durum döngüsü 401/403'ü ağ ve sunucu hatasından ayırır. */
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiCallError'
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'X-Agentdeck-Token': TOKEN,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new ApiCallError(
      typeof body.code === 'string' ? body.code : 'unknown',
      typeof body.message === 'string' ? body.message : `İstek başarısız (${res.status})`,
      res.status,
    )
  }
  return body as T
}

/** Kayıp create/launch cevabı aynı daemon'da ikinci Run açmasın. Daemon değişince kimlik yenilenir. */
const mutationIds = createMutationIds()
let boundDaemonId = ''

async function mutatingCall<T>(slot: string, url: string, payload: unknown, body: object): Promise<T> {
  const requestId = mutationIds.id(slot, boundDaemonId, payload)
  const result = await call<T>(url, { method: 'POST', body: JSON.stringify({ ...body, requestId }) })
  mutationIds.complete(slot, requestId)
  return result
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, signal])
  const combined = new AbortController()
  const abort = () => combined.abort()
  if (signal.aborted || timeout.aborted) abort()
  else {
    signal.addEventListener('abort', abort, { once: true })
    timeout.addEventListener('abort', abort, { once: true })
  }
  return combined.signal
}

export const getState = async (previewIds: string[] = [], signal?: AbortSignal) => {
  const state = await call<StateResponse>(`/api/state?previewIds=${encodeURIComponent(previewIds.join(','))}`, {
    signal: withTimeout(signal, 5000),
  })
  boundDaemonId = state.daemonId
  return state
}

export const addProject = (path: string) =>
  call<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ path }) })

/** Oturumu olan proje yalnız taze proje onayıyla silinir; branch'ler korunur. */
export const deleteProject = (id: string, confirmationToken?: string) =>
  call<{ ok: true }>(`/api/projects/${id}`, {
    method: 'DELETE',
    ...(confirmationToken ? { body: JSON.stringify({ confirmationToken }) } : {}),
  })

export interface ProjectDeletePreview {
  confirmationToken: string
  expiresInMs: number
  projectId: string
  sessions: {
    id: string
    name: string
    cwd: string
    branch: string | null
    isolation: Isolation
    changedEntries: number
    ignoredEntries: number
  }[]
}

/** Projenin bütün oturumlarını tek onaya bağlar; bütçe oturumlar arasında paylaşılır. */
export const previewProjectDelete = (id: string) =>
  call<ProjectDeletePreview>(`/api/projects/${id}/delete-preview`, { method: 'POST' })

export const createSession = (input: {
  projectId: string
  name: string
  command: string | null
  isolation: Isolation
  /** Oturumun bağlanacağı iş; null işsiz demektir. */
  workId?: string | null
}) => mutatingCall<SessionView>(`create:${input.projectId}`, '/api/sessions', input, input)

export const stopSession = (id: string, expectedRunId: string | null) =>
  call<SessionView>(`/api/sessions/${id}/stop`, {
    method: 'POST',
    body: JSON.stringify({ expectedRunId }),
  })

export const restartSession = (id: string, expectedRunId: string | null) =>
  mutatingCall<SessionView>(
    `restart:${id}`,
    `/api/sessions/${id}/restart`,
    { id, expectedRunId },
    { expectedRunId },
  )

/** Mevcut çalışma kopyasında komutu aynen çalıştırır; başlangıç Command'ı değişmez. */
export const launchSession = (
  id: string,
  expectedRunId: string | null,
  command: string | null,
  mode: 'command' | 'fresh' | 'picker' = 'command',
) =>
  mutatingCall<SessionView>(
    `launch:${id}`,
    `/api/sessions/${id}/launch`,
    { id, expectedRunId, mode, command },
    { expectedRunId, mode, command },
  )

export interface RunsResult {
  currentRunId: string | null
  previous: StoredRun[]
}

/** Saklanmış önceki Run görüntüleri; en çok son iki Run tutulur. */
export const getRuns = (id: string) => call<RunsResult>(`/api/sessions/${id}/runs`)

/** Canlı iş yalnız stopIfLive ile, doğrulanmış durdurmayla kapanır. */
export const archiveSession = (id: string, expectedRunId: string | null, stopIfLive: boolean) =>
  call<SessionView>(`/api/sessions/${id}/archive`, {
    method: 'POST',
    body: JSON.stringify({ expectedRunId, stopIfLive }),
  })

export const unarchiveSession = (id: string) =>
  call<SessionView>(`/api/sessions/${id}/unarchive`, { method: 'POST' })

export interface DeletePreview {
  confirmationToken: string
  expiresInMs: number
  cwd: string
  branch: string | null
  isolation: Isolation
  changedEntries: number
  /** Silmeyle gidecek ignored girişler (.env, bağımlılıklar). */
  ignoredEntries: number
  fingerprintScope: string
  keepsBranch: boolean
}

export const previewSessionDelete = (id: string) =>
  call<DeletePreview>(`/api/sessions/${id}/delete-preview`, { method: 'POST' })

/** Silme yalnız taze bir onayla yapılır; branch her durumda korunur. */
export const deleteSession = (id: string, confirmationToken: string) =>
  call<{ ok: true; branchKept: string | null }>(`/api/sessions/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmationToken }),
  })

export const getDiff = (id: string, scope: DiffScope) =>
  call<DiffResult>(`/api/sessions/${id}/diff?scope=${scope}`)

export interface BranchesResult {
  repos: {
    path: string
    branches: { name: string; oid: string; sessionId: string | null }[]
    truncated: boolean
    error: string | null
  }[]
  truncated: boolean
}

export interface ProjectHead {
  kind: 'git' | 'folder'
  /** Git projesinde commit var mı. Klasör projesinde bakılmaz. */
  hasHead: boolean | null
}

/** Worktree preset'i bu okumaya göre kapanır; oluşturmaz. */
export const getProjectHead = (projectId: string) => call<ProjectHead>(`/api/projects/${projectId}/head`)

/** Projedeki agentdeck/ branch'leri; oturum silinse de branch burada bulunur. */
export const getBranches = (projectId: string) => call<BranchesResult>(`/api/projects/${projectId}/branches`)

export interface OrphanScanResult {
  entries: { path: string; kind: string; gitLink: string | null }[]
  truncated: boolean
  unreadable: string[]
}

export const getOrphanWorktrees = () => call<OrphanScanResult>('/api/orphan-worktrees')


export const getGitWorkspaces = (id: string, branches = false) =>
  call<import('../shared/types').GitWorkspaces>(`/api/sessions/${id}/git?branches=${branches ? '1' : '0'}`)
export const switchBranch = (id: string, input: { repo: string; branch: string; create: boolean; expectedHead: string | null; expectedBranch: string | null; expectedRunId: string | null }) =>
  call<import('../shared/types').GitWorkspace>(`/api/sessions/${id}/git/switch`, { method: 'POST', body: JSON.stringify(input) })

/** Claude hesapları (ADR 0017); etkinleştirme canlı kimlik dosyalarını değiştirir. */
export const getClaudeAccounts = () => call<ClaudeAccountsResponse>('/api/claude-accounts')
export const saveLiveClaudeAccount = () => call('/api/claude-accounts/save-live', { method: 'POST' })
export const activateClaudeAccount = (id: string) =>
  call(`/api/claude-accounts/${encodeURIComponent(id)}/activate`, { method: 'POST' })
export const removeClaudeAccount = (id: string) =>
  call(`/api/claude-accounts/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const startClaudeLogin = () => call<{ login: ClaudeLoginView }>('/api/claude-accounts/login', { method: 'POST' })
export const sendClaudeLoginInput = (text: string) =>
  call('/api/claude-accounts/login/input', { method: 'POST', body: JSON.stringify({ text }) })
export const cancelClaudeLogin = () => call('/api/claude-accounts/login/cancel', { method: 'POST' })

/** İşler (ADR 0018): oturumları ve konuşmalarını bir amaç altında toplar. */
export const createWork = (projectId: string, name: string) =>
  call<Work>('/api/works', { method: 'POST', body: JSON.stringify({ projectId, name }) })
export const renameWork = (id: string, name: string) =>
  call<Work>(`/api/works/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
/** Yalnız iş kaydı kalkar; oturumlar işsiz olarak yerinde kalır. */
export const removeWork = (id: string) => call<{ ok: true }>(`/api/works/${id}`, { method: 'DELETE' })
export const assignWork = (sessionId: string, workId: string | null) =>
  call<SessionView>(`/api/sessions/${sessionId}/work`, { method: 'POST', body: JSON.stringify({ workId }) })
export const getWorkConversations = (id: string) =>
  call<{ conversations: ConversationView[] }>(`/api/works/${id}/conversations`)
export const getSessionConversations = (id: string) =>
  call<{ conversations: ConversationView[] }>(`/api/sessions/${id}/conversations`)

export type ClaudeSessionListing = { supported: boolean; error: string | null; sessions: (ClaudeAgentView & { workId: string | null })[] }
/** Projenin Claude arka plan oturumları (`claude agents`). */
export const getClaudeSessions = (projectId: string) => call<ClaudeSessionListing>(`/api/projects/${projectId}/claude-sessions`)
export const linkClaudeSessions = (workId: string, ids: string[]) =>
  call<Work>(`/api/works/${workId}/claude-sessions`, { method: 'POST', body: JSON.stringify({ ids }) })
export const unlinkClaudeSession = (workId: string, id: string) =>
  call<Work>(`/api/works/${workId}/claude-sessions/${id}`, { method: 'DELETE' })

/** İşin tek Claude oturumu; yoksa işin adıyla açılır. */
export const ensureWorkClaude = (workId: string) =>
  call<{ id: string; created: boolean }>(`/api/works/${workId}/claude-session`, { method: 'POST' })

/**
 * Oturum açar; işteki Claude, işin Claude oturumuna attach olur. Böylece bir
 * işin bütün Claude terminalleri aynı oturumu gösterir ve adı işin adıdır.
 */
export async function createSessionInWork(input: Parameters<typeof createSession>[0]): Promise<SessionView> {
  if (input.workId && input.command?.trim() === 'claude') {
    const { id } = await ensureWorkClaude(input.workId)
    return createSession({ ...input, command: `claude attach ${id}`, isolation: 'shared' })
  }
  return createSession(input)
}
