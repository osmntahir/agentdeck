import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequestLedger, DedupConflictError } from '../src/server/dedup'

test('aynı requestId + aynı payload bir kez çalışır ve aynı sonucu döner', async () => {
  const ledger = createRequestLedger<string>()
  let runs = 0
  const work = async () => {
    runs += 1
    return 'sonuç'
  }
  const first = await ledger.run('r1', { a: 1 }, work)
  const second = await ledger.run('r1', { a: 1 }, work)
  assert.equal(first, 'sonuç')
  assert.equal(second, 'sonuç')
  assert.equal(runs, 1, 'ikinci istek yeni Run başlatmamalı')
})

test('payload alan sırası sonucu değiştirmez', async () => {
  const ledger = createRequestLedger<number>()
  let runs = 0
  await ledger.run('r1', { a: 1, b: 2 }, async () => ++runs)
  await ledger.run('r1', { b: 2, a: 1 }, async () => ++runs)
  assert.equal(runs, 1)
})

test('aynı requestId farklı payload ile çakışma verir', async () => {
  const ledger = createRequestLedger<string>()
  await ledger.run('r1', { a: 1 }, async () => 'ilk')
  await assert.rejects(
    ledger.run('r1', { a: 2 }, async () => 'ikinci'),
    (err: unknown) => {
      assert.ok(err instanceof DedupConflictError)
      return true
    },
  )
})

test('uçuşta olan aynı istek ikinci bir çalıştırma doğurmaz', async () => {
  const ledger = createRequestLedger<string>()
  let runs = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const work = async () => {
    runs += 1
    await gate
    return 'bir'
  }
  const a = ledger.run('r1', { x: 1 }, work)
  const b = ledger.run('r1', { x: 1 }, work)
  release()
  assert.deepEqual(await Promise.all([a, b]), ['bir', 'bir'])
  assert.equal(runs, 1)
})

test('başarısız istek aynı kimlikle tekrar denenebilir', async () => {
  const ledger = createRequestLedger<string>()
  await assert.rejects(
    ledger.run('r1', { x: 1 }, async () => {
      throw new Error('spawn patladı')
    }),
  )
  assert.equal(await ledger.run('r1', { x: 1 }, async () => 'ikinci deneme'), 'ikinci deneme')
})

test('TTL sonrası sonuç hatırlanmaz', async () => {
  let now = 1_000_000
  const ledger = createRequestLedger<number>({ ttlMs: 1000, maxEntries: 8, now: () => now })
  let runs = 0
  await ledger.run('r1', { x: 1 }, async () => ++runs)
  now += 1001
  await ledger.run('r1', { x: 1 }, async () => ++runs)
  assert.equal(runs, 2)
})

test('kapasite aşılınca en eski sonuç düşer, yenisi korunur', async () => {
  const ledger = createRequestLedger<number>({ ttlMs: 60_000, maxEntries: 2 })
  let runs = 0
  await ledger.run('r1', {}, async () => ++runs)
  await ledger.run('r2', {}, async () => ++runs)
  await ledger.run('r3', {}, async () => ++runs)
  await ledger.run('r1', {}, async () => ++runs)
  assert.equal(runs, 4, 'düşen kayıt yeniden çalışır')
  await ledger.run('r3', {}, async () => ++runs)
  assert.equal(runs, 4, 'kapasitede kalan kayıt hatırlanır')
})
