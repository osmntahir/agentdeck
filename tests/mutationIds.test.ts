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
