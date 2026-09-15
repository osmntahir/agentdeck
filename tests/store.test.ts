import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openStore, StateError } from '../src/server/store'
import type { PersistedState, Session } from '../src/shared/types'
import { tempDir, removeDir, isRoot } from './helpers'

function session(over: Partial<Session> = {}): Session {
  return {
    id: 'a1',
    projectId: 'p1',
    name: 'iş',
    command: 'claude',
    isolation: 'worktree',
    cwd: '/tmp/agentdeck-x/p1/a1',
    branch: 'agentdeck/is-a1',
    baseCommit: 'f'.repeat(40),
    worktrees: [],
    lifecycle: 'live',
    exitCode: null,
    exitSignal: null,
    createdAt: 1000,
    endedAt: null,
    runId: 'r1',
    archivedAt: null,
    lastLaunch: { mode: 'command', command: 'claude' },
    ...over,
  }
}

function writeState(dir: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(value, null, 2))
}

test('state yoksa ve yönetilen kaynak yoksa boş state kurulur ama diske yazılmaz', () => {
  const dir = tempDir()
  try {
    const store = openStore(dir)
    assert.deepEqual(store.get(), { schemaVersion: 2, projects: [], sessions: [] })
    assert.equal(fs.existsSync(path.join(dir, 'state.json')), false, 'boş state yazılmamalı')
  } finally {
    removeDir(dir)
  }
})

test('state yok ama yönetilen worktree duruyorsa durur; hiçbir dosya silinmez', () => {
  const dir = tempDir()
  try {
    const orphan = path.join(dir, 'worktrees', 'p1', 'a1')
    fs.mkdirSync(orphan, { recursive: true })
    fs.writeFileSync(path.join(orphan, 'kullanici-isi.txt'), 'silinmemeli')

    assert.throws(() => openStore(dir), (err: unknown) => {
      assert.ok(err instanceof StateError)
      assert.equal(err.code, 'state_missing_with_resources')
      return true
    })
    assert.equal(fs.existsSync(path.join(orphan, 'kullanici-isi.txt')), true)
    assert.equal(fs.existsSync(path.join(dir, 'state.json')), false)
  } finally {
    removeDir(dir)
  }
})

test('bozuk state yazmadan durur ve dosyayı olduğu gibi bırakır', () => {
  const dir = tempDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'state.json')
    fs.writeFileSync(file, '{ yarim')

    assert.throws(() => openStore(dir), (err: unknown) => {
      assert.ok(err instanceof StateError)
      assert.equal(err.code, 'state_corrupt')
      return true
    })
    assert.equal(fs.readFileSync(file, 'utf8'), '{ yarim', 'bozuk dosya korunmalı')
  } finally {
    removeDir(dir)
  }
})

test('daha yeni şema durur', () => {
  const dir = tempDir()
  try {
    writeState(dir, { schemaVersion: 3, projects: [], sessions: [] })
    assert.throws(() => openStore(dir), (err: unknown) => {
      assert.ok(err instanceof StateError)
      assert.equal(err.code, 'state_newer_schema')
      return true
    })
  } finally {
    removeDir(dir)
  }
})

test('tanınmayan kayıt şekli durur; kayıt sessizce düşürülmez', () => {
  const dir = tempDir()
  try {
    writeState(dir, { schemaVersion: 2, projects: [], sessions: [{ id: 'a1', lifecycle: 'uydurma' }] })
    assert.throws(() => openStore(dir), (err: unknown) => {
      assert.ok(err instanceof StateError)
      assert.equal(err.code, 'state_corrupt')
      return true
    })
  } finally {
    removeDir(dir)
  }
})

test('okunamayan state durur', { skip: isRoot ? 'root izinleri kontrolü atlar' : false }, () => {
  const dir = tempDir()
  try {
    writeState(dir, { schemaVersion: 2, projects: [], sessions: [] })
    fs.chmodSync(path.join(dir, 'state.json'), 0o000)

    assert.throws(() => openStore(dir), (err: unknown) => {
      assert.ok(err instanceof StateError)
      assert.equal(err.code, 'state_unreadable')
      return true
    })
  } finally {
    fs.chmodSync(path.join(dir, 'state.json'), 0o644)
    removeDir(dir)
  }
})

test('önceki daemon canlı bıraktıysa kayıt orphaned olur, ölüm bilgisi uydurulmaz', () => {
  const dir = tempDir()
  try {
    writeState(dir, {
      schemaVersion: 2,
      projects: [{ id: 'p1', name: 'x', path: '/tmp/x', createdAt: 1 }],
      sessions: [session({ lifecycle: 'live' })],
    })
    const store = openStore(dir)
    const s = store.get().sessions[0]
    assert.equal(s.lifecycle, 'orphaned')
    assert.equal(s.exitCode, null)
    assert.equal(s.exitSignal, null)
    assert.equal(s.endedAt, null, 'kurtarma saati ölüm saati gibi yazılmaz')
    assert.equal(s.runId, 'r1', 'kayıtlı runId korunur')
    assert.deepEqual(store.interruptedSessionIds(), ['a1'], 'yalnız bu açılışta otomatik geri açma adayıdır')
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as PersistedState
    assert.equal(onDisk.sessions[0]?.lifecycle, 'orphaned', 'başarısız geri açma tekrar denenmesin diye durum kalıcılaşır')
    assert.deepEqual(openStore(dir).interruptedSessionIds(), [], 'aynı orphaned kayıt sonraki açılışta yeniden aday olmaz')
  } finally {
    removeDir(dir)
  }
})

test('gözlenen exit kalıcıdır', () => {
  const dir = tempDir()
  try {
    writeState(dir, {
      schemaVersion: 2,
      projects: [],
      sessions: [session({ lifecycle: 'exited', exitCode: 3, endedAt: 2000, runId: 'r1' })],
    })
    const s = openStore(dir).get().sessions[0]
    assert.equal(s.lifecycle, 'exited')
    assert.equal(s.exitCode, 3)
    assert.equal(s.endedAt, 2000)
  } finally {
    removeDir(dir)
  }
})

test('legacy agent/status kaydı yedekle birlikte migrate edilir', () => {
  const dir = tempDir()
  try {
    writeState(dir, {
      projects: [{ id: 'p1', name: 'x', path: '/tmp/x', createdAt: 1 }],
      sessions: [
        { id: 'a1', projectId: 'p1', name: 'iş', agent: 'claude', isolation: 'worktree', cwd: '/tmp/x/a1', branch: 'agentdeck/is-a1', status: 'running', exitCode: null, createdAt: 10 },
        { id: 'a2', projectId: 'p1', name: 'kabuk', agent: 'shell', isolation: 'shared', cwd: '/tmp/x', branch: null, status: 'exited', exitCode: 0, createdAt: 20 },
      ],
    })
    const store = openStore(dir)
    const [a1, a2] = store.get().sessions

    assert.equal(store.get().schemaVersion, 2)
    assert.equal(a1.command, 'claude', 'agent → command')
    assert.equal(a1.lifecycle, 'orphaned', 'eski running yönetilebilir PTY bırakmaz')
    assert.equal(a1.baseCommit, null, 'bilinmeyen base uydurulmaz')
    assert.equal(a1.runId, null, 'sahte eski runId üretilmez')
    assert.equal(a1.archivedAt, null)
    assert.deepEqual(a1.lastLaunch, { mode: 'command', command: 'claude' })
    assert.equal(a2.command, null, 'shell → null command')
    assert.equal(a2.lifecycle, 'exited')
    assert.equal(a2.exitCode, 0)

    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.bak-'))
    assert.equal(backups.length, 1, 'migrate yedek bırakmalı')
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as PersistedState
    assert.equal(onDisk.schemaVersion, 2, 'migrate atomik olarak yayımlanmalı')
  } finally {
    removeDir(dir)
  }
})

test('tanınmayan legacy ajan durur', () => {
  const dir = tempDir()
  try {
    writeState(dir, {
      projects: [],
      sessions: [{ id: 'a1', projectId: 'p1', name: 'x', agent: 'bilinmeyen', isolation: 'shared', cwd: '/tmp/x', branch: null, status: 'exited', exitCode: 0, createdAt: 1 }],
    })
    assert.throws(() => openStore(dir), (err: unknown) => {
      assert.ok(err instanceof StateError)
      assert.equal(err.code, 'state_corrupt')
      return true
    })
  } finally {
    removeDir(dir)
  }
})

test('commit copy-on-write: yayımlanan state ancak rename sonrası değişir', async () => {
  const dir = tempDir()
  try {
    const store = openStore(dir)
    const before = store.get()
    await store.commit((draft) => {
      draft.projects.push({ kind: 'git', id: 'p1', name: 'x', path: '/tmp/x', createdAt: 1 })
    })
    assert.equal(before.projects.length, 0, 'eski görünüm değişmez (copy-on-write)')
    assert.equal(store.get().projects.length, 1)
    assert.equal(store.revision(), 1)

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as PersistedState
    assert.equal(onDisk.projects.length, 1)
  } finally {
    removeDir(dir)
  }
})

test('commit başarısızsa yayımlanan state ve disk korunur', async () => {
  const dir = tempDir()
  try {
    const store = openStore(dir)
    await store.commit((draft) => {
      draft.projects.push({ kind: 'git', id: 'p1', name: 'x', path: '/tmp/x', createdAt: 1 })
    })

    // Yazılamaz veri dizini disk hatasını taklit eder.
    fs.chmodSync(dir, 0o500)
    await assert.rejects(
      store.commit((draft) => {
        draft.projects.push({ kind: 'git', id: 'p2', name: 'y', path: '/tmp/y', createdAt: 2 })
      }),
    )
    fs.chmodSync(dir, 0o755)

    assert.equal(store.get().projects.length, 1, 'başarısız mutation yayımlanmaz')
    assert.ok(store.serviceError(), 'kalıcılık hatası görünür olmalı')
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as PersistedState
    assert.equal(onDisk.projects.length, 1)
  } finally {
    removeDir(dir)
  }
})

test('ENOSPC yazımında yayımlanan state korunur ve serviceError görünür', async () => {
  const dir = tempDir()
  const original = fs.writeFileSync
  try {
    const store = openStore(dir)
    await store.commit((draft) => {
      draft.projects.push({ kind: 'git', id: 'p1', name: 'x', path: '/tmp/x', createdAt: 1 })
    })
    fs.writeFileSync = ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(target).endsWith('state.json.tmp')) {
        const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
        err.code = 'ENOSPC'
        throw err
      }
      return (original as (...args: unknown[]) => void)(target, ...rest)
    }) as typeof fs.writeFileSync
    await assert.rejects(
      store.commit((draft) => {
        draft.projects.push({ kind: 'git', id: 'p2', name: 'y', path: '/tmp/y', createdAt: 2 })
      }),
    )
    assert.equal(store.get().projects.length, 1, 'disk doluyken mutation yayımlanmaz')
    assert.match(store.serviceError() ?? '', /Kalıcı kayıt yazılamadı/)
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as PersistedState
    assert.equal(onDisk.projects.length, 1)
  } finally {
    fs.writeFileSync = original
    removeDir(dir)
  }
})

test('eşzamanlı commit çağrıları sıralanır ve hiçbiri kaybolmaz', async () => {
  const dir = tempDir()
  try {
    const store = openStore(dir)
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.commit((draft) => {
          draft.projects.push({ kind: 'git', id: `p${i}`, name: `x${i}`, path: `/tmp/x${i}`, createdAt: i })
        }),
      ),
    )
    assert.equal(store.get().projects.length, 12)
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as PersistedState
    assert.equal(onDisk.projects.length, 12)
  } finally {
    removeDir(dir)
  }
})

test('token dosyası yalnız sahibine okunur izinle üretilir', { skip: isRoot ? 'root izinleri kontrolü atlar' : false }, () => {
  const dir = tempDir()
  try {
    const store = openStore(dir)
    const value = store.token()
    assert.match(value, /^[0-9a-f]{48}$/)
    assert.equal(store.token(), value, 'token kalıcı olmalı')
    const mode = fs.statSync(path.join(dir, 'token')).mode & 0o777
    assert.equal(mode, 0o600)
  } finally {
    removeDir(dir)
  }
})


test('proje türü eski kayıtlarda git olur; klasör türü yeniden açılışta korunur', async () => {
  const dir = tempDir()
  try {
    writeState(dir, { schemaVersion: 2, projects: [{ id: 'old', name: 'old', path: '/tmp/old', createdAt: 1 }], sessions: [] })
    const store = openStore(dir)
    assert.equal(store.get().projects[0].kind, 'git')
    await store.commit(draft => {
      draft.projects.push({ id: 'folder', name: 'kiosk', path: '/tmp/kiosk', kind: 'folder', createdAt: 2 })
    })
    assert.deepEqual(openStore(dir).get().projects.map(p => p.kind), ['git', 'folder'])
  } finally { removeDir(dir) }
})

test('bilinmeyen proje türü bozuk kayıt olarak reddedilir', () => {
  const dir = tempDir()
  try {
    writeState(dir, { schemaVersion: 2, projects: [{ id: 'p', name: 'p', path: '/tmp/p', kind: 'unknown', createdAt: 1 }], sessions: [] })
    assert.throws(() => openStore(dir), StateError)
  } finally { removeDir(dir) }
})
