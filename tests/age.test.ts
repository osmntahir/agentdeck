import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAge, sessionAgeMs, type SessionView } from '../src/shared/types'

test('yaş kısa ve yuvarlanmış Türkçe süreyle söylenir', () => {
  const second = 1000
  const minute = 60 * second
  const hour = 60 * minute
  const day = 24 * hour
  const cases: [number, string][] = [
    [-500, 'az önce'],
    [0, 'az önce'],
    [9 * second + 999, 'az önce'],
    [45 * second, '45 sn'],
    [minute - 1, '59 sn'],
    [minute, '1 dk'],
    [hour - 1, '59 dk'],
    [hour, '1 sa'],
    [day - 1, '23 sa'],
    [day, '1 gün'],
    [3 * day + 5 * hour, '3 gün'],
  ]
  for (const [ms, expected] of cases) assert.equal(formatAge(ms), expected, `${ms} ms`)
})

test('canlı oturumun yaşı son harekete, diğerlerininki çıkışa bakılır', () => {
  const base = {
    lastActivityAt: 1_000,
    createdAt: 0,
    endedAt: 5_000,
  } as Pick<SessionView, 'lifecycle' | 'lastActivityAt' | 'createdAt' | 'endedAt'>
  assert.equal(sessionAgeMs({ ...base, lifecycle: 'live' }, 4_000), 3_000)
  assert.equal(sessionAgeMs({ ...base, lifecycle: 'exited' }, 8_000), 3_000)
  assert.equal(sessionAgeMs({ ...base, lifecycle: 'orphaned', endedAt: null }, 4_000), 4_000)
})
