/**
 * Create/launch/restart kimliği. Aynı daemon ve payload için kayıp cevap
 * ikinci bir Run açmasın diye kimlik hatırlanır. Daemon değişince eski
 * kimlik kullanılmaz: yeni defter boştur, aynı id sessizce ikinci kayıt açardı.
 */

export interface MutationIds {
  id(slot: string, daemonId: string, payload: unknown): string
  complete(slot: string, requestId: string): void
}

function payloadKey(payload: unknown): string {
  return JSON.stringify(payload, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
    }
    return value
  })
}

const TTL_MS = 10 * 60 * 1000
const MAX_PENDING = 1024

export function createMutationIds(
  random: () => string = () => crypto.randomUUID(),
  now: () => number = Date.now,
): MutationIds {
  const slots = new Map<string, { daemonId: string; requestId: string; at: number }>()
  const keyOf = (slot: string, key: string) => `${slot}\0${key}`
  return {
    id(slot, daemonId, payload) {
      const at = now()
      for (const [key, entry] of slots) {
        if (at - entry.at >= TTL_MS || (daemonId && entry.daemonId && entry.daemonId !== daemonId)) slots.delete(key)
      }
      const key = payloadKey(payload)
      const mapKey = keyOf(slot, key)
      const existing = slots.get(mapKey)
      const unexpired = existing && now() - existing.at < TTL_MS
      // Henüz poll edilmemiş boş kimlik aynı daemon'dır; ilk state onu doldurur.
      if (unexpired && (existing.daemonId === daemonId || existing.daemonId === '' || daemonId === '')) {
        if (daemonId && !existing.daemonId) existing.daemonId = daemonId
        return existing.requestId
      }
      // Geçerli kayıp cevap kimliğini atmak aynı işlemi yeniden çalıştırabilir.
      if (slots.size >= MAX_PENDING) throw new Error('Bekleyen işlem sınırı doldu; durumu yenileyip süre dolunca tekrar deneyin')
      const requestId = random()
      slots.set(mapKey, { daemonId, requestId, at: now() })
      return requestId
    },
    complete(slot, requestId) {
      const prefix = `${slot}\0`
      for (const [mapKey, entry] of slots) {
        if (entry.requestId === requestId && mapKey.startsWith(prefix)) {
          slots.delete(mapKey)
          return
        }
      }
    },
  }
}
