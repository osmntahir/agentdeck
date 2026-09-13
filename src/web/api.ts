import type { DiffResult, DiffScope, Isolation, Project, SessionView, StateResponse } from '../shared/types'

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
    )
  }
  return body as T
}

/** Kaybolan bir cevabın ikinci Run açmaması için her mutation kendi kimliğini taşır. */
const newRequestId = (): string =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`

export const getState = (previewIds: string[] = []) =>
  call<StateResponse>(`/api/state?previewIds=${encodeURIComponent(previewIds.join(','))}`, {
    signal: AbortSignal.timeout(5000),
  })

export const addProject = (path: string) =>
  call<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ path }) })

export const deleteProject = (id: string) => call<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' })

export const createSession = (input: {
  projectId: string
  name: string
  command: string | null
  isolation: Isolation
}) =>
  call<SessionView>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ ...input, requestId: newRequestId() }),
  })

export const stopSession = (id: string, expectedRunId: string | null) =>
  call<SessionView>(`/api/sessions/${id}/stop`, {
    method: 'POST',
    body: JSON.stringify({ expectedRunId }),
  })

export const restartSession = (id: string, expectedRunId: string | null) =>
  call<SessionView>(`/api/sessions/${id}/restart`, {
    method: 'POST',
    body: JSON.stringify({ requestId: newRequestId(), expectedRunId }),
  })

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

export interface OrphanScanResult {
  entries: { path: string; kind: string; gitLink: string | null }[]
  truncated: boolean
  unreadable: string[]
}

export const getOrphanWorktrees = () => call<OrphanScanResult>('/api/orphan-worktrees')
