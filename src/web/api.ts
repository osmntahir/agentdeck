import type {
  DiffResult,
  DiffScope,
  Isolation,
  Project,
  SessionView,
  StateResponse,
  StoredRun,
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
