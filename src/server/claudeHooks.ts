import fs from 'node:fs'
import path from 'node:path'
import type { ConversationSource } from '../shared/types'

/**
 * Claude konuşma takibi (ADR 0018). Claude'un SessionStart kancası her yeni,
 * sürdürülen, /clear veya /compact sonrası konuşmada kimliği stdin'den verir.
 * Kanca kullanıcının Claude ayarlarına bir kez eklenir ve yalnız AgentDeck
 * Run'larında bir şey yapar: AGENTDECK_HOOK_DIR yoksa stdin'i tüketip çıkar.
 * Kanca daemon'a ağdan bağlanmaz; olay dosyası bırakır, daemon toplar.
 */

/** Kancayı tanıma işareti; bu metni içeren eski girişin yerine güncel komut yazılır. */
const MARKER = 'AGENTDECK_HOOK_DIR'

/** stdout'a yazmaz: SessionStart çıktısı Claude'un bağlamına eklenirdi. */
export const HOOK_COMMAND =
  'if [ -n "$AGENTDECK_HOOK_DIR" ]; then f="$AGENTDECK_HOOK_DIR/$AGENTDECK_SESSION.$AGENTDECK_RUN.$$"; ' +
  'cat > "$f.tmp" && mv "$f.tmp" "$f.json"; else cat > /dev/null; fi 2>/dev/null; exit 0'

export type HookInstall = { active: true; changed: boolean } | { active: false; message: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Kancayı settings.json'a ekler. Okunamayan veya beklenmedik biçimdeki ayar
 * dosyasına dokunulmaz; takip kapalı kalır ve nedeni bildirilir.
 */
export function installClaudeHook(settingsFile: string): HookInstall {
  let target = settingsFile
  let settings: Record<string, unknown> = {}
  let mode = 0o600
  try {
    // Dotfile deposuna symlink'li ayar dosyası symlink olarak kalır.
    target = fs.realpathSync(settingsFile)
    const stat = fs.statSync(target)
    mode = stat.mode & 0o777
    const raw = fs.readFileSync(target, 'utf8')
    const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw)
    if (!isObject(parsed)) return { active: false, message: `${settingsFile} bir JSON nesnesi değil; kanca eklenmedi` }
    settings = parsed
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      const reason = err instanceof SyntaxError ? 'JSON olarak okunamadı' : `okunamadı (${code ?? 'bilinmeyen hata'})`
      return { active: false, message: `${settingsFile} ${reason}; kanca eklenmedi` }
    }
  }

  const hooks = settings.hooks ?? {}
  if (!isObject(hooks)) return { active: false, message: `${settingsFile} içindeki hooks alanı nesne değil; kanca eklenmedi` }
  const groups = hooks.SessionStart ?? []
  if (!Array.isArray(groups)) return { active: false, message: `${settingsFile} içindeki hooks.SessionStart dizi değil; kanca eklenmedi` }

  let found = false
  let changed = false
  const nextGroups = groups.map((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return group
    const entries = group.hooks.map((entry) => {
      if (!isObject(entry) || typeof entry.command !== 'string' || !entry.command.includes(MARKER)) return entry
      found = true
      if (entry.command === HOOK_COMMAND && entry.type === 'command') return entry
      changed = true
      return { ...entry, type: 'command', command: HOOK_COMMAND }
    })
    return { ...group, hooks: entries }
  })
  if (!found) {
    nextGroups.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] })
    changed = true
  }
  if (!changed) return { active: true, changed: false }

  const next = { ...settings, hooks: { ...hooks, SessionStart: nextGroups } }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.agentdeck-${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode })
    fs.renameSync(tmp, target)
  } catch (err) {
    return { active: false, message: `${settingsFile} yazılamadı (${(err as NodeJS.ErrnoException).code ?? 'bilinmeyen hata'}); kanca eklenmedi` }
  }
  return { active: true, changed: true }
}

export interface HookEvent {
  sessionId: string
  runId: string
  conversationId: string
  source: ConversationSource
  transcriptPath: string | null
  at: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENT = /^[0-9a-f]{32}$/
const SOURCES: ConversationSource[] = ['startup', 'resume', 'clear', 'compact']
const EVENT_MAX_BYTES = 64 * 1024

/** Dosya adı `<session>.<run>.<pid>.json`; içerik Claude'un kanca girdisidir. */
export function parseHookEvent(fileName: string, raw: string, at: number): HookEvent | null {
  const parts = fileName.split('.')
  if (parts.length !== 4 || parts[3] !== 'json') return null
  const [sessionId, runId] = parts as [string, string]
  if (!IDENT.test(sessionId) || !IDENT.test(runId)) return null
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(input)) return null
  if (input.hook_event_name !== undefined && input.hook_event_name !== 'SessionStart') return null
  const conversationId = input.session_id
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) return null
  const source = SOURCES.includes(input.source as ConversationSource) ? (input.source as ConversationSource) : 'other'
  const transcriptPath = typeof input.transcript_path === 'string' && path.isAbsolute(input.transcript_path) ? input.transcript_path : null
  return { sessionId, runId, conversationId: conversationId.toLowerCase(), source, transcriptPath, at }
}

export interface HookInbox {
  /** Bekleyen olayları hemen toplar; testler ve kapanış için. */
  drain(): void
  close(): void
}

/**
 * Olay dizinini izler. Her olay bir kez okunur ve silinir; bozuk dosya da
 * silinir, yarım yazılmış (.tmp) dosyaya dokunulmaz.
 */
export function openHookInbox(dir: string, onEvents: (events: HookEvent[]) => void, pollMs = 2000): HookInbox {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let closed = false

  function drain(): void {
    if (closed) return
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    } catch {
      // dizin okunamazsa bu turda olay yok
    }
    const events: HookEvent[] = []
    for (const name of names) {
      const file = path.join(dir, name)
      let event: HookEvent | null = null
      try {
        const stat = fs.statSync(file)
        if (stat.isFile() && stat.size <= EVENT_MAX_BYTES) event = parseHookEvent(name, fs.readFileSync(file, 'utf8'), stat.mtimeMs)
      } catch {
        // okunamayan olay atlanır
      }
      try {
        fs.unlinkSync(file)
      } catch {
        // başka bir tarama silmiş olabilir
      }
      if (event) events.push(event)
    }
    // Boş tur da bildirilir: kaydı henüz yazılmamış oturumun olayı yeniden denenir.
    onEvents(events)
  }

  let watcher: fs.FSWatcher | null = null
  try {
    watcher = fs.watch(dir, () => drain())
    watcher.on('error', () => undefined)
  } catch {
    // izleme yoksa periyodik tarama yeterlidir
  }
  const timer = setInterval(drain, pollMs)
  timer.unref?.()
  drain()

  return {
    drain,
    close() {
      closed = true
      clearInterval(timer)
      watcher?.close()
    },
  }
}
