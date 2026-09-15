import test from 'node:test'
import assert from 'node:assert/strict'
import { inProjectNavigation, recoveryLaunch } from '../src/shared/workspacePolicy'
import type { SessionView } from '../src/shared/types'
const session = (over: Partial<SessionView> = {}): SessionView => ({ id: 's', projectId: 'p', name: 'iş', command: 'claude', lastLaunch: null, lifecycle: 'orphaned', archivedAt: null, degraded: null, remainingProcessGroup: false, ...over } as SessionView)
test('sol gezinme yalnız canlı ve kalan süreçli işleri gösterir; geçmiş silinmez', () => {
  assert.equal(inProjectNavigation(session()), false)
  assert.equal(inProjectNavigation(session({ lifecycle: 'exited' })), false)
  assert.equal(inProjectNavigation(session({ lifecycle: 'live' })), true)
  assert.equal(inProjectNavigation(session({ lifecycle: 'exited', remainingProcessGroup: true })), true)
  assert.equal(inProjectNavigation(session({ lifecycle: 'live', archivedAt: 1 })), false)
})
test('yarım kalan CLI aynı kayıtta seçici veya açık konuşma kimliğiyle döner', () => {
  assert.deepEqual(recoveryLaunch(session()), { command: 'claude --resume', mode: 'picker' })
  const command = 'codex resume 12345678-1234-1234-1234-123456789abc'
  assert.deepEqual(recoveryLaunch(session({ lastLaunch: { mode: 'command', command } })), { command, mode: 'command' })
  assert.deepEqual(recoveryLaunch(session({ command: 'grok' })), { command: 'grok', mode: 'command' })
  assert.deepEqual(recoveryLaunch(session({ command: null })), { command: null, mode: 'command' })
})
test('bilerek biten, arşivli, bozuk dizin ve serbest program otomatik başlamaz', () => {
  for (const over of [{ lifecycle: 'exited' as const }, { lifecycle: 'live' as const }, { archivedAt: 1 }, { degraded: 'missing' }, { command: 'npm run deploy' }, { command: 'claude --dangerously-skip-permissions' }]) assert.equal(recoveryLaunch(session(over)), null)
})

test('bitmiş oturumda saklanmış exact resume hedefi bir kez otomatik açılır', () => {
  const target = { mode: 'resume' as const, cli: 'grok', conversationId: '12345678-1234-1234-1234-123456789abc' }
  assert.deepEqual(
    recoveryLaunch(session({ lifecycle: 'exited', lastLaunch: target })),
    { command: 'grok --resume 12345678-1234-1234-1234-123456789abc', mode: 'command' },
  )
  assert.equal(recoveryLaunch(session({ lifecycle: 'exited', lastLaunch: target, autoResumeAttempted: true })), null)
})
