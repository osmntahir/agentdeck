import { foldText } from './textSearch'

/**
 * Hazır istemler ve tekrar tespiti (ADR 0024). Kullanıcının konuşmalarda
 * sık yazdığı istemler ve arka arkaya yazdığı istem dizileri, kaydedilip tek
 * tıkla veya kuyrukla yeniden gönderilebilecek hazır istem olarak önerilir.
 */

/** Kaydedilmiş, bir veya birkaç adımlı istem. Adımlar sırayla kuyruğa girer. */
export interface SavedPrompt {
  id: string
  name: string
  steps: string[]
  createdAt: number
  /** Kaç kez gönderildiği; palette sık kullanılanı öne alır. */
  uses?: number
  lastUsedAt?: number
}

/** Oturumun istem kuyruğundaki bir istem; ajan turunu bitirince sırayla gönderilir. */
export interface QueuedPrompt {
  id: string
  text: string
  addedAt: number
  /** Hazır istemden geldiyse adı; kuyrukta gösterim içindir. */
  from?: string
}

/** Tekrar tespitinin önerisi: kaydedilince hazır istem olur. */
export interface PromptSuggestion {
  steps: string[]
  /** Tekrar sayısı (dizi için, dizinin görüldüğü sayı). */
  count: number
  /** Kaç farklı konuşmada görüldüğü. */
  conversations: number
  lastAt: number | null
}

export const PROMPT_NAME_MAX = 80
export const PROMPT_STEP_MAX_CHARS = 8000
export const PROMPT_STEPS_MAX = 12
export const QUEUE_MAX = 50

/** İstem anahtarı: katlanmış, noktalamasız, tek boşluklu. */
export function promptKey(text: string): string {
  return foldText(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function words(key: string): Set<string> {
  return new Set(key.split(' ').filter((w) => w.length > 1))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let common = 0
  for (const w of a) if (b.has(w)) common++
  return common / (a.size + b.size - common || 1)
}

/** Tekrar sayılabilecek istem: iki kelimeden uzun, yapıştırılmış belge kadar uzun değil. */
function repeatable(key: string, text: string): boolean {
  return key.length >= 8 && key.split(' ').length >= 2 && text.length <= 600
}

export interface PromptHistory {
  /** Bir konuşmanın kullanıcı istemleri, eskiden yeniye. */
  prompts: Array<{ text: string; at: number | null }>
}

const SIMILAR = 0.65

/**
 * Tekrarlanan istemleri ve istem dizilerini bulur.
 * - Tek istem: en az 3 kez, en az 2 konuşmada.
 * - Dizi: arka arkaya yazılan 2–3 istem, en az 2 konuşmada aynı sırayla.
 * Kelime kümesi en az %65 örtüşen istemler aynı sayılır; gösterilen metin en yeni yazılışıdır.
 * Kaydedilmiş hazır istemlerle aynı olanlar önerilmez.
 */
export function detectRepeatedPrompts(history: PromptHistory[], saved: SavedPrompt[], limit = 8): PromptSuggestion[] {
  const clusters: Array<{ words: Set<string>; text: string; at: number | null; count: number; seen: Set<number> }> = []
  const byKey = new Map<string, number>()
  const sequences: number[][] = []
  history.forEach((conversation, index) => {
    const sequence: number[] = []
    for (const prompt of conversation.prompts) {
      const key = promptKey(prompt.text)
      if (!repeatable(key, prompt.text)) {
        sequence.push(-1)
        continue
      }
      let id = byKey.get(key)
      if (id === undefined) {
        const set = words(key)
        id = clusters.findIndex((c) => jaccard(c.words, set) >= SIMILAR)
        if (id < 0) {
          clusters.push({ words: set, text: prompt.text, at: prompt.at, count: 0, seen: new Set() })
          id = clusters.length - 1
        }
        byKey.set(key, id)
      }
      const cluster = clusters[id]!
      cluster.count++
      cluster.seen.add(index)
      if ((prompt.at ?? 0) >= (cluster.at ?? 0)) {
        cluster.text = prompt.text
        cluster.at = prompt.at
      }
      // Aynı istemi art arda yinelemek dizi değildir.
      if (sequence.at(-1) !== id) sequence.push(id)
    }
    sequences.push(sequence)
  })

  const savedKeys = new Set(saved.map((p) => p.steps.map(promptKey).join('\n')))
  const suggestions: Array<PromptSuggestion & { score: number; ids: number[] }> = []
  for (const length of [3, 2]) {
    const found = new Map<string, { ids: number[]; seen: Set<number>; count: number }>()
    sequences.forEach((sequence, index) => {
      for (let i = 0; i + length <= sequence.length; i++) {
        const ids = sequence.slice(i, i + length)
        if (ids.includes(-1) || new Set(ids).size < length) continue
        const key = ids.join(',')
        const entry = found.get(key) ?? { ids, seen: new Set<number>(), count: 0 }
        entry.count++
        entry.seen.add(index)
        found.set(key, entry)
      }
    })
    for (const entry of found.values()) {
      if (entry.seen.size < 2) continue
      // Daha uzun bir önerinin parçası olan dizi ayrıca önerilmez.
      if (suggestions.some((s) => `,${s.ids.join(',')},`.includes(`,${entry.ids.join(',')},`))) continue
      suggestions.push({
        ids: entry.ids,
        steps: entry.ids.map((id) => clusters[id]!.text),
        count: entry.count,
        conversations: entry.seen.size,
        lastAt: Math.max(...entry.ids.map((id) => clusters[id]!.at ?? 0)) || null,
        score: entry.seen.size * length * 2,
      })
    }
  }
  clusters.forEach((cluster, id) => {
    if (cluster.count < 3 || cluster.seen.size < 2) return
    suggestions.push({ ids: [id], steps: [cluster.text], count: cluster.count, conversations: cluster.seen.size, lastAt: cluster.at, score: cluster.count + cluster.seen.size })
  })
  return suggestions
    .filter((s) => !savedKeys.has(s.steps.map(promptKey).join('\n')))
    .sort((a, b) => b.score - a.score || (b.lastAt ?? 0) - (a.lastAt ?? 0))
    .slice(0, limit)
    .map(({ score: _score, ids: _ids, ...suggestion }) => suggestion)
}

/** Öneriden hazır istem adı: ilk adımın ilk birkaç kelimesi. */
export function suggestedName(steps: string[]): string {
  const first = (steps[0] ?? '').replace(/\s+/g, ' ').trim()
  const name = first.split(' ').slice(0, 5).join(' ')
  const short = name.length > 40 ? `${name.slice(0, 39)}…` : name
  return steps.length > 1 ? `${short} +${steps.length - 1}` : short
}
