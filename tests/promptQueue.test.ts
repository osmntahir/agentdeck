import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startDaemon, type Daemon } from '../src/server/daemon'
import { HOOK_COMMAND } from '../src/server/claudeHooks'
import type { SavedPrompt } from '../src/shared/prompts'
import type { SessionView, StateResponse } from '../src/shared/types'
import { tempDir, removeDir } from './helpers'

function client(daemon: Daemon) {
  const call = async <T>(method: string, route: string, body?: unknown) => {
    const res = await fetch(`${daemon.url}${route}`, {
      method,
      headers: { 'X-Agentdeck-Token': daemon.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T }
  }
  return {
    get: <T>(route: string) => call<T>('GET', route),
    post: <T>(route: string, body?: unknown) => call<T>('POST', route, body),
    patch: <T>(route: string, body?: unknown) => call<T>('PATCH', route, body),
    del: <T>(route: string) => call<T>('DELETE', route),
  }
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('zaman aşımı')
}

let requestCount = 0
const requestId = () => `queue-${process.pid}-${++requestCount}`

/**
 * Claude'u taklit eden program: adı `claude.js` olduğu için ön plan ajanı
 * claude sayılır. Gerçek kanca komutunu SessionStart, UserPromptSubmit ve
 * Stop olaylarıyla çalıştırır; aldığı istemleri dosyaya yazar.
 */
const FAKE_CLAUDE = `
const { execFileSync } = require('child_process')
const fs = require('fs')
const [hook, received] = process.argv.slice(2)
const fire = (name) => execFileSync('sh', [hook], { input: JSON.stringify({ session_id: '88888888-8888-4888-8888-888888888888', hook_event_name: name, source: 'startup' }) })
fire('SessionStart')
let buffer = ''
process.stdin.on('data', (data) => {
  buffer += data.toString()
  let end
  while ((end = buffer.search(/[\\r\\n]/)) >= 0) {
    const line = buffer.slice(0, end).replace(/\\x1b\\[20[01]~/g, '')
    buffer = buffer.slice(end + 1)
    if (!line) continue
    fire('UserPromptSubmit')
    fs.appendFileSync(received, line + '\\n')
    setTimeout(() => fire('Stop'), 400)
  }
})
`

test('kuyruk Claude turunu bitirince sıradaki istemi gönderir; duraklatma ve hazır istem çalışır', { timeout: 60000 }, async () => {
  const dataDir = tempDir()
  const project = tempDir()
  const scratch = tempDir()
  const daemon = await startDaemon({ dataDir, port: 0 })
  const api = client(daemon)
  try {
    const fake = path.join(scratch, 'claude.js')
    fs.writeFileSync(fake, FAKE_CLAUDE)
    const hook = path.join(scratch, 'hook.sh')
    fs.writeFileSync(hook, HOOK_COMMAND)
    const received = path.join(scratch, 'received.txt')
    const lines = () => (fs.existsSync(received) ? fs.readFileSync(received, 'utf8').trim().split('\n').filter(Boolean) : [])

    const projectId = (await api.post<{ id: string }>('/api/projects', { path: project })).body.id
    const created = await api.post<SessionView>('/api/sessions', { requestId: requestId(), projectId, name: 'claude', command: `exec "${process.execPath}" '${fake}' '${hook}' '${received}'`, isolation: 'shared' })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const id = created.body.id
    const session = async () => (await api.get<StateResponse>('/api/state')).body.sessions.find((s) => s.id === id)!
    await until(async () => ((await session()).agentTurn === 'waiting' ? true : undefined))

    // Bekleyen Claude'a ilk istem hemen gider; ikincisi tur bitene kadar sırada kalır.
    await api.post(`/api/sessions/${id}/queue`, { text: 'birinci' })
    const second = await api.post<SessionView>(`/api/sessions/${id}/queue`, { text: 'ikinci' })
    assert.deepEqual(second.body.promptQueue?.map((q) => q.text), ['ikinci'])
    await until(async () => (lines().length >= 1 ? true : undefined))
    assert.deepEqual(lines(), ['birinci'])
    await until(async () => (lines().length >= 2 ? true : undefined))
    assert.deepEqual(lines(), ['birinci', 'ikinci'])
    await until(async () => ((await session()).promptQueue === undefined ? true : undefined))

    // Duraklatılmış kuyruk tur bitse de göndermez.
    await until(async () => ((await session()).agentTurn === 'waiting' ? true : undefined))
    await api.post(`/api/sessions/${id}/queue/pause`, { paused: true })
    await api.post(`/api/sessions/${id}/queue`, { text: 'bekleyen' })
    await new Promise((r) => setTimeout(r, 1500))
    assert.deepEqual(lines(), ['birinci', 'ikinci'])
    await api.post(`/api/sessions/${id}/queue/pause`, { paused: false })
    await until(async () => (lines().length >= 3 ? true : undefined))

    // Hazır istemin adımları sırayla gider; kullanım sayısı artar.
    const prompt = (await api.post<SavedPrompt>('/api/prompts', { name: '  Bitir ', steps: ['testleri çalıştır', '  ', 'commit at'] })).body
    assert.deepEqual([prompt.name, prompt.steps], ['Bitir', ['testleri çalıştır', 'commit at']])
    await until(async () => ((await session()).agentTurn === 'waiting' ? true : undefined))
    await api.post(`/api/sessions/${id}/queue`, { promptId: prompt.id })
    await until(async () => (lines().length >= 5 ? true : undefined))
    assert.deepEqual(lines(), ['birinci', 'ikinci', 'bekleyen', 'testleri çalıştır', 'commit at'])
    const state = (await api.get<StateResponse>('/api/state')).body
    assert.equal(state.prompts?.[0]?.uses, 1)

    // Doğrulama ve silme.
    assert.equal((await api.post('/api/prompts', { name: 'boş', steps: [' '] })).status, 400)
    assert.equal((await api.post(`/api/sessions/${id}/queue`, {})).status, 400)
    assert.equal((await api.del(`/api/prompts/${prompt.id}`)).status, 200)
    assert.equal((await api.get<StateResponse>('/api/state')).body.prompts?.length, 0)
  } finally {
    await daemon.close()
    removeDir(dataDir)
    removeDir(project)
    removeDir(scratch)
  }
})

test('ön planda Claude yoksa kuyruk hiçbir şey göndermez', { timeout: 30000 }, async () => {
  const dataDir = tempDir()
  const project = tempDir()
  const scratch = tempDir()
  const daemon = await startDaemon({ dataDir, port: 0 })
  const api = client(daemon)
  try {
    const hook = path.join(scratch, 'hook.sh')
    fs.writeFileSync(hook, HOOK_COMMAND)
    const event = path.join(scratch, 'stop.json')
    fs.writeFileSync(event, JSON.stringify({ session_id: '99999999-9999-4999-8999-999999999999', hook_event_name: 'Stop' }))
    const received = path.join(scratch, 'received.txt')
    // Kabuk Stop olayı bıraksa da ön plandaki program claude değildir.
    const projectId = (await api.post<{ id: string }>('/api/projects', { path: project })).body.id
    const created = await api.post<SessionView>('/api/sessions', { requestId: requestId(), projectId, name: 'kabuk', command: `sh '${hook}' < '${event}'; cat > '${received}'`, isolation: 'shared' })
    const id = created.body.id
    await new Promise((r) => setTimeout(r, 1500))
    const queued = await api.post<SessionView>(`/api/sessions/${id}/queue`, { text: 'rm -rf olmasın' })
    assert.equal(queued.body.agentTurn, null)
    await new Promise((r) => setTimeout(r, 1500))
    assert.equal(fs.existsSync(received) ? fs.readFileSync(received, 'utf8') : '', '')
    assert.deepEqual((await api.get<StateResponse>('/api/state')).body.sessions.find((s) => s.id === id)?.promptQueue?.map((q) => q.text), ['rm -rf olmasın'])
  } finally {
    await daemon.close()
    removeDir(dataDir)
    removeDir(project)
    removeDir(scratch)
  }
})
