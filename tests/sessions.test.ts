import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import * as sessions from '../src/server/sessions'
import type { RunExit } from '../src/server/sessions'

const FAST = { hangupWaitMs: 400, killWaitMs: 400, pollMs: 10 }

function collector() {
  const chunks: string[] = []
  return {
    chunks,
    text: () => chunks.join(''),
    async waitFor(needle: string, budgetMs = 8000): Promise<void> {
      const deadline = Date.now() + budgetMs
      while (!chunks.join('').includes(needle)) {
        if (Date.now() > deadline) throw new Error(`"${needle}" çıktıda görünmedi: ${chunks.join('')}`)
        await new Promise((r) => setTimeout(r, 25))
      }
    },
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

test('command null etkileşimli login kabuğu başlatır', { timeout: 20000 }, async () => {
  const out = collector()
  const exits: RunExit[] = []
  const run = sessions.spawn({
    sessionId: 's-shell',
    runId: 'r1',
    command: null,
    cwd: os.tmpdir(),
    onExit: (exit) => exits.push(exit),
  })
  sessions.subscribe('s-shell', (d) => out.chunks.push(d), () => {})
  try {
    assert.equal(sessions.isLive('s-shell'), true)
    assert.equal(sessions.currentRunId('s-shell'), 'r1')
    sessions.write('s-shell', 'echo AGENTDECK_KABUK\n')
    await out.waitFor('AGENTDECK_KABUK')
  } finally {
    const outcome = await sessions.stop('s-shell', FAST)
    assert.equal(outcome.verified, true)
  }
  assert.equal(groupAlive(run.pid), false, 'süreç grubu gerçekten gitmeli')
  assert.equal(sessions.isLive('s-shell'), false)
})

test('string command aynen program olarak yürür ve gerçek çıkış kaydedilir', { timeout: 20000 }, async () => {
  const out = collector()
  const exits: RunExit[] = []
  sessions.spawn({
    sessionId: 's-cmd',
    runId: 'r1',
    command: 'printf AGENTDECK_CIKTI; exit 7',
    cwd: os.tmpdir(),
    onExit: (exit) => exits.push(exit),
  })
  sessions.subscribe('s-cmd', (d) => out.chunks.push(d), () => {})

  await out.waitFor('AGENTDECK_CIKTI')
  const deadline = Date.now() + 8000
  while (exits.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))

  assert.equal(exits.length, 1)
  assert.equal(exits[0].runId, 'r1')
  assert.equal(exits[0].exitCode, 7, 'gözlenen çıkış kodu kaydedilir')
  assert.equal(sessions.isLive('s-cmd'), false)
})

test('Run ortamı izin listesine uyar ve AGENTDECK_RUN atanır', { timeout: 20000 }, async () => {
  const out = collector()
  process.env.AGENTDECK_TEST_SIZMA = 'sizmamali'
  try {
    sessions.spawn({
      sessionId: 's-env',
      runId: 'r-env-42',
      command: 'echo "run=$AGENTDECK_RUN sizma=${AGENTDECK_TEST_SIZMA:-yok} term=$TERM"',
      cwd: os.tmpdir(),
      onExit: () => {},
    })
    sessions.subscribe('s-env', (d) => out.chunks.push(d), () => {})
    await out.waitFor('run=r-env-42')
    await out.waitFor('sizma=yok')
    await out.waitFor('term=xterm-256color')
  } finally {
    delete process.env.AGENTDECK_TEST_SIZMA
    await sessions.stop('s-env', FAST)
  }
})

test('SIGHUP yetmeyen grup SIGKILL ile doğrulanarak durdurulur', { timeout: 20000 }, async () => {
  const out = collector()
  const run = sessions.spawn({
    sessionId: 's-hup',
    runId: 'r1',
    // Yoksayılan sinyal exec üzerinden miras alınır: hem kabuk hem çocuk HUP'ı yutar.
    command: 'trap "" HUP; echo AGENTDECK_HAZIR; sleep 300 & sleep 300',
    cwd: os.tmpdir(),
    onExit: () => {},
  })
  sessions.subscribe('s-hup', (d) => out.chunks.push(d), () => {})
  await out.waitFor('AGENTDECK_HAZIR')

  const outcome = await sessions.stop('s-hup', FAST)
  assert.equal(outcome.verified, true)
  assert.equal(outcome.verified === true && outcome.escalated, true, 'SIGHUP yetmediyse yükseltilmeli')
  assert.equal(groupAlive(run.pid), false)
})

test('lider çıkıp çocuk kaldığında grup izlenir ve durdurma onu da temizler', { timeout: 20000 }, async () => {
  const out = collector()
  const exits: RunExit[] = []
  const run = sessions.spawn({
    sessionId: 's-cocuk',
    runId: 'r1',
    command: 'trap "" HUP; sleep 300 & echo AGENTDECK_COCUK; exit 0',
    cwd: os.tmpdir(),
    onExit: (exit) => exits.push(exit),
  })
  sessions.subscribe('s-cocuk', (d) => out.chunks.push(d), () => {})
  await out.waitFor('AGENTDECK_COCUK')

  const deadline = Date.now() + 8000
  while (exits.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  assert.equal(exits.length, 1, 'liderin çıkışı gözlenir')
  assert.equal(sessions.isLive('s-cocuk'), false)
  assert.equal(groupAlive(run.pid), true, 'çocuk hâlâ grupta yaşıyor')
  assert.equal(sessions.hasLingeringGroup('s-cocuk'), true, 'lider çıkışı grubun bittiğini kanıtlamaz')

  const outcome = await sessions.stop('s-cocuk', FAST)
  assert.equal(outcome.verified, true)
  assert.equal(groupAlive(run.pid), false)
  assert.equal(sessions.hasLingeringGroup('s-cocuk'), false)
})

test('canlı Run varken ikinci Run açılamaz', { timeout: 20000 }, async () => {
  sessions.spawn({ sessionId: 's-tek', runId: 'r1', command: 'sleep 300', cwd: os.tmpdir(), onExit: () => {} })
  try {
    assert.throws(
      () =>
        sessions.spawn({ sessionId: 's-tek', runId: 'r2', command: 'sleep 300', cwd: os.tmpdir(), onExit: () => {} }),
      /canlı Run/i,
    )
    assert.equal(sessions.currentRunId('s-tek'), 'r1')
  } finally {
    await sessions.stop('s-tek', FAST)
  }
})

test('olmayan oturumu durdurmak doğrulanmış sayılır', async () => {
  const outcome = await sessions.stop('s-yok', FAST)
  assert.deepEqual(outcome, { verified: true, alreadyGone: true, escalated: false })
})

test('aktivite yalnız gerçek çıktı ve girdiyle ilerler', { timeout: 20000 }, async () => {
  const out = collector()
  sessions.spawn({
    sessionId: 's-akt',
    runId: 'r1',
    command: 'echo AGENTDECK_AKTIF; sleep 300',
    cwd: os.tmpdir(),
    onExit: () => {},
  })
  sessions.subscribe('s-akt', (d) => out.chunks.push(d), () => {})
  try {
    await out.waitFor('AGENTDECK_AKTIF')
    const first = sessions.activity('s-akt')
    assert.ok(first)
    assert.equal(first.activity, 'active')
    await new Promise((r) => setTimeout(r, 30))
    sessions.write('s-akt', '')
    assert.equal(
      sessions.activity('s-akt')!.lastActivityAt,
      first.lastActivityAt,
      'boş girdi aktivite üretmez',
    )
    sessions.write('s-akt', 'x')
    assert.ok(sessions.activity('s-akt')!.lastActivityAt > first.lastActivityAt, 'kabul edilmiş girdi ilerletir')
  } finally {
    await sessions.stop('s-akt', FAST)
  }
})

test('canlı Run sayısı kapasite kontrolü için görünür', { timeout: 20000 }, async () => {
  const before = sessions.liveCount()
  sessions.spawn({ sessionId: 's-say', runId: 'r1', command: 'sleep 300', cwd: os.tmpdir(), onExit: () => {} })
  try {
    assert.equal(sessions.liveCount(), before + 1)
  } finally {
    await sessions.stop('s-say', FAST)
  }
  assert.equal(sessions.liveCount(), before)
})

test('okunamayan cwd için Run başlamaz', () => {
  assert.throws(
    () =>
      sessions.spawn({
        sessionId: 's-cwd',
        runId: 'r1',
        command: null,
        cwd: '/tmp/agentdeck-olmayan-dizin-xyz',
        onExit: () => {},
      }),
    /cwd/i,
  )
  assert.equal(fs.existsSync('/tmp/agentdeck-olmayan-dizin-xyz'), false, 'dizin yaratılmaz')
})
