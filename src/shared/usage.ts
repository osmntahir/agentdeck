/**
 * Ajan konuşmalarının token kullanımı ve API karşılığı tahmini (ADR 0023).
 * Sayılar Claude transcript'indeki usage alanlarından gelir; maliyet, fiyatı
 * bilinen modeller için standart API fiyatıyla hesaplanmış tahmindir. Abonelikle
 * kullanılan hesapta ödenen tutar değildir.
 */

export interface TokenUsage {
  /** Önbelleğe girmeyen giriş tokenları. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Fiyatı bilinen mesajların API karşılığı (USD); hiçbiri bilinmiyorsa null. */
  costUsd: number | null
  /** Fiyatı bilinmeyen modelin mesajı da var; costUsd eksik. */
  costPartial: boolean
}

/** Konuşmanın son ana-zincir isteğinin bağlam büyüklüğü. */
export interface ContextUsage {
  model: string
  tokens: number
  /** Modelin bağlam penceresi; model tanınmıyorsa null. */
  window: number | null
  at: number | null
}

export interface ConversationUsage {
  total: TokenUsage
  context: ContextUsage | null
}

interface Price {
  input: number
  output: number
  /** Önbellek okuma fiyatı; verilmezse girişin onda biri. */
  cacheRead?: number
  /** Hızlı mod fiyat çarpanı; verilmezse hızlı moddaki mesajın fiyatı bilinmez. */
  fast?: number
  window: number
}

/** Milyon token başına USD; önekle eşleşir, en uzun önek kazanır. */
const PRICES: Array<[string, Price]> = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25, window: 1_000_000 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25, window: 1_000_000 }],
  ['claude-fable-5', { input: 10, output: 50, window: 1_000_000 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2, fast: 2, window: 1_000_000 }],
  ['claude-opus-5', { input: 5, output: 25, fast: 2, window: 1_000_000 }],
  ['claude-opus-4-8', { input: 5, output: 25, window: 1_000_000 }],
  ['claude-opus-4-7', { input: 5, output: 25, window: 1_000_000 }],
  ['claude-opus-4-6', { input: 5, output: 25, window: 1_000_000 }],
  ['claude-sonnet-5', { input: 2, output: 10, window: 1_000_000 }],
  ['claude-sonnet-4-6', { input: 3, output: 15, window: 1_000_000 }],
  ['claude-haiku-4-5', { input: 1, output: 5, window: 200_000 }],
]

function priceFor(model: string): Price | null {
  const id = model.replace(/\[[^\]]*\]$/, '')
  let best: [string, Price] | null = null
  for (const entry of PRICES) {
    if ((id === entry[0] || id.startsWith(`${entry[0]}-`)) && (!best || entry[0].length > best[0].length)) best = entry
  }
  return best?.[1] ?? null
}

export function contextWindowFor(model: string): number | null {
  return priceFor(model)?.window ?? null
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, costPartial: false }
}

export function addUsage(a: TokenUsage, b: TokenUsage, sign: 1 | -1 = 1): TokenUsage {
  const cost = a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + sign * (b.costUsd ?? 0)
  return {
    input: a.input + sign * b.input,
    output: a.output + sign * b.output,
    cacheRead: a.cacheRead + sign * b.cacheRead,
    cacheWrite: a.cacheWrite + sign * b.cacheWrite,
    costUsd: cost,
    costPartial: a.costPartial || b.costPartial,
  }
}

export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

/** Tek bir API yanıtının usage alanı → token sayıları ve API karşılığı. */
export function messageUsage(model: string, raw: Record<string, unknown>): TokenUsage {
  const input = count(raw.input_tokens)
  const output = count(raw.output_tokens)
  const cacheRead = count(raw.cache_read_input_tokens)
  const cacheWrite = count(raw.cache_creation_input_tokens)
  const split = typeof raw.cache_creation === 'object' && raw.cache_creation !== null ? (raw.cache_creation as Record<string, unknown>) : null
  const writeHour = Math.min(cacheWrite, count(split?.ephemeral_1h_input_tokens))
  const price = priceFor(model)
  const fast = raw.speed === 'fast'
  const multiplier = fast ? (price?.fast ?? null) : 1
  if (!price || multiplier === null) return { input, output, cacheRead, cacheWrite, costUsd: null, costPartial: true }
  const cost =
    input * price.input +
    output * price.output +
    cacheRead * (price.cacheRead ?? price.input / 10) +
    (cacheWrite - writeHour) * price.input * 1.25 +
    writeHour * price.input * 2
  return { input, output, cacheRead, cacheWrite, costUsd: (cost * multiplier) / 1_000_000, costPartial: false }
}

/** 950 → "950", 12_400 → "12,4k", 1_250_000 → "1,25M". */
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) {
    const k = value / 1000
    return `${k < 10 ? k.toFixed(1).replace('.', ',').replace(',0', '') : Math.round(k)}k`
  }
  const m = value / 1_000_000
  return `${m < 10 ? m.toFixed(2).replace('.', ',').replace(/,?0+$/, '') : m.toFixed(1).replace('.', ',').replace(',0', '')}M`
}

/** "$0,84", "<$0,01"; null → null. */
export function formatCost(usd: number | null): string | null {
  if (usd === null) return null
  if (usd > 0 && usd < 0.01) return '<$0,01'
  return `$${usd.toFixed(usd < 100 ? 2 : 0).replace('.', ',')}`
}

/** Bağlam doluluğu 0–1; pencere bilinmiyorsa null. */
export function contextFill(context: ContextUsage): number | null {
  return context.window ? Math.min(1, context.tokens / context.window) : null
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5"; tanınmayan kimlik olduğu gibi kalır. */
export function modelLabel(model: string): string {
  const parts = model.replace(/\[[^\]]*\]$/, '').replace(/^claude-/, '').split('-').filter((p) => !/^\d{8}$/.test(p))
  const [family, ...version] = parts
  if (!family || version.length === 0 || !version.every((v) => /^\d+$/.test(v))) return model
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${version.join('.')}`
}
