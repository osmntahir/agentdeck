import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMutationIds } from '../src/shared/mutationIds'

test('aynı daemon ve payload kayıp cevapta aynı requestId yi tekrar kullanır', () => {
  let n = 0
  const ids = createMutationIds(() => `id-${++n}`)
  const payload = { projectId: 'p1', command: null, isolation: 'shared' }
  const first = ids.id('create', 'daemon-a', payload)
  const retry = ids.id('create', 'daemon-a', payload)
  assert.equal(first, 'id-1')
  assert.equal(retry, 'id-1', 'kayıp cevap ikinci Run açmamalı')
  assert.equal(n, 1)
})

test('başarılı sonuçtan sonra sonraki eylem yeni kimlik alır', () => {
  let n = 0
  const ids = createMutationIds(() => `id-${++n}`)
  const payload = { projectId: 'p1' }
  const first = ids.id('create', 'd', payload)
  ids.complete('create', first)
  assert.equal(ids.id('create', 'd', payload), 'id-2')
})

test('başka daemonId ile otomatik aynı kimlik kullanılmaz', () => {
  let n = 0
  const ids = createMutationIds(() => `id-${++n}`)
  const payload = { projectId: 'p1' }
  assert.equal(ids.id('create', 'eski', payload), 'id-1')
  assert.equal(ids.id('create', 'yeni', payload), 'id-2', 'yeni daemon defteri boştur; eski kimlik ikinci oturum açardı')
})

test('ilk poll boş daemonId yi doldurur, kimliği yenilemez', () => {
  let n = 0
  const ids = createMutationIds(() => `id-${++n}`)
  const payload = { projectId: 'p1' }
  assert.equal(ids.id('create', '', payload), 'id-1')
  assert.equal(ids.id('create', 'daemon-a', payload), 'id-1')
  assert.equal(ids.id('create', 'daemon-a', payload), 'id-1')
})

test('payload değişince yeni kimlik üretilir', () => {
  let n = 0
  const ids = createMutationIds(() => `id-${++n}`)
  ids.id('launch', 'd', { command: 'claude --resume' })
  assert.equal(ids.id('launch', 'd', { command: 'codex resume' }), 'id-2')
})

test('complete yalnız kendi kimliğini düşürür', () => {
  let n = 0
  const ids = createMutationIds(() => `id-${++n}`)
  const current = ids.id('restart', 'd', { expectedRunId: 'r1' })
  ids.complete('restart', 'başka')
  assert.equal(ids.id('restart', 'd', { expectedRunId: 'r1' }), current)
})

test('farklı payload aynı slotta birbirinin kayıp cevabını ezmez', () => {
  let n = 0
  const ids = createMutationIds(() => `id-${++n}`)
  const first = ids.id('launch', 'd', { id: 's1', command: 'claude' })
  const second = ids.id('launch', 'd', { id: 's2', command: 'codex' })
  assert.equal(first, 'id-1')
  assert.equal(second, 'id-2')
  assert.equal(ids.id('launch', 'd', { id: 's1', command: 'claude' }), 'id-1', 'kayıp cevap ikinci Run açmamalı')
})

test('on dakika sonra aynı daemon ve payload yeni kimlik alır', () => {
  let n = 0
  let now = 1_000
  const ids = createMutationIds(
    () => `id-${++n}`,
    () => now,
  )
  const payload = { projectId: 'p1' }
  assert.equal(ids.id('create', 'd', payload), 'id-1')
  now += 10 * 60 * 1000 - 1
  assert.equal(ids.id('create', 'd', payload), 'id-1', 'süre dolmadan kimlik korunur')
  now += 1
  assert.equal(ids.id('create', 'd', payload), 'id-2', 'sunucu defteri düşmüş kimlik ikinci Run açardı')
})


test('bekleyen kimlik bütçesi kayıp cevapları atmaz; tamamlanma ve TTL yer açar', () => {
  let n = 0
  let time = 0
  const ids = createMutationIds(() => `id-${++n}`, () => time)
  for (let i = 0; i < 1024; i++) ids.id('create', 'd', { i })
  assert.throws(() => ids.id('create', 'd', { i: 1024 }), /Bekleyen işlem sınırı/)
  assert.equal(ids.id('create', 'd', { i: 0 }), 'id-1')
  ids.complete('create', 'id-2')
  assert.equal(ids.id('create', 'd', { i: 1024 }), 'id-1025')
  time = 600000
  assert.equal(ids.id('create', 'd', { i: 1025 }), 'id-1026')
})

test('daemon değişimi eski bekleyen kimliklerin kapasitesini serbest bırakır', () => {
  let n = 0
  const ids = createMutationIds(() => `id-${++n}`)
  for (let i = 0; i < 1024; i++) ids.id('create', 'old', { i })
  assert.equal(ids.id('create', 'new', { i: 1024 }), 'id-1025')
})
