/**
 * Claude robotunun kalıcı durumu: sevgi, kurabiye ve top sayaçları,
 * mutluluk, açlık, aksesuarlar ve doğum günü. Kayıt yalnız istemcide
 * (localStorage) tutulur; bu modül yalnız doğrulama ve hesaplamayı yapar.
 */

export type AccessoryId = 'hat' | 'scarf' | 'glasses' | 'bow' | 'crown'

export interface MascotStats {
  pets: number
  cookies: number
  fetches: number
  /** İlk karşılaşma; robotun kendi doğum günü bundan çıkar. */
  firstSeen: number
  /** Son hesaplanan mutluluk (0-100) ve o anın zamanı; arada zamanla azalır. */
  happiness: number
  happinessAt: number
  lastFed: number
  accessory: AccessoryId | null
  /** Kullanıcının doğum günü, "AA-GG". */
  birthday: string | null
  /** Son selamlaşılan gün, "YYYY-AA-GG". */
  greetedOn: string | null
}

export const ACCESSORIES: { id: AccessoryId; label: string; hint: string; unlocked: (s: MascotStats) => boolean }[] = [
  { id: 'hat', label: 'Silindir şapka 🎩', hint: '10 kez sev', unlocked: (s) => s.pets >= 10 },
  { id: 'scarf', label: 'Atkı 🧣', hint: '5 kurabiye ver', unlocked: (s) => s.cookies >= 5 },
  { id: 'glasses', label: 'Güneş gözlüğü 🕶️', hint: '25 kez sev', unlocked: (s) => s.pets >= 25 },
  { id: 'bow', label: 'Fiyonk 🎀', hint: '10 kez top getirsin', unlocked: (s) => s.fetches >= 10 },
  { id: 'crown', label: 'Taç 👑', hint: '100 kez sev', unlocked: (s) => s.pets >= 100 },
]

const HAPPINESS_START = 70
/** Mutluluk her 6 dakikada bir puan azalır; hiç sıfırın altına inmez. */
const DECAY_MS_PER_POINT = 6 * 60_000
export const HUNGRY_AFTER_MS = 6 * 60 * 60_000
const MILESTONES = [10, 50, 100, 250, 500, 1000]

const clamp = (value: number) => Math.max(0, Math.min(100, value))
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)

export function freshStats(now: number): MascotStats {
  return { pets: 0, cookies: 0, fetches: 0, firstSeen: now, happiness: HAPPINESS_START, happinessAt: now, lastFed: now, accessory: null, birthday: null, greetedOn: null }
}

/** Kayıtlı değerleri doğrulayarak okur; bozuk alan varsayılanına döner. */
export function parseStats(raw: unknown, now: number, legacyPets = 0): MascotStats {
  const base = freshStats(now)
  if (!raw || typeof raw !== 'object') return { ...base, pets: legacyPets }
  const r = raw as Record<string, unknown>
  const time = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now ? value : fallback)
  return {
    pets: count(r.pets),
    cookies: count(r.cookies),
    fetches: count(r.fetches),
    firstSeen: time(r.firstSeen, now),
    happiness: typeof r.happiness === 'number' && Number.isFinite(r.happiness) ? clamp(r.happiness) : HAPPINESS_START,
    happinessAt: time(r.happinessAt, now),
    lastFed: time(r.lastFed, now),
    accessory: ACCESSORIES.some((a) => a.id === r.accessory) ? (r.accessory as AccessoryId) : null,
    birthday: typeof r.birthday === 'string' && /^\d{2}-\d{2}$/.test(r.birthday) ? r.birthday : null,
    greetedOn: typeof r.greetedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.greetedOn) ? r.greetedOn : null,
  }
}

/** Şu anki mutluluk: son kayıttan bu yana geçen süre kadar azalmış hali. */
export function currentHappiness(stats: MascotStats, now: number): number {
  return clamp(stats.happiness - Math.max(0, now - stats.happinessAt) / DECAY_MS_PER_POINT)
}

export function withHappiness(stats: MascotStats, now: number, delta: number): MascotStats {
  return { ...stats, happiness: clamp(currentHappiness(stats, now) + delta), happinessAt: now }
}

export function isHungry(stats: MascotStats, now: number): boolean {
  return now - stats.lastFed > HUNGRY_AFTER_MS
}

/** Bir sayaç eşiği geçildiyse kutlama metni; yeni açılan aksesuar da söylenir. */
export function milestoneMessage(before: MascotStats, after: MascotStats): string | null {
  const unlocked = ACCESSORIES.find((a) => !a.unlocked(before) && a.unlocked(after))
  if (unlocked) return `Yeni aksesuar: ${unlocked.label}!`
  const crossed = (key: 'pets' | 'cookies' | 'fetches', noun: string) => {
    const mark = MILESTONES.find((m) => before[key] < m && after[key] >= m)
    return mark ? `${mark}. ${noun}! 🎉` : null
  }
  return crossed('pets', 'sevgi') ?? crossed('cookies', 'kurabiye') ?? crossed('fetches', 'top')
}

/** Robotun seninle geçirdiği gün sayısı (ilk gün 1). */
export function daysTogether(stats: MascotStats, now: number): number {
  return Math.max(1, Math.floor((now - stats.firstSeen) / 86_400_000) + 1)
}
