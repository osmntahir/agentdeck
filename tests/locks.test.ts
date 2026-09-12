import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createExclusiveLocks, createSerialQueues } from '../src/server/locks'

test('aynı Session için ikinci lifecycle mutasyonu kilidi alamaz', () => {
  const locks = createExclusiveLocks()
  const held = locks.tryAcquire('s1')
  assert.ok(held)
  assert.equal(locks.tryAcquire('s1'), null, 'çakışma beklemeye değil hataya dönüşmeli')
  assert.ok(locks.tryAcquire('s2'), 'başka Session engellenmez')
  held.release()
  assert.ok(locks.tryAcquire('s1'))
})

test('kilit iki kez bırakılsa bile başkasının kilidini düşürmez', () => {
  const locks = createExclusiveLocks()
  const first = locks.tryAcquire('s1')!
  first.release()
  const second = locks.tryAcquire('s1')!
  first.release()
  assert.equal(locks.tryAcquire('s1'), null, 'ikinci kilit hâlâ tutulmalı')
  second.release()
})

test('aynı Git dizini için mutasyonlar sıralanır', async () => {
  const queues = createSerialQueues()
  const order: string[] = []
  let concurrent = 0
  let maxConcurrent = 0

  const job = (name: string, ms: number) =>
    queues.run('/repo/.git', async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, ms))
      order.push(name)
      concurrent -= 1
    })

  await Promise.all([job('a', 20), job('b', 1), job('c', 1)])
  assert.equal(maxConcurrent, 1, 'Git mutasyonları çakışmamalı')
  assert.deepEqual(order, ['a', 'b', 'c'], 'sıra korunmalı')
})

test('farklı Git dizinleri paralel ilerler', async () => {
  const queues = createSerialQueues()
  let concurrent = 0
  let maxConcurrent = 0
  const job = (key: string) =>
    queues.run(key, async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 15))
      concurrent -= 1
    })
  await Promise.all([job('/a/.git'), job('/b/.git')])
  assert.equal(maxConcurrent, 2)
})

test('sıradaki bir iş patlarsa kuyruk kırılmaz', async () => {
  const queues = createSerialQueues()
  await assert.rejects(
    queues.run('/repo/.git', async () => {
      throw new Error('git patladı')
    }),
  )
  assert.equal(await queues.run('/repo/.git', async () => 'devam'), 'devam')
})
