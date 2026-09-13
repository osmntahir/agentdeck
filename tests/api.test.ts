import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import WebSocket from 'ws'
import { startDaemon, type Daemon } from '../src/server/daemon'
import { acquireDaemonLock } from '../src/server/lock'
import { StateError } from '../src/server/store'
import type { DiffResult, Project, SessionView, StateResponse } from '../src/shared/types'
import { tempDir, removeDir, isRoot } from './helpers'

interface Reply<T = any> {
  status: number
  body: T
}

function client(daemon: Daemon) {
  const call = async <T>(method: string, route: string, body?: unknown): Promise<Reply<T>> => {
    const res = await fetch(`${daemon.url}${route}`, {
      method,
      headers: {
        'X-Agentdeck-Token': daemon.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T }
  }
  return {
    get: <T>(route: string) => call<T>('GET', route),
    post: <T>(route: string, body?: unknown) => call<T>('POST', route, body),
    del: <T>(route: string, body?: unknown) => call<T>('DELETE', route, body),
  }
}

function initRepo(dir = tempDir()): string {
  fs.mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@agentdeck.local')
  git('config', 'user.name', 'AgentDeck Test')
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n')
  git('add', '.')
  git('commit', '-m', 'ilk')
  return dir
}

/** Veri dizini + depo + daemon kuran, sonunda hepsini toplayan çerçeve. */
async function withDaemon(
  fn: (ctx: {
    daemon: Daemon
    api: ReturnType<typeof client>
    dataDir: string
    repo: string
    projectId: string
  }) => Promise<void>,
  options: { seedState?: unknown; withProject?: boolean; environmentFile?: string } = {},
): Promise<void> {
  const dataDir = tempDir()
  const repo = initRepo()
  if (options.seedState !== undefined) {
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(options.seedState, null, 2))
  }
  const daemon = await startDaemon({ dataDir, port: 0, environmentFile: options.environmentFile })
  const api = client(daemon)
  let projectId = ''
  try {
    if (options.withProject !== false) {
      const added = await api.post<{ id: string }>('/api/projects', { path: repo })
      assert.equal(added.status, 200, JSON.stringify(added.body))
      projectId = added.body.id
    }
    await fn({ daemon, api, dataDir, repo, projectId })
  } finally {
    await daemon.close()
    removeDir(dataDir)
    removeDir(repo)
  }
}

const createBody = (projectId: string, over: Record<string, unknown> = {}) => ({
  requestId: `req-${Math.random().toString(16).slice(2)}`,
  projectId,
  command: 'sleep 300',
  isolation: 'worktree',
  ...over,
})

/**
 * Node'un global fetch'i aynı origin'e giden istekleri tek sokette sıraya
 * alır; gerçek eşzamanlılık için her istek kendi soketini açar.
 */
function rawCall<T>(daemon: Daemon, method: string, route: string, body: unknown): Promise<Reply<T>> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${daemon.url}${route}`,
      {
        method,
        agent: false,
        headers: {
          'X-Agentdeck-Token': daemon.token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (raw += chunk))
        res.on('end', () => {
          let parsed: unknown = {}
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = {}
          }
          resolve({ status: res.statusCode ?? 0, body: parsed as T })
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

function rawPost<T>(daemon: Daemon, route: string, body: unknown): Promise<Reply<T>> {
  return rawCall(daemon, 'POST', route, body)
}

async function waitFor(check: () => Promise<boolean>, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('koşul zamanında sağlanmadı')
    await new Promise((r) => setTimeout(r, 30))
  }
}

test('health tokensızdır ve protokol sürümünü bildirir', async () => {
  await withDaemon(async ({ daemon }) => {
    const res = await fetch(`${daemon.url}/api/health`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as { app: string; protocolVersion: number; pid: number }
    assert.equal(body.app, 'agentdeck')
    assert.equal(body.protocolVersion, 2)
    assert.equal(typeof body.pid, 'number')
  })
})

test('token ve origin kontrolü', async () => {
  await withDaemon(async ({ daemon }) => {
    const noToken = await fetch(`${daemon.url}/api/state`)
    assert.equal(noToken.status, 401)
    assert.equal(((await noToken.json()) as { code: string }).code, 'token')

    const badOrigin = await fetch(`${daemon.url}/api/state`, {
      headers: { 'X-Agentdeck-Token': daemon.token, Origin: 'https://kotu.example' },
    })
    assert.equal(badOrigin.status, 403)
    assert.equal(((await badOrigin.json()) as { code: string }).code, 'origin')
  })
})

test('bozuk kalıcı kayıtla daemon açılmaz ve dosyaya dokunmaz', async () => {
  const dataDir = tempDir()
  try {
    const file = path.join(dataDir, 'state.json')
    fs.writeFileSync(file, '{ bozuk')
    await assert.rejects(startDaemon({ dataDir, port: 0 }), (err: unknown) => {
      assert.ok(err instanceof StateError)
      assert.equal(err.code, 'state_corrupt')
      return true
    })
    assert.equal(fs.readFileSync(file, 'utf8'), '{ bozuk')
  } finally {
    removeDir(dataDir)
  }
})

test('aynı veri dizini için ikinci daemon açılmaz', async () => {
  const dataDir = tempDir()
  const first = await startDaemon({ dataDir, port: 0 })
  try {
    await assert.rejects(startDaemon({ dataDir, port: 0 }), /tutuyor/)
  } finally {
    await first.close()
    removeDir(dataDir)
  }
})

test('state kalıcı lifecycle yerine canlılık tahmini yayımlamaz', async () => {
  // Önceki daemon canlı bırakmış bir kayıt: orphaned olur ve exited'a dönüşmez.
  const seed = {
    schemaVersion: 2,
    projects: [{ id: 'p1', name: 'x', path: '/tmp/x', createdAt: 1 }],
    sessions: [
      {
        id: 'onceki',
        projectId: 'p1',
        name: 'önceki iş',
        command: 'claude',
        isolation: 'worktree',
        cwd: '/tmp/x/onceki',
        branch: 'agentdeck/onceki',
        baseCommit: 'a'.repeat(40),
        lifecycle: 'live',
        exitCode: null,
        exitSignal: null,
        createdAt: 10,
        endedAt: null,
        runId: 'eski-run',
        archivedAt: null,
        lastLaunch: { mode: 'command', command: 'claude' },
      },
    ],
  }
  await withDaemon(
    async ({ api }) => {
      const state = await api.get<StateResponse>('/api/state')
      assert.equal(state.status, 200)
      assert.equal(state.body.protocolVersion, 2)
      const session = state.body.sessions.find((s) => s.id === 'onceki')
      assert.ok(session)
      assert.equal(session.lifecycle, 'orphaned', 'canlı olmayan kayıt exited diye gösterilmez')
      assert.equal(session.exitCode, null, 'bilinmeyen çıkış kodu uydurulmaz')
      assert.equal(session.endedAt, null)
      assert.equal(session.activity, null, 'activity yalnız canlı Run için anlamlıdır')
    },
    { seedState: seed, withProject: false },
  )
})

test('oturum açılır, canlı görünür ve gerçek çıkış kaydedilir', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId, { name: 'ölçüm işi' }))
    assert.equal(created.status, 200, JSON.stringify(created.body))
    assert.equal(created.body.lifecycle, 'live')
    assert.ok(created.body.runId)
    assert.match(created.body.baseCommit ?? '', /^[0-9a-f]{40,64}$/, 'baseCommit çözümlenmiş OID olmalı')
    assert.match(created.body.branch ?? '', /^agentdeck\/olcum-isi-[0-9a-f]{32}$/)
    assert.equal(fs.existsSync(created.body.cwd), true)
    assert.deepEqual(created.body.lastLaunch, { mode: 'command', command: 'sleep 300' })

    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions[0].activity, 'active')

    const stopped = await api.post<SessionView>(`/api/sessions/${created.body.id}/stop`, {
      expectedRunId: created.body.runId,
    })
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body))
    assert.equal(stopped.body.lifecycle, 'exited')
    assert.equal(stopped.body.activity, null)
  })
})

test('eski expectedRunId ile gelen stop yeni Run u etkilemez', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const firstRun = created.body.runId

    const restarted = await api.post<SessionView>(`/api/sessions/${created.body.id}/restart`, {
      requestId: 'restart-1',
      expectedRunId: firstRun,
    })
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body))
    assert.notEqual(restarted.body.runId, firstRun, 'yeniden çalıştırma yeni Run dur')
    assert.equal(restarted.body.lifecycle, 'live')

    const stale = await api.post<{ code: string }>(`/api/sessions/${created.body.id}/stop`, {
      expectedRunId: firstRun,
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'stale_run')

    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions[0].lifecycle, 'live', 'geç stop yeni Run u durdurmadı')
    assert.equal(state.body.sessions[0].runId, restarted.body.runId)
  })
})

test('cwd yoksa yeniden çalıştırma live yazmaz ve dizin yaratmaz', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const stopped = await api.post(`/api/sessions/${created.body.id}/stop`, { expectedRunId: created.body.runId })
    assert.equal(stopped.status, 200)

    // Çalışma kopyası dışarıdan kaldırıldı.
    fs.rmSync(created.body.cwd, { recursive: true, force: true })

    const restarted = await api.post<{ code: string }>(`/api/sessions/${created.body.id}/restart`, {
      requestId: 'restart-cwd',
    })
    assert.equal(restarted.status, 400)
    assert.equal(restarted.body.code, 'cwd_missing')
    assert.equal(fs.existsSync(created.body.cwd), false, 'eksik cwd yaratılmaz')

    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions[0].lifecycle, 'exited', 'PTY doğmadan live yazılmaz')
  })
})

test('worktree kaldırılamazsa rmSync fallback yok; kayıt ve dosyalar korunur', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, repo, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const cwd = created.body.cwd
    fs.writeFileSync(path.join(cwd, 'ajan-isi.txt'), 'kaybolmamalı')

    const preview = await api.post<{ confirmationToken: string }>(`/api/sessions/${created.body.id}/delete-preview`)
    assert.equal(preview.status, 200, JSON.stringify(preview.body))

    // Kilitli worktree git tarafından kaldırılamaz (tek --force yetmez).
    execFileSync('git', ['worktree', 'lock', cwd], { cwd: repo, stdio: 'pipe' })
    try {
      const removed = await api.del<{ code: string; details: { cwd: string } }>(`/api/sessions/${created.body.id}`, {
        confirmationToken: preview.body.confirmationToken,
      })
      assert.equal(removed.status, 500)
      assert.equal(removed.body.code, 'worktree_remove_failed')
      assert.equal(fs.readFileSync(path.join(cwd, 'ajan-isi.txt'), 'utf8'), 'kaybolmamalı')

      const state = await api.get<StateResponse>('/api/state')
      assert.equal(state.body.sessions.length, 1, 'kayıt korunur')
    } finally {
      execFileSync('git', ['worktree', 'unlock', cwd], { cwd: repo, stdio: 'pipe' })
    }
  })
})

test('branch silme alanı reddedilir', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const withField = await api.del<{ code: string }>(`/api/sessions/${created.body.id}`, {
      confirmationToken: 'x',
      deleteBranch: true,
    })
    assert.equal(withField.status, 400)
    assert.equal(withField.body.code, 'unsupported_field')

    const withQuery = await api.del<{ code: string }>(`/api/sessions/${created.body.id}?deleteBranch=true`)
    assert.equal(withQuery.status, 400)
    assert.equal(withQuery.body.code, 'unsupported_field')
  })
})

test('onaysız silme reddedilir, onay sonrası içerik değişirse silme durur', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))

    const noToken = await api.del<{ code: string }>(`/api/sessions/${created.body.id}`)
    assert.equal(noToken.status, 400)
    assert.equal(noToken.body.code, 'validation')

    const preview = await api.post<{ confirmationToken: string; keepsBranch: boolean }>(
      `/api/sessions/${created.body.id}/delete-preview`,
    )
    assert.equal(preview.body.keepsBranch, true)

    // Onaydan sonra ajan yeni dosya yazdı: onay eskidi.
    fs.writeFileSync(path.join(created.body.cwd, 'sonradan.txt'), 'yeni iş')

    const stale = await api.del<{ code: string }>(`/api/sessions/${created.body.id}`, {
      confirmationToken: preview.body.confirmationToken,
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'confirmation_stale')
    assert.equal(fs.existsSync(created.body.cwd), true, 'eski onayla dosya silinmez')
  })
})

test('silme onayı ignored içeriği de kapsar; bütçe aşılırsa onay üretilmez', { timeout: 60000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    type Preview = { confirmationToken?: string; changedEntries: number; ignoredEntries: number; fingerprintScope: string }
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const id = created.body.id
    const cwd = created.body.cwd
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.env\nnode_modules/\n')
    fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n')

    const preview = await api.post<Preview>(`/api/sessions/${id}/delete-preview`)
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.equal(preview.body.fingerprintScope, 'content')
    assert.equal(preview.body.changedEntries, 1)
    assert.equal(preview.body.ignoredEntries, 1)

    // Git durumu aynı kalır; yalnız ignored dosyanın içeriği değişir.
    fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=2\n')
    const stale = await api.del<{ code: string }>(`/api/sessions/${id}`, {
      confirmationToken: preview.body.confirmationToken,
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'confirmation_stale')
    assert.equal(fs.readFileSync(path.join(cwd, '.env'), 'utf8'), 'SECRET=2\n', 'eski onayla ignored dosya silinmez')

    const modules = path.join(cwd, 'node_modules')
    fs.mkdirSync(modules)
    for (let i = 0; i <= 10_000; i++) fs.writeFileSync(path.join(modules, `f${i}.js`), '')
    const big = await api.post<Preview & { code: string; message: string }>(`/api/sessions/${id}/delete-preview`)
    assert.equal(big.status, 409, JSON.stringify(big.body))
    assert.equal(big.body.code, 'preview_budget_exceeded')
    assert.equal(big.body.confirmationToken, undefined, 'bütçe aşımında onay üretilmez')
    assert.match(big.body.message, /yerel araç/)
    assert.equal(fs.existsSync(modules), true)
  })
})

test('taze onayla silme dosyaları kaldırır ama branch i korur', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, repo, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const branch = created.body.branch as string
    const preview = await api.post<{ confirmationToken: string }>(`/api/sessions/${created.body.id}/delete-preview`)

    const removed = await api.del<{ ok: boolean; branchKept: string }>(`/api/sessions/${created.body.id}`, {
      confirmationToken: preview.body.confirmationToken,
    })
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.equal(removed.body.branchKept, branch)
    assert.equal(fs.existsSync(created.body.cwd), false)

    const branches = execFileSync('git', ['branch', '--list', branch], { cwd: repo, encoding: 'utf8' })
    assert.match(branches, new RegExp(branch.replace('/', '\\/')), 'branch korunur')

    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions.length, 0)
  })
})

test('lider çıkıp çocuk kalsa da silme grubu doğrulanmış biçimde durdurur', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', {
      ...createBody(projectId),
      command: 'trap "" HUP; sleep 300 & exit 0',
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))

    await waitFor(async () => {
      const state = await api.get<StateResponse>('/api/state')
      return state.body.sessions[0]?.lifecycle === 'exited'
    })

    const preview = await api.post<{ confirmationToken: string }>(`/api/sessions/${created.body.id}/delete-preview`)
    const removed = await api.del(`/api/sessions/${created.body.id}`, {
      confirmationToken: preview.body.confirmationToken,
    })
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.equal(fs.existsSync(created.body.cwd), false)
  })
})

test('arşiv canlı işi açık istek olmadan durdurmaz; arşiv ve arşivden çıkarma dosyalara dokunmaz', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, repo, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const id = created.body.id
    fs.writeFileSync(path.join(created.body.cwd, 'ajan-isi.txt'), 'korunmalı')

    const refused = await api.post<{ code: string }>(`/api/sessions/${id}/archive`, {
      expectedRunId: created.body.runId,
    })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.code, 'live_requires_stop')
    let state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions[0].lifecycle, 'live', 'açık istek olmadan canlı iş durdurulmaz')
    assert.equal(state.body.sessions[0].archivedAt, null)

    const stale = await api.post<{ code: string }>(`/api/sessions/${id}/archive`, {
      expectedRunId: 'eski-run',
      stopIfLive: true,
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'stale_run')

    const archived = await api.post<SessionView>(`/api/sessions/${id}/archive`, {
      expectedRunId: created.body.runId,
      stopIfLive: true,
    })
    assert.equal(archived.status, 200, JSON.stringify(archived.body))
    assert.equal(archived.body.lifecycle, 'exited', 'durdur ve arşivle doğrulanmış durdurmadır')
    assert.equal(typeof archived.body.archivedAt, 'number')
    assert.equal(archived.body.cwd, created.body.cwd)
    assert.equal(archived.body.branch, created.body.branch)
    assert.equal(archived.body.baseCommit, created.body.baseCommit)
    assert.equal(fs.readFileSync(path.join(created.body.cwd, 'ajan-isi.txt'), 'utf8'), 'korunmalı')
    const branch = created.body.branch as string
    assert.match(execFileSync('git', ['branch', '--list', branch], { cwd: repo, encoding: 'utf8' }), /agentdeck\//)

    const relaunch = await api.post<{ code: string }>(`/api/sessions/${id}/restart`, { requestId: 'arsivde-restart' })
    assert.equal(relaunch.status, 409)
    assert.equal(relaunch.body.code, 'session_archived', 'arşivdeki oturum görünmeden canlanmaz')
    assert.equal((await api.get<StateResponse>('/api/state')).body.sessions[0].lifecycle, 'exited')

    const restored = await api.post<SessionView>(`/api/sessions/${id}/unarchive`)
    assert.equal(restored.status, 200, JSON.stringify(restored.body))
    assert.equal(restored.body.archivedAt, null)
    assert.equal(restored.body.lifecycle, 'exited', 'arşivden çıkarma Run başlatmaz')
    assert.equal(fs.readFileSync(path.join(created.body.cwd, 'ajan-isi.txt'), 'utf8'), 'korunmalı')

    state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions[0].archivedAt, null)
  })
})

test('lideri çıkmış süreç grubu durum görünümünde işaretlenir; arşiv onu açık durdurmayla kapatır', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', {
      ...createBody(projectId),
      command: 'trap "" HUP; sleep 300 & exit 0',
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    await waitFor(async () => (await api.get<StateResponse>('/api/state')).body.sessions[0]?.lifecycle === 'exited')

    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions[0].remainingProcessGroup, true, 'lider çıktı ama grupta süreç kaldı')

    const refused = await api.post<{ code: string }>(`/api/sessions/${created.body.id}/archive`, {})
    assert.equal(refused.status, 409)
    assert.equal(refused.body.code, 'live_requires_stop')

    const archived = await api.post<SessionView>(`/api/sessions/${created.body.id}/archive`, { stopIfLive: true })
    assert.equal(archived.status, 200, JSON.stringify(archived.body))
    assert.equal(archived.body.remainingProcessGroup, false, 'kalan grup doğrulanmış biçimde durduruldu')
    assert.equal(typeof archived.body.archivedAt, 'number')
  })
})

test('bu çalışma kopyasında komut çalıştırma aynı cwd de yeni Run açar; başlangıç Command ı değişmez', { timeout: 40000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const id = created.body.id
    const cwd = created.body.cwd
    const marker = path.join(cwd, 'launch-cwd.txt')
    const command = 'pwd > launch-cwd.txt; sleep 300'

    const launched = await api.post<SessionView>(`/api/sessions/${id}/launch`, {
      requestId: 'launch-1',
      expectedRunId: created.body.runId,
      mode: 'command',
      command,
    })
    assert.equal(launched.status, 200, JSON.stringify(launched.body))
    assert.notEqual(launched.body.runId, created.body.runId, 'yeni Run')
    assert.equal(launched.body.lifecycle, 'live')
    assert.equal(launched.body.cwd, cwd)
    assert.equal(launched.body.command, 'sleep 300', 'başlangıç Command ı değişmez')
    assert.deepEqual(launched.body.lastLaunch, { mode: 'command', command })
    await waitFor(async () => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() !== '')
    assert.equal(fs.realpathSync(fs.readFileSync(marker, 'utf8').trim()), fs.realpathSync(cwd), 'aynı çalışma kopyasında')

    // Yeniden çalıştır son başarılı niyeti tekrarlar, başlangıç Command ını değil.
    fs.rmSync(marker)
    const restarted = await api.post<SessionView>(`/api/sessions/${id}/restart`, {
      requestId: 'restart-1',
      expectedRunId: launched.body.runId,
    })
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body))
    assert.deepEqual(restarted.body.lastLaunch, { mode: 'command', command })
    await waitFor(async () => fs.existsSync(marker))

    const managed = await api.post<{ code: string }>(`/api/sessions/${id}/launch`, {
      requestId: 'launch-2',
      mode: 'resume',
      cli: 'claude',
      conversationId: '12345678-1234-1234-1234-123456789abc',
    })
    assert.equal(managed.status, 400)
    assert.equal(managed.body.code, 'mode_unsupported', 'yönetilen kimlik G2 geçmeden kapalı')

    const extra = await api.post<{ code: string }>(`/api/sessions/${id}/launch`, {
      requestId: 'launch-3',
      mode: 'command',
      command: null,
      conversationId: 'x',
    })
    assert.equal(extra.status, 400)
    assert.equal(extra.body.code, 'validation', 'modun izinli olmayan alanı reddedilir')

    const missing = await api.post<{ code: string }>(`/api/sessions/${id}/launch`, { requestId: 'launch-4', mode: 'command' })
    assert.equal(missing.status, 400)

    const stale = await api.post<{ code: string }>(`/api/sessions/${id}/launch`, {
      requestId: 'launch-5',
      expectedRunId: created.body.runId,
      mode: 'command',
      command: null,
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'stale_run')

    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions[0].runId, restarted.body.runId, 'reddedilen istek Run değiştirmez')
  })
})

test('aynı requestId ikinci bir Run doğurmaz, farklı payload çakışır', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const body = createBody(projectId, { name: 'tekil' })
    const first = await api.post<SessionView>('/api/sessions', body)
    const replay = await api.post<SessionView>('/api/sessions', body)
    assert.equal(first.status, 200)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.id, first.body.id, 'kayıp cevap ikinci oturum açmaz')

    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions.length, 1)

    const conflict = await api.post<{ code: string }>('/api/sessions', { ...body, name: 'başka' })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.code, 'request_id_conflict')
  })
})

test('aynı oturumda süren mutation ikinciyi 409 ile reddeder', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, daemon, projectId }) => {
    // HUP'ı yutan grup: doğrulanmış durdurma SIGKILL yükseltmesini beklediği
    // için ilk restart kilidi ölçülebilir bir süre tutar.
    const created = await api.post<SessionView>('/api/sessions', {
      ...createBody(projectId),
      command: 'trap "" HUP; sleep 300',
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))

    // Kabuk trap'i kurana kadar SIGHUP onu hemen öldürür ve durdurma anında
    // biter; kilidin ölçülebilir süre tutulması için Run'ın yerleşmesi beklenir.
    await new Promise((r) => setTimeout(r, 1000))

    const first = rawPost<{ code?: string }>(daemon, `/api/sessions/${created.body.id}/restart`, {
      requestId: 'r-a',
    })
    await new Promise((r) => setTimeout(r, 300))
    const second = await rawPost<{ code?: string }>(daemon, `/api/sessions/${created.body.id}/restart`, {
      requestId: 'r-b',
    })

    assert.equal(second.status, 409, JSON.stringify(second.body))
    assert.equal(second.body.code, 'operation_in_progress')
    assert.equal((await first).status, 200)
  })
})

test('create doğrulamaları', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const noRequestId = await api.post<{ code: string }>('/api/sessions', { projectId, command: null, isolation: 'shared' })
    assert.equal(noRequestId.status, 400)

    const emptyCommand = await api.post<{ code: string; message: string }>(
      '/api/sessions',
      createBody(projectId, { command: '' }),
    )
    assert.equal(emptyCommand.status, 400)
    assert.match(emptyCommand.body.message, /Boş komut/)

    const missingCommand = await api.post<{ message: string }>('/api/sessions', {
      requestId: 'yok-command',
      projectId,
      isolation: 'worktree',
    })
    assert.equal(missingCommand.status, 400)
    assert.match(missingCommand.body.message, /command alanı gerekli/)

    const longName = await api.post<{ message: string }>(
      '/api/sessions',
      createBody(projectId, { name: 'a'.repeat(81) }),
    )
    assert.equal(longName.status, 400)
    assert.match(longName.body.message, /80 karakter/)

    const badIsolation = await api.post<{ message: string }>(
      '/api/sessions',
      createBody(projectId, { isolation: 'sandbox' }),
    )
    assert.equal(badIsolation.status, 400)
  })
})

test('boş komut null olarak kabuk açar ve ad otomatik verilir', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId, { command: null, name: '' }))
    assert.equal(created.status, 200, JSON.stringify(created.body))
    assert.equal(created.body.command, null)
    assert.match(created.body.name, /^Kabuk [0-9a-f]{6}$/)
  })
})

test('environment.json her Run öncesi okunur; bozuk dosyada Run başlamaz ve canlı iş durdurulmaz', { timeout: 40000 }, async () => {
  const envDir = tempDir()
  const environmentFile = path.join(envDir, 'environment.json')
  const writeEnv = (values: unknown, mode: number) => {
    fs.writeFileSync(environmentFile, JSON.stringify(values))
    fs.chmodSync(environmentFile, mode)
  }
  try {
    await withDaemon(
      async ({ api, dataDir, projectId }) => {
        writeEnv({ DECK_ENV_PROBE: 'ilk' }, 0o644)
        const rejected = await api.post<{ code: string; message: string }>('/api/sessions', createBody(projectId))
        assert.equal(rejected.status, 409, JSON.stringify(rejected.body))
        assert.equal(rejected.body.code, 'environment_invalid')
        assert.match(rejected.body.message, /environment\.json/)
        assert.ok(!rejected.body.message.includes('ilk'), 'değer mesajda görünmez')
        assert.equal((await api.get<StateResponse>('/api/state')).body.sessions.length, 0, 'kayıt açılmaz')
        const worktrees = path.join(dataDir, 'worktrees')
        assert.ok(!fs.existsSync(worktrees) || fs.readdirSync(worktrees).every((p) => fs.readdirSync(path.join(worktrees, p)).length === 0), 'worktree açılmaz')

        writeEnv({ DECK_ENV_PROBE: 'ilk' }, 0o600)
        const created = await api.post<SessionView>(
          '/api/sessions',
          createBody(projectId, { command: 'printf "%s" "$DECK_ENV_PROBE" > env-value.txt; sleep 300' }),
        )
        assert.equal(created.status, 200, JSON.stringify(created.body))
        const marker = path.join(created.body.cwd, 'env-value.txt')
        await waitFor(async () => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'ilk')

        writeEnv({ DECK_ENV_PROBE: 'ikinci', TERM: 'dumb' }, 0o600)
        const restartRejected = await api.post<{ code: string }>(`/api/sessions/${created.body.id}/restart`, {
          requestId: 'env-restart-1',
          expectedRunId: created.body.runId,
        })
        assert.equal(restartRejected.status, 409, JSON.stringify(restartRejected.body))
        assert.equal(restartRejected.body.code, 'environment_invalid')
        const afterReject = (await api.get<StateResponse>('/api/state')).body.sessions[0]
        assert.equal(afterReject.lifecycle, 'live', 'bozuk dosya canlı işi durdurmaz')
        assert.equal(afterReject.runId, created.body.runId)

        // Değişiklik sonraki Run'a uygulanır.
        writeEnv({ DECK_ENV_PROBE: 'ikinci' }, 0o600)
        const restarted = await api.post<SessionView>(`/api/sessions/${created.body.id}/restart`, {
          requestId: 'env-restart-2',
          expectedRunId: created.body.runId,
        })
        assert.equal(restarted.status, 200, JSON.stringify(restarted.body))
        await waitFor(async () => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'ikinci')
      },
      { environmentFile },
    )
  } finally {
    removeDir(envDir)
  }
})

test('çalışma dizini veya proje kökü kaybolunca lifecycle değişmeden degraded görünür', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId, repo }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    assert.equal(created.status, 200, JSON.stringify(created.body))

    const healthy = await api.get<StateResponse>('/api/state')
    assert.equal(healthy.body.sessions[0].degraded, null)
    assert.equal(healthy.body.projects[0].degraded, null)

    fs.rmSync(created.body.cwd, { recursive: true, force: true })
    let session: SessionView | undefined
    await waitFor(async () => {
      session = (await api.get<StateResponse>('/api/state')).body.sessions[0]
      return session.degraded !== null
    })
    assert.match(session!.degraded!, /Çalışma dizini/)
    assert.equal(session!.lifecycle, 'live', 'degraded lifecycle değeri değildir')

    const moved = `${repo}-tasindi`
    fs.renameSync(repo, moved)
    try {
      let project: StateResponse['projects'][number] | undefined
      await waitFor(async () => {
        project = (await api.get<StateResponse>('/api/state')).body.projects[0]
        return project.degraded !== null
      })
      assert.match(project!.degraded!, /Proje klasörü/)
    } finally {
      fs.renameSync(moved, repo)
    }
  })
})

test('kayıt sınırı dolduğunda create durur ve hiçbir kayıt kesilmez', async () => {
  const many = Array.from({ length: 256 }, (_, i) => ({
    id: `s${i}`,
    projectId: 'p1',
    name: `iş ${i}`,
    command: null,
    isolation: 'shared',
    cwd: '/tmp/x',
    branch: null,
    baseCommit: null,
    lifecycle: 'exited',
    exitCode: 0,
    exitSignal: null,
    createdAt: i,
    endedAt: i,
    runId: null,
    archivedAt: null,
    lastLaunch: { mode: 'command', command: null },
  }))
  await withDaemon(
    async ({ api, projectId }) => {
      const created = await api.post<{ code: string }>('/api/sessions', createBody(projectId))
      assert.equal(created.status, 409)
      assert.equal(created.body.code, 'capacity')

      const state = await api.get<StateResponse>('/api/state')
      assert.equal(state.body.sessions.length, 256, 'fazla legacy kayıt kesilmez')
    },
    { seedState: { schemaVersion: 2, projects: [{ id: 'p1', name: 'x', path: '/tmp/x', createdAt: 1 }], sessions: many } },
  )
})

test('proje ekleme: alias aynı projeye çözülür, yönetilen kopya reddedilir', async () => {
  await withDaemon(async ({ api, dataDir, repo, projectId }) => {
    const again = await api.post<{ code: string; details: { existingProjectId: string } }>('/api/projects', {
      path: repo,
    })
    assert.equal(again.status, 409)
    assert.equal(again.body.details.existingProjectId, projectId)

    const aliasHome = tempDir()
    const alias = path.join(aliasHome, 'alias')
    fs.symlinkSync(repo, alias)
    try {
      const viaAlias = await api.post<{ code: string }>('/api/projects', { path: alias })
      assert.equal(viaAlias.status, 409, 'symlink alias aynı köke çözülür')
    } finally {
      fs.unlinkSync(alias)
      removeDir(aliasHome)
    }

    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const managed = await api.post<{ message: string }>('/api/projects', { path: created.body.cwd })
    assert.equal(managed.status, 400)
    assert.match(managed.body.message, /kendi çalışma kopyası/)
    assert.ok(dataDir.length > 0)
  })
})

test('yerel klasör projesi ortak oturum açar; silme kullanıcı dosyalarını korur', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, dataDir }) => {
    const plain = tempDir()
    try {
      const file = path.join(plain, 'kiosk.txt')
      fs.writeFileSync(file, 'kiosk')
      const added = await api.post<Project>('/api/projects', { path: plain })
      assert.equal(added.status, 200)
      assert.equal(added.body.kind, 'folder')
      assert.equal(added.body.path, fs.realpathSync(plain))
      assert.equal(fs.existsSync(path.join(plain, '.git')), false, 'Git deposu oluşturulmaz')
      const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'))
      assert.equal(persisted.projects.find((p: Project) => p.id === added.body.id).kind, 'folder')

      const alias = path.join(dataDir, 'kiosk-alias')
      fs.symlinkSync(plain, alias)
      assert.equal((await api.post('/api/projects', { path: alias })).status, 409)
      const isolated = await api.post<{ code: string }>('/api/sessions', createBody(added.body.id))
      assert.equal(isolated.status, 400)
      assert.equal(isolated.body.code, 'git_required')

      const created = await api.post<SessionView>('/api/sessions', createBody(added.body.id, { isolation: 'shared' }))
      assert.equal(created.status, 200)
      assert.equal(created.body.lifecycle, 'live')
      assert.equal(created.body.cwd, fs.realpathSync(plain))
      assert.equal(created.body.baseCommit, null)
      assert.equal(created.body.branch, null)
      const diff = await api.get<{ code: string }>(`/api/sessions/${created.body.id}/diff`)
      assert.equal(diff.status, 409)
      assert.equal(diff.body.code, 'git_required', 'Git olmayan klasör temiz diff gibi gösterilmez')

      const stopped = await api.post(`/api/sessions/${created.body.id}/stop`, { expectedRunId: created.body.runId })
      assert.equal(stopped.status, 200)
      const restarted = await api.post<SessionView>(`/api/sessions/${created.body.id}/restart`, {
        requestId: 'folder-restart', expectedRunId: created.body.runId,
      })
      assert.equal(restarted.status, 200)
      assert.notEqual(restarted.body.runId, created.body.runId)
      const preview = await api.post<{ confirmationToken: string; fingerprintScope: string }>(`/api/sessions/${created.body.id}/delete-preview`)
      assert.equal(preview.status, 200)
      assert.equal(preview.body.fingerprintScope, 'dir-identity')
      fs.writeFileSync(file, 'kiosk değişti')
      const deleted = await api.del(`/api/sessions/${created.body.id}`, { confirmationToken: preview.body.confirmationToken })
      assert.equal(deleted.status, 200)
      assert.equal(fs.readFileSync(file, 'utf8'), 'kiosk değişti', 'ortak klasör içeriğine dokunulmaz')
      assert.equal((await api.del(`/api/projects/${added.body.id}`)).status, 200)
      assert.equal(fs.existsSync(file), true)
    } finally { removeDir(plain) }
  })
})

test('klasör projesinde diff alt klasörlerdeki her Git deposunu ayrı gösterir', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api }) => {
    const folder = tempDir()
    try {
      const web = initRepo(path.join(folder, 'web'))
      initRepo(path.join(folder, 'org', 'api'))
      fs.mkdirSync(path.join(folder, 'notlar'))
      fs.writeFileSync(path.join(web, 'README.md'), '# değişti\n')
      fs.writeFileSync(path.join(web, 'yeni.txt'), 'yeni dosya\n')

      const added = await api.post<Project>('/api/projects', { path: folder })
      assert.equal(added.body.kind, 'folder')
      const created = await api.post<SessionView>('/api/sessions', createBody(added.body.id, { isolation: 'shared' }))
      assert.equal(created.status, 200)

      const res = await api.get<DiffResult>(`/api/sessions/${created.body.id}/diff`)
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.equal(res.body.truncated, false)
      assert.deepEqual(res.body.repos.map((r) => [r.path, r.branch]), [['org/api', 'main'], ['web', 'main']])
      const [clean, changed] = res.body.repos
      assert.equal(clean.diff, '')
      assert.equal(clean.status, '')
      assert.match(changed.diff, /\+# değişti/)
      assert.match(changed.diff, /\+yeni dosya/)
    } finally {
      removeDir(folder)
    }
  })
})

test('klasör projesinde izole oturum her alt depo için aynı branch ile worktree açar', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api }) => {
    const folder = tempDir()
    const git = (dir: string, ...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    try {
      const web = initRepo(path.join(folder, 'web'))
      const service = initRepo(path.join(folder, 'org', 'api'))
      fs.mkdirSync(path.join(folder, 'notlar'))
      fs.writeFileSync(path.join(folder, 'notlar', 'plan.txt'), 'kopyalanmaz')

      const added = await api.post<Project>('/api/projects', { path: folder })
      const created = await api.post<SessionView>('/api/sessions', createBody(added.body.id, { isolation: 'worktree' }))
      assert.equal(created.status, 200, JSON.stringify(created.body))
      const session = created.body
      assert.notEqual(session.cwd, added.body.path)
      assert.equal(session.baseCommit, null, 'tek bir başlangıç commit\'i yok; depo başına tutulur')
      assert.match(session.branch ?? '', /^agentdeck\//)
      assert.deepEqual(session.worktrees, [
        { path: 'org/api', baseCommit: git(service, 'rev-parse', 'HEAD') },
        { path: 'web', baseCommit: git(web, 'rev-parse', 'HEAD') },
      ])
      for (const rel of ['org/api', 'web']) {
        assert.equal(git(path.join(session.cwd, rel), 'rev-parse', '--abbrev-ref', 'HEAD'), session.branch)
      }
      assert.equal(fs.existsSync(path.join(session.cwd, 'notlar')), false, 'depo dışı dosyalar kopyalanmaz')

      fs.writeFileSync(path.join(session.cwd, 'web', 'README.md'), '# izole\n')
      assert.equal(fs.readFileSync(path.join(web, 'README.md'), 'utf8'), '# test\n', 'kaynak depoya dokunulmaz')
      const diff = await api.get<DiffResult>(`/api/sessions/${session.id}/diff`)
      assert.equal(diff.status, 200, JSON.stringify(diff.body))
      assert.deepEqual(diff.body.repos.map((r) => [r.path, r.branch]), [
        ['org/api', session.branch],
        ['web', session.branch],
      ])
      assert.match(diff.body.repos[1].diff, /\+# izole/)
    } finally {
      removeDir(folder)
    }
  })
})

test('klasör projesinde izole oturum silinince tüm worktree\'ler kalkar, branch\'ler kalır', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api }) => {
    const folder = tempDir()
    const git = (dir: string, ...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    try {
      const web = initRepo(path.join(folder, 'web'))
      const service = initRepo(path.join(folder, 'org', 'api'))
      const added = await api.post<Project>('/api/projects', { path: folder })
      const created = await api.post<SessionView>('/api/sessions', createBody(added.body.id))
      assert.equal(created.status, 200, JSON.stringify(created.body))
      const session = created.body
      fs.writeFileSync(path.join(session.cwd, 'web', 'README.md'), '# izole\n')
      fs.writeFileSync(path.join(session.cwd, 'org', 'api', 'yeni.txt'), 'yeni\n')

      type Preview = { confirmationToken: string; changedEntries: number; fingerprintScope: string }
      const first = await api.post<Preview>(`/api/sessions/${session.id}/delete-preview`)
      assert.equal(first.status, 200, JSON.stringify(first.body))
      assert.equal(first.body.changedEntries, 2, 'değişiklikler tüm worktree\'lerden toplanır')
      assert.equal(first.body.fingerprintScope, 'content')

      fs.writeFileSync(path.join(session.cwd, 'org', 'api', 'README.md'), '# sonradan\n')
      const stale = await api.del<{ code: string }>(`/api/sessions/${session.id}`, {
        confirmationToken: first.body.confirmationToken,
      })
      assert.equal(stale.status, 409)
      assert.equal(stale.body.code, 'confirmation_stale')
      assert.equal(fs.existsSync(path.join(session.cwd, 'web', 'README.md')), true, 'eskimiş onayla hiçbir worktree kalkmaz')

      const fresh = await api.post<Preview>(`/api/sessions/${session.id}/delete-preview`)
      assert.equal(fresh.body.changedEntries, 3)
      const deleted = await api.del(`/api/sessions/${session.id}`, { confirmationToken: fresh.body.confirmationToken })
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
      assert.equal(fs.existsSync(session.cwd), false, 'boş kalan kapsayıcı klasör kaldırılır')
      for (const repo of [web, service]) {
        assert.equal(git(repo, 'branch', '--list', session.branch as string), session.branch, 'branch korunur')
        assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
      }
      assert.equal(fs.readFileSync(path.join(web, 'README.md'), 'utf8'), '# test\n', 'kaynak depoya dokunulmaz')
    } finally {
      removeDir(folder)
    }
  })
})

test('klasör oturumunda bir worktree kaldırılamazsa kaldırılanlar kayıttan düşer; oturum sonra silinebilir', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api }) => {
    const folder = tempDir()
    try {
      initRepo(path.join(folder, 'a'))
      const lockedRepo = initRepo(path.join(folder, 'b'))
      const added = await api.post<Project>('/api/projects', { path: folder })
      const created = await api.post<SessionView>('/api/sessions', createBody(added.body.id))
      assert.equal(created.status, 200, JSON.stringify(created.body))
      const session = created.body
      const lockedWorktree = path.join(session.cwd, 'b')
      // Kilitli worktree git tarafından kaldırılamaz (tek --force yetmez).
      execFileSync('git', ['worktree', 'lock', lockedWorktree], { cwd: lockedRepo, stdio: 'pipe' })

      const preview = await api.post<{ confirmationToken: string }>(`/api/sessions/${session.id}/delete-preview`)
      const failed = await api.del<{ code: string; details: { removed: string[] } }>(`/api/sessions/${session.id}`, {
        confirmationToken: preview.body.confirmationToken,
      })
      assert.equal(failed.status, 500)
      assert.equal(failed.body.code, 'worktree_remove_failed')
      assert.deepEqual(failed.body.details.removed, ['a'])
      const state = await api.get<StateResponse>('/api/state')
      assert.deepEqual(state.body.sessions[0].worktrees.map((w) => w.path), ['b'], 'kalan worktree kayıtta durur')

      // Kullanıcı kalanı yerel Git ile kaldırır: kayıttaki yol artık yoktur, okunamaz değildir.
      execFileSync('git', ['worktree', 'unlock', lockedWorktree], { cwd: lockedRepo, stdio: 'pipe' })
      execFileSync('git', ['worktree', 'remove', lockedWorktree], { cwd: lockedRepo, stdio: 'pipe' })
      const retry = await api.post<{ confirmationToken: string; changedEntries: number }>(
        `/api/sessions/${session.id}/delete-preview`,
      )
      assert.equal(retry.status, 200, JSON.stringify(retry.body))
      assert.equal(retry.body.changedEntries, 0)
      const deleted = await api.del(`/api/sessions/${session.id}`, { confirmationToken: retry.body.confirmationToken })
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
      assert.equal(fs.existsSync(session.cwd), false)
    } finally {
      removeDir(folder)
    }
  })
})

test('aynı Git dizinini paylaşan alt depolarda izole oturum açıklamayla reddedilir', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api }) => {
    const folder = tempDir()
    try {
      const web = initRepo(path.join(folder, 'web'))
      execFileSync('git', ['worktree', 'add', '-b', 'kopya', path.join(folder, 'web-kopya')], { cwd: web, stdio: 'pipe' })

      const added = await api.post<Project>('/api/projects', { path: folder })
      const res = await api.post<{ code: string; message: string }>('/api/sessions', createBody(added.body.id))
      assert.equal(res.status, 400, JSON.stringify(res.body))
      assert.equal(res.body.code, 'shared_git_dir')
      assert.match(res.body.message, /web, web-kopya/)
      const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: web, encoding: 'utf8' })
      assert.equal(worktrees.trim().split('\n').length, 2, 'yeni worktree açılmaz')
    } finally {
      removeDir(folder)
    }
  })
})

test('klasördeki bir depoda commit yoksa izole oturum hiç worktree açmadan reddedilir', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api }) => {
    const folder = tempDir()
    try {
      const web = initRepo(path.join(folder, 'web'))
      fs.mkdirSync(path.join(folder, 'bos'))
      execFileSync('git', ['init', '-b', 'main'], { cwd: path.join(folder, 'bos'), stdio: 'pipe' })

      const added = await api.post<Project>('/api/projects', { path: folder })
      const res = await api.post<{ code: string; message: string }>('/api/sessions', createBody(added.body.id))
      assert.equal(res.status, 400)
      assert.equal(res.body.code, 'head_missing')
      assert.match(res.body.message, /bos/)
      const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: web, encoding: 'utf8' })
      assert.equal(worktrees.trim().split('\n').length, 1, 'diğer depoda da worktree açılmaz')
    } finally {
      removeDir(folder)
    }
  })
})

test('Git projesinde diff tek depo olarak "." yolunda döner', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    assert.equal(created.status, 200)
    fs.writeFileSync(path.join(created.body.cwd, 'README.md'), '# worktree\n')

    const res = await api.get<DiffResult>(`/api/sessions/${created.body.id}/diff`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.repos.map((r) => [r.path, r.branch]), [['.', created.body.branch]])
    assert.match(res.body.repos[0].diff, /\+# worktree/)
  })
})

test('"Bu çalışma" base commit ten toplam farkı, "Commit edilmemiş" yalnız HEAD e göre farkı gösterir', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const cwd = created.body.cwd
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })

    fs.writeFileSync(path.join(cwd, 'README.md'), '# ajan commit etti\n')
    git('commit', '-qam', 'ajan işi')
    fs.writeFileSync(path.join(cwd, 'notlar.txt'), 'commit edilmemiş\n')
    git('add', 'notlar.txt')
    fs.writeFileSync(path.join(cwd, 'yeni.txt'), 'takip edilmeyen\n')

    const work = await api.get<DiffResult>(`/api/sessions/${created.body.id}/diff`)
    assert.equal(work.status, 200, JSON.stringify(work.body))
    assert.equal(work.body.scope, 'work', 'izole oturumda varsayılan toplam görünümdür')
    const [repo] = work.body.repos
    assert.equal(repo.baseCommit, created.body.baseCommit)
    assert.equal(repo.error, null)
    assert.match(repo.diff, /\+# ajan commit etti/, 'commit edilmiş iş toplam görünümde bulunur')
    assert.match(repo.diff, /\+commit edilmemiş/)
    assert.match(repo.diff, /\+takip edilmeyen/)

    const uncommitted = await api.get<DiffResult>(`/api/sessions/${created.body.id}/diff?scope=uncommitted`)
    assert.equal(uncommitted.status, 200, JSON.stringify(uncommitted.body))
    assert.equal(uncommitted.body.scope, 'uncommitted')
    assert.doesNotMatch(uncommitted.body.repos[0].diff, /ajan commit etti/, 'HEAD e göre farkta commit edilmiş iş yok')
    assert.match(uncommitted.body.repos[0].diff, /\+commit edilmemiş/)
    assert.match(uncommitted.body.repos[0].diff, /\+takip edilmeyen/)

    const invalid = await api.get<{ code: string }>(`/api/sessions/${created.body.id}/diff?scope=main`)
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.code, 'validation')
  })
})

test('staged ve unstaged birbirini geri alsa da status kirli kalır; ortak kopyada toplam görünüm uydurulmaz', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, repo, projectId }) => {
    const isolated = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const cwd = isolated.body.cwd
    fs.writeFileSync(path.join(cwd, 'README.md'), '# staged\n')
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' })
    fs.writeFileSync(path.join(cwd, 'README.md'), '# test\n')

    const net = await api.get<DiffResult>(`/api/sessions/${isolated.body.id}/diff?scope=uncommitted`)
    assert.equal(net.status, 200, JSON.stringify(net.body))
    assert.equal(net.body.repos[0].diff, '', 'net patch boş')
    assert.match(net.body.repos[0].status, /^MM README\.md$/m, 'index ve çalışma ağacı ayrı belirtilir')
    assert.equal(net.body.repos[0].error, null)

    const shared = await api.post<SessionView>('/api/sessions', createBody(projectId, { isolation: 'shared' }))
    fs.writeFileSync(path.join(repo, 'ortak.txt'), 'ortak iş\n')
    const byDefault = await api.get<DiffResult>(`/api/sessions/${shared.body.id}/diff`)
    assert.equal(byDefault.body.scope, 'uncommitted', 'ortak kopyanın varsayılanı commit edilmemiş görünümdür')
    assert.match(byDefault.body.repos[0].diff, /\+ortak iş/)

    const work = await api.get<DiffResult>(`/api/sessions/${shared.body.id}/diff?scope=work`)
    assert.equal(work.status, 200, JSON.stringify(work.body))
    assert.equal(work.body.repos[0].baseCommit, null)
    assert.equal(work.body.repos[0].diff, '', 'hareketli HEAD ile ikame yapılmaz')
    assert.match(String(work.body.repos[0].error), /başlangıç commit/)
  })
})

test('diff patch sınırında kesildiğini söyler; Git hatası temiz diff sayılmaz', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const cwd = created.body.cwd
    fs.writeFileSync(path.join(cwd, 'README.md'), 'büyük satır\n'.repeat(200_000))

    const big = await api.get<DiffResult>(`/api/sessions/${created.body.id}/diff?scope=uncommitted`)
    assert.equal(big.status, 200)
    assert.equal(big.body.repos[0].patchTruncated, true)
    assert.ok(Buffer.byteLength(big.body.repos[0].diff) <= 1024 * 1024, 'patch 1 MiB sınırını aşmaz')
    assert.ok(big.body.repos[0].diff.endsWith('\n'), 'kesik patch son tam satırda biter')

    if (isRoot) return
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).trim()
    const index = path.join(gitDir, 'index')
    fs.chmodSync(index, 0o000)
    try {
      const broken = await api.get<DiffResult>(`/api/sessions/${created.body.id}/diff?scope=uncommitted`)
      assert.equal(broken.status, 200)
      assert.notEqual(broken.body.repos[0].error, null, 'okunamayan index temiz diff diye gösterilmez')
      assert.equal(broken.body.repos[0].diff, '')
    } finally {
      fs.chmodSync(index, 0o644)
    }
  })
})

test('bulunmayan yol, dosya, bare depo ve yönetilen normal klasör reddedilir', async () => {
  await withDaemon(async ({ api, dataDir, repo }) => {
    const missing = await api.post('/api/projects', { path: '/tmp/agentdeck-yok-xyz' })
    assert.equal(missing.status, 400)
    const file = await api.post('/api/projects', { path: path.join(repo, 'README.md') })
    assert.equal(file.status, 400)
    const bare = path.join(dataDir, 'bare.git')
    execFileSync('git', ['init', '--bare', bare], { stdio: 'pipe' })
    assert.equal((await api.post('/api/projects', { path: bare })).status, 400)
    const managed = path.join(dataDir, 'worktrees', 'plain')
    fs.mkdirSync(managed, { recursive: true })
    assert.equal((await api.post('/api/projects', { path: managed })).status, 400)
  })
})

test('oturumu olan proje gizlice cascade silinmez', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const removed = await api.del<{ code: string; details: { sessionIds: string[] } }>(`/api/projects/${projectId}`)
    assert.equal(removed.status, 409)
    assert.equal(removed.body.code, 'project_has_sessions')
    assert.deepEqual(removed.body.details.sessionIds, [created.body.id])
    assert.equal(fs.existsSync(created.body.cwd), true)
  })
})

test('korunan branch ler proje görünümünde tip OID siyle bulunur; kayıt yoksa görev bilgisi uydurulmaz', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, repo, projectId }) => {
    type Branches = {
      repos: {
        path: string
        branches: { name: string; oid: string; sessionId: string | null }[]
        truncated: boolean
        error: string | null
      }[]
      truncated: boolean
    }
    const removed = await api.post<SessionView>('/api/sessions', createBody(projectId, { name: 'silinecek' }))
    const kept = await api.post<SessionView>('/api/sessions', createBody(projectId, { name: 'kalan' }))
    execFileSync('git', ['branch', 'kullanici-dali'], { cwd: repo, stdio: 'pipe' })

    const cwd = removed.body.cwd
    fs.writeFileSync(path.join(cwd, 'is.txt'), 'ajan işi\n')
    execFileSync('git', ['add', 'is.txt'], { cwd, stdio: 'pipe' })
    execFileSync('git', ['commit', '-qm', 'ajan işi'], { cwd, stdio: 'pipe' })
    const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()

    const preview = await api.post<{ confirmationToken: string }>(`/api/sessions/${removed.body.id}/delete-preview`)
    const deleted = await api.del(`/api/sessions/${removed.body.id}`, { confirmationToken: preview.body.confirmationToken })
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body))

    const res = await api.get<Branches>(`/api/projects/${projectId}/branches`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.repos.length, 1)
    const [only] = res.body.repos
    assert.equal(only.path, '.')
    assert.equal(only.error, null)
    assert.equal(only.truncated, false)
    const byName = new Map(only.branches.map((b) => [b.name, b]))
    assert.equal(byName.get(removed.body.branch as string)?.oid, tip, 'silinen oturumun işi branch tipinde bulunur')
    assert.equal(byName.get(removed.body.branch as string)?.sessionId, null, 'kaydı olmayan branch e görev bilgisi uydurulmaz')
    assert.equal(byName.get(kept.body.branch as string)?.sessionId, kept.body.id)
    assert.equal(byName.has('kullanici-dali'), false, 'yalnız agentdeck/ branch leri listelenir')
    assert.equal(byName.has('main'), false)

    // Okunamayan depo boş liste diye gösterilmez.
    fs.renameSync(path.join(repo, '.git'), path.join(repo, '.git-gizli'))
    try {
      const broken = await api.get<Branches>(`/api/projects/${projectId}/branches`)
      assert.equal(broken.status, 200)
      assert.notEqual(broken.body.repos[0].error, null)
      assert.deepEqual(broken.body.repos[0].branches, [])
    } finally {
      fs.renameSync(path.join(repo, '.git-gizli'), path.join(repo, '.git'))
    }
  })
})

type ProjectDeletePreview = {
  confirmationToken?: string
  projectId: string
  sessions: { id: string; cwd: string; isolation: string; changedEntries: number; ignoredEntries: number }[]
}

test('proje silme tüm oturumları tek onaya bağlar; onaydan sonra içerik veya oturum kümesi değişirse hiçbir şey silinmez', { timeout: 60000 }, async () => {
  await withDaemon(async ({ api, repo, projectId }) => {
    const isolated = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const shared = await api.post<SessionView>('/api/sessions', createBody(projectId, { isolation: 'shared' }))
    const work = path.join(isolated.body.cwd, 'is.txt')
    fs.writeFileSync(work, 'ajan işi\n')

    const preview = await api.post<ProjectDeletePreview>(`/api/projects/${projectId}/delete-preview`)
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.deepEqual(preview.body.sessions.map((s) => s.id).sort(), [isolated.body.id, shared.body.id].sort())
    assert.equal(preview.body.sessions.find((s) => s.id === isolated.body.id)?.changedEntries, 1)

    fs.writeFileSync(work, 'onaydan sonra\n')
    const stale = await api.del<{ code: string }>(`/api/projects/${projectId}`, {
      confirmationToken: preview.body.confirmationToken,
    })
    assert.equal(stale.status, 409, JSON.stringify(stale.body))
    assert.equal(stale.body.code, 'confirmation_stale')
    assert.equal(fs.readFileSync(work, 'utf8'), 'onaydan sonra\n')
    let state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.projects.length, 1)
    assert.equal(state.body.sessions.length, 2, 'eski onayla hiçbir oturum silinmez')

    const fresh = await api.post<ProjectDeletePreview>(`/api/projects/${projectId}/delete-preview`)
    const late = await api.post<SessionView>('/api/sessions', createBody(projectId, { isolation: 'shared' }))
    assert.equal(late.status, 200)
    const uncovered = await api.del<{ code: string }>(`/api/projects/${projectId}`, {
      confirmationToken: fresh.body.confirmationToken,
    })
    assert.equal(uncovered.status, 409)
    assert.equal(uncovered.body.code, 'confirmation_stale', 'onaydan sonra açılan oturum onayın kapsamında değil')
    state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions.length, 3)

    const final = await api.post<ProjectDeletePreview>(`/api/projects/${projectId}/delete-preview`)
    const removed = await api.del(`/api/projects/${projectId}`, { confirmationToken: final.body.confirmationToken })
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.projects.length, 0)
    assert.equal(state.body.sessions.length, 0)
    assert.equal(fs.existsSync(isolated.body.cwd), false)
    assert.equal(fs.existsSync(path.join(repo, 'README.md')), true, 'ortak kopya dosyaları korunur')
    const branch = isolated.body.branch as string
    assert.match(execFileSync('git', ['branch', '--list', branch], { cwd: repo, encoding: 'utf8' }), /agentdeck\//)
  })
})

test('proje silme bütçeyi oturum sayısıyla aşmaz; kısmi sonuçta proje ve kalan oturumlar listelenir', { timeout: 90000 }, async () => {
  await withDaemon(async ({ api, repo, projectId }) => {
    const shared = await api.post<SessionView>('/api/sessions', createBody(projectId, { isolation: 'shared' }))
    const first = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const second = await api.post<SessionView>('/api/sessions', createBody(projectId))
    for (const session of [first.body, second.body]) {
      fs.writeFileSync(path.join(session.cwd, '.gitignore'), 'node_modules/\n')
      fs.mkdirSync(path.join(session.cwd, 'node_modules'))
      for (let i = 0; i < 6000; i++) fs.writeFileSync(path.join(session.cwd, 'node_modules', `f${i}.js`), '')
    }

    const single = await api.post(`/api/sessions/${first.body.id}/delete-preview`)
    assert.equal(single.status, 200, 'her oturum tek başına bütçeye sığar')
    const whole = await api.post<{ code: string; message: string; confirmationToken?: string }>(
      `/api/projects/${projectId}/delete-preview`,
    )
    assert.equal(whole.status, 409, JSON.stringify(whole.body))
    assert.equal(whole.body.code, 'preview_budget_exceeded')
    assert.equal(whole.body.confirmationToken, undefined)
    assert.match(whole.body.message, /tek tek/)

    for (const session of [first.body, second.body]) fs.rmSync(path.join(session.cwd, 'node_modules'), { recursive: true })
    const preview = await api.post<ProjectDeletePreview>(`/api/projects/${projectId}/delete-preview`)
    assert.equal(preview.status, 200, JSON.stringify(preview.body))

    execFileSync('git', ['worktree', 'lock', second.body.cwd], { cwd: repo, stdio: 'pipe' })
    try {
      const partial = await api.del<{
        code: string
        details: { removedSessionIds: string[]; remainingSessionIds: string[] }
      }>(`/api/projects/${projectId}`, { confirmationToken: preview.body.confirmationToken })
      assert.equal(partial.status, 500, JSON.stringify(partial.body))
      assert.equal(partial.body.code, 'project_delete_partial')
      assert.deepEqual(partial.body.details.removedSessionIds, [shared.body.id, first.body.id])
      assert.deepEqual(partial.body.details.remainingSessionIds, [second.body.id])

      const state = await api.get<StateResponse>('/api/state')
      assert.equal(state.body.projects.length, 1, 'kalan oturum varken proje kalır')
      assert.deepEqual(state.body.sessions.map((s) => s.id), [second.body.id])
      assert.equal(fs.existsSync(second.body.cwd), true)
    } finally {
      execFileSync('git', ['worktree', 'unlock', second.body.cwd], { cwd: repo, stdio: 'pipe' })
    }
  })
})

test('kayıtsız çalışma kopyaları salt okunur biçimde listelenir', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, dataDir, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const orphan = path.join(dataDir, 'worktrees', projectId, 'kayitsiz')
    fs.mkdirSync(orphan, { recursive: true })
    fs.writeFileSync(path.join(orphan, 'is.txt'), 'kalmalı')

    const scan = await api.get<{ entries: { path: string }[]; truncated: boolean }>('/api/orphan-worktrees')
    assert.equal(scan.status, 200)
    assert.deepEqual(
      scan.body.entries.map((e) => e.path),
      [orphan],
      'kayıtlı oturumun kopyası yetim sayılmaz',
    )
    assert.equal(scan.body.truncated, false)
    assert.equal(fs.existsSync(path.join(orphan, 'is.txt')), true, 'keşif silmez')
    assert.ok(created.body.cwd)
  })
})

test('commit i olmayan depoda worktree oturumu açıklamayla kapalıdır', async () => {
  const dataDir = tempDir()
  const empty = tempDir()
  execFileSync('git', ['init', '-b', 'main'], { cwd: empty, stdio: 'pipe' })
  const daemon = await startDaemon({ dataDir, port: 0 })
  const api = client(daemon)
  try {
    const added = await api.post<{ id: string }>('/api/projects', { path: empty })
    assert.equal(added.status, 200)
    const head = await api.get<{ kind: string; hasHead: boolean | null }>(`/api/projects/${added.body.id}/head`)
    assert.equal(head.status, 200, JSON.stringify(head.body))
    assert.deepEqual(head.body, { kind: 'git', hasHead: false })
    const created = await api.post<{ code: string; message: string }>(
      '/api/sessions',
      createBody(added.body.id),
    )
    assert.equal(created.status, 400)
    assert.equal(created.body.code, 'head_missing')
    assert.match(created.body.message, /commit yok/)
  } finally {
    await daemon.close()
    removeDir(dataDir)
    removeDir(empty)
  }
})

test('commit i olan Git projesinde HEAD worktree için açıktır', async () => {
  await withDaemon(async ({ api, projectId }) => {
    const head = await api.get<{ kind: string; hasHead: boolean | null }>(`/api/projects/${projectId}/head`)
    assert.equal(head.status, 200)
    assert.deepEqual(head.body, { kind: 'git', hasHead: true })
  })
})

test('ortak çalışma kopyasında silme dosyalara dokunmaz', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, repo, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId, { isolation: 'shared' }))
    assert.equal(created.status, 200, JSON.stringify(created.body))
    assert.equal(created.body.cwd, repo)
    assert.equal(created.body.branch, null)
    assert.equal(created.body.baseCommit, null, 'ortak kopyada başlangıç commit i uydurulmaz')

    const preview = await api.post<{ confirmationToken: string }>(`/api/sessions/${created.body.id}/delete-preview`)
    const removed = await api.del(`/api/sessions/${created.body.id}`, {
      confirmationToken: preview.body.confirmationToken,
    })
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.equal(fs.existsSync(path.join(repo, 'README.md')), true, 'ortak kopya dosyaları korunur')
    assert.equal(fs.existsSync(repo), true)
  })
})

test('onaydan sonra yeni Run başladıysa silme durur', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const preview = await api.post<{ confirmationToken: string }>(`/api/sessions/${created.body.id}/delete-preview`)

    const restarted = await api.post<SessionView>(`/api/sessions/${created.body.id}/restart`, {
      requestId: 'yeni-run',
      expectedRunId: created.body.runId,
    })
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body))

    const stale = await api.del<{ code: string }>(`/api/sessions/${created.body.id}`, {
      confirmationToken: preview.body.confirmationToken,
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'confirmation_stale')
    assert.equal(fs.existsSync(created.body.cwd), true)
  })
})

test('onay başka bir dizine dönen yolda geçersizdir', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, repo, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const preview = await api.post<{ confirmationToken: string }>(`/api/sessions/${created.body.id}/delete-preview`)

    // Aynı yol, başka dizin: kullanıcı klasörü taşıyıp yerine yenisini koydu.
    const stopped = await api.post(`/api/sessions/${created.body.id}/stop`, {})
    assert.equal(stopped.status, 200)
    execFileSync('git', ['worktree', 'remove', '--force', created.body.cwd], { cwd: repo, stdio: 'pipe' })
    fs.mkdirSync(created.body.cwd, { recursive: true })

    const stale = await api.del<{ code: string }>(`/api/sessions/${created.body.id}`, {
      confirmationToken: preview.body.confirmationToken,
    })
    assert.equal(stale.status, 409)
    assert.match(stale.body.code, /confirmation_stale|status_unreadable/)
    assert.equal(fs.existsSync(created.body.cwd), true, 'tanınmayan dizin silinmez')
  })
})

test('SIGKILL edilen daemon kilidi bırakır', { timeout: 60000 }, async () => {
  const dataDir = tempDir()
  // npx bir ara süreç doğurur ve onu öldürmek kilidi tutan node sürecini
  // öldürmez; bu yüzden node doğrudan başlatılır.
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/hold-lock.ts', dataDir], {
    cwd: process.cwd(),
    stdio: 'ignore',
  })
  try {
    // Hazır sinyali stdio yerine kilidin kendisinden okunur: kilit alınamıyorsa
    // çocuk süreç onu tutuyor demektir.
    await waitFor(async () => {
      try {
        const held = await acquireDaemonLock(dataDir)
        await held.release()
        return false
      } catch (err) {
        return (err as { code?: string }).code === 'data_dir_locked'
      }
    }, 40000)

    await assert.rejects(startDaemon({ dataDir, port: 0 }), /tutuyor/)

    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    // Abstract socket süreçle birlikte gider; kilit yeniden alınabilir olmalı.
    const daemon = await startDaemon({ dataDir, port: 0 })
    await daemon.close()
  } finally {
    child.kill('SIGKILL')
    removeDir(dataDir)
  }
})

test('porttaki yabancı servis öldürülmez', async () => {
  const dataDir = tempDir()
  const foreign = http.createServer((_req, res) => res.end('yabanci'))
  const port = await new Promise<number>((resolve) => {
    foreign.listen(0, '127.0.0.1', () => resolve((foreign.address() as { port: number }).port))
  })
  try {
    await assert.rejects(startDaemon({ dataDir, port }), (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, 'EADDRINUSE')
      return true
    })
    const res = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(await res.text(), 'yabanci', 'yabancı servis yaşamaya devam eder')

    // Kilit sızdırılmadı: aynı veri dizini yeniden açılabilir.
    const daemon = await startDaemon({ dataDir, port: 0 })
    await daemon.close()
  } finally {
    await new Promise<void>((resolve) => foreign.close(() => resolve()))
    removeDir(dataDir)
  }
})

test(
  'PTY doğup kayıt yazılamazsa yalnız kendi grubu durdurulur ve kendi worktree i geri alınır',
  { timeout: 30000, skip: isRoot ? 'root izinleri kontrolü atlar' : false },
  async () => {
    await withDaemon(async ({ api, dataDir, repo, projectId }) => {
      const before = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' })
      assert.equal(before.trim().split('\n').length, 1)

      // Veri dizini yazılamaz: worktree açılabilir ama state commit'i başarısız olur.
      fs.chmodSync(dataDir, 0o500)
      let created: Reply<{ code: string; message: string; details: { worktree: string; cwd: string } }>
      try {
        created = await api.post('/api/sessions', createBody(projectId))
      } finally {
        fs.chmodSync(dataDir, 0o755)
      }

      assert.equal(created.status, 503)
      assert.equal(created.body.code, 'persistence')
      assert.equal(created.body.details.worktree, 'kaldırıldı', 'değişmemiş kendi kaynağı geri alınır')
      assert.equal(fs.existsSync(created.body.details.cwd), false)

      const after = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' })
      assert.equal(after.trim().split('\n').length, 1, 'yarım worktree kaydı bırakılmaz')

      const state = await api.get<StateResponse>('/api/state')
      assert.equal(state.body.sessions.length, 0, 'yazılamayan oturum kayda girmez')
    })
  },
)

// --- Terminal temsili ve replay protokolü (spec §4) -------------------------

interface WsMessage {
  type: string
  [key: string]: unknown
}

/** Test istemcisi: mesajları sırayla biriktirir, koşul sağlanınca uyanır. */
function connectWs(daemon: Daemon, query: string) {
  const socket = new WebSocket(`${daemon.url.replace('http', 'ws')}/ws?${query}`)
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const messages: WsMessage[] = []
  const closes: { code: number }[] = []
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as WsMessage))
  socket.on('close', (code) => closes.push({ code }))
  return {
    messages,
    closes,
    async waitFor(predicate: (m: WsMessage) => boolean, budgetMs = 10000): Promise<WsMessage> {
      const deadline = Date.now() + budgetMs
      for (;;) {
        const found = messages.find(predicate)
        if (found) return found
        if (Date.now() > deadline) {
          throw new Error(`beklenen mesaj gelmedi; gelenler: ${messages.map((m) => m.type).join(',')}`)
        }
        await new Promise((r) => setTimeout(r, 25))
      }
    },
    send(payload: unknown) {
      const control = messages.filter((m) => m.type === 'control').at(-1)
      socket.send(JSON.stringify({ generation: control?.generation, ...(payload as object) }))
    },
    open: () => opened,
    /** İstemcinin ekrana yazdığı toplam girdi: replay parçaları + sonraki çıktı. */
    screenInput(): string {
      let text = ''
      for (const msg of messages) {
        if (msg.type === 'replay-chunk' || msg.type === 'output') text += String(msg.text)
      }
      return text
    },
    close() {
      socket.close()
    },
  }
}

test('canlı attach replay-start/chunk/end sırasını izler ve sonra input açılır', { timeout: 40000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    const created = await api.post<SessionView>(
      '/api/sessions',
      createBody(projectId, { command: 'printf AGENTDECK_EKRAN; sleep 300' }),
    )
    assert.equal(created.status, 200)

    const ws = connectWs(daemon, `session=${created.body.id}&token=${daemon.token}`)
    await ws.open()
    const start = await ws.waitFor((m) => m.type === 'replay-start')
    assert.equal(start.mode, 'live')
    assert.equal(start.scope, 'screen')
    assert.equal(start.daemonId, daemon.daemonId)
    assert.equal(start.runId, created.body.runId)
    assert.equal(typeof start.sequence, 'number')
    assert.equal(typeof start.formatVersion, 'number')

    const end = await ws.waitFor((m) => m.type === 'replay-end')
    assert.equal(end.snapshotId, start.snapshotId)

    const beforeEnd = ws.messages.slice(0, ws.messages.indexOf(end))
    assert.equal(beforeEnd[0].type, 'replay-start')
    assert.equal(
      beforeEnd.every((m) => m.type === 'replay-start' || m.type === 'replay-chunk'),
      true,
      'replay bitmeden canlı çıktı gönderilmez',
    )
    const indexes = beforeEnd.filter((m) => m.type === 'replay-chunk').map((m) => m.index)
    assert.deepEqual(indexes, indexes.map((_, i) => i), 'parçalar sırayla numaralanır')
    assert.equal(end.chunkCount, indexes.length)

    // Ekran modeli program çıktısını taşır.
    await ws.waitFor(() => ws.screenInput().includes('AGENTDECK_EKRAN'))

    // Replay bittikten sonra girdi kabul edilir.
    ws.send({ type: 'input', data: 'echo AGENTDECK_GIRDI\n' })
    await ws.waitFor(() => ws.screenInput().includes('AGENTDECK_GIRDI'))
    ws.close()
  })
})

test('istemci akışında terminal sorgusu bulunmaz', { timeout: 40000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    const created = await api.post<SessionView>(
      '/api/sessions',
      // Program imleç konumu sorar: cevabı daemon üretir, tarayıcı görmez.
      createBody(projectId, { command: 'printf "\\033[6nAGENTDECK_SORGU"; sleep 300' }),
    )
    const ws = connectWs(daemon, `session=${created.body.id}&token=${daemon.token}`)
    await ws.open()
    await ws.waitFor(() => ws.screenInput().includes('AGENTDECK_SORGU'))
    assert.equal(ws.screenInput().includes('\x1b[6n'), false, 'sorgu dizisi istemciye sızdı')
    ws.close()
  })
})

test('scrollback katmanı yalnız açık istekle gönderilir', { timeout: 40000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    const created = await api.post<SessionView>(
      '/api/sessions',
      createBody(projectId, { command: 'for i in $(seq 1 300); do echo "satır $i"; done; sleep 300' }),
    )
    const ws = connectWs(daemon, `session=${created.body.id}&token=${daemon.token}`)
    await ws.open()
    const first = await ws.waitFor((m) => m.type === 'replay-start')
    assert.equal(first.scope, 'screen')

    ws.send({ type: 'request-scrollback' })
    const second = await ws.waitFor((m) => m.type === 'replay-start' && m.scope === 'scrollback')
    assert.notEqual(second.snapshotId, first.snapshotId, 'ikinci katman yeni bir snapshot tır')
    assert.ok((second.totalBytes as number) > (first.totalBytes as number))
    ws.close()
  })
})

test('canlı olmayan Run salt okunur incelenir; girdi kabul edilmez', { timeout: 40000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    const created = await api.post<SessionView>(
      '/api/sessions',
      createBody(projectId, { command: 'printf AGENTDECK_GECMIS; sleep 300' }),
    )
    const runId = created.body.runId as string

    // Çıktının ekran modeline inmesini bekle, sonra durdur.
    const livews = connectWs(daemon, `session=${created.body.id}&token=${daemon.token}`)
    await livews.open()
    await livews.waitFor(() => livews.screenInput().includes('AGENTDECK_GECMIS'))
    livews.close()

    const stopped = await api.post(`/api/sessions/${created.body.id}/stop`, { expectedRunId: runId })
    assert.equal(stopped.status, 200)

    // Checkpoint çıkışta yazılır; hazır olana kadar denenir.
    let history = connectWs(daemon, `session=${created.body.id}&run=${runId}&token=${daemon.token}`)
    await waitFor(async () => {
      await history.open()
      try {
        await history.waitFor((m) => m.type === 'replay-start', 1500)
        return true
      } catch {
        history = connectWs(daemon, `session=${created.body.id}&run=${runId}&token=${daemon.token}`)
        return false
      }
    })

    const start = await history.waitFor((m) => m.type === 'replay-start')
    assert.equal(start.mode, 'inspect')
    await history.waitFor((m) => m.type === 'replay-end')
    const ended = await history.waitFor((m) => m.type === 'run-ended')
    assert.equal(ended.runId, runId)
    assert.ok(history.screenInput().includes('AGENTDECK_GECMIS'), 'saklanan görüntü geri gelmedi')

    // Salt okunur bağlantı girdi kabul etmez (bağlantı zaten kapanır).
    history.send({ type: 'input', data: 'echo SIZINTI\n' })
    history.close()
  })
})

test('önceki Run görüntüsü listelenir ve salt okunur açılır; en çok son iki Run tutulur', { timeout: 60000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    type Runs = { currentRunId: string | null; previous: { runId: string; updatedAt: number }[] }
    const created = await api.post<SessionView>(
      '/api/sessions',
      createBody(projectId, { command: 'printf ILK_RUN; sleep 300' }),
    )
    const id = created.body.id
    const first = created.body.runId as string

    const none = await api.get<Runs>(`/api/sessions/${id}/runs`)
    assert.equal(none.status, 200, JSON.stringify(none.body))
    assert.equal(none.body.currentRunId, first)
    assert.deepEqual(none.body.previous, [], 'ilk Run da önceki Run yok')

    /** Run çıktısı ekran modeline inene kadar bekler; durdurma sonrası görüntü onu taşır. */
    const settle = async (marker: string) => {
      const ws = connectWs(daemon, `session=${id}&token=${daemon.token}`)
      await ws.open()
      await ws.waitFor(() => ws.screenInput().includes(marker))
      ws.close()
    }
    const launch = (requestId: string, expectedRunId: string, command: string) =>
      api.post<SessionView>(`/api/sessions/${id}/launch`, { requestId, expectedRunId, mode: 'command', command })

    await settle('ILK_RUN')
    const second = await launch('ikinci', first, 'printf IKINCI_RUN; sleep 300')
    assert.equal(second.status, 200, JSON.stringify(second.body))

    const afterSecond = await api.get<Runs>(`/api/sessions/${id}/runs`)
    assert.deepEqual(afterSecond.body.previous.map((r) => r.runId), [first])

    const inspect = connectWs(daemon, `session=${id}&run=${first}&token=${daemon.token}`)
    await inspect.open()
    const start = await inspect.waitFor((m) => m.type === 'replay-start')
    assert.equal(start.mode, 'inspect', 'önceki Run salt okunur açılır')
    await inspect.waitFor((m) => m.type === 'replay-end')
    assert.ok(inspect.screenInput().includes('ILK_RUN'), 'önceki Run un kendi ekranı gelir')
    inspect.close()

    await settle('IKINCI_RUN')
    const third = await launch('ucuncu', second.body.runId as string, 'printf UCUNCU_RUN; sleep 300')
    assert.equal(third.status, 200, JSON.stringify(third.body))
    // Yeni Run'ın görüntüsü yazıldığında saklama sınırı en eski Run'ı budar.
    await waitFor(async () => {
      const runs = await api.get<Runs>(`/api/sessions/${id}/runs`)
      return runs.body.previous.map((r) => r.runId).join(',') === second.body.runId
    })
  })
})

test('bilinmeyen Run için uydurma ekran değil "geçmiş yok" döner', { timeout: 40000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const ws = connectWs(daemon, `session=${created.body.id}&run=bilinmeyenrun&token=${daemon.token}`)
    await ws.open()
    const msg = await ws.waitFor((m) => m.type === 'history-missing')
    assert.match(String(msg.message), /yok/)
    ws.close()
  })
})

test('kart önizlemesi ekran modelinden çıkar ve sınırı aşan istek reddedilir', { timeout: 40000 }, async () => {
  await withDaemon(async ({ api, projectId }) => {
    const created = await api.post<SessionView>(
      '/api/sessions',
      createBody(projectId, { command: 'printf "AGENTDECK_KART\\n"; sleep 300' }),
    )
    const id = created.body.id

    await waitFor(async () => {
      const state = await api.get<StateResponse & { previews: Record<string, { state: string; preview?: { text: string } }> }>(
        `/api/state?previewIds=${id}`,
      )
      return state.body.previews[id]?.state === 'ready' && !!state.body.previews[id].preview?.text.includes('AGENTDECK_KART')
    })

    const unknown = await api.get<{ previews: Record<string, { state: string; reason: string }> }>(
      '/api/state?previewIds=olmayan-oturum',
    )
    assert.equal(unknown.body.previews['olmayan-oturum'].state, 'unavailable')

    const tooMany = await api.get<{ code: string }>(
      `/api/state?previewIds=${Array.from({ length: 25 }, (_, i) => `s${i}`).join(',')}`,
    )
    assert.equal(tooMany.status, 400)
    assert.equal(tooMany.body.code, 'validation')
  })
})

test('oturum silinince terminal checkpoint dosyaları da kalkar', { timeout: 40000 }, async () => {
  await withDaemon(async ({ api, dataDir, projectId }) => {
    const created = await api.post<SessionView>(
      '/api/sessions',
      createBody(projectId, { command: 'printf AGENTDECK_SIL; sleep 300' }),
    )
    const id = created.body.id
    const sessionDir = path.join(dataDir, 'terminal', id)
    await waitFor(async () => fs.existsSync(sessionDir))

    const preview = await api.post<{ confirmationToken: string }>(`/api/sessions/${id}/delete-preview`)
    const removed = await api.del(`/api/sessions/${id}`, { confirmationToken: preview.body.confirmationToken })
    assert.equal(removed.status, 200)
    assert.equal(fs.existsSync(sessionDir), false, 'oturuma ait terminal kayıtları kalmamalı')
  })
})

test('ikinci izleyici salt okunur; açık kontrol devri eski generation girdisini reddeder', { timeout: 15000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const query = `session=${created.body.id}&run=${created.body.runId}&token=${daemon.token}`
    const a = connectWs(daemon, query)
    const b = connectWs(daemon, query)
    try {
      const owner = await a.waitFor((m) => m.type === 'control')
      const viewer = await b.waitFor((m) => m.type === 'control')
      assert.equal(owner.owned, true)
      assert.equal(viewer.owned, false)
      b.send({ type: 'input', data: 'VIEWER_BLOCKED' })
      b.send({ type: 'take-control' })
      const taken = await b.waitFor((m) => m.type === 'control' && m.owned === true)
      a.send({ type: 'input', generation: owner.generation, data: 'OLD_BLOCKED' })
      b.send({ type: 'input', generation: taken.generation, data: 'OWNER_ACCEPTED' })
      await b.waitFor(() => b.screenInput().includes('OWNER_ACCEPTED'))
      assert.equal(b.screenInput().includes('VIEWER_BLOCKED'), false)
      assert.equal(b.screenInput().includes('OLD_BLOCKED'), false)
    } finally { a.close(); b.close() }
  })
})

test('kontrol sahibi ayrılınca izleyiciye sahipsiz lease bildirilir', { timeout: 15000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const query = `session=${created.body.id}&run=${created.body.runId}&token=${daemon.token}`
    const a = connectWs(daemon, query)
    const b = connectWs(daemon, query)
    try {
      const owner = await a.waitFor((m) => m.type === 'control')
      const viewer = await b.waitFor((m) => m.type === 'control')
      assert.equal(owner.owned, true)
      assert.equal(owner.vacant, false)
      assert.equal(viewer.owned, false)
      assert.equal(viewer.vacant, false, 'sahibi olan lease sahipsiz görünmez')

      // Grid ile tek görünüm arasında geçişte eski bağlantı yeni bağlantıdan sonra kapanabilir.
      a.close()
      const vacated = await b.waitFor((m) => m.type === 'control' && m.vacant === true)
      assert.equal(vacated.owned, false, 'sahipsiz lease kendiliğinden kimseye verilmez')
      b.send({ type: 'take-control' })
      await b.waitFor((m) => m.type === 'control' && m.owned === true && m.vacant === false)
    } finally { a.close(); b.close() }
  })
})

test('önceki Run bağlantısı yeniden başlatılan Run a girdi gönderemez', { timeout: 15000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const old = connectWs(daemon, `session=${created.body.id}&token=${daemon.token}`)
    let current: ReturnType<typeof connectWs> | undefined
    try {
      await old.waitFor((m) => m.type === 'control')
      await api.post(`/api/sessions/${created.body.id}/restart`, { requestId: 'replace', expectedRunId: created.body.runId })
      current = connectWs(daemon, `session=${created.body.id}&token=${daemon.token}`)
      await current.waitFor((m) => m.type === 'control')
      old.send({ type: 'input', data: 'OLD_RUN_INPUT' })
      current.send({ type: 'input', data: 'NEW_RUN_INPUT' })
      await current.waitFor(() => current!.screenInput().includes('NEW_RUN_INPUT'))
      assert.equal(current.screenInput().includes('OLD_RUN_INPUT'), false)
    } finally { old.close(); current?.close() }
  })
})

test('null WebSocket mesajı daemon u düşürmez', { timeout: 15000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const socket = new WebSocket(`${daemon.url.replace('http', 'ws')}/ws?session=${created.body.id}&token=${daemon.token}`)
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      socket.send('null')
      socket.send('[]')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal((await api.get('/api/state')).status, 200)
    } finally { socket.close() }
  })
})

test('biçimsiz Run kimliği okunamayan geçmiş diye etiketlenmez', { timeout: 40000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    await api.post(`/api/sessions/${created.body.id}/stop`, { expectedRunId: created.body.runId })
    const ws = connectWs(daemon, `session=${created.body.id}&run=${encodeURIComponent('../state')}&token=${daemon.token}`)
    await ws.open().catch(() => undefined)
    const msg = await ws.waitFor((m) => m.type === 'error' || m.type === 'history-unreadable' || m.type === 'history-missing')
    assert.equal(msg.type, 'error')
    assert.equal(msg.code, 'validation')
    ws.close()
  })
})

test('arşiv durdurması sürerken silme reddedilir ve çalışma kopyası korunur', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, daemon, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId, {
      command: 'trap "" HUP; touch ready; sleep 300',
    }))
    assert.equal(created.status, 200)
    const session = created.body
    await waitFor(async () => fs.existsSync(path.join(session.cwd, 'ready')))
    const preview = await api.post<{ confirmationToken: string }>(`/api/sessions/${session.id}/delete-preview`)
    assert.equal(preview.status, 200)
    const archive = rawPost(daemon, `/api/sessions/${session.id}/archive`, {
      expectedRunId: session.runId, stopIfLive: true,
    })
    await waitFor(async () => (await api.get(`/api/sessions/${session.id}/runs`)).status === 409)
    const deletion = await api.del<{ code: string }>(`/api/sessions/${session.id}`, {
      confirmationToken: preview.body.confirmationToken,
    })
    assert.equal(deletion.status, 409)
    assert.equal(deletion.body.code, 'operation_in_progress')
    assert.equal((await archive).status, 200)
    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions[0].id, session.id)
    assert.equal(typeof state.body.sessions[0].archivedAt, 'number')
    assert.equal(fs.existsSync(path.join(session.cwd, 'ready')), true)
  })
})

test('PTY doğup kayıt yazılamazsa kirli worktree korunur', { timeout: 30000, skip: isRoot ? 'root izinleri kontrolü atlar' : false }, async () => {
  await withDaemon(async ({ api, dataDir, repo, projectId }) => {
    const hook = path.join(repo, '.git/hooks/post-checkout')
    fs.writeFileSync(hook, '#!/bin/sh\nprintf dirty > KEEP\n')
    fs.chmodSync(hook, 0o755)

    fs.chmodSync(dataDir, 0o500)
    let created: Reply<{ code: string; details: { worktree: string; cwd: string } }>
    try {
      created = await api.post('/api/sessions', createBody(projectId))
    } finally {
      fs.chmodSync(dataDir, 0o755)
    }

    assert.equal(created.status, 503)
    assert.equal(created.body.code, 'persistence')
    assert.equal(created.body.details.worktree, 'korundu')
    assert.equal(fs.existsSync(created.body.details.cwd), true)
    assert.equal(fs.existsSync(path.join(created.body.details.cwd, 'KEEP')), true)

    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions.length, 0, 'yazılamayan oturum kayda girmez')
  })
})

test('disk hatası canlı PTY yi öldürmez; yeni kayıt 503 döner', { timeout: 30000, skip: isRoot ? 'root izinleri kontrolü atlar' : false }, async () => {
  await withDaemon(async ({ api, daemon, dataDir, projectId }) => {
    const first = await api.post<SessionView>('/api/sessions', createBody(projectId, { command: 'sleep 300' }))
    assert.equal(first.status, 200)
    const ws = connectWs(daemon, `session=${first.body.id}&token=${daemon.token}`)
    try {
      await ws.waitFor((m) => m.type === 'control' && m.owned === true)
      fs.chmodSync(dataDir, 0o500)
      let second: Reply<{ code: string }>
      try {
        second = await api.post('/api/sessions', createBody(projectId, { name: 'ikinci' }))
      } finally {
        fs.chmodSync(dataDir, 0o755)
      }
      assert.equal(second.status, 503)
      assert.equal(second.body.code, 'persistence')

      const state = await api.get<StateResponse>('/api/state')
      assert.equal(state.body.sessions.length, 1)
      assert.equal(state.body.sessions[0].lifecycle, 'live')
      assert.ok(state.body.serviceError)

      ws.send({ type: 'input', data: 'echo SURDU\n' })
      await ws.waitFor(() => ws.screenInput().includes('SURDU'))
    } finally {
      ws.close()
    }
  })
})

test('durdurma kaydı yazılamazsa süreç durur, çıkış uydurulmaz', { timeout: 30000, skip: isRoot ? 'root izinleri kontrolü atlar' : false }, async () => {
  await withDaemon(async ({ api, dataDir, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId, { command: 'sleep 300' }))
    assert.equal(created.status, 200)
    fs.chmodSync(dataDir, 0o500)
    let stopped: Reply<{ code: string }>
    try {
      stopped = await api.post(`/api/sessions/${created.body.id}/stop`, { expectedRunId: created.body.runId })
    } finally {
      fs.chmodSync(dataDir, 0o755)
    }
    assert.equal(stopped.status, 503)
    assert.equal(stopped.body.code, 'persistence')
    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions[0].lifecycle, 'live', 'çıkış diske inmedi')
    assert.equal(state.body.sessions[0].remainingProcessGroup, false)
    assert.ok(state.body.serviceError)
  })
})

test('yalnız WS kopuşu oturumu orphaned yapmaz', { timeout: 15000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId))
    const ws = connectWs(daemon, `session=${created.body.id}&token=${daemon.token}`)
    await ws.waitFor((m) => m.type === 'control')
    ws.close()
    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions[0].lifecycle, 'live')
  })
})

test('SIGTERM çıkışı kaydeder; kilit bırakılır ve ikinci close zararsızdır', { timeout: 40000 }, async () => {
  await withDaemon(async ({ daemon, api, dataDir, projectId }) => {
    const created = await api.post<SessionView>(
      '/api/sessions',
      createBody(projectId, { command: 'printf KAPANDI; sleep 300' }),
    )
    const ws = connectWs(daemon, `session=${created.body.id}&token=${daemon.token}`)
    await ws.waitFor(() => ws.screenInput().includes('KAPANDI'))
    ws.close()
    await daemon.close()
    await daemon.close()

    const again = await startDaemon({ dataDir, port: 0 })
    try {
      const api2 = client(again)
      const state = await api2.get<StateResponse>('/api/state')
      assert.equal(state.body.sessions[0].lifecycle, 'exited', 'düzgün kapanış live bırakmaz')
      const inspect = connectWs(again, `session=${created.body.id}&run=${created.body.runId}&token=${again.token}`)
      await inspect.open()
      const start = await inspect.waitFor((m) => m.type === 'replay-start' || m.type === 'history-missing')
      assert.equal(start.type, 'replay-start', 'SIGTERM son checkpoint i yazmalı')
      await inspect.waitFor((m) => m.type === 'replay-end')
      assert.ok(inspect.screenInput().includes('KAPANDI'))
      inspect.close()
    } finally {
      await again.close()
    }
  })
})

test('yeni daemon aynı requestId ile ikinci oturum açabilir; istemci kimliği yenilemek zorundadır', { timeout: 40000 }, async () => {
  await withDaemon(async ({ daemon, api, dataDir, projectId }) => {
    const body = createBody(projectId, { name: 'ilk-defter' })
    const first = await api.post<SessionView>('/api/sessions', body)
    assert.equal(first.status, 200)
    await daemon.close()

    const again = await startDaemon({ dataDir, port: 0 })
    try {
      const api2 = client(again)
      const second = await api2.post<SessionView>('/api/sessions', body)
      assert.equal(second.status, 200, JSON.stringify(second.body))
      assert.notEqual(second.body.id, first.body.id)
      const state = await api2.get<StateResponse>('/api/state')
      assert.equal(state.body.sessions.length, 2)
    } finally {
      await again.close()
    }
  })
})

test('çöküşte iki Run checkpoint i ayakta kalır ve orphaned oturumdan okunur', { timeout: 60000 }, async () => {
  const dataDir = tempDir()
  const repo = initRepo()
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/hold-daemon.ts', dataDir], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const info = await new Promise<{ url: string; token: string }>((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error('çocuk daemon hazır olmadı')), 40000)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        buf += chunk
        const line = buf.split('\n').find((row) => row.startsWith('{'))
        if (!line) return
        clearTimeout(timer)
        resolve(JSON.parse(line) as { url: string; token: string })
      })
      child.once('error', reject)
      child.once('exit', (code) => reject(new Error(`çocuk daemon çıktı: ${code}`)))
    })
    const fake = { url: info.url, token: info.token } as Daemon
    const api = client(fake)
    const added = await api.post<{ id: string }>('/api/projects', { path: repo })
    assert.equal(added.status, 200, JSON.stringify(added.body))
    const created = await api.post<SessionView>(
      '/api/sessions',
      createBody(added.body.id, { command: 'printf ILK_CRASH; sleep 300' }),
    )
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const firstRun = created.body.runId as string
    const settle = async (marker: string) => {
      const ws = connectWs(fake, `session=${created.body.id}&token=${fake.token}`)
      await ws.open()
      await ws.waitFor(() => ws.screenInput().includes(marker))
      ws.close()
    }
    await settle('ILK_CRASH')
    const second = await api.post<SessionView>(`/api/sessions/${created.body.id}/launch`, {
      requestId: 'crash-2',
      expectedRunId: firstRun,
      mode: 'command',
      command: 'printf IKINCI_CRASH; sleep 300',
    })
    assert.equal(second.status, 200, JSON.stringify(second.body))
    await settle('IKINCI_CRASH')
    const sessionDir = path.join(dataDir, 'terminal', created.body.id)
    await waitFor(async () => {
      const files = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).filter((f) => f.endsWith('.json')) : []
      return files.length >= 2
    })

    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    const daemon = await startDaemon({ dataDir, port: 0 })
    try {
      const api2 = client(daemon)
      const state = await api2.get<StateResponse>('/api/state')
      assert.equal(state.body.sessions[0].lifecycle, 'orphaned')
      for (const [runId, marker] of [
        [firstRun, 'ILK_CRASH'],
        [second.body.runId as string, 'IKINCI_CRASH'],
      ] as const) {
        const inspect = connectWs(daemon, `session=${created.body.id}&run=${runId}&token=${daemon.token}`)
        await inspect.open()
        await inspect.waitFor((m) => m.type === 'replay-start')
        await inspect.waitFor((m) => m.type === 'replay-end')
        assert.ok(inspect.screenInput().includes(marker), `${marker} checkpoint yok`)
        inspect.close()
      }
    } finally {
      await daemon.close()
    }
  } finally {
    child.kill('SIGKILL')
    removeDir(dataDir)
    removeDir(repo)
  }
})

test('fresh ve picker lastLaunch niyetini kaydeder; UUID üretmez', { timeout: 40000 }, async () => {
  const home = tempDir()
  const environmentFile = path.join(home, 'environment.json')
  fs.writeFileSync(environmentFile, JSON.stringify({ HOME: home }), { mode: 0o600 })
  fs.writeFileSync(path.join(home, '.bash_profile'), `claude() { printf '%s\\n' "$*" >> "$HOME/launches"; sleep 300; }\n`)
  try {
    await withDaemon(async ({ api, projectId }) => {
      const created = await api.post<SessionView>(
        '/api/sessions',
        createBody(projectId, { command: 'claude' }),
      )
      assert.equal(created.status, 200, JSON.stringify(created.body))
      const id = created.body.id
      await waitFor(async () => fs.existsSync(path.join(home, 'launches')))

      const fresh = await api.post<SessionView>(`/api/sessions/${id}/launch`, {
        requestId: 'fresh-1',
        expectedRunId: created.body.runId,
        mode: 'fresh',
        command: 'claude',
      })
      assert.equal(fresh.status, 200, JSON.stringify(fresh.body))
      assert.deepEqual(fresh.body.lastLaunch, { mode: 'fresh', cli: 'claude', conversationId: null })
      assert.equal(fresh.body.command, 'claude', 'başlangıç Command ı değişmez')

      await waitFor(async () => fs.readFileSync(path.join(home, 'launches'), 'utf8').split('\n').length === 3)
      const picker = await api.post<SessionView>(`/api/sessions/${id}/launch`, {
        requestId: 'picker-1',
        expectedRunId: fresh.body.runId,
        mode: 'picker',
        command: 'claude --resume',
      })
      assert.equal(picker.status, 200, JSON.stringify(picker.body))
      assert.deepEqual(picker.body.lastLaunch, { mode: 'picker', cli: 'claude' })

      await waitFor(async () => fs.readFileSync(path.join(home, 'launches'), 'utf8').includes('--resume'))
      const restarted = await api.post<SessionView>(`/api/sessions/${id}/restart`, {
        requestId: 'restart-picker',
        expectedRunId: picker.body.runId,
      })
      assert.equal(restarted.status, 200, JSON.stringify(restarted.body))
      assert.deepEqual(restarted.body.lastLaunch, { mode: 'picker', cli: 'claude' })

      const badFresh = await api.post<{ code: string }>(`/api/sessions/${id}/launch`, {
        requestId: 'fresh-bad',
        expectedRunId: restarted.body.runId,
        mode: 'fresh',
        command: 'claude --resume',
      })
      assert.equal(badFresh.status, 400)
      assert.equal(badFresh.body.code, 'validation')
      await waitFor(async () => fs.existsSync(path.join(home, 'launches')) && fs.readFileSync(path.join(home, 'launches'), 'utf8').split('\n').filter(line => line === '--resume').length === 2)
    }, { environmentFile })
  } finally {
    removeDir(home)
  }
})

test('PTY doğup kayıt yazılamazsa kilitli worktree korunur', { timeout: 30000, skip: isRoot ? 'root izinleri kontrolü atlar' : false }, async () => {
  await withDaemon(async ({ api, dataDir, repo, projectId }) => {
    const hook = path.join(repo, '.git/hooks/post-checkout')
    fs.writeFileSync(hook, '#!/bin/sh\ngit worktree lock "$(pwd)"\n')
    fs.chmodSync(hook, 0o755)

    fs.chmodSync(dataDir, 0o500)
    let created: Reply<{ code: string; details: { worktree: string; cwd: string } }>
    try {
      created = await api.post('/api/sessions', createBody(projectId))
    } finally {
      fs.chmodSync(dataDir, 0o755)
    }

    assert.equal(created.status, 503)
    assert.equal(created.body.code, 'persistence')
    assert.equal(created.body.details.worktree, 'korundu')
    assert.equal(fs.existsSync(created.body.details.cwd), true)

    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions.length, 0, 'yazılamayan oturum kayda girmez')

    try {
      execFileSync('git', ['worktree', 'unlock', created.body.details.cwd], { cwd: repo, stdio: 'pipe' })
    } catch {
      // kilit yoksa temizlik yine dener
    }
  })
})

test('exited oturumda launch kayıt yazılamazsa önceki lastLaunch ve exited kalır', {
  timeout: 30000,
  skip: isRoot ? 'root izinleri kontrolü atlar' : false,
}, async () => {
  await withDaemon(async ({ api, dataDir, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId, { command: 'true' }))
    assert.equal(created.status, 200)
    await waitFor(async () => {
      const state = await api.get<StateResponse>('/api/state')
      return state.body.sessions[0]?.lifecycle === 'exited'
    })
    const before = await api.get<StateResponse>('/api/state')
    const previous = before.body.sessions[0].lastLaunch

    fs.chmodSync(dataDir, 0o500)
    let launched: Reply<{ code: string }>
    try {
      launched = await api.post(`/api/sessions/${created.body.id}/launch`, {
        requestId: 'launch-persist',
        expectedRunId: created.body.runId,
        mode: 'command',
        command: 'sleep 300',
      })
    } finally {
      fs.chmodSync(dataDir, 0o755)
    }
    assert.equal(launched.status, 503)
    assert.equal(launched.body.code, 'persistence')

    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.sessions[0].lifecycle, 'exited')
    assert.deepEqual(state.body.sessions[0].lastLaunch, previous)
    assert.equal(state.body.sessions[0].runId, created.body.runId)
  })
})

test('silme durdurması sürerken arşiv 409 operation_in_progress', { timeout: 30000 }, async () => {
  await withDaemon(async ({ api, daemon, projectId }) => {
    const created = await api.post<SessionView>('/api/sessions', createBody(projectId, {
      command: 'trap "" HUP; touch ready; sleep 300',
    }))
    assert.equal(created.status, 200)
    const session = created.body
    await waitFor(async () => fs.existsSync(path.join(session.cwd, 'ready')))
    const preview = await api.post<{ confirmationToken: string }>(`/api/sessions/${session.id}/delete-preview`)
    assert.equal(preview.status, 200)
    const deletion = rawCall(daemon, 'DELETE', `/api/sessions/${session.id}`, {
      confirmationToken: preview.body.confirmationToken,
    })
    await waitFor(async () => (await api.get(`/api/sessions/${session.id}/runs`)).status === 409)
    const archive = await api.post<{ code: string }>(`/api/sessions/${session.id}/archive`, {
      expectedRunId: session.runId,
      stopIfLive: true,
    })
    assert.equal(archive.status, 409)
    assert.equal(archive.body.code, 'operation_in_progress')
    const removed = await deletion
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
  })
})

test('yoğun PTY çıktısında çıktı baskısı görünür; health cevap verir', { timeout: 40000 }, async () => {
  await withDaemon(async ({ daemon, api, projectId }) => {
    const created = await api.post<SessionView>(
      '/api/sessions',
      createBody(projectId, {
        command: `node -e "process.stdout.write('x'.repeat(2500000)); setInterval(() => {}, 1000)"`,
      }),
    )
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const ws = connectWs(daemon, `session=${created.body.id}&token=${daemon.token}`)
    await ws.open()
    await ws.waitFor((m) => m.type === 'output-pressure' && m.active === true, 15000)
    const state = await api.get<StateResponse>('/api/state')
    assert.equal(state.body.terminals?.[created.body.id]?.outputPressure, true)
    const health = await fetch(`${daemon.url}/api/health`)
    assert.equal(health.status, 200)
    ws.close()
  })
})


test('eski desteklenmeyen launch reddedilir; başlangıç programı ve yeni Run çalışmaz', async () => {
  const cwd = tempDir()
  const lastLaunch = { mode: 'resume', cli: 'claude', conversationId: 'invalid' }
  const saved = {
    id: 'legacy', projectId: 'p1', name: 'eski iş', command: 'touch unexpected',
    isolation: 'shared', cwd, branch: null, baseCommit: null, worktrees: [],
    lifecycle: 'exited', exitCode: 0, exitSignal: null, createdAt: 1, endedAt: 2,
    runId: null, archivedAt: null, lastLaunch,
  }
  try {
    await withDaemon(async ({ api }) => {
      const restarted = await api.post<{ code: string }>('/api/sessions/legacy/restart', {
        requestId: 'unsupported-restart', expectedRunId: null,
      })
      assert.equal(restarted.status, 400)
      assert.equal(restarted.body.code, 'launch_unavailable')
      const state = (await api.get<StateResponse>('/api/state')).body
      assert.equal(state.sessions[0].runId, null)
      assert.equal(state.sessions[0].lifecycle, 'exited')
      assert.deepEqual(state.sessions[0].lastLaunch, lastLaunch)
      assert.equal(fs.existsSync(path.join(cwd, 'unexpected')), false)
    }, {
      withProject: false,
      seedState: { schemaVersion: 2, projects: [{ id: 'p1', name: 'p', path: cwd, createdAt: 1 }], sessions: [saved] },
    })
  } finally {
    removeDir(cwd)
  }
})
