/**
 * İki ayrı eşzamanlılık kuralı vardır ve karıştırılmamalıdır:
 *
 * - Aynı Session'ın lifecycle mutasyonu **beklemez**: çakışma 409 olur.
 * - Aynı common Git dizinindeki mutasyonlar **sıralanır**: iki `git worktree`
 *   işlemi aynı depoda çakışırsa depo kilidi yarışır.
 */
export interface HeldLock {
  release(): void
}

export interface ExclusiveLocks {
  tryAcquire(key: string): HeldLock | null
}

export function createExclusiveLocks(): ExclusiveLocks {
  const held = new Map<string, symbol>()
  return {
    tryAcquire(key) {
      if (held.has(key)) return null
      const ticket = Symbol(key)
      held.set(key, ticket)
      return {
        release() {
          // Yalnız kendi biletimizi düşürürüz; çifte release başkasının
          // kilidini açmaz.
          if (held.get(key) === ticket) held.delete(key)
        },
      }
    },
  }
}

export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>
}

/** Aynı anda en çok `max` iş çalışır; fazlası geliş sırasıyla bekler. */
export function createLimiter(max: number): Limiter {
  let active = 0
  const waiting: (() => void)[] = []
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
      else active += 1
      try {
        return await fn()
      } finally {
        // Yer bekleyene devredilir; sayaç yalnız kimse beklemiyorsa düşer.
        const next = waiting.shift()
        if (next) next()
        else active -= 1
      }
    },
  }
}

export interface SerialQueues {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>
}

export function createSerialQueues(): SerialQueues {
  const tails = new Map<string, Promise<unknown>>()
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()
      const task = previous.then(fn, fn)
      // Kuyruk bir hatada kırılmaz ve boşalınca anahtar bırakılır.
      const settled = task.then(
        () => undefined,
        () => undefined,
      )
      tails.set(key, settled)
      settled.then(() => {
        if (tails.get(key) === settled) tails.delete(key)
      })
      return task
    },
  }
}
