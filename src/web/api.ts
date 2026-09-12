import type { AgentKind, AppState, DiffResult, Isolation, Project, Session } from '../shared/types'

// Token URL'den bir kez alınır, sonra adres çubuğundan temizlenir.
const fromUrl = new URLSearchParams(location.search).get('token')
if (fromUrl) {
  localStorage.setItem('agentdeck_token', fromUrl)
  history.replaceState({}, '', location.pathname)
}
export const TOKEN = localStorage.getItem('agentdeck_token') ?? ''

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'X-Agentdeck-Token': TOKEN,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `İstek başarısız (${res.status})`)
  return body as T
}

export const getState = () => call<AppState>('/api/state')

export const addProject = (path: string) =>
  call<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ path }) })

export const deleteProject = (id: string) =>
  call<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' })

export const createSession = (input: {
  projectId: string
  name: string
  agent: AgentKind
  isolation: Isolation
}) => call<Session>('/api/sessions', { method: 'POST', body: JSON.stringify(input) })

export const restartSession = (id: string) =>
  call<Session>(`/api/sessions/${id}/restart`, { method: 'POST' })

export const deleteSession = (id: string, deleteBranch: boolean) =>
  call<{ ok: true }>(`/api/sessions/${id}?deleteBranch=${deleteBranch}`, { method: 'DELETE' })

export const getDiff = (id: string) => call<DiffResult>(`/api/sessions/${id}/diff`)
