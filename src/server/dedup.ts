import crypto from 'node:crypto'

/**
 * Create ve yeni Run eylemleri için bounded istek defteri. Amaç: kaybolan bir
 * cevabın kullanıcıya ikinci bir Run açtırmaması. Aynı kimlik + aynı payload
 * aynı sonucu verir; aynı kimlik farklı payload çakışmadır.
 */
export class DedupConflictError extends Error {
  readonly code = 'request_id_conflict'
  constructor(requestId: string) {
    super(`Aynı requestId farklı bir istekle kullanıldı: ${requestId}`)
    this.name = 'DedupConflictError'
  }
}

export interface LedgerOptions {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

interface Entry<T> {
  payloadHash: string
  at: number
  result: Promise<T>
}

/** Alan sırasından bağımsız kararlı payload imzası. */
function stableHash(payload: unknown): string {
  const canonical = JSON.stringify(payload, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
    }
    return value
  })
  return crypto.createHash('sha256').update(canonical ?? 'null').digest('hex')
}

export interface RequestLedger<T> {
  run(requestId: string, payload: unknown, fn: () => Promise<T>): Promise<T>
}

export function createRequestLedger<T>(options: LedgerOptions = {}): RequestLedger<T> {
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000
  const maxEntries = options.maxEntries ?? 1024
  const now = options.now ?? Date.now
  // Insertion order = FIFO tahliye sırası.
  const entries = new Map<string, Entry<T>>()

  function evict(): void {
    const cutoff = now() - ttlMs
    for (const [id, entry] of entries) {
      if (entry.at > cutoff) break
      entries.delete(id)
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
  }

  return {
    run(requestId, payload, fn) {
      evict()
      const payloadHash = stableHash(payload)
      const existing = entries.get(requestId)
      if (existing) {
        // Promise dönen bir yol senkron fırlatmaz; çakışma da reddetme olarak gelir.
        if (existing.payloadHash !== payloadHash) return Promise.reject(new DedupConflictError(requestId))
        return existing.result
      }

      const result = fn()
      entries.set(requestId, { payloadHash, at: now(), result })
      // Başarısız deneme hatırlanmaz: kullanıcı aynı kimlikle tekrar deneyebilir.
      result.catch(() => {
        if (entries.get(requestId)?.result === result) entries.delete(requestId)
      })
      evict()
      return result
    },
  }
}
