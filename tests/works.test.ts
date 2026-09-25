import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startDaemon, type Daemon } from '../src/server/daemon'
import { HOOK_COMMAND } from '../src/server/claudeHooks'
import type { ConversationView, SessionView, StateResponse, Work } from '../src/shared/types'
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
    del: <T>(route: string, body?: unknown) => call<T>('DELETE', route, body),
  }
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('zaman aşımı')
}

let requestCount = 0
const requestId = () => `test-${process.pid}-${++requestCount}`

test('iş oluşturulur, oturum işe bağlanır, taşınır; iş oturumlarıyla birlikte silinir', { timeout: 30000 }, async () => {
  const dataDir = tempDir()
  const project = tempDir()
  const other = tempDir()
  const daemon = await startDaemon({ dataDir, port: 0 })
  const api = client(daemon)
  try {
    const projectId = (await api.post<{ id: string }>('/api/projects', { path: project })).body.id
    const otherId = (await api.post<{ id: string }>('/api/projects', { path: other })).body.id

    assert.equal((await api.post('/api/works', { projectId, name: '   ' })).status, 400)
    const work = (await api.post<Work>('/api/works', { projectId, name: '  Çoklu   dil ' })).body
    assert.equal(work.name, 'Çoklu dil')
    const foreign = (await api.post<Work>('/api/works', { projectId: otherId, name: 'Başka' })).body

    const wrong = await api.post('/api/sessions', { requestId: requestId(), projectId, name: '', command: 'sleep 30', isolation: 'shared', workId: foreign.id })
    assert.equal(wrong.status, 400)

    const created = await api.post<SessionView>('/api/sessions', { requestId: requestId(), projectId, name: '', command: 'sleep 30', isolation: 'shared', workId: work.id })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    assert.equal(created.body.workId, work.id)
    assert.equal(created.body.name, 'Çoklu dil', 'işteki terminal işin adını alır')
    const sibling = await api.post<SessionView>('/api/sessions', { requestId: requestId(), projectId, name: '', command: 'sleep 30', isolation: 'shared', workId: work.id })
    assert.equal(sibling.body.name, 'Çoklu dil 2', 'sonraki terminal numaralanır')

    assert.equal((await api.patch<Work>(`/api/works/${work.id}`, { name: 'i18n' })).body.name, 'i18n')
    assert.equal((await api.post(`/api/sessions/${created.body.id}/work`, { workId: foreign.id })).status, 400)
    assert.equal((await api.post<SessionView>(`/api/sessions/${created.body.id}/work`, { workId: null })).body.workId, undefined)
    await api.post(`/api/sessions/${created.body.id}/work`, { workId: work.id })

    const loose = await api.post<SessionView>('/api/sessions', { requestId: requestId(), projectId, name: '', command: 'sleep 30', isolation: 'shared' })
    const unconfirmed = await api.del<{ code: string }>(`/api/works/${work.id}`)
    assert.equal(unconfirmed.status, 409)
    assert.equal(unconfirmed.body.code, 'work_has_sessions', 'gizli cascade yok; önce önizleme')
    const preview = await api.post<{ confirmationToken: string; sessions: { id: string }[] }>(`/api/works/${work.id}/delete-preview`)
    assert.deepEqual(preview.body.sessions.map((s) => s.id).sort(), [created.body.id, sibling.body.id].sort())
    assert.equal((await api.del(`/api/works/${work.id}`, { confirmationToken: preview.body.confirmationToken })).status, 200)
    const state = (await api.get<StateResponse>('/api/state')).body
    assert.deepEqual(state.works?.map((w) => w.id), [foreign.id])
    assert.deepEqual(state.sessions.map((s) => s.id), [loose.body.id], 'işin oturumu silinir, işsiz oturum kalır')
    // Oturumu olmayan iş onaysız kalkar.
    assert.equal((await api.del(`/api/works/${(await api.post<Work>('/api/works', { projectId, name: 'Boş' })).body.id}`)).status, 200)

    // Proje silinince işleri de kalkar.
    assert.equal((await api.del(`/api/projects/${otherId}`)).status, 200)
    assert.deepEqual((await api.get<StateResponse>('/api/state')).body.works, [])
  } finally {
    await daemon.close()
    removeDir(dataDir)
    removeDir(project)
    removeDir(other)
  }
})

test('Claude kancası konuşmaları oturuma yazar; /clear yeni konuşmayı açık konuşma yapar', { timeout: 30000 }, async () => {
  const dataDir = tempDir()
  const project = tempDir()
  const scratch = tempDir()
  const daemon = await startDaemon({ dataDir, port: 0 })
  const api = client(daemon)
  try {
    const first = '11111111-1111-4111-8111-111111111111'
    const second = '22222222-2222-4222-8222-222222222222'
    const transcript = path.join(scratch, `${first}.jsonl`)
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Çoklu dil desteği ekle' } }),
      JSON.stringify({ type: 'custom-title', customTitle: 'ekran yirtilmasi' }),
      '',
    ].join('\n'))
    const hook = path.join(scratch, 'hook.sh')
    fs.writeFileSync(hook, HOOK_COMMAND)
    const event = (id: string, source: string, file?: string) => {
      const target = path.join(scratch, `${id}.json`)
      fs.writeFileSync(target, JSON.stringify({ session_id: id, source, hook_event_name: 'SessionStart', ...(file ? { transcript_path: file } : {}) }))
      return `sh '${hook}' < '${target}'`
    }
    // Gerçek kanca komutu PTY ortamıyla çalışır; ikinci olay /clear sonrasını taklit eder.
    const command = `${event(first, 'startup', transcript)}; sleep 0.5; ${event(second, 'clear')}; sleep 30`

    const projectId = (await api.post<{ id: string }>('/api/projects', { path: project })).body.id
    const work = (await api.post<Work>('/api/works', { projectId, name: 'i18n' })).body
    const created = await api.post<SessionView>('/api/sessions', { requestId: requestId(), projectId, name: '', command, isolation: 'shared', workId: work.id })
    assert.equal(created.status, 200, JSON.stringify(created.body))

    const list = await until(async () => {
      const reply = await api.get<{ conversations: ConversationView[] }>(`/api/works/${work.id}/conversations`)
      const items = reply.body.conversations
      return items.length === 2 && items[1]!.firstPrompt ? items : undefined
    })
    assert.deepEqual(list.map((c) => [c.id, c.source, c.current]), [[second, 'clear', true], [first, 'startup', false]])
    assert.equal(list[1]!.firstPrompt, 'Çoklu dil desteği ekle')
    assert.equal(list[1]!.title, 'ekran yirtilmasi')
    assert.equal(list[1]!.sessionId, created.body.id)

    const session = (await api.get<StateResponse>('/api/state')).body.sessions.find((s) => s.id === created.body.id)!
    assert.equal(session.conversation?.id, second)
    assert.equal(session.conversation?.current, true)
    assert.equal(fs.readdirSync(path.join(dataDir, 'hooks', 'claude')).length, 0, 'işlenen olay dosyası kalmaz')
  } finally {
    await daemon.close()
    removeDir(dataDir)
    removeDir(project)
    removeDir(scratch)
  }
})

test('Claude arka plan oturumları işe bağlanır; bir oturum tek işte durur', { timeout: 30000 }, async () => {
  const dataDir = tempDir()
  const project = tempDir()
  const bin = tempDir()
  const fake = path.join(bin, 'claude')
  fs.writeFileSync(fake, `#!/bin/sh\necho '[{"id":"93befcf9","cwd":"'"$5"'","name":"ekran yirtilmasi","state":"blocked"},{"id":"2b879538","cwd":"'"$5"'/alt","name":"multi-language","state":"done"}]'\n`, { mode: 0o755 })
  const daemon = await startDaemon({ dataDir, port: 0, claudeAgents: { command: fake, claudeDir: bin } })
  const api = client(daemon)
  try {
    const projectId = (await api.post<{ id: string }>('/api/projects', { path: project })).body.id
    const first = (await api.post<Work>('/api/works', { projectId, name: 'Ekran' })).body
    const second = (await api.post<Work>('/api/works', { projectId, name: 'i18n' })).body

    const listing = await api.get<{ supported: boolean; sessions: { id: string; workId: string | null }[] }>(`/api/projects/${projectId}/claude-sessions`)
    assert.equal(listing.body.supported, true)
    assert.deepEqual(listing.body.sessions.map((s) => s.id).sort(), ['2b879538', '93befcf9'])

    assert.equal((await api.post(`/api/works/${first.id}/claude-sessions`, { ids: ['nope'] })).status, 400)
    await api.post(`/api/works/${first.id}/claude-sessions`, { ids: ['93befcf9', '2b879538'] })
    await api.post(`/api/works/${second.id}/claude-sessions`, { ids: ['2b879538'] })
    const state = await until(async () => {
      const s = (await api.get<StateResponse>('/api/state')).body
      return s.claudeSessions?.[first.id]?.[0]?.state === 'blocked' ? s : undefined
    })
    assert.deepEqual(state.works?.find((w) => w.id === first.id)?.claudeSessions, ['93befcf9'])
    assert.deepEqual(state.claudeSessions?.[second.id]?.map((a) => a.name), ['multi-language'])

    await api.del(`/api/works/${first.id}/claude-sessions/93befcf9`)
    const after = (await api.get<StateResponse>('/api/state')).body
    assert.equal(after.claudeSessions?.[first.id], undefined)
  } finally {
    await daemon.close()
    removeDir(dataDir)
    removeDir(project)
    removeDir(bin)
  }
})

test('Claude oturumunun konuşma zinciri işte görünür; konuşma başka işe taşınıp geri alınabilir, dosyalar değişmez', { timeout: 30000 }, async () => {
  const dataDir = tempDir()
  const project = tempDir()
  const claudeDir = tempDir()
  const fake = path.join(claudeDir, 'claude')
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '[{"id":"93befcf9","cwd":"%s","name":"ekran yirtilmasi","state":"done","sessionId":"${b}"}]' "$5"\n`, { mode: 0o755 })
  const dir = path.join(claudeDir, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  const marker = 'Use `$CLAUDE_JOB_DIR/tmp` (`/x/.claude/jobs/93befcf9/tmp`) for temp files'
  const transcript = (prompt: string) => [
    JSON.stringify({ type: 'user', isMeta: true, cwd: project, message: { content: marker } }),
    JSON.stringify({ type: 'user', cwd: project, message: { content: prompt } }),
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, `${a}.jsonl`), transcript('Çoklu dil spec yaz'))
  fs.writeFileSync(path.join(dir, `${b}.jsonl`), transcript('ekran yırtılmasını incele'))
  const before = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))

  const daemon = await startDaemon({ dataDir, port: 0, claudeAgents: { command: fake, claudeDir } })
  const api = client(daemon)
  try {
    const projectId = (await api.post<{ id: string }>('/api/projects', { path: project })).body.id
    const screen = (await api.post<Work>('/api/works', { projectId, name: 'Ekran' })).body
    const i18n = (await api.post<Work>('/api/works', { projectId, name: 'Çeviri' })).body
    await api.post(`/api/works/${screen.id}/claude-sessions`, { ids: ['93befcf9'] })

    const list = async (work: Work) => (await api.get<{ conversations: ConversationView[] }>(`/api/works/${work.id}/conversations`)).body.conversations
    const chain = await list(screen)
    assert.deepEqual(chain.map((c) => [c.id, c.origin, c.current, c.claudeSessionId]).sort(), [[a, 'claude-session', false, '93befcf9'], [b, 'claude-session', true, '93befcf9']])
    assert.equal(chain.find((c) => c.id === a)?.firstPrompt, 'Çoklu dil spec yaz')
    assert.equal(chain.find((c) => c.id === a)?.cwd, project)

    assert.equal((await api.post(`/api/works/${i18n.id}/conversation-refs`, { ids: ['33333333-3333-4333-8333-333333333333'] })).status, 404)
    await api.post(`/api/works/${i18n.id}/conversation-refs`, { ids: [a] })
    assert.deepEqual((await list(screen)).map((c) => c.id), [b], 'taşınan konuşma asıl işte görünmez')
    assert.deepEqual((await list(i18n)).map((c) => [c.id, c.origin]), [[a, 'reference']])

    await api.del(`/api/works/${i18n.id}/conversation-refs/${a}`)
    assert.equal((await list(screen)).length, 2)
    assert.equal((await list(i18n)).length, 0)
    assert.deepEqual(fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')), before, 'Claude dosyalarına yazılmaz')
  } finally {
    await daemon.close()
    removeDir(dataDir)
    removeDir(project)
    removeDir(claudeDir)
  }
})
