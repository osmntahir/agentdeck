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
import type { SessionView, StateResponse } from '../src/shared/types'
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

function initRepo(): string {
  const dir = tempDir()
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
  options: { seedState?: unknown; withProject?: boolean } = {},
): Promise<void> {
  const dataDir = tempDir()
  const repo = initRepo()
  if (options.seedState !== undefined) {
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(options.seedState, null, 2))
  }
  const daemon = await startDaemon({ dataDir, port: 0 })
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
function rawPost<T>(daemon: Daemon, route: string, body: unknown): Promise<Reply<T>> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${daemon.url}${route}`,
      {
        method: 'POST',
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

test('git olmayan klasör ve bulunmayan yol reddedilir', async () => {
  await withDaemon(async ({ api }) => {
    const plain = tempDir()
    try {
      const res = await api.post<{ message: string }>('/api/projects', { path: plain })
      assert.equal(res.status, 400)
      assert.match(res.body.message, /git deposu değil/)
    } finally {
      removeDir(plain)
    }

    const missing = await api.post<{ message: string }>('/api/projects', { path: '/tmp/agentdeck-yok-xyz' })
    assert.equal(missing.status, 400)
    assert.match(missing.body.message, /bulunamadı/)
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
