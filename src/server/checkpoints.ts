import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { FORMAT_VERSION, type SnapshotScope } from './terminalState'
import type { StoredRun } from '../shared/types'

/**
 * Run kimlikli terminal checkpoint'leri (spec §4). state.json'ın dışında, özel
 * izinli dosyalarda, atomik temp+rename ile tutulur. Okunamayan bir kayıt boş
 * geçmişle karıştırılmaz: "önceki görüntü yok" ile "önceki görüntü okunamadı"
 * ayrı sonuçlardır.
 */

/** Session başına tutulan Run sayısı; yeni Run öncekini silmez. */
const KEPT_RUNS = 2

/** Salt okunur inceleme için eşzamanlı yükleme tavanı. */
const MAX_CONCURRENT_READS = 2

export interface CheckpointInput {
  sessionId: string
  runId: string
  text: string
  scope: SnapshotScope
  cols: number
  rows: number
  sequence: number
  capturedAt: number
}

export interface StoredCheckpoint extends CheckpointInput {
  formatVersion: number
  byteLength: number
}

export type CheckpointRead =
  | { state: 'ready'; checkpoint: StoredCheckpoint }
  | { state: 'missing' }
  | { state: 'unreadable'; reason: string }

export interface CheckpointStore {
  readonly root: string
  fileFor(sessionId: string, runId: string): string
  /** Yazar ama budamaz: kayda girmemiş bir Run önceki Run'ların kaydını silemez. */
  write(input: CheckpointInput): Promise<void>
  read(sessionId: string, runId: string): Promise<CheckpointRead>
  /** Saklanmış Run kayıtları, en yeni önce; dosya içeriği okunmaz. */
  list(sessionId: string): StoredRun[]
  /** Kayda girmiş Run için saklama sınırını uygular; o Run'ın kaydı her durumda kalır. */
  prune(sessionId: string, keepRunId: string): void
  /** Tek Run kaydını kaldırır; oturum dizini boşalırsa o da kalkar. */
  removeRun(sessionId: string, runId: string): void
  removeSession(sessionId: string): void
  stats(): { peakConcurrentReads: number }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Kimlik dosya adına girebilir mi: yol ayırıcısı veya üst dizin kaçışı içermez. */
export function isCheckpointId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

/** Kimlikler dosya adına girer; yol ayırıcısı veya üst dizin kaçışı kabul edilmez. */
function safeId(id: string, what: string): string {
  if (!isCheckpointId(id)) throw new Error(`Checkpoint ${what} kimliği kullanılamaz: ${id}`)
  return id
}

export function openCheckpointStore(dataDir: string): CheckpointStore {
  const root = path.join(dataDir, 'terminal')
  let inflight = 0
  let peakConcurrentReads = 0
  const waiting: (() => void)[] = []

  function sessionDir(sessionId: string): string {
    return path.join(root, safeId(sessionId, 'oturum'))
  }

  function fileFor(sessionId: string, runId: string): string {
    return path.join(sessionDir(sessionId), `${safeId(runId, 'run')}.json`)
  }

  /** En yeni KEPT_RUNS kaydı bırakır; kalanları kaldırır. */
  function pruneDir(dir: string, justWritten: string): void {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      return
    }
    if (entries.length <= KEPT_RUNS) return
    // Korunan kaydın dosyası yoksa (yazım başarısız) diğerlerinden bir fazlası kalır.
    const othersKept = entries.includes(path.basename(justWritten)) ? KEPT_RUNS - 1 : KEPT_RUNS
    // Az önce yazılan kayıt her durumda korunur; mtime eşitliği onu düşüremez.
    const byAge = entries
      .filter((name) => path.join(dir, name) !== justWritten)
      .map((name) => {
        const full = path.join(dir, name)
        try {
          return { full, at: fs.statSync(full).mtimeMs }
        } catch {
          return { full, at: 0 }
        }
      })
      .sort((a, b) => b.at - a.at)
    for (const stale of byAge.slice(othersKept)) {
      try {
        fs.unlinkSync(stale.full)
      } catch {
        // Kaldırılamayan eski kayıt yeni kaydı engellemez.
      }
    }
  }

  async function acquireRead(): Promise<() => void> {
    if (inflight >= MAX_CONCURRENT_READS) {
      await new Promise<void>((resolve) => waiting.push(resolve))
    } else {
      inflight += 1
    }
    peakConcurrentReads = Math.max(peakConcurrentReads, inflight)
    return () => {
      const next = waiting.shift()
      if (next) next()
      else inflight -= 1
    }
  }

  return {
    root,
    fileFor,

    async write(input: CheckpointInput): Promise<void> {
      if (Buffer.byteLength(input.text) > 8 * 1024 * 1024) throw new Error('Terminal checkpoint boyutu 8 MiB sınırını aşıyor')
      const dir = sessionDir(input.sessionId)
      const file = fileFor(input.sessionId, input.runId)
      const record: StoredCheckpoint = {
        ...input,
        formatVersion: FORMAT_VERSION,
        byteLength: Buffer.byteLength(input.text),
      }
      const tmp = `${file}.${randomUUID()}.tmp`
      try {
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
        await fs.promises.writeFile(tmp, JSON.stringify(record), { mode: 0o600 })
        await fs.promises.rename(tmp, file)
      } catch (err) {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
        throw new Error(`Terminal checkpoint yazılamadı: ${(err as Error).message}`)
      }
    },

    async read(sessionId: string, runId: string): Promise<CheckpointRead> {
      const release = await acquireRead()
      try {
        let raw: string
        try {
          const file = fileFor(sessionId, runId)
          if ((await fs.promises.stat(file)).size > 50 * 1024 * 1024) return { state: 'unreadable', reason: 'kayıt boyut sınırını aşıyor' }
          raw = await fs.promises.readFile(file, 'utf8')
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'ENOENT') return { state: 'missing' }
          return { state: 'unreadable', reason: `dosya okunamadı (${code})` }
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return { state: 'unreadable', reason: 'kayıt ayrıştırılamadı' }
        }
        if (!isObject(parsed)) return { state: 'unreadable', reason: 'kayıt tanınmıyor' }
        if (parsed.formatVersion !== FORMAT_VERSION) {
          return { state: 'unreadable', reason: `biçim sürümü desteklenmiyor: ${String(parsed.formatVersion)}` }
        }
        if (parsed.sessionId !== sessionId || parsed.runId !== runId) {
          return { state: 'unreadable', reason: 'kayıt başka bir Run a ait' }
        }
        const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
        if (typeof parsed.text !== 'string' || !integer(parsed.sequence, 0, Number.MAX_SAFE_INTEGER) ||
            !integer(parsed.cols, 2, 300) || !integer(parsed.rows, 1, 120) ||
            !integer(parsed.capturedAt, 0, Number.MAX_SAFE_INTEGER) ||
            !['screen', 'scrollback'].includes(String(parsed.scope)) || Buffer.byteLength(parsed.text) > 8 * 1024 * 1024) {
          return { state: 'unreadable', reason: 'kayıt alanları eksik' }
        }
        if (parsed.byteLength !== Buffer.byteLength(parsed.text)) {
          return { state: 'unreadable', reason: 'kayıt boyutu gövdeyle uyuşmuyor' }
        }
        return { state: 'ready', checkpoint: parsed as unknown as StoredCheckpoint }
      } finally {
        release()
      }
    },

    list(sessionId: string): StoredRun[] {
      const dir = sessionDir(sessionId)
      let entries: string[]
      try {
        entries = fs.readdirSync(dir)
      } catch {
        return []
      }
      const runs: StoredRun[] = []
      for (const name of entries) {
        // Yarım kalmış temp dosyaları ve tanınmayan adlar Run kaydı değildir.
        const runId = name.slice(0, -'.json'.length)
        if (!name.endsWith('.json') || !isCheckpointId(runId)) continue
        try {
          runs.push({ runId, updatedAt: Math.floor(fs.statSync(path.join(dir, name)).mtimeMs) })
        } catch {
          // Listeleme ile stat arasında budanmış kayıt atlanır.
        }
      }
      return runs.sort((a, b) => b.updatedAt - a.updatedAt)
    },

    prune(sessionId: string, keepRunId: string): void {
      pruneDir(sessionDir(sessionId), fileFor(sessionId, keepRunId))
    },

    removeRun(sessionId: string, runId: string): void {
      fs.rmSync(fileFor(sessionId, runId), { force: true })
      try {
        // rmdir yalnız boş dizini kaldırır; başka Run'ın kaydı varsa dokunmaz.
        fs.rmdirSync(sessionDir(sessionId))
      } catch {
        // Dizin dolu veya hiç yok.
      }
    },

    removeSession(sessionId: string): void {
      fs.rmSync(sessionDir(sessionId), { recursive: true, force: true })
    },

    stats: () => ({ peakConcurrentReads }),
  }
}
