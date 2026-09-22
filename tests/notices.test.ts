import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectNotices, QUIET_AFTER_MS, WORK_MIN_MS, type WorkSpan } from '../src/shared/notices'
import type { SessionView, StateResponse } from '../src/shared/types'

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1', projectId: 'p1', name: 'Ödeme', command: 'claude', isolation: 'shared', cwd: '/tmp', branch: null,
    baseCommit: null, worktrees: [], lifecycle: 'live', exitCode: null, exitSignal: null, createdAt: 0, endedAt: null,
    runId: 'r1', archivedAt: null, lastLaunch: null, foregroundAgent: 'claude', attention: null, activity: 'active',
    lastActivityAt: 0, remainingProcessGroup: false, degraded: null, ...over,
  }
}
function state(now: number, ...sessions: SessionView[]): StateResponse {
  return { protocolVersion: 2, daemonId: 'd', revision: 1, serverNow: now, projects: [], sessions, serviceError: null }
}

test('onay isteği aynı Run içinde yeniden çizilse de bir kez bildirilir', () => {
  const spans = new Map<string, WorkSpan>()
  const asking = session({ attention: { kind: 'approval', message: 'İzin veya onay bekliyor', detectedAt: 1 } })
  assert.deepEqual(detectNotices(state(0, session()), state(0, asking), spans).map((e) => e.kind), ['attention'])
  const redrawn = session({ attention: { kind: 'approval', message: 'İzin veya onay bekliyor', detectedAt: 2 } })
  assert.deepEqual(detectNotices(state(0, asking), state(0, redrawn), spans), [])
})

test('çıkış kodu tamamlanmayı ve hatayı ayırır', () => {
  const spans = new Map<string, WorkSpan>()
  const ok = detectNotices(state(0, session()), state(0, session({ lifecycle: 'exited', exitCode: 0 })), spans)
  const bad = detectNotices(state(0, session()), state(0, session({ lifecycle: 'exited', exitCode: 2 })), spans)
  assert.deepEqual([ok[0]?.kind, bad[0]?.kind], ['finished', 'failed'])
})

test('uzun çalışmadan sonra çıktı durunca bir kez "sıra sizde olabilir" denir', () => {
  const spans = new Map<string, WorkSpan>()
  let previous = state(0, session({ lastActivityAt: 0 }))
  const step = (now: number, lastActivityAt: number) => {
    const next = state(now, session({ lastActivityAt }))
    const events = detectNotices(previous, next, spans)
    previous = next
    return events.map((e) => e.kind)
  }
  assert.deepEqual(step(1000, 1000), [])
  assert.deepEqual(step(WORK_MIN_MS + 2000, WORK_MIN_MS + 2000), [])
  assert.deepEqual(step(WORK_MIN_MS + 2000 + QUIET_AFTER_MS, WORK_MIN_MS + 2000), ['quiet'])
  assert.deepEqual(step(WORK_MIN_MS + 4000 + QUIET_AFTER_MS, WORK_MIN_MS + 2000), [])
})

test('kısa yanıt, kabuk ve onay bekleyen ajan için sessizlik bildirilmez', () => {
  for (const over of [{}, { foregroundAgent: null }, { attention: { kind: 'approval' as const, message: '', detectedAt: 0 } }]) {
    const spans = new Map<string, WorkSpan>()
    const long = 'attention' in over || 'foregroundAgent' in over
    const busyUntil = long ? WORK_MIN_MS + 1000 : 2000
    detectNotices(state(0, session(over)), state(500, session({ ...over, lastActivityAt: 500 })), spans)
    detectNotices(state(500, session(over)), state(busyUntil, session({ ...over, lastActivityAt: busyUntil })), spans)
    const events = detectNotices(state(busyUntil, session(over)), state(busyUntil + QUIET_AFTER_MS, session({ ...over, lastActivityAt: busyUntil })), spans)
    assert.deepEqual(events.filter((e) => e.kind === 'quiet'), [], JSON.stringify(over))
  }
})
