import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionWorkActions } from '../src/shared/sessionActions'
import type { SessionView } from '../src/shared/types'

const UUID = '12345678-1234-1234-1234-123456789abc'

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    projectId: 'p1',
    name: 'iş',
    command: 'claude',
    isolation: 'worktree',
    cwd: '/tmp/x',
    branch: 'agentdeck/x',
    baseCommit: 'abc',
    worktrees: [],
    lifecycle: 'exited',
    exitCode: 0,
    exitSignal: null,
    createdAt: 1,
    endedAt: 2,
    runId: 'r1',
    archivedAt: null,
    lastLaunch: { mode: 'command', command: 'claude' },
    activity: null,
    lastActivityAt: null,
    remainingProcessGroup: false,
    degraded: null,
    attention: null,
    ...over,
  }
}

function kinds(s: SessionView) {
  return sessionWorkActions(s).map((action) => `${action.kind}${action.primary ? '*' : ''}`)
}

test('literal CLI: yeniden çalıştır birincildir; seçici ayrıdır; aynı komut ikinci kez listelenmez', () => {
  const actions = sessionWorkActions(session())
  assert.deepEqual(kinds(session()), ['restart*', 'continue', 'launch'])
  const restart = actions.find((a) => a.kind === 'restart')
  const cont = actions.find((a) => a.kind === 'continue')
  assert.equal(restart?.label, 'yeniden çalıştır')
  assert.match(restart?.description ?? '', /komutu aynen yeniden çalıştırır/i)
  assert.equal(cont?.kind, 'continue')
  if (cont?.kind !== 'continue') throw new Error('continue yok')
  assert.equal(cont.command, 'claude --resume')
  assert.match(cont.description, /aynı konuşmayı sürdürür|seçicisini açar/)
})

test('açık UUID konuşma adayıysa konuşmayı sürdür birincildir', () => {
  const s = session({ lastLaunch: { mode: 'command', command: `claude --resume ${UUID}` } })
  assert.deepEqual(kinds(s), ['continue*', 'fresh', 'restart', 'launch'])
  const actions = sessionWorkActions(s)
  const cont = actions.find((a) => a.kind === 'continue')
  const fresh = actions.find((a) => a.kind === 'fresh')
  if (cont?.kind !== 'continue' || fresh?.kind !== 'fresh') throw new Error('continue/fresh yok')
  assert.equal(cont.command, 'claude --resume')
  assert.equal(fresh.command, 'claude')
  assert.match(fresh.description, /yeni konuşma açar/)
})

test('seçici lastLaunch ise konuşmayı sürdür yinelenmez', () => {
  const s = session({ lastLaunch: { mode: 'command', command: 'claude --resume' } })
  assert.deepEqual(kinds(s), ['restart*', 'fresh', 'launch'])
})

test('lastLaunch.mode fresh ise yeniden çalıştır gizlenir', () => {
  const s = session({ lastLaunch: { mode: 'fresh', cli: 'claude', conversationId: null } })
  assert.deepEqual(kinds(s), ['fresh*', 'continue', 'launch'])
  const fresh = sessionWorkActions(s).find((a) => a.kind === 'fresh')
  if (fresh?.kind !== 'fresh') throw new Error('fresh yok')
  assert.equal(fresh.command, 'claude')
})

test('lastLaunch.mode resume ise konuşmayı sürdür birincildir', () => {
  const s = session({ lastLaunch: { mode: 'resume', cli: 'claude', conversationId: UUID } })
  assert.deepEqual(kinds(s), ['continue*', 'fresh', 'restart', 'launch'])
  const restart = sessionWorkActions(s).find((a) => a.kind === 'restart')
  assert.match(restart?.description ?? '', /aynı konuşmayı sürdürür/)
  assert.doesNotMatch(restart?.description ?? '', /claude$/)
})

test('kabuk oturumunda CLI eylemleri yoktur', () => {
  const s = session({ command: null, lastLaunch: { mode: 'command', command: null } })
  assert.deepEqual(kinds(s), ['restart*', 'launch'])
})

test('canlı işte durdur görünür ve diğer eylemler durdurmayı söyler', () => {
  const s = session({ lifecycle: 'live', activity: 'active', remainingProcessGroup: false })
  const actions = sessionWorkActions(s)
  assert.equal(kinds(s)[0], 'stop')
  assert.match(actions[0]?.description ?? '', /terminal geçmişi/)
  const restart = actions.find((a) => a.kind === 'restart')
  const launch = actions.find((a) => a.kind === 'launch')
  assert.equal(restart?.label, 'durdur ve yeniden çalıştır')
  assert.match(restart?.description ?? '', /doğrulanmış biçimde durdurur/)
  assert.equal(launch?.label, 'durdur ve komut çalıştır…')
})

test('kalan süreç grubu da durdurma ister', () => {
  const s = session({ lifecycle: 'exited', remainingProcessGroup: true })
  assert.equal(sessionWorkActions(s)[0]?.kind, 'stop')
})

test('son çalıştırılan CLI konuşma eylemlerini belirler', () => {
  const s = session({ command: 'claude', lastLaunch: { mode: 'command', command: 'codex' } })
  assert.deepEqual(kinds(s), ['restart*', 'continue', 'launch'])
  const cont = sessionWorkActions(s).find((a) => a.kind === 'continue')
  if (cont?.kind !== 'continue') throw new Error('continue yok')
  assert.equal(cont.command, 'codex resume')
})

test('lastLaunch.mode picker ise konuşmayı sürdür yinelenmez', () => {
  const s = session({ lastLaunch: { mode: 'picker', cli: 'claude' } })
  assert.deepEqual(kinds(s), ['restart*', 'fresh', 'launch'])
  const restart = sessionWorkActions(s).find((a) => a.kind === 'restart')
  assert.match(restart?.description ?? '', /seçicisini tekrar açar/)
})

test('son Run CLI değilse konuşma eylemleri başlangıç Command ından üretilmez', () => {
  const s = session({ command: 'claude', lastLaunch: { mode: 'command', command: 'pwd' } })
  assert.deepEqual(kinds(s), ['restart*', 'launch'])
})

test('kabuk oturumunda picker lastLaunch konuşma eylemlerini açar', () => {
  const s = session({ command: null, lastLaunch: { mode: 'picker', cli: 'claude' } })
  assert.deepEqual(kinds(s), ['restart*', 'fresh', 'launch'])
  const restart = sessionWorkActions(s).find((a) => a.kind === 'restart')
  assert.match(restart?.description ?? '', /seçicisini tekrar açar/)
})

test('canlı fresh eylemi durdurmayı söyler', () => {
  const s = session({
    lifecycle: 'live',
    activity: 'active',
    lastLaunch: { mode: 'fresh', cli: 'claude', conversationId: null },
  })
  const actions = sessionWorkActions(s)
  assert.equal(actions.find((a) => a.kind === 'fresh')?.label, 'durdur ve aynı dosyalarla yeni konuşma')
  assert.equal(actions.find((a) => a.kind === 'continue')?.label, 'durdur ve konuşmayı sürdür')
  assert.equal(actions.some((a) => a.kind === 'restart'), false)
})


test('desteklenmeyen eski niyette yanlış restart sunulmaz; açık komut yolu kalır', () => {
  assert.deepEqual(kinds(session({ lastLaunch: { mode: 'picker', cli: 'unknown' } })), ['launch'])
})
