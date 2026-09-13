import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStatePoller, pollPreviewIds, type PollFailure } from '../src/shared/statePoll'

interface FakeState {
  daemonId: string
  revision: number
}

const state = (daemonId: string, revision: number): FakeState => ({ daemonId, revision })

test('önizleme kimlikleri gizli taramada GET e girmez', () => {
  assert.deepEqual(pollPreviewIds(true, ['a', 'b']), ['a', 'b'])
  assert.deepEqual(pollPreviewIds(false, ['a', 'b']), [])
})

/** Ağ, zamanlayıcı ve sekme görünürlüğü testin elindedir; gerçek süre beklenmez. */
function harness() {
  const timers: { fn: () => void; ms: number }[] = []
  const requests: { resolve: (s: FakeState) => void; reject: (e: unknown) => void }[] = []
  const states: FakeState[] = []
  const failures: PollFailure[] = []
  let hidden = false
  const poller = createStatePoller<FakeState>({
    fetchState: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    schedule: (fn, ms) => {
      const timer = { fn, ms }
      timers.push(timer)
      return timer
    },
    cancel: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number])
      if (index >= 0) timers.splice(index, 1)
    },
    isHidden: () => hidden,
    onState: (next) => states.push(next),
    onFailure: (failure) => failures.push(failure),
  })
  return {
    poller,
    timers,
    requests,
    states,
    failures,
    setHidden: (value: boolean) => {
      hidden = value
    },
    fire: () => timers.shift()!.fn(),
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('durum hemen okunur; sonraki okuma önceki istek bittikten 2 sn sonra planlanır', async () => {
  const h = harness()
  h.poller.start()
  assert.equal(h.requests.length, 1, 'hemen okunur')
  assert.equal(h.timers.length, 0, 'istek sürerken ikinci okuma planlanmaz')

  h.requests[0].resolve(state('d', 1))
  await settle()
  assert.deepEqual(h.states, [state('d', 1)])
  assert.deepEqual(
    h.timers.map((t) => t.ms),
    [2000],
  )

  h.fire()
  assert.equal(h.requests.length, 2)
})

test('eski isteğin geç cevabı yeni tazelemeyi ezmez; aynı daemon da düşük revision atılır, eşit revision işlenir', async () => {
  const h = harness()
  h.poller.start()
  const refreshed = h.poller.refresh()
  assert.equal(h.requests.length, 2, 'mutation sonrası tazeleme beklemeden okur')

  h.requests[1].resolve(state('d', 5))
  await refreshed
  h.requests[0].resolve(state('d', 4))
  await settle()
  assert.deepEqual(h.states, [state('d', 5)], 'eski generation cevabı uygulanmaz')
  assert.equal(h.timers.length, 1, 'eski cevap ikinci bir döngü açmaz')

  h.fire()
  h.requests[2].resolve(state('d', 3))
  await settle()
  h.fire()
  h.requests[3].resolve(state('d', 5))
  await settle()
  h.fire()
  h.requests[4].resolve(state('e', 1))
  await settle()
  assert.deepEqual(
    h.states,
    [state('d', 5), state('d', 5), state('e', 1)],
    'düşük revision atılır; eşit revision ve yeni daemon işlenir',
  )
})

test('gizli sekmede okuma durur; görünür olunca hemen okunur', async () => {
  const h = harness()
  h.poller.start()
  h.requests[0].resolve(state('d', 1))
  await settle()
  assert.equal(h.timers.length, 1)

  h.setHidden(true)
  h.poller.visibilityChanged()
  assert.equal(h.timers.length, 0, 'bekleyen okuma iptal edilir')

  h.poller.refresh()
  h.requests[1].resolve(state('d', 2))
  await settle()
  assert.equal(h.timers.length, 0, 'gizliyken sonraki okuma planlanmaz')

  h.setHidden(false)
  h.poller.visibilityChanged()
  assert.equal(h.requests.length, 3, 'dönüşte beklemeden okunur')
})

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })

test('401/403 otomatik denemeyi durdurur; ağ ve sunucu hatası 2/4/8/10 sn geri çekilir, başarı sıfırlar', async () => {
  const h = harness()
  h.poller.start()
  h.requests[0].reject(httpError(401))
  await settle()
  assert.equal(h.failures[0].kind, 'auth')
  assert.equal(h.failures[0].retryInMs, null)
  assert.equal(h.timers.length, 0, 'yetki hatası kendiliğinden tekrar denenmez')

  void h.poller.refresh().catch(() => {})
  const delays: number[] = []
  for (let index = 1; index <= 5; index++) {
    h.requests[index].reject(index % 2 === 1 ? new TypeError('Failed to fetch') : httpError(503))
    await settle()
    delays.push(h.timers[0].ms)
    h.fire()
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 10000, 10000])
  assert.deepEqual(
    h.failures.slice(1).map((f) => [f.kind, f.retryInMs]),
    [
      ['network', 2000],
      ['server', 4000],
      ['network', 8000],
      ['server', 10000],
      ['network', 10000],
    ],
  )
  for (const failure of h.failures) assert.ok(failure.message.length > 0)

  h.requests[6].resolve(state('d', 1))
  await settle()
  h.fire()
  h.requests[7].reject(new TypeError('Failed to fetch'))
  await settle()
  assert.deepEqual(
    h.timers.map((t) => t.ms),
    [2000],
    'başarılı okuma geri çekilmeyi sıfırlar',
  )
})
