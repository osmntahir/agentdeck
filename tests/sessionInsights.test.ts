import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startDaemon, type Daemon } from '../src/server/daemon'
import { HOOK_COMMAND } from '../src/server/claudeHooks'
import type { ConversationSearchResponse, SessionView, StateResponse, Work } from '../src/shared/types'
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
  return { get: <T>(route: string) => call<T>('GET', route), post: <T>(route: string, body?: unknown) => call<T>('POST', route, body) }
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('zaman aşımı')
}

let requestCount = 0
const requestId = () => `insight-${process.pid}-${++requestCount}`
const line = (value: object) => JSON.stringify(value)

test('oturuma sabit port ayrılır; programın dinlediği port görünür', { skip: process.platform !== 'linux', timeout: 30000 }, async () => {
  const dataDir = tempDir()
  const project = tempDir()
  const daemon = await startDaemon({ dataDir, port: 0 })
  const api = client(daemon)
  try {
    const projectId = (await api.post<{ id: string }>('/api/projects', { path: project })).body.id
    const server = `"${process.execPath}" -e "require('net').createServer().listen(Number(process.env.PORT),'127.0.0.1')"`
    const a = await api.post<SessionView>('/api/sessions', { requestId: requestId(), projectId, name: 'a', command: server, isolation: 'shared' })
    const b = await api.post<SessionView>('/api/sessions', { requestId: requestId(), projectId, name: 'b', command: 'sleep 30', isolation: 'shared' })
    assert.equal(a.status, 200, JSON.stringify(a.body))
    assert.ok(a.body.port && b.body.port && a.body.port !== b.body.port, `${a.body.port} ${b.body.port}`)

    const seen = await until(async () => {
      const state = (await api.get<StateResponse>('/api/state')).body
      const session = state.sessions.find((s) => s.id === a.body.id)
      return session?.ports?.length ? session : undefined
    })
    assert.deepEqual(seen.ports, [a.body.port])
    const other = (await api.get<StateResponse>('/api/state')).body.sessions.find((s) => s.id === b.body.id)
    assert.deepEqual(other?.ports, [])

    // Yeni Run aynı portu alır.
    const restarted = await api.post<SessionView>(`/api/sessions/${b.body.id}/restart`, { requestId: requestId(), expectedRunId: b.body.runId })
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body))
    assert.equal(restarted.body.port, b.body.port)
  } finally {
    await daemon.close()
    removeDir(dataDir)
    removeDir(project)
  }
})

test('oturum ve iş kullanımı transcript usage alanlarından okunur', { timeout: 30000 }, async () => {
  const dataDir = tempDir()
  const project = tempDir()
  const scratch = tempDir()
  const daemon = await startDaemon({ dataDir, port: 0 })
  const api = client(daemon)
  try {
    const id = '33333333-3333-4333-8333-333333333333'
    const transcript = path.join(scratch, `${id}.jsonl`)
    const usage = { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 }
    fs.writeFileSync(transcript, [
      line({ type: 'user', message: { content: 'kullanım ölç' } }),
      line({ type: 'assistant', message: { model: 'claude-sonnet-5', id: 'msg_a', content: [{ type: 'thinking' }], usage } }),
      line({ type: 'assistant', message: { model: 'claude-sonnet-5', id: 'msg_a', content: [{ type: 'text', text: 'tamam' }], usage } }),
      '',
    ].join('\n'))
    const hook = path.join(scratch, 'hook.sh')
    fs.writeFileSync(hook, HOOK_COMMAND)
    const event = path.join(scratch, 'event.json')
    fs.writeFileSync(event, JSON.stringify({ session_id: id, source: 'startup', hook_event_name: 'SessionStart', transcript_path: transcript }))

    const projectId = (await api.post<{ id: string }>('/api/projects', { path: project })).body.id
    const work = (await api.post<Work>('/api/works', { projectId, name: 'Ölçüm' })).body
    const created = await api.post<SessionView>('/api/sessions', { requestId: requestId(), projectId, name: '', command: `sh '${hook}' < '${event}'; sleep 30`, isolation: 'shared', workId: work.id })
    assert.equal(created.status, 200, JSON.stringify(created.body))

    const state = await until(async () => {
      const body = (await api.get<StateResponse>('/api/state')).body
      return body.sessions.find((s) => s.id === created.body.id)?.usage?.total.output ? body : undefined
    })
    const session = state.sessions.find((s) => s.id === created.body.id)!
    assert.equal(session.usage!.total.output, 1000, 'aynı mesaj bir kez sayılır')
    assert.equal(session.usage!.total.cacheRead, 40_000)
    assert.equal(session.usage!.context?.tokens, 41_010)
    assert.equal(session.usage!.context?.model, 'claude-sonnet-5')
    // Sonnet 5: 10 × $2 + 1000 × $10 + 40.000 × $0,20 (milyon başına)
    assert.ok(Math.abs(session.usage!.total.costUsd! - (10 * 2 + 1000 * 10 + 40_000 * 0.2) / 1e6) < 1e-12)
    assert.equal(state.workUsage?.[work.id]?.output, 1000)
  } finally {
    await daemon.close()
    removeDir(dataDir)
    removeDir(project)
    removeDir(scratch)
  }
})

test('konuşma araması projelerin transcriptlerinde metni bulur ve konuşmayı projeye bağlar', { timeout: 30000 }, async () => {
  const dataDir = tempDir()
  const project = tempDir()
  const claudeDir = tempDir()
  const fake = path.join(claudeDir, 'claude')
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "[]"\n', { mode: 0o755 })
  const dir = path.join(claudeDir, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  const a = '44444444-4444-4444-8444-444444444444'
  const b = '55555555-5555-4555-8555-555555555555'
  fs.writeFileSync(path.join(dir, `${a}.jsonl`), [
    line({ type: 'user', cwd: project, message: { content: 'Ödeme sayfasındaki Stripe webhook hatasını düzelt' } }),
    line({ type: 'assistant', cwd: project, message: { content: [{ type: 'text', text: 'İmza doğrulamasını düzelttim.' }] } }),
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, `${b}.jsonl`), [line({ type: 'user', cwd: project, message: { content: 'README yaz' } }), ''].join('\n'))
  const daemon = await startDaemon({ dataDir, port: 0, claudeAgents: { command: fake, claudeDir } })
  const api = client(daemon)
  try {
    const projectId = (await api.post<{ id: string }>('/api/projects', { path: project })).body.id
    const search = async (q: string) => (await api.get<ConversationSearchResponse>(`/api/conversations/search?q=${encodeURIComponent(q)}`)).body

    const found = await until(async () => {
      const reply = await search('stripe odeme')
      return reply.pending === 0 ? reply : undefined
    })
    assert.equal(found.hits.length, 1)
    const hit = found.hits[0]!
    assert.equal(hit.conversation.id, a)
    assert.equal(hit.projectId, projectId)
    assert.equal(hit.conversation.cwd, project)
    assert.equal(hit.conversation.firstPrompt, 'Ödeme sayfasındaki Stripe webhook hatasını düzelt')
    assert.deepEqual(hit.snippet.ranges.map(([s, e]) => hit.snippet.text.slice(s, e)), ['Ödeme', 'Stripe'])

    assert.equal((await search('imza')).hits[0]?.snippet.role, 'assistant')
    assert.deepEqual((await search('yok böyle bir şey')).hits, [])
    assert.deepEqual((await search('   ')).hits, [])
    assert.equal((await api.get(`/api/conversations/search?q=${'x'.repeat(201)}`)).status, 400)
  } finally {
    await daemon.close()
    removeDir(dataDir)
    removeDir(project)
    removeDir(claudeDir)
  }
})
