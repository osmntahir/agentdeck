import { addUsage, contextWindowFor, emptyUsage, messageUsage, type ConversationUsage, type TokenUsage } from '../shared/usage'

/**
 * Claude transcript'inden token kullanımı. Bir API yanıtı içerik bloğu başına
 * ayrı satıra yazılır ve her satır aynı usage'ı taşır: aynı mesaj kimliği bir
 * kez sayılır. Yan zincir (alt ajan) maliyete girer, bağlamı değiştirmez.
 */

export interface UsageState {
  usage: ConversationUsage
  /** Son sayılan mesaj ve katkısı; ardışık satırlar aynı mesajı tekrarlar. */
  lastId: string | null
  lastPart: TokenUsage | null
}

export function emptyUsageState(): UsageState {
  return { usage: { total: emptyUsage(), context: null }, lastId: null, lastPart: null }
}

/** JSON olarak çözülmeyecek kadar uzun satırda (büyük araç girdisi) usage yine okunur. */
const LINE_PARSE_MAX = 256 * 1024

interface AssistantUsage {
  id: string
  model: string
  usage: Record<string, unknown>
  sidechain: boolean
  at: number | null
}

function balancedObject(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

export function readAssistantUsage(line: string): AssistantUsage | null {
  if (!line.includes('"type":"assistant"')) return null
  if (line.length <= LINE_PARSE_MAX) {
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      return null
    }
    if (entry.type !== 'assistant') return null
    const message = entry.message as Record<string, unknown> | undefined
    if (!message || typeof message.id !== 'string' || typeof message.model !== 'string') return null
    if (typeof message.usage !== 'object' || message.usage === null) return null
    return { id: message.id, model: message.model, usage: message.usage as Record<string, unknown>, sidechain: entry.isSidechain === true, at: parseTime(entry.timestamp) }
  }
  // Mesaj nesnesi model ve kimlikle başlar, usage içerikten sonra gelir.
  const head = line.slice(0, 4096)
  const model = head.match(/"model":"([^"]+)"/)?.[1]
  const id = head.match(/"id":"(msg_[^"]+)"/)?.[1]
  const at = line.lastIndexOf('"usage":{')
  if (!model || !id || at < 0) return null
  const raw = balancedObject(line, at + 8)
  if (!raw) return null
  try {
    const usage = JSON.parse(raw) as Record<string, unknown>
    const time = line.slice(line.lastIndexOf('"timestamp":"') + 13).match(/^([^"]+)"/)?.[1]
    return { id, model, usage, sidechain: /"isSidechain":true/.test(head), at: parseTime(time) }
  } catch {
    return null
  }
}

/** Yeni tam satırları kullanıma işler; son yarım satır çağıranın sonraki okumasına kalır. */
export function applyUsageLines(state: UsageState, text: string): UsageState {
  const end = text.lastIndexOf('\n')
  if (end < 0) return state
  let { usage, lastId, lastPart } = state
  for (const line of text.slice(0, end).split('\n')) {
    const found = readAssistantUsage(line)
    if (!found || found.model === '<synthetic>') continue
    const part = messageUsage(found.model, found.usage)
    let total = usage.total
    if (found.id === lastId && lastPart) total = addUsage(total, lastPart, -1)
    total = addUsage(total, part)
    lastId = found.id
    lastPart = part
    const context = found.sidechain
      ? usage.context
      : { model: found.model, tokens: part.input + part.cacheRead + part.cacheWrite + part.output, window: contextWindowFor(found.model), at: found.at }
    usage = { total, context }
  }
  return { usage, lastId, lastPart }
}
