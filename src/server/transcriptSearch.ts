import fs from 'node:fs'
import { foldText, makeSnippet, searchTerms, type Snippet } from '../shared/textSearch'
import { userPromptText } from './transcripts'

/**
 * Claude konuşmalarında tam metin arama (ADR 0023). Dizin yalnız kullanıcı
 * istemlerini ve ajanın düz metin yanıtlarını tutar; araç çağrıları ve
 * çıktıları aranmaz. Transcript yalnız sona eklendiği için her dosyada yalnız
 * yeni baytlar okunur. Dizin bellekte yaşar, diske yazılmaz.
 */

const READ_STEP_BYTES = 8 * 1024 * 1024
const LINE_PARSE_MAX = 256 * 1024
/** Tek mesajdan saklanan en çok karakter. */
const MESSAGE_MAX_CHARS = 4000
/** Bir konuşmadan saklanan en çok metin; aşılınca en eski mesajlar düşer. */
const DOC_MAX_CHARS = 256 * 1024
const RESULT_LIMIT = 25

interface Message {
  role: 'user' | 'assistant'
  text: string
  folded: string
  at: number | null
}

interface Doc {
  offset: number
  /** Son okumadaki dosya boyutu. */
  size: number
  /** Son tamamlanan okumanın dayandığı değişiklik anı; hiç okunmadıysa -1. */
  mtimeMs: number
  chars: number
  messages: Message[]
  reading: Promise<void> | null
}

export interface SearchFile {
  path: string
  /** Son değişiklik; yeni konuşmalar önce dizinlenir, eşitlikte önce gelir. */
  mtimeMs: number
}

export interface SearchMatch {
  path: string
  role: 'user' | 'assistant'
  snippet: Snippet
  at: number | null
  matches: number
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

function assistantText(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'assistant' || entry.isSidechain === true) return null
  const content = (entry.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return null
  const parts = content.flatMap((p) => (typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string' ? [(p as { text: string }).text] : []))
  return parts.length > 0 ? parts.join('\n') : null
}

/** Satırlardan aranabilir mesajlar; son yarım satır sonraki okumaya kalır. */
export function readSearchLines(text: string): { messages: Message[]; consumed: number } {
  const end = text.lastIndexOf('\n')
  if (end < 0) return { messages: [], consumed: 0 }
  const messages: Message[] = []
  for (const line of text.slice(0, end).split('\n')) {
    if (line.length === 0 || line.length > LINE_PARSE_MAX) continue
    const isUser = line.includes('"type":"user"')
    if (!isUser && !line.includes('"type":"assistant"')) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const raw = entry.type === 'user' ? userPromptText(entry) : assistantText(entry)
    if (!raw) continue
    const clean = raw.replace(/<\/?pasted_content[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, MESSAGE_MAX_CHARS)
    if (!clean) continue
    messages.push({ role: entry.type === 'user' ? 'user' : 'assistant', text: clean, folded: foldText(clean), at: parseTime(entry.timestamp) })
  }
  return { messages, consumed: Buffer.byteLength(text.slice(0, end + 1)) }
}

/** Bir konuşmanın en iyi eşleşmesi: bütün terimler konuşmada geçmeli. */
export function matchMessages(messages: Message[], terms: string[]): Omit<SearchMatch, 'path'> & { score: number } | null {
  if (terms.length === 0) return null
  const covered = new Set<string>()
  let best: { message: Message; hits: number } | null = null
  let matches = 0
  for (const message of messages) {
    let hits = 0
    for (const term of terms) {
      if (message.folded.includes(term)) {
        hits++
        covered.add(term)
      }
    }
    if (hits === 0) continue
    matches++
    // Eşitlikte sonraki (daha yeni) mesaj kalır; kullanıcı istemi yanıttan önce gelir.
    if (!best || hits > best.hits || (hits === best.hits && (message.role === 'user' || best.message.role !== 'user'))) best = { message, hits }
  }
  if (!best || covered.size < terms.length) return null
  return {
    role: best.message.role,
    snippet: makeSnippet(best.message.text, best.message.folded, terms),
    at: best.message.at,
    matches,
    score: best.hits,
  }
}

export interface TranscriptSearch {
  /**
   * Dosyaları yeniden eskiye dizinleyip arar. Bütçe dolunca yetişmeyen
   * dosyalar pending'de sayılır; sonraki arama kaldığı yerden sürer.
   */
  search(files: SearchFile[], query: string, budgetMs: number): Promise<{ matches: SearchMatch[]; pending: number }>
}

export function createTranscriptSearch(): TranscriptSearch {
  const docs = new Map<string, Doc>()

  async function refresh(file: string, doc: Doc): Promise<void> {
    try {
      const stat = await fs.promises.stat(file)
      if (stat.size < doc.offset) Object.assign(doc, { offset: 0, chars: 0, messages: [] })
      doc.size = stat.size
      while (doc.offset < doc.size) {
        const handle = await fs.promises.open(file, 'r')
        let bytesRead = 0
        let consumed = 0
        try {
          const length = Math.min(READ_STEP_BYTES, doc.size - doc.offset)
          const buffer = Buffer.alloc(length)
          bytesRead = (await handle.read(buffer, 0, length, doc.offset)).bytesRead
          const read = readSearchLines(buffer.subarray(0, bytesRead).toString('utf8'))
          consumed = read.consumed
          for (const message of read.messages) {
            doc.messages.push(message)
            doc.chars += message.text.length
          }
          while (doc.chars > DOC_MAX_CHARS && doc.messages.length > 1) doc.chars -= doc.messages.shift()!.text.length
        } finally {
          await handle.close()
        }
        // Tek satır adımı aşıyorsa atlanır; yarım son satır dosya büyüyünce okunur.
        const advance = consumed > 0 ? consumed : bytesRead === READ_STEP_BYTES ? bytesRead : 0
        if (advance === 0) break
        doc.offset += advance
      }
    } catch {
      // okunamayan transcript aranmaz
    } finally {
      doc.reading = null
    }
  }

  /** Dosyanın okunmasını başlatır; değişmemiş ve sonuna kadar okunmuş dosya yeniden açılmaz. */
  function ensure(file: SearchFile): Doc {
    let doc = docs.get(file.path)
    if (!doc) {
      doc = { offset: 0, size: -1, mtimeMs: -1, chars: 0, messages: [], reading: null }
      docs.set(file.path, doc)
    }
    const current = doc.mtimeMs === file.mtimeMs && doc.offset >= doc.size
    if (!doc.reading && !current) {
      const target = doc
      target.reading = refresh(file.path, target).then(() => { target.mtimeMs = file.mtimeMs })
    }
    return doc
  }

  /** Okuma bütçe içinde biterse true. */
  async function settle(reading: Promise<void>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    const done = await Promise.race([
      reading.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms) }),
    ])
    clearTimeout(timer)
    return done
  }

  return {
    async search(files, query, budgetMs) {
      const terms = searchTerms(query)
      const deadline = Date.now() + budgetMs
      const found: Array<SearchMatch & { score: number; mtimeMs: number }> = []
      let pending = 0
      for (const file of [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
        const doc = ensure(file)
        if (doc.reading) {
          const remaining = deadline - Date.now()
          // Dizini hiç okunmamış dosya bekletilir; eski dizini olan dosya o haliyle aranır.
          if (doc.mtimeMs < 0 && (remaining <= 0 || !(await settle(doc.reading, remaining)))) {
            pending++
            continue
          }
        }
        const match = matchMessages(doc.messages, terms)
        if (match) found.push({ ...match, path: file.path, mtimeMs: file.mtimeMs })
      }
      found.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs)
      return {
        matches: found.slice(0, RESULT_LIMIT).map(({ score: _score, mtimeMs: _mtime, ...match }) => match),
        pending,
      }
    },
  }
}
