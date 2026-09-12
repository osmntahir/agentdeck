import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifiedStop, type ProcessGroup, type StopTiming } from '../src/server/stop'

const FAST: StopTiming = { hangupWaitMs: 30, killWaitMs: 30, pollMs: 5 }

/**
 * Gerçek süreç grubunun yerine geçen sahte grup. SIGKILL'i görmezden gelen bir
 * grup gerçek çekirdekte kurulamaz; timeout yolunu ancak burada ölçebiliriz.
 */
function fakeGroup(behaviour: {
  aliveAtStart?: boolean
  leaderExitsOn?: 'SIGHUP' | 'SIGKILL' | 'never'
  groupDiesOn?: 'leader' | 'SIGKILL' | 'never'
}): ProcessGroup & { signals: string[] } {
  const leaderExitsOn = behaviour.leaderExitsOn ?? 'SIGHUP'
  const groupDiesOn = behaviour.groupDiesOn ?? 'leader'
  let alive = behaviour.aliveAtStart ?? true
  let leaderExited = false
  const signals: string[] = []
  let resolveExit!: () => void
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })

  const killLeader = () => {
    if (leaderExited) return
    leaderExited = true
    if (groupDiesOn === 'leader') alive = false
    resolveExit()
  }
  if (!alive) killLeader()

  return {
    signals,
    signal(sig) {
      signals.push(sig)
      if (sig === leaderExitsOn) killLeader()
      if (sig === 'SIGKILL' && groupDiesOn === 'SIGKILL') alive = false
    },
    alive: () => alive,
    exited,
  }
}

test('grup çoktan gitmişse durdurma doğrulanmış sayılır', async () => {
  const group = fakeGroup({ aliveAtStart: false })
  const outcome = await verifiedStop(group, FAST)
  assert.deepEqual(outcome, { verified: true, alreadyGone: true, escalated: false })
  assert.deepEqual(group.signals, [], 'ölü gruba sinyal gönderilmez')
})

test('SIGHUP ile ölen grup yükseltme olmadan doğrulanır', async () => {
  const group = fakeGroup({ leaderExitsOn: 'SIGHUP' })
  const outcome = await verifiedStop(group, FAST)
  assert.deepEqual(outcome, { verified: true, alreadyGone: false, escalated: false })
  assert.deepEqual(group.signals, ['SIGHUP'])
})

test('SIGHUP yetmezse SIGKILL ile yükseltilir', async () => {
  const group = fakeGroup({ leaderExitsOn: 'SIGKILL' })
  const outcome = await verifiedStop(group, FAST)
  assert.deepEqual(outcome, { verified: true, alreadyGone: false, escalated: true })
  assert.deepEqual(group.signals, ['SIGHUP', 'SIGKILL'])
})

test('lider çıkmış ama grup yaşıyorsa grup ayrıca öldürülür', async () => {
  const group = fakeGroup({ leaderExitsOn: 'SIGHUP', groupDiesOn: 'SIGKILL' })
  const outcome = await verifiedStop(group, FAST)
  assert.equal(outcome.verified, true)
  assert.deepEqual(group.signals, ['SIGHUP', 'SIGKILL'], 'lider çıkışı grubun bittiğini kanıtlamaz')
})

test('lider çıksa bile grup ölmüyorsa doğrulanmadı döner', async () => {
  const group = fakeGroup({ leaderExitsOn: 'SIGHUP', groupDiesOn: 'never' })
  const outcome = await verifiedStop(group, FAST)
  assert.deepEqual(outcome, { verified: false, reason: 'group_running' })
})

test('lider hiç çıkmazsa timeout başarı sayılmaz', async () => {
  const group = fakeGroup({ leaderExitsOn: 'never', groupDiesOn: 'never' })
  const outcome = await verifiedStop(group, FAST)
  assert.deepEqual(outcome, { verified: false, reason: 'leader_running' })
  assert.deepEqual(group.signals, ['SIGHUP', 'SIGKILL'], 'her iki sinyal de denenmiş olmalı')
})
