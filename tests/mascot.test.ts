import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACCESSORIES, currentHappiness, daysTogether, freshStats, isHungry, milestoneMessage, parseStats, withHappiness, HUNGRY_AFTER_MS } from '../src/shared/mascotStats'
import { dayKey, dayPart, specialDay } from '../src/shared/mascotCalendar'

const T0 = Date.UTC(2026, 8, 25, 12)

test('bozuk kayıt varsayılana döner; eski sevgi sayacı taşınır', () => {
  assert.equal(parseStats(null, T0, 7).pets, 7)
  const parsed = parseStats({ pets: -3, cookies: 2.7, accessory: 'jetpack', birthday: '31/12', happiness: 500, firstSeen: T0 + 1 }, T0)
  assert.equal(parsed.pets, 0)
  assert.equal(parsed.cookies, 2)
  assert.equal(parsed.accessory, null)
  assert.equal(parsed.birthday, null)
  assert.equal(parsed.happiness, 100)
  assert.equal(parsed.firstSeen, T0, 'gelecekteki zaman kabul edilmez')
})

test('mutluluk zamanla azalır, ilgiyle artar, 0-100 dışına çıkmaz', () => {
  const stats = freshStats(T0)
  assert.equal(currentHappiness(stats, T0), 70)
  assert.equal(Math.round(currentHappiness(stats, T0 + 60 * 60_000)), 60, 'saatte 10 puan')
  assert.equal(currentHappiness(stats, T0 + 100 * 60 * 60_000), 0)
  assert.equal(withHappiness(stats, T0, 50).happiness, 100)
})

test('açlık 6 saat sonra başlar', () => {
  const stats = freshStats(T0)
  assert.equal(isHungry(stats, T0 + HUNGRY_AFTER_MS - 1), false)
  assert.equal(isHungry(stats, T0 + HUNGRY_AFTER_MS + 1), true)
})

test('eşik geçilince kutlanır; yeni aksesuar önce söylenir', () => {
  const before = { ...freshStats(T0), pets: 9 }
  assert.equal(milestoneMessage(before, { ...before, pets: 10 }), `Yeni aksesuar: ${ACCESSORIES[0]!.label}!`)
  assert.equal(milestoneMessage({ ...before, pets: 49 }, { ...before, pets: 50 }), '50. sevgi! 🎉')
  assert.equal(milestoneMessage({ ...before, pets: 50 }, { ...before, pets: 51 }), null)
  assert.equal(daysTogether(before, T0 + 86_400_000 * 2.5), 3)
})

test('günün saati ve özel günler', () => {
  const at = (h: number, m = 0) => new Date(2026, 8, 25, h, m)
  assert.deepEqual([at(2), at(7), at(11), at(12, 30), at(19), at(23, 30)].map(dayPart), ['night', 'morning', 'day', 'noon', 'evening', 'night'])
  const first = new Date(2025, 8, 25).getTime()
  assert.equal(specialDay(new Date(2026, 8, 25), null, first), 'robotday')
  assert.equal(specialDay(new Date(2025, 8, 25), null, first), null, 'tanışılan gün yıl dönümü değildir')
  assert.equal(specialDay(new Date(2026, 8, 25), '09-25', first), 'birthday', 'doğum günü önce gelir')
  assert.equal(specialDay(new Date(2026, 0, 1), null, first), 'newyear')
  assert.equal(specialDay(new Date(2026, 9, 29), null, first), 'republic')
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05')
})
