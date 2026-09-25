import { freshStats, parseStats, type MascotStats } from '../shared/mascotStats'

/** Robotun durumu yalnız bu tarayıcı/uygulama profilinde tutulur. */
const KEY = 'agentdeck.mascot.v1'
/** Önceki sürümün yalnız sevgi sayacı. */
const LEGACY_LOVE_KEY = 'agentdeck.mascotLove'

export function loadStats(now: number): MascotStats {
  try {
    const raw = localStorage.getItem(KEY)
    const legacy = Math.max(0, Math.floor(Number(localStorage.getItem(LEGACY_LOVE_KEY)) || 0))
    return parseStats(raw ? JSON.parse(raw) : null, now, legacy)
  } catch {
    return freshStats(now)
  }
}

export function saveStats(stats: MascotStats): void {
  try { localStorage.setItem(KEY, JSON.stringify(stats)) } catch { /* bu açılışla sınırlı kalır */ }
}
