import fs from 'node:fs'
import path from 'node:path'

/**
 * Claude transcript'lerinin salt okunur dizini. Claude arka plan oturumu her
 * konuşmasına sistem talimatı olarak kendi `jobs/<kısa-id>/tmp` yolunu yazar;
 * /clear sonrası açılan konuşma da bunu taşır. Konuşmanın hangi arka plan
 * oturumuna ait olduğu dosyanın başındaki bu ilk işaretten okunur. Dosyalara
 * asla yazılmaz.
 */

const HEAD_BYTES = 400 * 1024
const RESCAN_MS = 10_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const JOB_MARK = /CLAUDE_JOB_DIR\/tmp` \(`[^`]*\/jobs\/([0-9a-f]{8})\/tmp`\)/
const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/

export interface TranscriptEntry {
  id: string
  path: string
  /** Konuşmanın açıldığı klasör; okunamazsa null. */
  cwd: string | null
  /** Ait olduğu Claude arka plan oturumu; etkileşimli konuşmada null. */
  job: string | null
  mtimeMs: number
}

/** Claude'un proje dizini adı: yoldaki harf ve rakam dışı her karakter '-' olur. */
export function projectDirName(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-')
}

/** Dosya başından arka plan oturumu ve klasör. */
export function readTranscriptHead(head: string): { job: string | null; cwd: string | null } {
  const job = head.match(JOB_MARK)?.[1] ?? null
  const raw = head.match(CWD)?.[1]
  let cwd: string | null = null
  if (raw !== undefined) {
    try {
      cwd = JSON.parse(`"${raw}"`) as string
    } catch {
      cwd = null
    }
  }
  return { job, cwd }
}

export interface TranscriptIndex {
  /** Projenin (alt klasörleri dahil) transcript'leri; eskiyse arka planda yeniden taranır. */
  cached(projectPath: string): TranscriptEntry[]
  list(projectPath: string): Promise<TranscriptEntry[]>
  find(projectPath: string, id: string): Promise<TranscriptEntry | null>
}

export function createTranscriptIndex(projectsDir: string): TranscriptIndex {
  /** Dosya başı değişmez: bir kez okunur. */
  const heads = new Map<string, { job: string | null; cwd: string | null }>()
  const byProject = new Map<string, { at: number; entries: TranscriptEntry[] }>()
  const running = new Map<string, Promise<TranscriptEntry[]>>()

  async function readHead(file: string): Promise<{ job: string | null; cwd: string | null }> {
    const known = heads.get(file)
    if (known) return known
    let handle: fs.promises.FileHandle | null = null
    try {
      handle = await fs.promises.open(file, 'r')
      const buffer = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
      const value = readTranscriptHead(buffer.subarray(0, bytesRead).toString('utf8'))
      // Yeni açılmış, henüz talimatı yazılmamış dosyanın sonucu saklanmaz.
      if (value.job !== null || bytesRead === HEAD_BYTES) heads.set(file, value)
      return value
    } catch {
      return { job: null, cwd: null }
    } finally {
      await handle?.close()
    }
  }

  async function scan(projectPath: string): Promise<TranscriptEntry[]> {
    const prefix = projectDirName(projectPath)
    let dirs: string[] = []
    try {
      dirs = (await fs.promises.readdir(projectsDir)).filter((name) => name === prefix || name.startsWith(`${prefix}-`))
    } catch {
      return []
    }
    const entries: TranscriptEntry[] = []
    for (const dir of dirs) {
      let names: string[] = []
      try {
        names = await fs.promises.readdir(path.join(projectsDir, dir))
      } catch {
        continue
      }
      for (const name of names) {
        const id = name.endsWith('.jsonl') ? name.slice(0, -6) : ''
        if (!UUID.test(id)) continue
        const file = path.join(projectsDir, dir, name)
        let stat: fs.Stats
        try {
          stat = await fs.promises.stat(file)
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        const head = await readHead(file)
        // Önek eşleşmesi kaba olabilir (ör. kiosk ve kiosk-eski); klasör biliniyorsa proje içinde olmalı.
        if (head.cwd !== null && head.cwd !== projectPath && !head.cwd.startsWith(`${projectPath}/`)) continue
        entries.push({ id, path: file, cwd: head.cwd, job: head.job, mtimeMs: stat.mtimeMs })
      }
    }
    return entries
  }

  function refresh(projectPath: string): Promise<TranscriptEntry[]> {
    const pending = running.get(projectPath)
    if (pending) return pending
    const task = scan(projectPath).then((entries) => {
      byProject.set(projectPath, { at: Date.now(), entries })
      running.delete(projectPath)
      return entries
    })
    running.set(projectPath, task)
    return task
  }

  return {
    cached(projectPath) {
      const entry = byProject.get(projectPath)
      if (!entry || Date.now() - entry.at >= RESCAN_MS) void refresh(projectPath)
      return entry?.entries ?? []
    },
    async list(projectPath) {
      const entry = byProject.get(projectPath)
      if (entry && Date.now() - entry.at < RESCAN_MS) return entry.entries
      return refresh(projectPath)
    },
    async find(projectPath, id) {
      const entries = await refresh(projectPath)
      return entries.find((e) => e.id === id) ?? null
    },
  }
}
