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

export function createMutationIds(
  random: () => string = () => crypto.randomUUID(),
  now: () => number = Date.now,
): MutationIds {
  const slots = new Map<string, { daemonId: string; payloadKey: string; requestId: string; at: number }>()
  return {
    id(slot, daemonId, payload) {
      const key = payloadKey(payload)
      const existing = slots.get(slot)
      const fresh = existing && now() - existing.at < TTL_MS
      // Henüz poll edilmemiş boş kimlik aynı daemon'dır; ilk state onu doldurur.
      if (fresh && existing.payloadKey === key && (existing.daemonId === daemonId || existing.daemonId === '' || daemonId === '')) {
        if (daemonId && !existing.daemonId) existing.daemonId = daemonId
        return existing.requestId
      }
      const requestId = random()
      slots.set(slot, { daemonId, payloadKey: key, requestId, at: now() })
      return requestId
    },
    complete(slot, requestId) {
      if (slots.get(slot)?.requestId === requestId) slots.delete(slot)
    },
  }
}
