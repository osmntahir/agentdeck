import fs from 'node:fs'
import type { ConversationSummary } from '../shared/types'

/**
 * Claude transcript'inden konuşma özeti. Dosya yalnız sona eklenir; bu yüzden
 * her okumada yalnız yeni baytlar taranır. Okuma arka planda yapılır: durum
 * görünümü önbellekteki son özeti kullanır; yalnız konuşma listesi kısa süre bekler.
 */

const PROMPT_MAX_CHARS = 160
/** Tek seferde okunacak en çok yeni bayt; büyük transcript birkaç adımda yetişir. */
const READ_STEP_BYTES = 8 * 1024 * 1024
/** Bu kadar uzun satır istem değildir (araç çıktısı vb.); JSON olarak çözülmez. */
const LINE_PARSE_MAX = 256 * 1024
const REFRESH_MIN_MS = 3000

interface Entry {
  offset: number
  size: number
  checkedAt: number
  summary: ConversationSummary
  reading: Promise<void> | null
}

function clean(text: string): string | null {
  const value = text
    .replace(/<\/?pasted_content[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!value) return null
  return value.length > PROMPT_MAX_CHARS ? `${value.slice(0, PROMPT_MAX_CHARS - 1)}…` : value
}

/** Kullanıcının kendi yazdığı istem; komut, meta ve araç sonucu satırları değil. */
function userPrompt(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) return null
  const message = entry.message as { content?: unknown } | undefined
  let text: string | null = null
  if (typeof message?.content === 'string') text = message.content
  else if (Array.isArray(message?.content)) {
    const part = message.content.find((p) => typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text')
    if (part && typeof (part as { text?: unknown }).text === 'string') text = (part as { text: string }).text
  }
  if (text === null) return null
  const trimmed = text.trim()
  if (trimmed.startsWith('<command-') || trimmed.startsWith('<local-command') || trimmed.startsWith('<bash-')) return null
  return clean(trimmed)
}

/** Yeni tam satırları özete işler; son yarım satır sonraki okumaya kalır. */
export function applyTranscriptLines(summary: ConversationSummary, text: string): { summary: ConversationSummary; consumed: number } {
  const end = text.lastIndexOf('\n')
  if (end < 0) return { summary, consumed: 0 }
  const next = { ...summary }
  for (const line of text.slice(0, end).split('\n')) {
    if (line.length === 0 || line.length > LINE_PARSE_MAX) continue
    const isTitle = line.startsWith('{"type":"custom-title"')
    const isLastPrompt = line.startsWith('{"type":"last-prompt"')
    const maybeUser = !isTitle && !isLastPrompt && line.includes('"type":"user"')
    if (!isTitle && !isLastPrompt && !maybeUser) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (isTitle && typeof entry.customTitle === 'string') next.title = clean(entry.customTitle)
    else if (isLastPrompt && typeof entry.lastPrompt === 'string') next.lastPrompt = clean(entry.lastPrompt)
    else if (maybeUser) {
      const prompt = userPrompt(entry)
      if (prompt) {
        if (next.firstPrompt === null) next.firstPrompt = prompt
        next.lastPrompt = prompt
      }
    }
  }
  return { summary: next, consumed: Buffer.byteLength(text.slice(0, end + 1)) }
}

export interface TranscriptSummaries {
  /** Önbellekteki özet; gerekiyorsa arka planda tazelenir. */
  get(file: string): ConversationSummary
  /** Verilen dosyaların bekleyen okumalarını en çok timeoutMs bekler; liste isteği boş özet göstermesin. */
  settle(files: string[], timeoutMs: number): Promise<void>
}

export function createTranscriptSummaries(onUpdate: () => void = () => undefined): TranscriptSummaries {
  const cache = new Map<string, Entry>()

  async function refresh(file: string, entry: Entry): Promise<void> {
    try {
      const stat = await fs.promises.stat(file)
      entry.summary = { ...entry.summary, updatedAt: stat.mtimeMs }
      // Dosya kısaldıysa baştan okunur.
      if (stat.size < entry.offset) {
        entry.offset = 0
        entry.summary = { title: null, firstPrompt: null, lastPrompt: null, updatedAt: stat.mtimeMs }
      }
      entry.size = stat.size
      if (stat.size === entry.offset) return
      const handle = await fs.promises.open(file, 'r')
      try {
        const length = Math.min(READ_STEP_BYTES, stat.size - entry.offset)
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, entry.offset)
        const text = buffer.subarray(0, bytesRead).toString('utf8')
        const { summary, consumed } = applyTranscriptLines(entry.summary, text)
        entry.summary = summary
        // Tek satır adım sınırını aşıyorsa atlanır; aksi halde okuma ilerlemezdi.
        entry.offset += consumed > 0 ? consumed : bytesRead === READ_STEP_BYTES ? bytesRead : 0
      } finally {
        await handle.close()
      }
    } catch {
      // okunamayan transcript özeti boş bırakır
    } finally {
      entry.reading = null
      entry.checkedAt = Date.now()
      onUpdate()
    }
  }

  function entryFor(file: string): Entry {
    let entry = cache.get(file)
    if (!entry) {
      entry = { offset: 0, size: 0, checkedAt: 0, reading: null, summary: { title: null, firstPrompt: null, lastPrompt: null, updatedAt: null } }
      cache.set(file, entry)
    }
    const behind = entry.offset < entry.size
    if (!entry.reading && (behind || Date.now() - entry.checkedAt >= REFRESH_MIN_MS)) entry.reading = refresh(file, entry)
    return entry
  }

  return {
    get: (file) => entryFor(file).summary,
    async settle(files, timeoutMs) {
      const pending = files.map((file) => entryFor(file).reading).filter((p): p is Promise<void> => p !== null)
      if (pending.length === 0) return
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.all(pending),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) }),
      ])
      clearTimeout(timer)
    },
  }
}
