/** Robotun günün saatine ve özel günlere göre davranışı için takvim. */

export type DayPart = 'morning' | 'day' | 'noon' | 'evening' | 'night'
export type SpecialDay = 'newyear' | 'birthday' | 'robotday' | 'republic' | 'valentine'

export function dayPart(date: Date): DayPart {
  const minutes = date.getHours() * 60 + date.getMinutes()
  if (minutes < 5 * 60 || minutes >= 23 * 60) return 'night'
  if (minutes < 10 * 60) return 'morning'
  if (minutes >= 12 * 60 && minutes < 14 * 60) return 'noon'
  if (minutes >= 18 * 60) return 'evening'
  return 'day'
}

const monthDay = (date: Date) => `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${monthDay(date)}`
}

/**
 * Bugün özel bir gün mü: kullanıcının doğum günü, robotun ilk karşılaşma
 * yıl dönümü (aynı gün sayılmaz), yılbaşı, 29 Ekim, 14 Şubat.
 */
export function specialDay(date: Date, birthday: string | null, firstSeen: number): SpecialDay | null {
  const md = monthDay(date)
  if (birthday && md === birthday) return 'birthday'
  const first = new Date(firstSeen)
  if (monthDay(first) === md && first.getFullYear() < date.getFullYear()) return 'robotday'
  if (md === '12-31' || md === '01-01') return 'newyear'
  if (md === '10-29') return 'republic'
  if (md === '02-14') return 'valentine'
  return null
}

export const GREETINGS: Record<SpecialDay, string> = {
  newyear: 'Mutlu yıllar! 🎉',
  birthday: 'İyi ki doğdun! 🎂',
  robotday: 'Bugün tanışma yıl dönümümüz! 🎂',
  republic: 'Cumhuriyet Bayramı kutlu olsun! 🇹🇷',
  valentine: 'Seni seviyorum ♥',
}
